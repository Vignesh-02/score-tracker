import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { RefreshCw } from 'lucide-react'
import { Header } from './components/Header.jsx'
import { Filters } from './components/Filters.jsx'
import { MatchGrid, MatchGridSkeleton } from './components/MatchGrid.jsx'
import { fetchMatches, matchesQueryKey } from './lib/api.js'
import { ALL, filterMatches, filterOptions } from './lib/matches.js'
import { useFilters } from './lib/useFilters.js'
import { useSocketMessages } from './live/hooks.js'
import { useLiveMatchUpdates } from './live/useLiveMatchUpdates.js'

const timeFormat = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' })

// Temporary: shows raw broadcasts so the connection can be checked end to end.
// The commentary panel replaces this in step 4.
function SocketLog() {
  const [events, setEvents] = useState([])

  useSocketMessages((message) => {
    setEvents((list) => [{ at: new Date(), message }, ...list].slice(0, 20))
  })

  return (
    <aside className="rounded-2xl border-[3px] border-ink bg-card shadow-brutal">
      <div className="rounded-t-[13px] border-b-[3px] border-ink bg-sky px-5 py-4 text-on-accent">
        <h2 className="text-xl font-bold">Socket events</h2>
      </div>
      <ul className="max-h-[28rem] space-y-2 overflow-y-auto p-4">
        {events.length === 0 && <li className="text-muted">Waiting for messages…</li>}
        {events.map(({ at, message }, i) => (
          <li key={i} className="rounded-lg border border-line p-2 text-sm">
            <span className="font-mono text-xs text-muted">{timeFormat.format(at)}</span>{' '}
            <span className="font-bold">{message.type}</span>
            {message.data?.homeTeam && (
              <span className="text-muted">
                {' '}· {message.data.homeTeam} {message.data.homeScore}–{message.data.awayScore} {message.data.awayTeam}
              </span>
            )}
          </li>
        ))}
      </ul>
    </aside>
  )
}

function Matches() {
  const { data: matches, isPending, error, refetch, isRefetching } = useQuery({
    queryKey: matchesQueryKey,
    queryFn: () => fetchMatches(),
  })
  const [filters, setFilters] = useFilters()

  if (isPending) return <MatchGridSkeleton />

  if (error) {
    return (
      <div className="rounded-2xl border-[3px] border-ink bg-card p-6 shadow-brutal">
        <p className="font-bold text-live">Couldn't load matches</p>
        <p className="mt-1 text-muted">{error.message}</p>
        <button
          type="button"
          onClick={() => refetch()}
          disabled={isRefetching}
          className="mt-4 flex items-center gap-2 rounded-full border-2 border-ink bg-sun px-4 py-2 font-bold text-on-accent shadow-brutal-sm disabled:opacity-60"
        >
          <RefreshCw className={`size-4 ${isRefetching ? 'animate-spin' : ''}`} aria-hidden />
          Try again
        </button>
      </div>
    )
  }

  const filtered = filterMatches(matches, filters)
  const isFiltered = filters.sport !== ALL || filters.competition !== ALL

  return (
    <div className="space-y-8">
      <Filters
        options={filterOptions(matches, filters.sport)}
        filters={filters}
        total={matches.length}
        onChange={setFilters}
      />

      {filtered.length > 0 ? (
        <MatchGrid matches={filtered} />
      ) : (
        <div className="rounded-2xl border-[3px] border-dashed border-ink p-10 text-center">
          <p className="text-lg font-bold">{isFiltered ? 'No matches for these filters' : 'No matches yet'}</p>
          <p className="mt-1 text-muted">
            {isFiltered
              ? 'Try another sport or competition.'
              : 'New matches appear here automatically as soon as they are added.'}
          </p>
          {isFiltered && (
            <button
              type="button"
              onClick={() => setFilters({ sport: ALL, competition: ALL })}
              className="mt-4 rounded-full border-2 border-ink bg-card px-4 py-2 font-bold shadow-brutal-sm"
            >
              Clear filters
            </button>
          )}
        </div>
      )}
    </div>
  )
}

function MatchCount() {
  const { data: matches } = useQuery({ queryKey: matchesQueryKey, queryFn: () => fetchMatches() })
  if (!matches) return null

  return (
    <span className="rounded-md bg-ink px-2.5 py-1 font-mono text-sm font-bold text-page">API: {matches.length}</span>
  )
}

export default function App() {
  useLiveMatchUpdates()

  return (
    <div className="mx-auto max-w-7xl space-y-8 px-4 py-6 sm:px-6 sm:py-8">
      <Header />

      <div className="grid gap-8 lg:grid-cols-[1fr_22rem] lg:items-start">
        <section aria-labelledby="matches-heading" className="min-w-0">
          <div className="mb-5 flex items-center justify-between gap-3">
            <h2 id="matches-heading" className="border-l-4 border-sky pl-3 text-2xl font-bold">
              Current Matches
            </h2>
            <MatchCount />
          </div>
          <Matches />
        </section>

        <div className="lg:sticky lg:top-6">
          <SocketLog />
        </div>
      </div>
    </div>
  )
}
