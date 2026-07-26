// Top-level message types, shared by server.js's relay and the client's
// socket provider so the two sides can't silently drift out of numbering
// sync.
export const MSG_SYNC = 0
export const MSG_AWARENESS = 1
