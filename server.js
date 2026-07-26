/**
 * Minimal Yjs WebSocket server — relay + persistence + read-only enforcement.
 *
 *   npm i ws yjs y-protocols lib0
 */

import { WebSocketServer } from 'ws'
import * as Y from 'yjs'
import * as syncProtocol from 'y-protocols/sync'
import * as awarenessProtocol from 'y-protocols/awareness'
import * as encoding from 'lib0/encoding'
import * as decoding from 'lib0/decoding'
import { MSG_SYNC, MSG_AWARENESS, ROOM_EXPIRED_CLOSE_CODE } from './shared/protocol.js'

// ---------------------------------------------------------------------------
// Protocol constants
// ---------------------------------------------------------------------------

// Sync sub-message types. Verified against the installed y-protocols
// (node_modules/y-protocols/sync.js) rather than trusted from memory:
// messageYjsSyncStep1 = 0, messageYjsSyncStep2 = 1, messageYjsUpdate = 2.
// This version exports the real constants, so we use those directly instead
// of hand-copied numbers — a future renumbering can't silently break this.
const SYNC_STEP_1 = syncProtocol.messageYjsSyncStep1 // client asks "what do you have?" -> safe for viewers
const SYNC_STEP_2 = syncProtocol.messageYjsSyncStep2 // client sends missing updates      -> mutation
const SYNC_UPDATE = syncProtocol.messageYjsUpdate // client sends a live edit          -> mutation

const SAVE_DEBOUNCE_MS = 2_000
const SAVE_MAX_WAIT_MS = 10_000
const ROOM_IDLE_UNLOAD_MS = 30_000

// ---------------------------------------------------------------------------
// Persistence — swap these two functions for Postgres later
// ---------------------------------------------------------------------------

// node:sqlite over better-sqlite3: no native compilation, one less
// dependency. Node's own docs still flag it experimental (an
// ExperimentalWarning fires on import), but functionally verified — BLOB
// round-tripping and ON CONFLICT upserts both work correctly on Node 24.13
// (see Phase 4 report). Low-stakes trade for a localhost learning project;
// swap back to better-sqlite3 if a future Node version breaks this.
import { DatabaseSync } from 'node:sqlite'
const db = new DatabaseSync('rooms.db')
db.exec(`
  CREATE TABLE IF NOT EXISTS rooms (
    id            TEXT PRIMARY KEY,
    ydoc          BLOB,
    password_hash TEXT,
    read_token    TEXT,
    owner_token   TEXT,
    expires_at    INTEGER,
    created_at    INTEGER NOT NULL,
    updated_at    INTEGER NOT NULL
  )
`)

// Phase 6: idle-expiry columns. ALTER TABLE ADD COLUMN errors if the column
// already exists, so guard it — this runs on every startup.
// ttl_ms: NULL = never expires. expired_at: NULL = live, set = tombstone.
{
  const existingColumns = new Set(db.prepare('PRAGMA table_info(rooms)').all().map((c) => c.name))
  if (!existingColumns.has('ttl_ms')) db.exec('ALTER TABLE rooms ADD COLUMN ttl_ms INTEGER')
  if (!existingColumns.has('expired_at')) db.exec('ALTER TABLE rooms ADD COLUMN expired_at INTEGER')
}

const selectDoc = db.prepare('SELECT ydoc FROM rooms WHERE id = ?')
const selectRoomMeta = db.prepare('SELECT ttl_ms, expired_at, updated_at FROM rooms WHERE id = ?')
const insertRoom = db.prepare('INSERT INTO rooms (id, ttl_ms, created_at, updated_at) VALUES (?, ?, ?, ?)')
const updateDoc = db.prepare('UPDATE rooms SET ydoc = ?, updated_at = ? WHERE id = ?')
const tombstoneRoom = db.prepare('UPDATE rooms SET ydoc = NULL, expired_at = ? WHERE id = ?')
const touchRoom = db.prepare('UPDATE rooms SET updated_at = ? WHERE id = ? AND expired_at IS NULL')
const selectExpiredCandidates = db.prepare(
  'SELECT id FROM rooms WHERE expired_at IS NULL AND ttl_ms IS NOT NULL AND updated_at + ttl_ms < ?'
)
const deleteOldTombstones = db.prepare('DELETE FROM rooms WHERE expired_at IS NOT NULL AND expired_at < ?')

function loadDoc (roomId, doc) {
  const row = selectDoc.get(roomId)
  if (row?.ydoc) Y.applyUpdate(doc, new Uint8Array(row.ydoc), 'persistence')
}

