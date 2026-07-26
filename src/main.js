import './style.css'
import { createEditor } from './editor.js'
import { createRoomDoc } from './ydoc.js'
import { SocketProvider } from './socket-provider.js'
import { createPresenceList } from './presence.js'
import { getIdentity } from './identity.js'
import { PRIMARY_LANGUAGES, LEGACY_LANGUAGES } from './languages.js'
import { SERVER_PORT } from '../shared/config.js'
import { TTL_OPTIONS, DEFAULT_TTL_ID } from '../shared/ttl.js'
import { formatCountdown, formatExpiredDate } from './countdown.js'

const DEFAULT_LANGUAGE = 'javascript'
const DEFAULT_THEME = 'dark'
const COUNTDOWN_POLL_MS = 10_000
const API_BASE = `http://${location.hostname}:${SERVER_PORT}`

const root = document.documentElement
const landingView = document.getElementById('landing')
const notFoundView = document.getElementById('not-found-view')
const expiredView = document.getElementById('expired-view')
const expiredViewDate = document.getElementById('expired-view-date')
const appView = document.getElementById('app')
const ttlSelect = document.getElementById('ttl-select')
const createRoomButton = document.getElementById('create-room-button')
const languageSelect = document.getElementById('language-select')
const themeToggle = document.getElementById('theme-toggle')
const editorHost = document.getElementById('editor-host')
const roomIdButton = document.getElementById('room-id')
const viewLinkButton = document.getElementById('view-link')
const readonlyBadge = document.getElementById('readonly-badge')
const presenceListEl = document.getElementById('presence-list')
const countdownEl = document.getElementById('countdown')
const keepAliveButton = document.getElementById('keep-alive-button')
const expiredBanner = document.getElementById('expired-banner')
const copyAllButton = document.getElementById('copy-all-button')
const downloadButton = document.getElementById('download-button')

function showOnly (view) {
  for (const el of [landingView, notFoundView, expiredView, appView]) el.hidden = el !== view
}

function populateLanguageSelect () {
  const languagesGroup = document.createElement('optgroup')
  languagesGroup.label = 'Languages'
  for (const lang of PRIMARY_LANGUAGES) {
    const option = document.createElement('option')
    option.value = lang.id
    option.textContent = lang.name
    languagesGroup.appendChild(option)
  }
  languageSelect.appendChild(languagesGroup)

  const moreGroup = document.createElement('optgroup')
  moreGroup.label = 'More languages'
  for (const lang of LEGACY_LANGUAGES) {
    const option = document.createElement('option')
    option.value = lang.id
    option.textContent = lang.name
    moreGroup.appendChild(option)
  }
  languageSelect.appendChild(moreGroup)
}

function populateTtlSelect () {
  for (const option of TTL_OPTIONS) {
    const el = document.createElement('option')
    el.value = option.id
    el.textContent = option.label
    ttlSelect.appendChild(el)
  }
  ttlSelect.value = DEFAULT_TTL_ID
}

function applyTheme (mode) {
  root.setAttribute('data-theme', mode)
  themeToggle.textContent = mode === 'dark' ? 'Dark' : 'Light'
  themeToggle.dataset.theme = mode
}

function parseRoute () {
  const match = /^\/r\/([^/]+)(\/view)?\/?$/.exec(location.pathname)
  if (!match) return null
  return { roomId: match[1], readOnly: Boolean(match[2]) }
}

async function createRoomAndNavigate () {
  const response = await fetch(`${API_BASE}/api/rooms`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ttl: ttlSelect.value })
  })
  if (!response.ok) throw new Error(`server said ${response.status}`)
  const { roomId } = await response.json()
  location.href = `/r/${roomId}`
}

function copyToClipboard (button, getText) {
  button.addEventListener('click', async () => {
    await navigator.clipboard.writeText(getText())
    const original = button.textContent
    button.textContent = 'Copied'
    setTimeout(() => { button.textContent = original }, 1200)
  })
}

function wireRoomLinks (roomId, readOnly) {
  roomIdButton.textContent = roomId
  copyToClipboard(roomIdButton, () => location.href)

  if (!readOnly) {
    viewLinkButton.hidden = false
    copyToClipboard(viewLinkButton, () => `${location.origin}/r/${roomId}/view`)
  } else {
    readonlyBadge.hidden = false
  }
}

/** Polls room state to drive the countdown and to catch expiry even if the
 * WebSocket close race is somehow missed. */
function startCountdown (roomId, onExpiredDetected) {
  let stopped = false

  async function tick () {
    if (stopped) return
    try {
      const res = await fetch(`${API_BASE}/api/rooms/${roomId}`)
      const data = await res.json()
      if (data.state === 'expired' || data.state === 'not-found') {
        // not-found here means the row itself is gone (e.g. the 30-day
        // tombstone hard-delete) — from this open session's point of view
        // that's the same as expiry: the room is gone, stop treating it as
        // live.
        onExpiredDetected(data.expiredAt)
        return // stop polling — the room is gone
      }
      if (data.state === 'active') {
        keepAliveButton.hidden = data.ttlMs === null
        const { text, urgent } = formatCountdown({ updatedAt: data.updatedAt, ttlMs: data.ttlMs })
        countdownEl.textContent = text
        countdownEl.classList.toggle('urgent', urgent)
      }
    } catch {
      // A transient network hiccup here isn't worth surfacing — the next
      // tick will retry.
    }
    if (!stopped) setTimeout(tick, COUNTDOWN_POLL_MS)
  }

  tick()
  return () => { stopped = true }
}

