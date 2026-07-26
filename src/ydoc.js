import * as Y from 'yjs'
import { Awareness } from 'y-protocols/awareness'
import { IndexeddbPersistence } from 'y-indexeddb'

/** @param {string} roomId */
export function createRoomDoc (roomId) {
  const doc = new Y.Doc() // gc stays ON (default) — never pass { gc: false }
  const ytext = doc.getText('codemirror')
  const meta = doc.getMap('meta')
  const awareness = new Awareness(doc)
  const persistence = new IndexeddbPersistence(`collab-code-editor:${roomId}`, doc)

  return { doc, ytext, meta, awareness, persistence }
}
