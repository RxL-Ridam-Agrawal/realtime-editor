// Room creation TTL options — shared so the server can validate an incoming
// choice and the client can render the same picker and compute display text
// from the same source of truth.
export const TTL_OPTIONS = [
  { id: '1h', label: '1 hour', ms: 60 * 60 * 1000 },
  { id: '24h', label: '24 hours', ms: 24 * 60 * 60 * 1000 },
  { id: '7d', label: '7 days', ms: 7 * 24 * 60 * 60 * 1000 },
  { id: '30d', label: '30 days', ms: 30 * 24 * 60 * 60 * 1000 },
  { id: 'never', label: 'Never', ms: null }
]

export const DEFAULT_TTL_ID = '7d'

/** @returns {number|null} */
export function resolveTtlMs (ttlId) {
  const option = TTL_OPTIONS.find((o) => o.id === ttlId)
  return option ? option.ms : TTL_OPTIONS.find((o) => o.id === DEFAULT_TTL_ID).ms
}
