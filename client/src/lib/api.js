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