// Phase 6 prerequisite fix: this used to be an upsert, which papered over
// the real bug — POST /api/rooms never inserted a row, so any made-up room
// ID got a fully working, silently-never-persisted room (the "ghost room"
// bug). Room creation now inserts the row (see createRoomRow), and
// authenticate() verifies it exists before a socket is ever accepted — so a
// plain UPDATE is correct again, and changes === 0 becomes a real tripwire:
// it means the row vanished out from under a room that's still live.
function saveDoc (roomId, doc) {
  const now = Date.now()
  const result = updateDoc.run(Buffer.from(Y.encodeStateAsUpdate(doc)), now, roomId)
  if (result.changes === 0) {
    console.error(`[room ${roomId}] save affected 0 rows — its row vanished while the room was still live`)
  }
}

/** Called by POST /api/rooms right after minting the ID. @param {number|null} ttlMs */
export function createRoomRow (roomId, ttlMs) {
  const now = Date.now()
  insertRoom.run(roomId, ttlMs, now, now)
}

/**
 * For GET /api/rooms/:id — lets the client show "this room expired on
 * <date>" distinctly from a plain not-found, and drive the countdown UI.
 * Effective expiry is derived (updated_at + ttl_ms), not just the stored
 * tombstone, so a room that's aged out but hasn't been swept yet still
 * reports as expired.
 */
export function getRoomState (roomId) {
  const row = selectRoomMeta.get(roomId)
  if (!row) return { state: 'not-found' }
  if (row.expired_at !== null) return { state: 'expired', expiredAt: row.expired_at }
  const derivedExpiry = row.ttl_ms !== null ? row.updated_at + row.ttl_ms : null
  if (derivedExpiry !== null && derivedExpiry < Date.now()) {
    return { state: 'expired', expiredAt: derivedExpiry }
  }
  return { state: 'active', updatedAt: row.updated_at, ttlMs: row.ttl_ms }
}

/** For the "Keep this room" control — resets the idle countdown without an edit. */
export function keepRoomAlive (roomId) {
  const result = touchRoom.run(Date.now(), roomId)
  return result.changes > 0
}

// ---------------------------------------------------------------------------
// Room
// ---------------------------------------------------------------------------

/** @type {Map<string, Room>} */
const rooms = new Map()

class Room {
  constructor (id) {
    this.id = id
    this.doc = new Y.Doc() // gc stays ON — we don't need version history
    this.awareness = new awarenessProtocol.Awareness(this.doc)
    this.awareness.setLocalState(null) // the server is not a participant

    /** @type {Map<import('ws').WebSocket, Set<number>>} conn -> awareness clientIDs */
    this.conns = new Map()

    this.saveTimer = null
    this.saveDeadline = null
    this.unloadTimer = null
    // Set by evictRoom(). Guards flush()/removeConn() against a 'close' or
    // 'message' event that was already in flight when eviction ran — without
    // this, a stale event firing after doc.destroy() would try to save a
    // destroyed doc, or re-schedule a save that resurrects a tombstoned row.
    this.evicted = false

    loadDoc(id, this.doc)

    this.doc.on('update', (update, origin) => {
      const enc = encoding.createEncoder()
      encoding.writeVarUint(enc, MSG_SYNC)
      syncProtocol.writeUpdate(enc, update)
      this.broadcast(encoding.toUint8Array(enc))
      this.scheduleSave()
    })

    this.awareness.on('update', ({ added, updated, removed }) => {
      const changed = added.concat(updated, removed)
      const enc = encoding.createEncoder()
      encoding.writeVarUint(enc, MSG_AWARENESS)
      encoding.writeVarUint8Array(
        enc,
        awarenessProtocol.encodeAwarenessUpdate(this.awareness, changed)
      )
      this.broadcast(encoding.toUint8Array(enc))
    })
  }

  broadcast (payload) {
    for (const conn of this.conns.keys()) {
      if (conn.readyState === conn.OPEN) conn.send(payload)
    }
  }

  /**
   * Debounced save with a hard ceiling, so a user typing continuously for
   * five minutes still gets checkpointed.
   */
  scheduleSave () {
    const now = Date.now()
    if (this.saveDeadline == null) this.saveDeadline = now + SAVE_MAX_WAIT_MS
    clearTimeout(this.saveTimer)
    const delay = Math.min(SAVE_DEBOUNCE_MS, Math.max(0, this.saveDeadline - now))
    this.saveTimer = setTimeout(() => this.flush(), delay)
  }

