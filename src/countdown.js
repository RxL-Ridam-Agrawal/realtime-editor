const MINUTE = 60 * 1000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

/**
 * Phrased as consequence ("Deletes in 6 days"), not mechanism ("TTL
 * 604800s") — per SPEC-learning.md's UI section. `urgent` (under 1 hour
 * remaining) is the one case where the countdown may take the reserved
 * amber accent.
 * @param {{ updatedAt: number, ttlMs: number|null }} room
 * @returns {{ text: string, urgent: boolean }}
 */
export function formatCountdown ({ updatedAt, ttlMs }, now = Date.now()) {
  if (ttlMs === null) return { text: 'Never expires', urgent: false }

  const remaining = updatedAt + ttlMs - now
  if (remaining <= 0) return { text: 'Expired', urgent: true }

  const urgent = remaining < HOUR

  if (remaining >= DAY) {
    const days = Math.round(remaining / DAY)
    return { text: `Deletes in ${days} day${days === 1 ? '' : 's'}`, urgent }
  }
  if (remaining >= HOUR) {
    const hours = Math.round(remaining / HOUR)
    return { text: `Deletes in ${hours} hour${hours === 1 ? '' : 's'}`, urgent }
  }
  const minutes = Math.max(1, Math.round(remaining / MINUTE))
  return { text: `Deletes in ${minutes} minute${minutes === 1 ? '' : 's'}`, urgent }
}

export function formatExpiredDate (expiredAtMs) {
  return new Date(expiredAtMs).toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' })
}
