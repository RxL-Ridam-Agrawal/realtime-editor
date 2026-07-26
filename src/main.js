import './style.css'
import { createEditor } from './editor.js'
import { createRoomDoc } from './ydoc.js'
import { SocketProvider } from './socket-provider.js'
import { createPresenceList } from './presence.js'
import { getIdentity } from './identity.js'
import { PRIMARY_LANGUAGES, LEGACY_LANGUAGES } from './languages.js'
import { SERVER_PORT } from '../shared/config.js'

const DEFAULT_LANGUAGE = 'javascript'
const DEFAULT_THEME = 'dark'

const root = document.documentElement
const languageSelect = document.getElementById('language-select')
const themeToggle = document.getElementById('theme-toggle')
const editorHost = document.getElementById('editor-host')
const roomIdButton = document.getElementById('room-id')
const viewLinkButton = document.getElementById('view-link')
const readonlyBadge = document.getElementById('readonly-badge')
const presenceListEl = document.getElementById('presence-list')

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

function applyTheme (mode) {
  root.setAttribute('data-theme', mode)
  themeToggle.textContent = mode === 'dark' ? 'Dark' : 'Light'
  themeToggle.dataset.theme = mode
}

function showFatalError (message) {
  editorHost.textContent = message
}

function parseRoute () {
  const match = /^\/r\/([^/]+)(\/view)?\/?$/.exec(location.pathname)
  if (!match) return null
  return { roomId: match[1], readOnly: Boolean(match[2]) }
}

/**
 * Returns { roomId, readOnly } from the URL, or creates a new room and
 * navigates to its editor URL. The navigation case returns a promise that
 * never resolves, so the caller never builds an editor for a page that's
 * about to be replaced.
 */
async function ensureRoute () {
  const route = parseRoute()
  if (route) return route

  const response = await fetch(`http://${location.hostname}:${SERVER_PORT}/api/rooms`, { method: 'POST' })
  if (!response.ok) throw new Error(`Could not create a room (server said ${response.status}).`)
  const { roomId } = await response.json()
  location.href = `/r/${roomId}`
  return new Promise(() => {})
}

function copyToClipboard (button, text) {
  button.addEventListener('click', async () => {
    await navigator.clipboard.writeText(text)
    const original = button.textContent
    button.textContent = 'Copied'
    setTimeout(() => { button.textContent = original }, 1200)
  })
}

function wireRoomLinks (roomId, readOnly) {
  roomIdButton.textContent = roomId
  copyToClipboard(roomIdButton, location.href)

  if (!readOnly) {
    viewLinkButton.hidden = false
    const viewUrl = `${location.origin}/r/${roomId}/view`
    copyToClipboard(viewLinkButton, viewUrl)
  } else {
    readonlyBadge.hidden = false
  }
}

async function main () {
  populateLanguageSelect()
  applyTheme(DEFAULT_THEME)

  let roomId, readOnly
  try {
    ({ roomId, readOnly } = await ensureRoute())
  } catch (err) {
    showFatalError(`Couldn't reach the room server. Make sure it's running (npm run server), then reload. (${err.message})`)
    return
  }

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

  const wsUrl = `ws://${location.hostname}:${SERVER_PORT}/r/${roomId}${readOnly ? '/view' : ''}`
  const provider = new SocketProvider(wsUrl, doc, awareness)

  const editor = createEditor({ parent: editorHost, ytext, awareness, theme: DEFAULT_THEME, readOnly })

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