  flush () {
    if (this.evicted) return
    clearTimeout(this.saveTimer)
    this.saveTimer = null
    this.saveDeadline = null
    try {
      saveDoc(this.id, this.doc)
    } catch (err) {
      // Do NOT drop the doc from memory if persistence failed.
      console.error(`[room ${this.id}] save failed`, err)
    }
  }

  addConn (conn) {
    clearTimeout(this.unloadTimer)
    this.conns.set(conn, new Set())
  }

  removeConn (conn) {
    if (this.evicted) return
    const clientIDs = this.conns.get(conn)
    if (clientIDs?.size) {
      awarenessProtocol.removeAwarenessStates(this.awareness, [...clientIDs], null)
    }
    this.conns.delete(conn)

    if (this.conns.size === 0) {
      this.flush()
      // Keep the doc warm briefly — reloads and flaky networks reconnect fast,
      // and reloading from SQLite on every blip is wasteful.
      this.unloadTimer = setTimeout(() => {
        if (this.conns.size === 0) {
          this.flush()
          this.doc.destroy()
          rooms.delete(this.id)
        }
      }, ROOM_IDLE_UNLOAD_MS)
    }
  }
}

/**
 * Evicts a room per SPEC-learning.md's required order — inverting steps 4
 * and 5 lets an in-flight update re-create state after the tombstone,
 * and skipping the timer cancellation risks a debounced save writing the
 * doc back moments after its blob is nulled.
 */
function evictRoom (roomId, now) {
  const room = rooms.get(roomId)
  if (room) {
    room.evicted = true // 1. mark first, so any in-flight close/message event no-ops
    clearTimeout(room.saveTimer) // 2. cancel the pending save — do NOT flush it
    room.saveTimer = null
    room.saveDeadline = null
    clearTimeout(room.unloadTimer)
    room.unloadTimer = null
    for (const conn of room.conns.keys()) conn.close(ROOM_EXPIRED_CLOSE_CODE, 'room expired') // 3.
    room.conns.clear()
    room.doc.destroy() // 4.
    rooms.delete(roomId)
  }
  tombstoneRoom.run(now, roomId) // 5. only now write the tombstone
}

/**
 * Sweeps rooms whose derived expiry (updated_at + ttl_ms) has passed, and
 * hard-deletes tombstones past their own 30-day retention window. Runs on
 * an interval and once at startup, since the process may have been down
 * through a room's entire expiry window.
 */
// Overridable for testing the eviction race without waiting 10 real
// minutes — same code path either way, just a different interval.
const SWEEP_INTERVAL_MS = Number(process.env.SWEEP_INTERVAL_MS) || 10 * 60 * 1000
const TOMBSTONE_RETENTION_MS = 30 * 24 * 60 * 60 * 1000

function sweepExpiredRooms () {
  const now = Date.now()
  for (const { id } of selectExpiredCandidates.all(now)) evictRoom(id, now)
  deleteOldTombstones.run(now - TOMBSTONE_RETENTION_MS)
}

function getRoom (id) {
  let room = rooms.get(id)
  if (!room) {
    room = new Room(id)
    rooms.set(id, room)
  }
  return room
}

// ---------------------------------------------------------------------------
// Connection handling
// ---------------------------------------------------------------------------

const wss = new WebSocketServer({ noServer: true })

/**
 * No tokens yet (that's the deferred password-protection feature). Pulls
 * the room ID out of the upgrade request's URL and verifies the room both
 * exists and is live — before the upgrade is accepted, not after (accepting
 * first would mean a doc is already loaded into memory for a room that
 * shouldn't exist). Existence alone was the Phase 6 prerequisite fix;
 * liveness is the expiry check proper: reject if tombstoned, or if its
 * derived expiry (updated_at + ttl_ms) has already passed even though the
 * sweeper hasn't caught up to it yet.
 * @returns {{ roomId: string, role: 'editor'|'viewer' } | null}
 */
function authenticate (request) {
  const path = request.url.split('?')[0]
  const match = /^\/r\/([^/]+)(\/view)?\/?$/.exec(path)
  if (!match) return null
  const roomId = match[1]
  const meta = selectRoomMeta.get(roomId)
  if (!meta) return null
  if (meta.expired_at !== null) return null
  if (meta.ttl_ms !== null && meta.updated_at + meta.ttl_ms < Date.now()) return null
  return { roomId, role: match[2] ? 'viewer' : 'editor' }
}

