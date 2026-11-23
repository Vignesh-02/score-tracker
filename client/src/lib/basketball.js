// NBA games from BALLDONTLIE carry details = { period, clock, statusText,
// quarters: { home: [...], away: [...] } } (src/providers/balldontlie.js)

export const isBasketball = (match) => match.sport?.toLowerCase() === 'basketball'

// 1–4 the quarters, 5 the first overtime, 6 the second…
export const periodLabel = (period) => (period <= 4 ? `Q${period}` : period === 5 ? 'OT' : `${period - 4}OT`)

// The live status label: "Q3 4:12", "HT", "End Q1", "OT 1:05"
export function gameClock(details) {
  const { period, clock, statusText } = details ?? {}
  if (/half/i.test(statusText ?? '')) return 'HT'
  if (!period) return null
  return clock ? `${periodLabel(period)} ${clock}` : `End ${periodLabel(period)}`
}
