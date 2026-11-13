import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { RefreshCw } from 'lucide-react'
import { Header } from './components/Header.jsx'
import { Filters } from './components/Filters.jsx'
import { MatchGrid, MatchGridSkeleton } from './components/MatchGrid.jsx'
import { Tabs } from './components/Tabs.jsx'
import { tabId, tabPanelId } from './lib/tabs.js'
import { fetchMatches, matchesQueryKey } from './lib/api.js'
import { ALL, STATUS, TAB, TABS, filterMatches, filterOptions, groupMatches, isOverdue, matchesForTab } from './lib/matches.js'
import { formatCountdown, formatKickoff } from './lib/format.js'
import { useNow } from './lib/useNow.js'
import { useFilters } from './lib/useFilters.js'
import { useMatchSubscriptions, useSocketMessages } from './live/hooks.js'
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
    <aside className="overflow-hidden rounded-lg border border-line bg-panel">
      <div className="h-1 bg-cyan" aria-hidden />
      <div className="border-b border-line px-4 py-3">
        <h2 className="text-base font-bold tracking-[0.2em] text-cyan uppercase">Socket events</h2>
      </div>
      <ul className="max-h-[28rem] space-y-2 overflow-y-auto p-4">
        {events.length === 0 && <li className="text-muted">Waiting for messages…</li>}
        {events.map(({ at, message }, i) => (
          <li key={i} className="rounded-md border border-line bg-board p-2 text-sm">
            <span className="font-mono text-xs text-muted">{timeFormat.format(at)}</span>{' '}
            <span className="font-bold tracking-wide text-amber uppercase">{message.type}</span>
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

function EmptyPanel({ title, children }) {
  return (
    <div className="rounded-lg border border-dashed border-line p-10 text-center">
      <p className="text-xl font-bold tracking-[0.15em] uppercase">{title}</p>
      {children}
    </div>
  )
}

const actionClass =
  'mt-4 rounded-md border border-amber px-4 py-2 font-bold tracking-[0.15em] text-amber uppercase transition hover:bg-amber/10'

// Shown in the Live tab when nothing is on: the next kick-off, so the page
// still says something useful during an international break or overnight
function NothingLive({ next, fixtures, onShowFixtures }) {
  const now = useNow()

  return (
    <EmptyPanel title="Nothing live right now">
      {next ? (
        <>
          <p className="mt-4 text-sm font-bold tracking-[0.2em] text-muted uppercase">Next up</p>
          <p className="mt-1 text-2xl font-semibold tracking-wide uppercase">
            {next.homeTeam} <span className="text-muted">vs</span> {next.awayTeam}
          </p>
          <p className="mt-1 text-muted">{next.competition ?? next.sport}</p>
          <p className="mt-2 font-mono text-sm text-amber">
            {formatKickoff(next.startTime, now)} · {formatCountdown(next.startTime, now)}
          </p>
          <button type="button" onClick={onShowFixtures} className={actionClass}>
            See all {fixtures} fixtures
          </button>
        </>
      ) : (
        <p className="mt-1 text-muted">Nothing is scheduled in the next two weeks either.</p>
      )}
    </EmptyPanel>
  )
}

const TAB_ACCENT = { [TAB.LIVE]: 'bg-live', [TAB.FIXTURES]: 'bg-amber', [TAB.RESULTS]: 'bg-muted' }

function Matches() {
  const { data: matches, isPending, error, refetch, isRefetching } = useQuery({
    queryKey: matchesQueryKey,
    queryFn: () => fetchMatches(),
  })
  const [filters, setFilters] = useFilters()
  const now = useNow()

  // score_update is only sent to subscribers, so every live match is subscribed
  // to, whichever tab is open
  useMatchSubscriptions(matches?.filter((m) => m.status === STATUS.LIVE).map((m) => m.id) ?? [])

  if (isPending) return <MatchGridSkeleton />

  if (error) {
    return (
      <div className="rounded-lg border border-live/50 bg-panel p-6">
        <p className="text-lg font-bold tracking-[0.15em] text-live uppercase">Couldn't load matches</p>
        <p className="mt-1 text-muted">{error.message}</p>
        <button
          type="button"
          onClick={() => refetch()}
          disabled={isRefetching}
          className="mt-4 flex items-center gap-2 rounded-md bg-amber px-4 py-2 font-bold tracking-[0.15em] text-on-amber uppercase transition hover:brightness-110 disabled:opacity-60"
        >
          <RefreshCw className={`size-4 ${isRefetching ? 'animate-spin' : ''}`} aria-hidden />
          Try again
        </button>
      </div>
    )
  }

  const { tab } = filters
  const isFiltered = filters.sport !== ALL || filters.competition !== ALL

  // Tab counts follow the sport and competition filters; the sport and
  // competition counts follow the open tab
  const groups = groupMatches(filterMatches(matches, filters), now)
  const counts = Object.fromEntries(TABS.map((t) => [t, matchesForTab(groups, t).length]))
  const shown = matchesForTab(groups, tab)
  const inTab = matchesForTab(groupMatches(matches, now), tab)
  const clearFilters = () => setFilters({ sport: ALL, competition: ALL })

  let content
  if (shown.length > 0) {
    content = <MatchGrid matches={shown} byDay={tab !== TAB.LIVE} accent={TAB_ACCENT[tab]} />
  } else if (tab === TAB.LIVE) {
    const next = groups.upcoming.find((m) => !isOverdue(m, now) && m.startTime)
    content = <NothingLive next={next} fixtures={counts[TAB.FIXTURES]} onShowFixtures={() => setFilters({ tab: TAB.FIXTURES })} />
  } else {
    content = (
      <EmptyPanel title={tab === TAB.FIXTURES ? 'No fixtures in the next two weeks' : 'No recent results'}>
        {isFiltered ? (
          <>
            <p className="mt-1 text-muted">Try another sport or competition.</p>
            <button type="button" onClick={clearFilters} className={actionClass}>
              Clear filters
            </button>
          </>
        ) : (
          <p className="mt-1 text-muted">New matches appear here automatically as soon as they are added.</p>
        )}
      </EmptyPanel>
    )
  }

  return (
    <div className="space-y-6">
      <Tabs tab={tab} counts={counts} onChange={(t) => setFilters({ tab: t })} />

      <Filters
        options={filterOptions(matches, filters.sport, inTab)}
        filters={filters}
        total={inTab.length}
        onChange={setFilters}
      />

      <div role="tabpanel" id={tabPanelId(tab)} aria-labelledby={tabId(tab)}>
        {content}
      </div>
    </div>
  )
}

function MatchCount() {
  const { data: matches } = useQuery({ queryKey: matchesQueryKey, queryFn: () => fetchMatches() })
  if (!matches) return null

  return (
    <span className="font-mono text-xs text-muted">{matches.length} matches</span>
  )
}

export default function App() {
  useLiveMatchUpdates()

  return (
    <div className="mx-auto max-w-7xl space-y-8 px-4 py-6 sm:px-6 sm:py-8">
      <Header />

      <div className="grid gap-8 lg:grid-cols-[1fr_20rem] lg:items-start">
        <section aria-labelledby="matches-heading" className="min-w-0">
          <div className="mb-5 flex items-center justify-between gap-3">
            <h2 id="matches-heading" className="text-2xl font-bold tracking-[0.12em] uppercase">
              Matches
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
