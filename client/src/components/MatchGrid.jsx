import { useState } from 'react'
import { AnimatePresence, LayoutGroup } from 'motion/react'
import { MatchCard, MatchCardSkeleton } from './MatchCard.jsx'
import { groupMatches } from '../lib/matches.js'
import { useNow } from '../lib/useNow.js'

// Finished matches pile up, so only the most recent show until asked
const FINISHED_PREVIEW = 6

// count can differ from matches.length when only some are shown
function Section({ title, accent, matches, count = matches.length, footer }) {
  if (matches.length === 0) return null

  return (
    <section aria-label={title}>
      <h3 className="mb-4 flex items-center gap-3 text-base font-bold tracking-[0.2em] uppercase">
        <span className={`h-4 w-1 rounded-full ${accent}`} aria-hidden />
        {title}
        <span className="font-mono text-xs font-medium tracking-normal text-muted">{count}</span>
        <span className="h-px flex-1 bg-line" aria-hidden />
      </h3>
      <div className="grid gap-4 sm:grid-cols-2">
        <AnimatePresence initial={false}>
          {matches.map((match) => (
            <MatchCard key={match.id} match={match} />
          ))}
        </AnimatePresence>
      </div>
      {footer}
    </section>
  )
}

export function MatchGrid({ matches }) {
  const now = useNow()
  const [showAllFinished, setShowAllFinished] = useState(false)
  const { live, upcoming, finished } = groupMatches(matches, now)

  const visibleFinished = showAllFinished ? finished : finished.slice(0, FINISHED_PREVIEW)
  const hiddenCount = finished.length - visibleFinished.length

  return (
    // LayoutGroup lets a card animate from one section to another, e.g. Live → Finished
    <LayoutGroup>
      <div className="space-y-10">
        <Section title="Live now" accent="bg-live" matches={live} />
        <Section title="Upcoming" accent="bg-amber" matches={upcoming} />
        <Section
          title="Full time"
          accent="bg-muted"
          matches={visibleFinished}
          count={finished.length}
          footer={
            (hiddenCount > 0 || showAllFinished) &&
            finished.length > FINISHED_PREVIEW && (
              <button
                type="button"
                onClick={() => setShowAllFinished((v) => !v)}
                className="mt-4 w-full rounded-md border border-dashed border-line py-2.5 text-sm font-bold tracking-[0.15em] text-muted uppercase transition hover:border-amber hover:text-amber"
              >
                {showAllFinished ? 'Show fewer' : `Show ${hiddenCount} more results`}
              </button>
            )
          }
        />
      </div>
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
