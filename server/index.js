import Fastify from 'fastify'
import { nanoid } from 'nanoid'
import { attach } from '../server.js'
import { SERVER_PORT } from '../shared/config.js'

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

app.options('/api/rooms', (request, reply) => {
  reply.code(204).send()
})

app.post('/api/rooms', async () => {
  return { roomId: nanoid(10) }
})

await app.listen({ port: SERVER_PORT, host: '0.0.0.0' })

attach(app.server)
