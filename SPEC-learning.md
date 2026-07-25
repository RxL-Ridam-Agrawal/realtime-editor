# Collaborative Code Editor — Build Specification (learning build)

## What this is

A room-based realtime collaborative code editor, built to learn how CRDT-based
collaboration actually works. Someone opens the site, gets a room with a
shareable URL, and starts typing. A second person opens the link with no account
and sees their cursor move.

Reference point is codeshare.io.

**This is a learning project running on localhost.** Every dependency is
open-source and free. There is no hosting, no paid service, and no account
signup anywhere in this build. Multi-user testing is done with multiple browser
windows, or a phone on the same LAN via `vite --host`.

## Non-goals

Do not build these, and do not leave scaffolding for them:

- User accounts, login, profiles, email.
- **Password-protected rooms.** Deliberately cut — see "Deferred" below.
- Version history, time travel, document diffing.
- Code execution, linting, autocomplete, language servers.
- End-to-end encryption.
- Deployment config, Dockerfiles, CI, or multi-instance clustering.
- File trees or multi-file projects. One room is one document.
- Chat, comments, video.
- Any paid or freemium service, CDN account, or hosted realtime provider.

---

## Phases

Complete one phase per session. Meet every acceptance criterion, demonstrate it
with output you actually observed, then stop and report.

### Phase 0 — Scaffold

Vite, `package.json` with `"type": "module"`, directories (`src/`, `server/`,
`shared/`), `.gitignore`, placeholder `index.html`. Install nothing but Vite yet.

Self-host the two fonts (IBM Plex Mono, Instrument Sans — both OFL) in
`public/fonts/`. Do not link to Google Fonts; local files mean the app works
offline and there's no third-party request.

**Acceptance:** `npm run dev` serves a blank page, no console errors. Report the
Node and Vite versions actually installed.

---

### Phase 1 — Editor shell, fully local

Features 6, 7, 8, 9, 10. No networking, no Yjs. Get the editor right alone,
because debugging a broken editor and broken sync simultaneously is miserable.

CodeMirror 6 with line numbers, language-aware auto-indent, `indentWithTab` in
the keymap, a language picker, and a dark/light toggle.

**Use `Compartment` for both language and theme.** Language and theme must swap
via `dispatch({ effects: compartment.reconfigure(...) })` without rebuilding
`EditorState`. Rebuilding state destroys undo history and — once Phase 3 lands —
detaches the Yjs binding. This is the one structural decision that's painful to
retrofit.

Languages: `@codemirror/lang-javascript`, `-python`, `-html`, `-css`, `-json`,
`-sql`, `-markdown`, `-cpp`, `-java`, `-rust`. Load them **lazily** via dynamic
import. For anything beyond those, `@codemirror/legacy-modes` with
`StreamLanguage` covers roughly a hundred more for almost no bundle cost.

**Acceptance:** typing works; Tab indents by the language's rules; switching
language re-highlights without losing content or undo history; switching theme
likewise; line numbers render. Report the production bundle size from
`npm run build`.

---

### Phase 2 — Yjs, still local

Introduce `Y.Doc`, bind it with `yCollab` from `y-codemirror.next`, add
`y-indexeddb` so content survives a refresh.

Put `language` in `ydoc.getMap('meta')` rather than local state — in Phase 3 that
makes language selection sync to everyone for free. Theme stays local; it's a
personal preference, not a room property.

**Acceptance:** type, refresh, content is still there. Undo/redo works through the
Yjs undo manager. Holding a key down and pasting 500 lines does not corrupt or
reorder text.

---

### Phase 3 — Server, rooms, presence

Features 1, 2, 3, 4, 5, 11, 12, 13. The milestone where it becomes real, and the
phase with the most learning in it.

`server.js` in this repo is a working skeleton of the relay. **Read it before
writing anything and build on it rather than starting over.** It already handles
message framing, the sync handshake, awareness cleanup, debounced persistence,
and heartbeats. Its `authenticate()` function is a `TODO` — for this build,
replace it with a stub that extracts the room ID from the URL and returns
`{ roomId, role: 'editor' }`. No tokens.

Add Fastify for HTTP, room creation (`POST /api/rooms` → `nanoid(10)`), routing on
`/r/:roomId`, and the client-side `WebsocketProvider` wiring.

Anonymous identity: on first visit generate a random id, an adjective-animal
display name, and a color; persist in `localStorage`. Put `{ name, color }` in
awareness local state.

Assign cursor colors from a **fixed palette of 8 hues at matched lightness and
chroma** (define in OKLCH, convert to hex). Randomly generated colors produce
unreadable cursors and near-identical pairs.

Build a presence list of who's connected.

**Acceptance:** two windows on the same room URL sync in under ~100ms locally.
Each sees the other's cursor and selection with the correct name and color.
Closing one removes its cursor from the other within 30s — verify this, because
leaked awareness state causes permanent ghost cursors. Language change in one
window appears in the other. **Then repeat the whole test with four windows** —
bugs in a hand-rolled relay routinely hide at two clients.

---

### Phase 4 — Persistence

Features 15, 16, 17. Small but the difference between "toy" and "works."

Wire the SQLite schema from `server.js`. On **Node 22.5+**, prefer the built-in
`node:sqlite` module over `better-sqlite3` — no native compilation, one less
dependency. It's marked experimental; check its current status and fall back to
`better-sqlite3` if it's unstable.

