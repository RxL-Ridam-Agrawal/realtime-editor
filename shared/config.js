// The Fastify/ws server's port. The client constructs absolute http:// and
// ws:// URLs from this plus `location.hostname`, so it works both from
// `npm run dev` on localhost and from a phone on the same LAN via
// `vite --host` (see SPEC-learning.md).
export const SERVER_PORT = 3001