function downloadTextFile (filename, text) {
  const blob = new Blob([text], { type: 'text/plain' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}

async function main () {
  populateLanguageSelect()
  populateTtlSelect()
  applyTheme(DEFAULT_THEME)

  const route = parseRoute()

  if (!route) {
    showOnly(landingView)
    createRoomButton.addEventListener('click', async () => {
      createRoomButton.disabled = true
      try {
        await createRoomAndNavigate()
      } catch (err) {
        createRoomButton.disabled = false
        alert(`Couldn't create a room. Make sure the server is running (npm run server). (${err.message})`)
      }
    })
    return
  }

  const { roomId, readOnly } = route

  let state
  try {
    state = await (await fetch(`${API_BASE}/api/rooms/${roomId}`)).json()
  } catch (err) {
    showOnly(notFoundView)
    notFoundView.querySelector('p').textContent =
      `Couldn't reach the room server. Make sure it's running (npm run server), then reload. (${err.message})`
    return
  }

  if (state.state === 'not-found') {
    showOnly(notFoundView)
    return
  }
  if (state.state === 'expired') {
    showOnly(expiredView)
    expiredViewDate.textContent = `It expired on ${formatExpiredDate(state.expiredAt)}.`
    return
  }

  showOnly(appView)
  wireRoomLinks(roomId, readOnly)

  const identity = getIdentity()
  const { doc, ytext, meta, awareness, persistence } = createRoomDoc(roomId)

  awareness.setLocalStateField('user', { name: identity.name, color: identity.color })

  // Wait for whatever was cached locally before creating the editor, so
  // typing never flashes empty then jumps to restored content. The network
  // provider (below) still merges in the room's live state once connected.
  await persistence.whenSynced

  // A viewer must never attempt this write — the server drops it anyway
  // (see server.js's read-only gate), but attempting it would leave this
  // client's local doc believing the write succeeded when the server never
  // applied it, silently diverging the two.
  if (!readOnly && !meta.get('language')) meta.set('language', DEFAULT_LANGUAGE)

  const editor = createEditor({ parent: editorHost, ytext, awareness, theme: DEFAULT_THEME, readOnly })

  // Both the socket's own onExpired and the countdown poll can independently
  // detect expiry — guard so cleanup (especially persistence.clearData(),
  // which destroys the IndexedDB persistence instance) only runs once.
  let expiredHandled = false
  function handleExpiry (expiredAt) {
    if (expiredHandled) return
    expiredHandled = true
    stopCountdown()
    editor.setReadOnly(true)
    languageSelect.disabled = true
    keepAliveButton.hidden = true
    countdownEl.textContent = expiredAt ? `Expired ${formatExpiredDate(expiredAt)}` : 'Expired'
    expiredBanner.hidden = false
    persistence.clearData() // don't let the stale local copy resurrect on refresh
  }

  const wsUrl = `ws://${location.hostname}:${SERVER_PORT}/r/${roomId}${readOnly ? '/view' : ''}`
  const provider = new SocketProvider(wsUrl, doc, awareness, { onExpired: () => handleExpiry() })

  const stopCountdown = startCountdown(roomId, handleExpiry)

  copyAllButton.addEventListener('click', () => navigator.clipboard.writeText(ytext.toString()))
  downloadButton.addEventListener('click', () => downloadTextFile(`${roomId}.txt`, ytext.toString()))

  if (!readOnly) {
    keepAliveButton.addEventListener('click', async () => {
      try {
        await fetch(`${API_BASE}/api/rooms/${roomId}/keep-alive`, { method: 'POST' })
      } catch {
        // best-effort — the next countdown poll will just show reality
      }
    })
  }

  createPresenceList(presenceListEl, awareness, doc.clientID)

  // `language` lives in the Yjs doc, not local state, so it syncs to
  // everyone in the room for free — the select and the editor both just
  // react to this one observer.
  meta.observe((event) => {
    if (!event.keysChanged.has('language')) return
    const lang = meta.get('language')
    languageSelect.value = lang
    editor.setLanguage(lang)
  })

  languageSelect.value = meta.get('language')
  editor.setLanguage(meta.get('language'))

  // The server would drop a viewer's language change anyway (same
  // read-only gate as document edits — meta.set is just another Yjs doc
  // mutation), but disabling the control avoids a confusing no-op click.
  languageSelect.disabled = readOnly

  languageSelect.addEventListener('change', () => {
    meta.set('language', languageSelect.value)
  })

  themeToggle.addEventListener('click', () => {
    const next = themeToggle.dataset.theme === 'dark' ? 'light' : 'dark'
    applyTheme(next)
    editor.setTheme(next)
  })

  window.addEventListener('beforeunload', () => provider.destroy())
}

main()
