// The estimated minute of a live football match, from the half start times the
// server records (details.clock). A copy of matchMinute in
// src/live/football-clock.js, which explains the estimate; keep the two in step.

const MINUTE_MS = 60_000
const SECOND_HALF_AFTER_MS = 62 * MINUTE_MS
const MAX_STOPPAGE = 15

// { label, minute, period } or null. label: "23'", "45+2'", "HT", "67'", "90+3'", "ET"
export function matchMinute(details, now = Date.now()) {
  const kickoff = Date.parse(details?.clock?.kickoffAt ?? '')
  if (!Number.isFinite(kickoff)) return null

  if (details.phase === 'PAUSED') return { label: 'HT', minute: 45, period: 'HT' }
  if (details.phase !== 'IN_PLAY') return null

  const since = (from) => Math.max(1, Math.floor((now - from) / MINUTE_MS) + 1)

  const seenSecondHalf = Date.parse(details.clock.secondHalfAt ?? '')
  const secondHalf = Number.isFinite(seenSecondHalf)
    ? seenSecondHalf
    : now - kickoff > SECOND_HALF_AFTER_MS
      ? kickoff + SECOND_HALF_AFTER_MS
      : null

  if (secondHalf == null) {
    const minute = since(kickoff)
    return { label: minute <= 45 ? `${minute}'` : `45+${minute - 45}'`, minute, period: '1H' }
  }

  const minute = 45 + since(secondHalf)
  if (minute <= 90) return { label: `${minute}'`, minute, period: '2H' }
  if (minute <= 90 + MAX_STOPPAGE) return { label: `90+${minute - 90}'`, minute, period: '2H' }
  return { label: 'ET', minute, period: 'ET' }
}
