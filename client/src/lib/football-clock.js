// The estimated minute of a live football match, from the half start times the
// server records (details.clock). A copy of matchMinute in
// src/live/football-clock.js, which explains the estimate; keep the two in step.

const MINUTE_MS = 60_000
const FIRST_HALF_MS = 48 * MINUTE_MS
const SECOND_HALF_AFTER_MS = 62 * MINUTE_MS
const RESTART_FROM_MS = 58 * MINUTE_MS
const RESTART_UNTIL_MS = 80 * MINUTE_MS
const MAX_STOPPAGE = 15

// { label, minute, period } or null. label: "23'", "45+2'", "HT", "67'", "90+3'", "ET"
export function matchMinute(details, now = Date.now()) {
  const kickoff = Date.parse(details?.clock?.kickoffAt ?? '')
  if (!Number.isFinite(kickoff)) return null

  if (details.phase === 'PAUSED') return { label: 'HT', minute: 45, period: 'HT' }
  if (details.phase !== 'IN_PLAY') return null

  const since = (from) => Math.max(1, Math.floor((now - from) / MINUTE_MS) + 1)

  if (now - kickoff < FIRST_HALF_MS) {
    const minute = since(kickoff)
    return { label: minute <= 45 ? `${minute}'` : `45+${minute - 45}'`, minute, period: '1H' }
  }

  // A reported restart only counts 58-80 minutes after kick-off
  const seen = Date.parse(details.clock.secondHalfAt ?? '')
  const plausible = Number.isFinite(seen) && seen - kickoff >= RESTART_FROM_MS && seen - kickoff <= RESTART_UNTIL_MS
  const secondHalf = plausible ? seen : kickoff + SECOND_HALF_AFTER_MS

  if (now < secondHalf) return { label: 'HT', minute: 45, period: 'HT' }

  const minute = 45 + since(secondHalf)
  if (minute <= 90) return { label: `${minute}'`, minute, period: '2H' }
  if (minute <= 90 + MAX_STOPPAGE) return { label: `90+${minute - 90}'`, minute, period: '2H' }
  return { label: 'ET', minute, period: 'ET' }
}
