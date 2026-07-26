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

/**
 * Returns the room ID from the URL, or creates a new room and navigates to
 * it. The navigation case returns a promise that never resolves, so the
 * caller never builds an editor for a page that's about to be replaced.
 */
async function ensureRoomId () {
  const match = /^\/r\/([^/]+)/.exec(location.pathname)
  if (match) return match[1]

  const response = await fetch(`http://${location.hostname}:${SERVER_PORT}/api/rooms`, { method: 'POST' })
  if (!response.ok) throw new Error(`Could not create a room (server said ${response.status}).`)
  const { roomId } = await response.json()
  location.href = `/r/${roomId}`
  return new Promise(() => {})
}

function wireRoomIdButton (roomId) {
  roomIdButton.textContent = roomId
  roomIdButton.addEventListener('click', async () => {
    await navigator.clipboard.writeText(location.href)
    roomIdButton.textContent = 'Copied'
    setTimeout(() => { roomIdButton.textContent = roomId }, 1200)
  })
}

async function main () {
  populateLanguageSelect()
  applyTheme(DEFAULT_THEME)

  let roomId
  try {
    roomId = await ensureRoomId()
  } catch (err) {
    showFatalError(`Couldn't reach the room server. Make sure it's running (npm run server), then reload. (${err.message})`)
    return
  }

  wireRoomIdButton(roomId)

  const identity = getIdentity()
  const { doc, ytext, meta, awareness, persistence } = createRoomDoc(roomId)

  awareness.setLocalStateField('user', { name: identity.name, color: identity.color })

  // Wait for whatever was cached locally before creating the editor, so
  // typing never flashes empty then jumps to restored content. The network
  // provider (below) still merges in the room's live state once connected.
  await persistence.whenSynced

  if (!meta.get('language')) meta.set('language', DEFAULT_LANGUAGE)

  const wsUrl = `ws://${location.hostname}:${SERVER_PORT}/r/${roomId}`
  const provider = new SocketProvider(wsUrl, doc, awareness)

  const editor = createEditor({ parent: editorHost, ytext, awareness, theme: DEFAULT_THEME })

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