wss.on('connection', (conn, request, session) => {
  const { roomId, role } = session
  const readOnly = role === 'viewer'
  const room = getRoom(roomId)
  room.addConn(conn)

  conn.binaryType = 'arraybuffer'

  // Handshake: offer our state vector so the client can send us its diff.
  {
    const enc = encoding.createEncoder()
    encoding.writeVarUint(enc, MSG_SYNC)
    syncProtocol.writeSyncStep1(enc, room.doc)
    conn.send(encoding.toUint8Array(enc))
  }

  // Send everyone's current presence so the new arrival sees existing cursors.
  const states = room.awareness.getStates()
  if (states.size > 0) {
    const enc = encoding.createEncoder()
    encoding.writeVarUint(enc, MSG_AWARENESS)
    encoding.writeVarUint8Array(
      enc,
      awarenessProtocol.encodeAwarenessUpdate(room.awareness, [...states.keys()])
    )
    conn.send(encoding.toUint8Array(enc))
  }

  conn.on('message', (data) => {
    // The room may have been evicted between this message being sent and
    // being processed (its socket close is already in flight) — a stale
    // message reaching a destroyed doc would throw or resurrect the room.
    if (room.evicted) return
    let message
    try {
      message = new Uint8Array(data)
      const decoder = decoding.createDecoder(message)
      const messageType = decoding.readVarUint(decoder)

      if (messageType === MSG_SYNC) {
        // Peek the sub-type on a fresh decoder so we don't disturb `decoder`.
        const peek = decoding.createDecoder(message)
        decoding.readVarUint(peek)
        const subType = decoding.readVarUint(peek)

        // *** THE READ-ONLY GATE ***
        // readSyncMessage will happily apply updates. Client-side
        // EditorState.readOnly is a UX affordance, not a security boundary —
        // this check is the real one.
        if (readOnly && (subType === SYNC_STEP_2 || subType === SYNC_UPDATE)) {
          return // silently drop; optionally send an error frame instead
        }

        const enc = encoding.createEncoder()
        encoding.writeVarUint(enc, MSG_SYNC)
        syncProtocol.readSyncMessage(decoder, enc, room.doc, conn)
        // length > 1 means there's a real reply, not just the type byte.
        if (encoding.length(enc) > 1) conn.send(encoding.toUint8Array(enc))

      } else if (messageType === MSG_AWARENESS) {
        // Viewers ARE allowed presence — you want to see who's watching.
        const update = decoding.readVarUint8Array(decoder)
        awarenessProtocol.applyAwarenessUpdate(room.awareness, update, conn)

        // Track which awareness clientIDs this socket owns, so we can clean
        // them up on disconnect. Without this you get permanent ghost cursors.
        const ids = room.conns.get(conn)
        if (ids) {
          const d = decoding.createDecoder(update)
          const count = decoding.readVarUint(d)
          for (let i = 0; i < count; i++) {
            ids.add(decoding.readVarUint(d)) // clientID
            decoding.readVarUint(d)          // clock
            decoding.readVarString(d)        // state JSON
          }
        }
      }
    } catch (err) {
      console.error(`[room ${roomId}] bad message`, err)
      conn.close(1011, 'protocol error')
    }
  })

  // Heartbeat: without this, half-open sockets linger and presence lies.
  conn.isAlive = true
  conn.on('pong', () => { conn.isAlive = true })

  conn.on('close', () => room.removeConn(conn))
  conn.on('error', () => room.removeConn(conn))
})

setInterval(() => {
  for (const room of rooms.values()) {
    for (const conn of room.conns.keys()) {
      if (!conn.isAlive) { conn.terminate(); continue }
      conn.isAlive = false
      conn.ping()
    }
  }
}, 30_000)

// ---------------------------------------------------------------------------
// Expiration sweeper
// ---------------------------------------------------------------------------

// Once at startup too — the process may have been down through a room's
// entire expiry window, so relying on the interval alone would leave it
// live until the next tick.
sweepExpiredRooms()
const sweepIntervalHandle = setInterval(sweepExpiredRooms, SWEEP_INTERVAL_MS)

// ---------------------------------------------------------------------------
// HTTP upgrade — authenticate BEFORE accepting the socket
// ---------------------------------------------------------------------------

/** Attach to your Fastify/Express http.Server. */
export function attach (server) {
  server.on('upgrade', (request, socket, head) => {
    const session = authenticate(request)
    if (!session) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n')
      socket.destroy()
      return
    }
    wss.handleUpgrade(request, socket, head, (conn) => {
      wss.emit('connection', conn, request, session)
    })
  })
}

// Flush everything on shutdown or a deploy loses unsaved edits. Clear the
// sweeper interval too, so shutdown isn't delayed by it.
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    clearInterval(sweepIntervalHandle)
    for (const room of rooms.values()) room.flush()
    process.exit(0)
  })
}
