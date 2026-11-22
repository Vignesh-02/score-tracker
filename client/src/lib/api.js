// REST calls to the Express API. In development Vite proxies these paths to
// localhost:8000; in production Express serves this app, so they're same-origin.

async function getJson(path) {
  const res = await fetch(path)
  const body = await res.json().catch(() => null)

  if (!res.ok) {
    throw new Error(body?.error ?? `Request failed with ${res.status}`)
  }

  return body
}

export async function fetchMatches({ limit = 200 } = {}) {
  const { data } = await getJson(`/matches?view=current&limit=${limit}`)
  return data
}

export const matchesQueryKey = ['matches']

// League and points tables: the competitions that have one, in season, each
// with its sport ('Football' or 'Cricket')
export async function fetchCompetitions() {
  const { data } = await getJson('/competitions')
  return data
}

// One competition's table(s), and football's top scorers
export async function fetchCompetition(code) {
  const { data } = await getJson(`/competitions/${encodeURIComponent(code)}`)
  return data
}

export const competitionsQueryKey = ['competitions']
export const competitionQueryKey = (code) => ['competitions', code]

// One match, its live updates feed (newest first) and its head-to-head
export async function fetchMatch(id) {
  const { data } = await getJson(`/matches/${id}`)
  return data
}

export async function fetchCommentary(id, { limit = 100 } = {}) {
  const { data } = await getJson(`/matches/${id}/commentary?limit=${limit}`)
  return data
}

export async function fetchHeadToHead(id) {
  const { data } = await getJson(`/matches/${id}/head2head`)
  return data
}

// Cricket batting and bowling card: { data, reason } (see src/routes/scorecard.js)
export async function fetchScorecard(id) {
  return getJson(`/matches/${id}/scorecard`)
}

export const matchQueryKey = (id) => ['match', id]
export const commentaryQueryKey = (id) => ['match', id, 'commentary']
export const headToHeadQueryKey = (id) => ['match', id, 'head2head']
// The status is part of the key, so the final scorecard loads when a match ends
export const scorecardQueryKey = (id, status) => ['match', id, 'scorecard', status]