Confirm the debounced save actually fires. Then confirm the `SIGTERM` flush does too.

**Acceptance:** edit a room, kill the server with Ctrl-C, restart it, reopen the
room, content intact. Show the real terminal output. Then repeat killing the
process with `SIGKILL` instead and report honestly how much was lost — knowing
your durability window is the point of this phase.

---

### Phase 5 — Read-only mode (stretch goal, do this before anything else optional)

Features 19, 20. Fiddlier than password auth but far more instructive: it forces
you to read the Yjs wire protocol rather than just consume its API.

Two URLs: `/r/:id` for editors, `/r/:id/view` for viewers. Skip JWTs entirely for
now — room IDs are unguessable enough for a learning build, and the auth layer
can come later without changing this code.

Client half is trivial: `EditorState.readOnly` and `editable: false`.

Server half is the real work. `server.js` peeks the sync sub-message type to
reject mutations from viewer connections. **The sub-message constants in that
file were written from memory — verify them against the installed `y-protocols`
before trusting the branch.** If the numbering is wrong, viewers silently gain
write access rather than erroring, which is the worst possible failure mode.

Viewers should still broadcast awareness — you want to see who's watching.

**Acceptance:** a script that connects as a viewer, sends a raw sync update
frame, and asserts the server-side document did not change. Not a UI check — the
UI proves nothing here.

---

### Deferred

Not in this build. Listed so it's clear they were decided against, not forgotten.

- **Feature 14, password protection.** Needs argon2 hashing, a token-exchange
  endpoint, JWT verification, and IP rate limiting — roughly a day of work that
  teaches generic web auth rather than anything about collaboration. Add it later
  if you deploy publicly. Until then, unguessable room IDs are the access model.
- **Feature 18, expiration.** About 20 lines (an `expires_at` column, a check on
  connect, an interval that sweeps), but meaningless on localhost where you own
  the database file. Add it alongside deployment.

---

## Design direction

Follow this exactly. It's a decided direction, not a starting point.

**Concept.** The interface is a room, and presence is the emotional core — the
thing separating this from a text file. Chrome stays quiet and recessive so the
code and the people in it carry the page. Any decoration competes with syntax
highlighting, which is already dense color.

**Signature element: the presence rail.** A narrow vertical strip immediately left
of the line-number gutter, spanning the full document height, showing each
collaborator's cursor as a small colored tick mapped to their line. A minimap of
people rather than content: you can see at a glance that someone is working 400
lines below you, off-screen. Clicking a tick scrolls to them. This is the one
element the app is remembered by — spend the boldness here, keep everything else
disciplined.

**Palette.** Cool ink, deliberately neither pure black nor warm:

| Role | Dark | Light |
|---|---|---|
| Canvas | `#14161A` | `#F7F7F5` |
| Raised surface | `#1E2127` | `#FFFFFF` |
| Border / hairline | `#2A2E36` | `#E3E3DF` |
| Text primary | `#D8DBE0` | `#1A1C20` |
| Text muted | `#7C838F` | `#6B7280` |

One accent only: `#E0A34E`, warm amber, reserved exclusively for sync and save
state. Because it's the single warm note in a cool interface it reads as
information rather than decoration — so never use it for buttons, links, or
emphasis, or it stops meaning anything.

**Typography.** UI chrome in **Instrument Sans**. Editor in **IBM Plex Mono**. Use
the mono for utility text too — room IDs, timestamps, presence-list names —
because here monospace signals "machine-generated identifier," which those all
are. Structure encoding meaning, not styling.

Avoid Inter for UI and JetBrains Mono for the editor. Both are the default answer
and read as one.

**Motion.** One orchestrated moment: the sync indicator moving between saved,
syncing, and offline. Remote cursor labels fade after ~2s of that user's
inactivity and return on movement. Nothing else animates. Respect
`prefers-reduced-motion`.

**Copy.** Active voice, sentence case, plain verbs. Name things by what the person
controls: "Anyone with this link can edit," not "ACL: write." A button reading
"Create room" produces a room, not a "workspace." Errors state what happened and
the next step. An empty room invites the first keystroke rather than explaining
the product.

---

## Known hazards

1. **`gc: false` is a trap we're avoiding.** Yjs garbage collection stays on. We
   don't support history, and turning GC off makes documents grow without bound.
2. **Awareness state leaks.** If a socket's awareness clientIDs aren't removed on
   disconnect, ghost cursors accumulate forever. `server.js` tracks them per
   connection — preserve that.
3. **Client-side read-only is not read-only.** Anyone can open devtools.
4. **`lib0` import paths changed across versions.** If `lib0/encoding` doesn't
   resolve, read the installed package's `exports` map rather than guessing at
   `lib0/dist/encoding.cjs`.
5. **Rebuilding `EditorState` detaches the Yjs binding.** Always reconfigure
   through a `Compartment`.
6. **Two-client testing hides relay bugs.** Always verify with four.
7. **Broadcasting an update back to its own sender is fine.** Yjs is idempotent.
   Don't add filtering that risks dropping legitimate updates.

---

## Verification standard

The failure mode here is code that looks complete and is subtly broken — sync
that works with two clients but not three, saves that never fire, read-only that
isn't. No phase is done on inspection. Every acceptance criterion gets
demonstrated with output you observed, and anything unverified gets reported as
unverified rather than assumed working.
