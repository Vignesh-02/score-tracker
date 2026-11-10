import { useState } from 'react'
import { AnimatePresence, LayoutGroup } from 'motion/react'
import { CalendarClock, CircleCheck, Radio } from 'lucide-react'
import { MatchCard, MatchCardSkeleton } from './MatchCard.jsx'
import { groupMatches } from '../lib/matches.js'
import { useNow } from '../lib/useNow.js'

// Finished matches pile up, so only the most recent show until asked
const FINISHED_PREVIEW = 6

// count can differ from matches.length when only some are shown
function Section({ title, icon: Icon, accent, matches, count = matches.length, footer }) {
  if (matches.length === 0) return null

  return (
    <section aria-label={title}>
      <h3 className="mb-4 flex items-center gap-2 text-lg font-bold">
        <Icon className={`size-5 ${accent}`} aria-hidden />
        {title}
        <span className="rounded-md border-2 border-ink px-1.5 font-mono text-xs">{count}</span>
      </h3>
      <div className="grid gap-5 sm:grid-cols-2">
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
        <Section title="Live now" icon={Radio} accent="text-live" matches={live} />
        <Section title="Upcoming" icon={CalendarClock} accent="text-warn" matches={upcoming} />
        <Section
          title="Finished"
          icon={CircleCheck}
          accent="text-ok"
          matches={visibleFinished}
          count={finished.length}
          footer={
            (hiddenCount > 0 || showAllFinished) &&
            finished.length > FINISHED_PREVIEW && (
              <button
                type="button"
                onClick={() => setShowAllFinished((v) => !v)}
                className="mt-5 w-full rounded-xl border-2 border-dashed border-ink py-2.5 font-bold transition hover:bg-card"
              >
                {showAllFinished ? 'Show fewer' : `Show ${hiddenCount} more finished`}
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
    <div className="grid gap-5 sm:grid-cols-2">
      {[0, 1, 2, 3].map((i) => (
        <MatchCardSkeleton key={i} />
      ))}
    </div>
  )
}
