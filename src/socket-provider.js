import * as syncProtocol from 'y-protocols/sync'
import * as awarenessProtocol from 'y-protocols/awareness'
import * as encoding from 'lib0/encoding'
import * as decoding from 'lib0/decoding'
import { MSG_SYNC, MSG_AWARENESS } from '../shared/protocol.js'

const RECONNECT_DELAY_MS = 1000

/**
 * The client half of server.js's hand-rolled relay. Not the `y-websocket`
 * package's WebsocketProvider — that's not in this project's approved
 * dependency list, and since the server here is hand-rolled rather than
 * `y-websocket`'s own server, this is a thin hand-rolled counterpart using
 * the same y-protocols/sync + y-protocols/awareness + lib0 wire format.
 */
export class SocketProvider {
  constructor (url, doc, awareness) {
    this.url = url
    this.doc = doc
    this.awareness = awareness
    this.socket = null
    this.shouldReconnect = true

    this._onDocUpdate = this._onDocUpdate.bind(this)
    this._onAwarenessUpdate = this._onAwarenessUpdate.bind(this)

    doc.on('update', this._onDocUpdate)
    awareness.on('update', this._onAwarenessUpdate)

    window.addEventListener('beforeunload', () => {
      awarenessProtocol.removeAwarenessStates(this.awareness, [doc.clientID], 'window unload')
    })

    this._connect()
  }

  _connect () {
    const socket = new WebSocket(this.url)
    socket.binaryType = 'arraybuffer'
    this.socket = socket

    socket.addEventListener('open', () => {
      // The server only sends *its* SyncStep1 (see server.js) — it never
      // proactively pushes the room's existing content. We have to ask for
      // it the same way, or a newly joined window would never receive
      // whatever an earlier window already typed.
      const encoder = encoding.createEncoder()
      encoding.writeVarUint(encoder, MSG_SYNC)
      syncProtocol.writeSyncStep1(encoder, this.doc)
      this._send(encoding.toUint8Array(encoder))

      const localState = this.awareness.getLocalState()
      if (localState !== null) this._sendAwarenessUpdate([this.doc.clientID])
    })

    socket.addEventListener('message', (event) => {
      this._handleMessage(new Uint8Array(event.data))
    })

    socket.addEventListener('close', () => {
      this.socket = null
      // A broken socket means we can no longer vouch for any remote peer's
      // presence — drop them locally so they don't linger as ghost cursors.
      const remoteIds = [...this.awareness.getStates().keys()].filter((id) => id !== this.doc.clientID)
      if (remoteIds.length) awarenessProtocol.removeAwarenessStates(this.awareness, remoteIds, this)
      if (this.shouldReconnect) setTimeout(() => this._connect(), RECONNECT_DELAY_MS)
    })

    socket.addEventListener('error', () => socket.close())
  }

  _handleMessage (message) {
    const decoder = decoding.createDecoder(message)
    const messageType = decoding.readVarUint(decoder)

    if (messageType === MSG_SYNC) {
      const encoder = encoding.createEncoder()
      encoding.writeVarUint(encoder, MSG_SYNC)
      syncProtocol.readSyncMessage(decoder, encoder, this.doc, this)
      if (encoding.length(encoder) > 1) this._send(encoding.toUint8Array(encoder))
    } else if (messageType === MSG_AWARENESS) {
      const update = decoding.readVarUint8Array(decoder)
      awarenessProtocol.applyAwarenessUpdate(this.awareness, update, this)
    }
  }

  _onDocUpdate (update, origin) {
    if (origin === this) return // just applied from the network — don't echo back
    const encoder = encoding.createEncoder()
    encoding.writeVarUint(encoder, MSG_SYNC)
    syncProtocol.writeUpdate(encoder, update)
    this._send(encoding.toUint8Array(encoder))
  }

  _onAwarenessUpdate ({ added, updated, removed }, origin) {
    if (origin === this) return
    this._sendAwarenessUpdate(added.concat(updated, removed))
  }

  _sendAwarenessUpdate (clientIds) {
    const encoder = encoding.createEncoder()
    encoding.writeVarUint(encoder, MSG_AWARENESS)
    encoding.writeVarUint8Array(encoder, awarenessProtocol.encodeAwarenessUpdate(this.awareness, clientIds))
    this._send(encoding.toUint8Array(encoder))
  }

  _send (payload) {
    if (this.socket && this.socket.readyState === WebSocket.OPEN) this.socket.send(payload)
  }

  destroy () {
    this.shouldReconnect = false
    this.doc.off('update', this._onDocUpdate)
    this.awareness.off('update', this._onAwarenessUpdate)
    awarenessProtocol.removeAwarenessStates(this.awareness, [this.doc.clientID], 'provider destroyed')
    if (this.socket) this.socket.close()
  }
}
