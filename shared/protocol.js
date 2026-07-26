// Top-level message types, shared by server.js's relay and the client's
// socket provider so the two sides can't silently drift out of numbering
// sync.
export const MSG_SYNC = 0
export const MSG_AWARENESS = 1

// WebSocket close code for "this room expired." 4000-4999 is reserved for
// application use; this is our choice, not a standard one — terminal, the
// client must not reconnect on seeing it.
export const ROOM_EXPIRED_CLOSE_CODE = 4001
