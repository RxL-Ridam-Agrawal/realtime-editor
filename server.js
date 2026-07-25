/**
 * Minimal Yjs WebSocket server — relay + persistence + read-only enforcement.
 *
 *   npm i ws yjs y-protocols lib0 better-sqlite3
 *
 * This is a skeleton, not finished code. Sections marked TODO are yours.
 * VERIFY the y-protocols sync sub-message constants against your installed
 * version before trusting the read-only path (see SYNC_STEP_1 below).
 */

import { WebSocketServer } from 'ws'
import * as Y from 'yjs'
import * as syncProtocol from 'y-protocols/sync'
import * as awarenessProtocol from 'y-protocols/awareness'
import * as encoding from 'lib0/encoding'
import * as decoding from 'lib0/decoding'

// ---------------------------------------------------------------------------
// Protocol constants
// ---------------------------------------------------------------------------

// Top-level message types, as used by y-websocket clients.
const MSG_SYNC = 0
const MSG_AWARENESS = 1

// Sync sub-message types, from y-protocols/sync. We need these to tell a
// harmless state-vector request apart from an actual document mutation.
// If a future y-protocols renumbers these, read-only silently breaks — so
// prefer the exported constants if your version provides them.
const SYNC_STEP_1 = 0 // client asks "what do you have?"  -> safe for viewers
const SYNC_STEP_2 = 1 // client sends missing updates      -> mutation
const SYNC_UPDATE = 2 // client sends a live edit          -> mutation

const SAVE_DEBOUNCE_MS = 2_000
const SAVE_MAX_WAIT_MS = 10_000
const ROOM_IDLE_UNLOAD_MS = 30_000

// ---------------------------------------------------------------------------
// Persistence — swap these two functions for Postgres later
// ---------------------------------------------------------------------------

import Database from 'better-sqlite3'
const db = new Database('rooms.db')
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

const selectDoc = db.prepare('SELECT ydoc FROM rooms WHERE id = ?')
const updateDoc = db.prepare('UPDATE rooms SET ydoc = ?, updated_at = ? WHERE id = ?')

function loadDoc (roomId, doc) {
  const row = selectDoc.get(roomId)
  if (row?.ydoc) Y.applyUpdate(doc, new Uint8Array(row.ydoc), 'persistence')
}

function saveDoc (roomId, doc) {
  updateDoc.run(Buffer.from(Y.encodeStateAsUpdate(doc)), Date.now(), roomId)
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
 * TODO(you): verify the JWT minted by POST /api/rooms/:id/token.
 * Must return null on any failure, and check `expires_at` on the room.
 * @returns {{ roomId: string, role: 'editor'|'viewer' } | null}
 */
function authenticate (request) {
  throw new Error('not implemented')
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

// Flush everything on shutdown or a deploy loses unsaved edits.
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    for (const room of rooms.values()) room.flush()
    process.exit(0)
  })
}
