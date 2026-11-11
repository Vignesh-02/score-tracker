import { useEffect, useState } from 'react'
import { ALL, TAB, TABS } from './matches.js'

// Filters live in the URL (?tab=results&sport=Football&competition=Premier%20League),
// so a view survives a refresh and can be shared as a link. Values equal to
// their default are left out of the URL.
const DEFAULTS = { tab: TAB.LIVE, sport: ALL, competition: ALL }

function readFilters() {
  const params = new URLSearchParams(window.location.search)
  const filters = Object.fromEntries(Object.entries(DEFAULTS).map(([key, value]) => [key, params.get(key) ?? value]))
  if (!TABS.includes(filters.tab)) filters.tab = DEFAULTS.tab
  return filters
}

export function useFilters() {
  const [filters, setFilters] = useState(readFilters)

  // Back and forward move between tabs
  useEffect(() => {
    const onPopState = () => setFilters(readFilters())
    window.addEventListener('popstate', onPopState)
    return () => window.removeEventListener('popstate', onPopState)
  }, [])

  function updateFilters(changes) {
    const next = { ...filters, ...changes }

    // A competition belongs to one sport, so changing sport resets it
    if ('sport' in changes && !('competition' in changes)) next.competition = ALL

    const params = new URLSearchParams(window.location.search)
    for (const [key, value] of Object.entries(DEFAULTS)) {
      if (next[key] === value) params.delete(key)
      else params.set(key, next[key])
    }
    const query = params.toString()
    const url = `${window.location.pathname}${query ? `?${query}` : ''}`

    // Switching tab is a step the back button should undo; changing a filter isn't
    if (next.tab !== filters.tab) window.history.pushState(null, '', url)
    else window.history.replaceState(null, '', url)

    setFilters(next)
  }

  return [filters, updateFilters]
}
