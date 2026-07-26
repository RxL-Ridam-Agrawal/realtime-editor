import { EditorView } from '@codemirror/view'
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language'
import { tags as t } from '@lezer/highlight'

// Chrome palette — from SPEC-learning.md's "Design direction" table.
// #E0A34E (the one accent) is reserved for sync/save state and must never
// appear here; none of these colors are it.
export const palette = {
  dark: { canvas: '#14161A', surface: '#1E2127', border: '#2A2E36', text: '#D8DBE0', muted: '#7C838F' },
  light: { canvas: '#F7F7F5', surface: '#FFFFFF', border: '#E3E3DF', text: '#1A1C20', muted: '#6B7280' }
}

// Syntax colors are not specified by SPEC (only chrome colors and the
// reserved accent are) — chosen here to stay legible against the dark/light
// surface above without going near the reserved amber's hue.
const syntaxColors = {
  dark: { comment: '#7C838F', keyword: '#7DA6D9', string: '#8FBF9A', name: '#B39DDB', type: '#6FC2CE', number: '#E08A8A', invalid: '#FF6B6B' },
  light: { comment: '#8A8F98', keyword: '#3B6FA6', string: '#3E8F5C', name: '#7551B3', type: '#1F8FA0', number: '#B4453F', invalid: '#D1453D' }
}

function buildEditorTheme (mode) {
  const c = palette[mode]
  return EditorView.theme({
    '&': { color: c.text, backgroundColor: c.surface, height: '100%' },
    '.cm-content': { caretColor: c.text, fontFamily: "'IBM Plex Mono', monospace", fontSize: '13px' },
    '.cm-gutters': { backgroundColor: c.surface, color: c.muted, border: 'none', borderRight: `1px solid ${c.border}` },
    '.cm-activeLine': { backgroundColor: mode === 'dark' ? 'rgba(255,255,255,0.04)' : 'rgba(0,0,0,0.03)' },
    '.cm-activeLineGutter': { backgroundColor: mode === 'dark' ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.05)' },
    '.cm-cursor': { borderLeftColor: c.text },
    '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection': {
      backgroundColor: mode === 'dark' ? 'rgba(124,131,143,0.35)' : 'rgba(124,131,143,0.25)'
    }
  }, { dark: mode === 'dark' })
}

function buildHighlightStyle (mode) {
  const c = syntaxColors[mode]
  return HighlightStyle.define([
    { tag: [t.comment, t.lineComment, t.blockComment], color: c.comment, fontStyle: 'italic' },
    { tag: [t.keyword, t.controlKeyword, t.moduleKeyword, t.operator], color: c.keyword },
    { tag: [t.string, t.special(t.string)], color: c.string },
    { tag: [t.number, t.bool, t.atom], color: c.number },
    { tag: [t.function(t.variableName), t.function(t.definition(t.variableName)), t.propertyName], color: c.name },
    { tag: [t.typeName, t.className], color: c.type },
    { tag: t.invalid, color: c.invalid, fontWeight: 'bold' }
  ])
}

const themes = {
  dark: [buildEditorTheme('dark'), syntaxHighlighting(buildHighlightStyle('dark'))],
  light: [buildEditorTheme('light'), syntaxHighlighting(buildHighlightStyle('light'))]
}

export function getTheme (mode) {
  return themes[mode]
}
