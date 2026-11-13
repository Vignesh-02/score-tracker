import { AnimatePresence, LayoutGroup } from 'motion/react'
import { MatchCard, MatchCardSkeleton } from './MatchCard.jsx'
import { groupByDay } from '../lib/matches.js'
import { formatDay } from '../lib/format.js'
import { useNow } from '../lib/useNow.js'

function Cards({ matches }) {
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      <AnimatePresence initial={false}>
        {matches.map((match) => (
          <MatchCard key={match.id} match={match} />
        ))}
      </AnimatePresence>
    </div>
  )
}

function DayHeading({ accent, children, count }) {
  return (
    <h3 className="mb-4 flex items-center gap-3 text-base font-bold tracking-[0.2em] uppercase">
      <span className={`h-4 w-1 rounded-full ${accent}`} aria-hidden />
      {children}
      <span className="font-mono text-xs font-medium tracking-normal text-muted">{count}</span>
      <span className="h-px flex-1 bg-line" aria-hidden />
    </h3>
  )
}

function dayLabel({ key, matches }, now) {
  if (key === 'overdue') return 'Awaiting update'
  if (key === 'tbc') return 'Date to be confirmed'
  return formatDay(matches[0].startTime, now)
}

// One tab's matches. Fixtures and results are split by day ("Today",
// "Tomorrow", "Sat 14 Nov"); live matches are one grid.
export function MatchGrid({ matches, byDay = false, accent = 'bg-amber' }) {
  const now = useNow()

  return (
    // LayoutGroup lets cards slide into place as others leave the tab
    <LayoutGroup>
      {byDay ? (
        <div className="space-y-8">
          {groupByDay(matches, now).map((day) => (
            <section key={day.key} aria-label={dayLabel(day, now)}>
              <DayHeading accent={day.key === 'overdue' ? 'bg-warn' : accent} count={day.matches.length}>
                {dayLabel(day, now)}
              </DayHeading>
              <Cards matches={day.matches} />
            </section>
          ))}
        </div>
      ) : (
        <Cards matches={matches} />
      )}
    </LayoutGroup>
  )
}

export function MatchGridSkeleton() {
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      {[0, 1, 2, 3].map((i) => (
        <MatchCardSkeleton key={i} />
      ))}
    </div>
  )
}
