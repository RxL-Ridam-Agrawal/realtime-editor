import Fastify from 'fastify'
import { nanoid } from 'nanoid'
import { attach, createRoomRow, getRoomState, keepRoomAlive } from '../server.js'
import { SERVER_PORT } from '../shared/config.js'
import { resolveTtlMs } from '../shared/ttl.js'

const app = Fastify({ logger: true })

// No accounts, no cookies — a bare CORS allow-all is fine for a room ID
// that's already the entire access model. Fastify's own OPTIONS handling
// needs a hand-rolled preflight reply since we're not adding a CORS plugin.
app.addHook('onRequest', (request, reply, done) => {
  reply.header('Access-Control-Allow-Origin', '*')
  reply.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
  reply.header('Access-Control-Allow-Headers', 'Content-Type')
  done()
})

app.options('/api/*', (request, reply) => {
  reply.code(204).send()
})

app.post('/api/rooms', async (request) => {
  const roomId = nanoid(10)
  createRoomRow(roomId, resolveTtlMs(request.body?.ttl))
  return { roomId }
})

// Lets the client show "this room expired on <date>" distinctly from a
// typo'd/never-existed ID, and drives the countdown UI.
app.get('/api/rooms/:id', async (request, reply) => {
  const state = getRoomState(request.params.id)
  if (state.state === 'not-found') reply.code(404)
  return state
})

// "Keep this room" — resets the idle countdown without requiring an edit.
app.post('/api/rooms/:id/keep-alive', async (request, reply) => {
  const ok = keepRoomAlive(request.params.id)
  if (!ok) {
    reply.code(404)
    return { error: 'not-found-or-expired' }
  }
  return { ok: true }
})

await app.listen({ port: SERVER_PORT, host: '0.0.0.0' })

attach(app.server)
