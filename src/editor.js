import { EditorState, Compartment } from '@codemirror/state'
import {
  EditorView,
  keymap,
  lineNumbers,
  highlightActiveLineGutter,
  highlightSpecialChars,
  drawSelection,
  dropCursor,
  rectangularSelection,
  crosshairCursor,
  highlightActiveLine
} from '@codemirror/view'
import {
  foldGutter,
  indentOnInput,
  syntaxHighlighting,
  defaultHighlightStyle,
  bracketMatching,
  foldKeymap
} from '@codemirror/language'
import { defaultKeymap, indentWithTab } from '@codemirror/commands'
import { highlightSelectionMatches, searchKeymap } from '@codemirror/search'
import { closeBrackets, autocompletion, closeBracketsKeymap, completionKeymap } from '@codemirror/autocomplete'
import { lintKeymap } from '@codemirror/lint'
import { yCollab, yUndoManagerKeymap } from 'y-codemirror.next'
import { findLanguage } from './languages.js'
import { getTheme } from './theme.js'

// Everything the `codemirror` package's basicSetup bundles, EXCEPT
// history()/historyKeymap. Those must not coexist with yCollab: it installs
// its own Y.UndoManager, and Mod-z hitting CM6's local history first (or
// both firing) would track edits in two independent undo stacks and corrupt
// undo/redo. yUndoManagerKeymap below replaces historyKeymap.
const baseExtensions = [
  lineNumbers(),
  highlightActiveLineGutter(),
  highlightSpecialChars(),
  foldGutter(),
  drawSelection(),
  dropCursor(),
  EditorState.allowMultipleSelections.of(true),
  indentOnInput(),
  syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
  bracketMatching(),
  closeBrackets(),
  autocompletion(),
  rectangularSelection(),
  crosshairCursor(),
  highlightActiveLine(),
  highlightSelectionMatches(),
  keymap.of([
    ...closeBracketsKeymap,
    ...defaultKeymap,
    ...searchKeymap,
    ...foldKeymap,
    ...completionKeymap,
    ...lintKeymap
  ])
]

/**
 * @param {{ parent: HTMLElement, ytext: import('yjs').Text, awareness: any, theme?: 'dark'|'light', readOnly?: boolean }} opts
 */
export function createEditor ({ parent, ytext, awareness, theme = 'dark', readOnly = false }) {
  const languageCompartment = new Compartment()
  const themeCompartment = new Compartment()

  // Fixed for the whole session (tied to which URL — /r/:id vs
  // /r/:id/view — the person opened), so a plain conditional extension is
  // enough; no Compartment needed. This is a UX affordance only — the real
  // enforcement is server-side (see server.js's read-only gate), since
  // anyone can open devtools and ignore this.
  const readOnlyExtensions = readOnly ? [EditorState.readOnly.of(true), EditorView.editable.of(false)] : []

  const state = EditorState.create({
    doc: ytext.toString(),
    extensions: [
      baseExtensions,
      keymap.of([...yUndoManagerKeymap, indentWithTab]),
      yCollab(ytext, awareness),
      languageCompartment.of([]),
      themeCompartment.of(getTheme(theme)),
      readOnlyExtensions
    ]
  })

  const view = new EditorView({ state, parent })

  return {
    view,
    // Reconfiguring through the compartment (rather than rebuilding
    // EditorState) is what keeps undo history intact across a language or
    // theme switch — see SPEC-learning.md's "known hazards" #5.
    async setLanguage (id) {
      const lang = findLanguage(id)
      const extension = lang ? await lang.load() : []
      view.dispatch({ effects: languageCompartment.reconfigure(extension) })
    },
    setTheme (mode) {
      view.dispatch({ effects: themeCompartment.reconfigure(getTheme(mode)) })
    }
  }
}
