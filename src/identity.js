import { nanoid } from 'nanoid'
import { CURSOR_PALETTE } from './colors.js'

const STORAGE_KEY = 'collab-code-editor:identity'

const ADJECTIVES = [
  'quiet', 'clever', 'brisk', 'amber', 'gentle', 'swift', 'calm', 'bold',
  'wry', 'lucid', 'plain', 'keen', 'mellow', 'tidy', 'sly', 'stark',
  'nimble', 'faint', 'sturdy', 'vivid', 'dry', 'blunt', 'sharp', 'soft'
]

const ANIMALS = [
  'otter', 'fox', 'heron', 'lynx', 'moth', 'crow', 'hare', 'wren',
  'badger', 'seal', 'newt', 'stoat', 'finch', 'gull', 'vole', 'toad',
  'raven', 'shrew', 'ibis', 'marten', 'grouse', 'ferret', 'plover', 'mink'
]

function randomFrom (list) {
  return list[Math.floor(Math.random() * list.length)]
}

function generateIdentity () {
  return {
    id: nanoid(),
    name: `${randomFrom(ADJECTIVES)}-${randomFrom(ANIMALS)}`,
    color: randomFrom(CURSOR_PALETTE)
  }
}

/** Stable per-browser identity: generated once on first visit, then reused. */
export function getIdentity () {
  const stored = localStorage.getItem(STORAGE_KEY)
  if (stored) {
    try {
      return JSON.parse(stored)
    } catch {
      // Corrupted value — fall through and regenerate.
    }
  }
  const identity = generateIdentity()
  localStorage.setItem(STORAGE_KEY, JSON.stringify(identity))
  return identity
}
