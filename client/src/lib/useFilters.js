import { useState } from 'react'
import { ALL } from './matches.js'

// Filters live in the URL (?sport=Football&competition=Premier%20League), so a
// filtered view survives a refresh and can be shared as a link
const KEYS = ['sport', 'competition']

function readFilters() {
  const params = new URLSearchParams(window.location.search)
  return Object.fromEntries(KEYS.map((key) => [key, params.get(key) ?? ALL]))
}

export function useFilters() {
  const [filters, setFilters] = useState(readFilters)

  function updateFilters(changes) {
    const next = { ...filters, ...changes }

    // A competition belongs to one sport, so changing sport resets it
    if ('sport' in changes && !('competition' in changes)) next.competition = ALL

    const params = new URLSearchParams(window.location.search)
    for (const key of KEYS) {
      if (next[key] === ALL) params.delete(key)
      else params.set(key, next[key])
    }
    const query = params.toString()
    window.history.replaceState(null, '', `${window.location.pathname}${query ? `?${query}` : ''}`)

    setFilters(next)
  }

  return [filters, updateFilters]
}
