# Collaborative Code Editor — Project Rules

A codeshare.io-style realtime collaborative code editor. Full build plan is in
`SPEC.md` — read the current phase from there before starting work.

## Stack (decided — do not substitute)

- **Frontend:** vanilla JavaScript (ESM), no framework. Vite for bundling.
- **Editor:** CodeMirror 6.
- **CRDT:** Yjs. Binding via `y-codemirror.next`. Presence via `y-protocols/awareness`.
- **Offline cache:** `y-indexeddb`.
- **Server:** Node 20+, `ws`, `y-protocols`, `lib0`. Hand-rolled relay — see `server.js`.
- **HTTP/REST:** Fastify. **DB:** SQLite via `better-sqlite3`.
- **Auth:** `@node-rs/argon2` for hashing, `jose` for JWTs. **IDs:** `nanoid`.

Do not introduce Monaco, Ace, React, Automerge, Hocuspocus, Liveblocks, Socket.IO,
an ORM, or a CSS framework. Do not add any dependency not listed above without
asking first and explaining why the standard library or an existing dep won't do.

## Hard constraints

- **Yjs garbage collection stays ON** (default). We do not support version history.
  Never pass `{ gc: false }`.
- **Read-only mode must be enforced server-side.** CodeMirror's `EditorState.readOnly`
  is a UX affordance, not a security boundary. A viewer connection must have its
  sync mutations rejected at the socket. Any PR touching this needs a test that
  connects as a viewer and asserts the document did not change.
- **Passwords never appear in a URL or query string.** Exchange password for a
  short-lived JWT over POST, then pass the token on the WebSocket connection.
- **Single server instance only.** Two instances holding the same `Y.Doc` diverge
  silently. Do not add clustering, `cluster`, or PM2 fork mode.
- Never disable TLS verification, hardcode credentials, or `eval` untrusted input.
- Room content is user data. Do not log document contents, passwords, or tokens.

## Working agreement

- **Work one phase at a time.** Complete the current phase in `SPEC.md`, meet its
  acceptance criteria, then STOP and report. Do not start the next phase.
- **Never claim a test passes, a build succeeds, or a feature works unless you ran
  it and observed the output.** Paste the actual output. "Should work" is not a
  status report.
- When you change files, name them and the line ranges. Don't touch unrelated code.
- If you're unsure of a library's API, say "I need to verify" and check the
  installed package in `node_modules` rather than guessing. Invented APIs cost
  more time than questions do.
- Prefer small commits at meaningful checkpoints, with the phase number in the message.

## Conventions

- ESM everywhere (`"type": "module"`). Plain JS with JSDoc annotations for types.
- Two-space indent, no semicolons omitted-by-style debates — match `server.js`.
- Server code in `server/`, client in `src/`, shared constants in `shared/`.
- All user-facing strings in sentence case. Errors state what happened and what
  to do next; they never apologize and are never vague.
