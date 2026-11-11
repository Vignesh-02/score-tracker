// Pure helpers for match lists: grouping, sorting, filtering, and applying
// WebSocket updates to the cached list. No React here, so they're easy to test.

export const STATUS = { LIVE: 'live', SCHEDULED: 'scheduled', FINISHED: 'finished' }

// A scheduled match this long past kick-off is late or postponed, or its
// status hasn't been updated; it shouldn't look like it's about to start
const OVERDUE_AFTER_MS = 15 * 60 * 1000

const startOf = (match) => (match.startTime ? new Date(match.startTime).getTime() : null)

export function isOverdue(match, now) {
  const start = startOf(match)
  return match.status === STATUS.SCHEDULED && start != null && start < now - OVERDUE_AFTER_MS
}

const byStartAsc = (a, b) => (startOf(a) ?? Infinity) - (startOf(b) ?? Infinity)
const byStartDesc = (a, b) => (startOf(b) ?? -Infinity) - (startOf(a) ?? -Infinity)

// Live: earliest kick-off first. Upcoming: soonest first, overdue ones last.
// Finished: most recent first.
export function groupMatches(list, now) {
  const live = []
  const upcoming = []
  const overdue = []
  const finished = []

  for (const match of list) {
    if (match.status === STATUS.LIVE) live.push(match)
    else if (match.status === STATUS.FINISHED) finished.push(match)
    else if (isOverdue(match, now)) overdue.push(match)
    else upcoming.push(match)
  }

  return {
    live: live.sort(byStartAsc),
    upcoming: [...upcoming.sort(byStartAsc), ...overdue.sort(byStartDesc)],
    finished: finished.sort(byStartDesc),
  }
}

export const ALL = 'all'

// Sports are typed by hand for manual matches ("football" vs "Football"),
// so they're compared ignoring case
const sameText = (a, b) => a?.toLowerCase() === b?.toLowerCase()

export function filterMatches(list, { sport, competition }) {
  return list.filter(
    (match) =>
      (sport === ALL || sameText(match.sport, sport)) &&
      (competition === ALL || match.competition === competition),
  )
}

// Counts values ignoring case, labelled with the most common spelling
function countBy(list, key) {
  const groups = new Map()

  for (const match of list) {
    const value = match[key]
    if (!value) continue

    const group = groups.get(value.toLowerCase()) ?? { count: 0, spellings: new Map() }
    group.count++
    group.spellings.set(value, (group.spellings.get(value) ?? 0) + 1)
    groups.set(value.toLowerCase(), group)
  }

  return [...groups.values()]
    .map(({ count, spellings }) => ({
      value: [...spellings].sort((a, b) => b[1] - a[1])[0][0],
      count,
    }))
    .sort((a, b) => a.value.localeCompare(b.value))
}

// Sports across all matches; competitions within the selected sport
export function filterOptions(list, sport) {
  return {
    sports: countBy(list, 'sport'),
    competitions: countBy(sport === ALL ? list : list.filter((m) => sameText(m.sport, sport)), 'competition'),
  }
}

// ---------- applying WebSocket messages to the cached list ----------

// Adds the match, or replaces the cached copy, keeping any local UI fields
export function upsertMatch(list = [], match) {
  const index = list.findIndex((m) => m.id === match.id)
  if (index === -1) return [match, ...list]

  const next = [...list]
  next[index] = { ...list[index], ...match }
  return next
}

// Total wickets across all innings; 0 for sports without innings
const wicketsOf = (match) => (match?.details?.innings ?? []).reduce((sum, i) => sum + i.wickets, 0)

// Like upsertMatch, but also records which side scored (and, in cricket,
// whether a wicket fell) so the card can celebrate it. `_scored` is a local
// UI field; the server never sends it.
export function applyScoreUpdate(list = [], match, at) {
  const previous = list.find((m) => m.id === match.id)
  const home = previous ? match.homeScore - previous.homeScore : 0
  const away = previous ? match.awayScore - previous.awayScore : 0
  const wicket = previous ? wicketsOf(match) > wicketsOf(previous) : false

  let side = home > 0 && away > 0 ? 'both' : home > 0 ? 'home' : away > 0 ? 'away' : null
  // A wicket with no runs added: flash the batting side
  if (!side && wicket) side = match.details?.innings?.at(-1)?.side ?? 'both'

  return upsertMatch(list, { ...match, _scored: side ? { side, at, wicket } : null })
}

// Removes the celebration marker once its animation has played
export function clearScored(list = [], matchId, at) {
  return list.map((m) => (m.id === matchId && m._scored?.at === at ? { ...m, _scored: null } : m))
}
