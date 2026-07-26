/**
 * SPEC-learning.md Phase 5 acceptance test: connects as a viewer, sends a
 * raw sync update frame directly (bypassing any client-side "don't edit"
 * affordance), and asserts the server-side document did not change. A UI
 * check proves nothing here — client-side read-only is not a security
 * boundary (anyone can open devtools), so this talks the wire protocol
 * directly, the way a malicious or broken client actually could.
 *
 * Requires the server running: npm run server
 * Run with:                    npm run test:readonly
 */
import * as Y from 'yjs'
import { Awareness } from 'y-protocols/awareness'
import * as syncProtocol from 'y-protocols/sync'
import * as awarenessProtocol from 'y-protocols/awareness'
import * as encoding from 'lib0/encoding'
import * as decoding from 'lib0/decoding'
import { MSG_SYNC, MSG_AWARENESS } from '../shared/protocol.js'
import { SERVER_PORT } from '../shared/config.js'

const BASE_HTTP = `http://localhost:${SERVER_PORT}`
const BASE_WS = `ws://localhost:${SERVER_PORT}`
const wait = (ms) => new Promise((r) => setTimeout(r, ms))

function makeSyncClient (url) {
  const doc = new Y.Doc()
  const awareness = new Awareness(doc)
  const socket = new WebSocket(url)
  socket.binaryType = 'arraybuffer'
  const client = { doc, awareness, socket, ytext: doc.getText('codemirror') }

  doc.on('update', (update, origin) => {
    if (origin === client) return // just applied from the network — don't echo back
    const encoder = encoding.createEncoder()
    encoding.writeVarUint(encoder, MSG_SYNC)
    syncProtocol.writeUpdate(encoder, update)
    if (socket.readyState === WebSocket.OPEN) socket.send(encoding.toUint8Array(encoder))
  })

  awareness.on('update', ({ added, updated, removed }, origin) => {
    if (origin === client) return
    const encoder = encoding.createEncoder()
    encoding.writeVarUint(encoder, MSG_AWARENESS)
    encoding.writeVarUint8Array(encoder, awarenessProtocol.encodeAwarenessUpdate(awareness, added.concat(updated, removed)))
    if (socket.readyState === WebSocket.OPEN) socket.send(encoding.toUint8Array(encoder))
  })

  socket.addEventListener('open', () => {
    const encoder = encoding.createEncoder()
    encoding.writeVarUint(encoder, MSG_SYNC)
    syncProtocol.writeSyncStep1(encoder, doc)
    socket.send(encoding.toUint8Array(encoder))
  })

  socket.addEventListener('message', (event) => {
    const decoder = decoding.createDecoder(new Uint8Array(event.data))
    const type = decoding.readVarUint(decoder)
    if (type === MSG_SYNC) {
      const encoder = encoding.createEncoder()
      encoding.writeVarUint(encoder, MSG_SYNC)
      syncProtocol.readSyncMessage(decoder, encoder, doc, client)
      if (encoding.length(encoder) > 1 && socket.readyState === WebSocket.OPEN) {
        socket.send(encoding.toUint8Array(encoder))
      }
    } else if (type === MSG_AWARENESS) {
      const update = decoding.readVarUint8Array(decoder)
      awarenessProtocol.applyAwarenessUpdate(awareness, update, client)
    }
  })

  client.waitOpen = new Promise((resolve) => socket.addEventListener('open', resolve))
  return client
}

/** Sends a raw MSG_SYNC + update frame — a document mutation — over `socket`. */
function sendRawUpdate (socket, update) {
  const encoder = encoding.createEncoder()
  encoding.writeVarUint(encoder, MSG_SYNC)
  syncProtocol.writeUpdate(encoder, update)
  socket.send(encoding.toUint8Array(encoder))
}

let failures = 0
function check (name, cond) {
  if (cond) console.log(`PASS  ${name}`)
  else { console.log(`FAIL  ${name}`); failures++ }
}

console.log(`Connecting to ${BASE_HTTP} — make sure "npm run server" is running.\n`)

const res = await fetch(`${BASE_HTTP}/api/rooms`, { method: 'POST' })
if (!res.ok) {
  console.error(`Could not create a room (server said ${res.status}). Is the server running?`)
  process.exit(1)
}
const { roomId } = await res.json()
console.log('room:', roomId)

// A legitimate editor establishes the room's real, known-good content.
const editor = makeSyncClient(`${BASE_WS}/r/${roomId}`)
await editor.waitOpen
await wait(200)
editor.doc.transact(() => editor.ytext.insert(0, 'legitimate content'))
await wait(300)

// The attack: connect as a viewer (/view), then send a raw update frame
// directly — not through any UI, exactly what SYNC_UPDATE mutation looks
// like on the wire, from a client that ignores EditorState.readOnly
// entirely.
const viewer = makeSyncClient(`${BASE_WS}/r/${roomId}/view`)
await viewer.waitOpen
await wait(300) // let the viewer's own sync settle so it has the real state vector

check('viewer received the real content (read access works)', viewer.ytext.toString() === 'legitimate content')

const forgedDoc = new Y.Doc()
const forgedText = forgedDoc.getText('codemirror')
forgedText.insert(0, 'INJECTED-BY-VIEWER')
const forgedUpdate = Y.encodeStateAsUpdate(forgedDoc)

console.log('\nsending a raw SYNC_UPDATE frame from the viewer connection...')
sendRawUpdate(viewer.socket, forgedUpdate)
await wait(500)

// Verify against the SERVER's copy of the document, via a brand new,
// independent connection — not the attacker's own (possibly locally
// optimistic) view of things.
const witness = makeSyncClient(`${BASE_WS}/r/${roomId}`)
await witness.waitOpen
await wait(400)

console.log('witness (fresh connection) sees:', JSON.stringify(witness.ytext.toString()))
check('server-side document does NOT contain the viewer\'s injected content', !witness.ytext.toString().includes('INJECTED-BY-VIEWER'))
check('server-side document is unchanged from the legitimate content', witness.ytext.toString() === 'legitimate content')

// Spec: "Viewers should still broadcast awareness — you want to see who's
// watching." Only document mutation is gated; presence must still flow.
console.log('\nchecking that a viewer still broadcasts presence...')
viewer.awareness.setLocalStateField('user', { name: 'test-viewer', color: '#809eff' })
await wait(400)
const witnessSeesViewer = witness.awareness.getStates().get(viewer.doc.clientID)
check('a fresh connection still sees the viewer\'s presence', witnessSeesViewer?.user?.name === 'test-viewer')

editor.socket.close()
viewer.socket.close()
witness.socket.close()
await wait(300)

console.log(failures === 0 ? '\nALL CHECKS PASSED — read-only is enforced server-side.' : `\n${failures} CHECK(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)
