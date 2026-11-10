import { AnimatePresence, motion } from 'motion/react'
import { Clock } from 'lucide-react'
import { useMatchSubscription } from '../live/hooks.js'
import { STATUS, isOverdue } from '../lib/matches.js'
import { formatCountdown, formatKickoff } from '../lib/format.js'
import { useNow } from '../lib/useNow.js'

function ScoreBox({ value, leading, scored }) {
  return (
    <div
      className={`relative grid h-14 w-14 shrink-0 place-items-center overflow-hidden rounded-xl border-2 border-ink text-3xl font-extrabold tabular-nums transition-colors duration-500 ${
        leading ? 'bg-sun text-on-accent' : 'bg-card'
      }`}
    >
      {/* The old number slides out and the new one drops in */}
      <AnimatePresence mode="popLayout" initial={false}>
        <motion.span
          key={value}
          initial={{ y: '-110%' }}
          animate={{ y: 0 }}
          exit={{ y: '110%' }}
          transition={{ type: 'spring', stiffness: 500, damping: 32 }}
        >
          {value}
        </motion.span>
      </AnimatePresence>

      {/* scored is the update's timestamp, so each new score replays the flash */}
      {scored && (
        <motion.span
          key={scored}
          className="pointer-events-none absolute inset-0 bg-sun"
          initial={{ opacity: 0.9 }}
          animate={{ opacity: 0 }}
          transition={{ duration: 1.6, ease: 'easeOut' }}
          aria-hidden
        />
      )}
    </div>
  )
}

function TeamRow({ name, score, leading, scored }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="min-w-0 truncate text-lg font-bold sm:text-xl" title={name}>
        {name}
      </span>
      <ScoreBox value={score} leading={leading} scored={scored} />
    </div>
  )
}

function StatusPill({ match, overdue }) {
  if (match.status === STATUS.LIVE) {
    return (
      <span className="flex items-center gap-1.5 font-semibold text-live">
        <span className="relative flex size-2.5">
          <span className="absolute inline-flex size-full animate-ping rounded-full bg-live opacity-60" />
          <span className="relative inline-flex size-2.5 rounded-full bg-live" />
        </span>
        Live
      </span>
    )
  }

  if (match.status === STATUS.FINISHED) {
    return (
      <span className="font-semibold text-muted">{match.sport === 'Football' ? 'Full time' : 'Final'}</span>
    )
  }

  if (overdue) return <span className="font-semibold text-warn">Awaiting update</span>

  return <span className="font-semibold text-muted">Upcoming</span>
}

function footerText(match, now, overdue) {
  const kickoff = formatKickoff(match.startTime, now)

  if (match.status === STATUS.LIVE) return `Started ${kickoff}`
  if (match.status === STATUS.FINISHED) return kickoff
  if (overdue || !match.startTime) return `Kick-off ${kickoff}`
  return `${kickoff} · ${formatCountdown(match.startTime, now)}`
}

export function MatchCard({ match }) {
  const now = useNow()
  const isLive = match.status === STATUS.LIVE
  const isUpcoming = match.status === STATUS.SCHEDULED
  const overdue = isOverdue(match, now)

  // score_update is only sent to subscribers, so every live card on screen subscribes
  useMatchSubscription(isLive ? match.id : null)

  const { homeScore, awayScore, _scored: scored } = match
  const showScores = !isUpcoming
  const scoredLabel = match.sport === 'Football' ? 'Goal!' : 'Score!'

  return (
    <motion.article
      layout
      layoutId={`match-${match.id}`}
      initial={{ opacity: 0, scale: 0.96 }}
      animate={{ opacity: 1, scale: 1 }}
      exit={{ opacity: 0, scale: 0.96 }}
      transition={{ type: 'spring', stiffness: 400, damping: 34 }}
      className={`relative flex flex-col rounded-2xl border-[3px] border-ink bg-card p-5 shadow-brutal ${
        scored ? 'ring-4 ring-sun ring-offset-2 ring-offset-page' : ''
      }`}
      aria-label={`${match.homeTeam} vs ${match.awayTeam}`}
    >
      <div className="mb-4 flex items-start justify-between gap-3">
        <div className="min-w-0">
          <span className="inline-block rounded-full border-2 border-ink px-2.5 py-0.5 text-xs font-bold uppercase tracking-wider">
            {match.sport}
          </span>
          {match.competition && (
            <p className="mt-1.5 truncate text-sm text-muted" title={match.competition}>
              {match.competition}
            </p>
          )}
        </div>

        <div className="flex shrink-0 items-center gap-2 text-sm">
          <AnimatePresence>
            {scored && (
              <motion.span
                key={scored.at}
                initial={{ opacity: 0, y: -6, scale: 0.8 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={{ opacity: 0, scale: 0.8 }}
                className="rounded-full bg-sun px-2 py-0.5 text-xs font-extrabold uppercase text-on-accent"
              >
                {scoredLabel}
              </motion.span>
            )}
          </AnimatePresence>
          <StatusPill match={match} overdue={overdue} />
        </div>
      </div>

      <div className="space-y-3">
        <TeamRow
          name={match.homeTeam}
          score={showScores ? homeScore : '–'}
          leading={showScores && homeScore > awayScore}
          scored={scored && scored.side !== 'away' ? scored.at : null}
        />
        <TeamRow
          name={match.awayTeam}
          score={showScores ? awayScore : '–'}
          leading={showScores && awayScore > homeScore}
          scored={scored && scored.side !== 'home' ? scored.at : null}
        />
      </div>

      <div className="mt-5 flex items-center gap-1.5 border-t-2 border-dashed border-line pt-4 text-sm text-muted">
        <Clock className="size-4 shrink-0" aria-hidden />
        <span className="truncate">{footerText(match, now, overdue)}</span>
      </div>
    </motion.article>
  )
}

export function MatchCardSkeleton() {
  return (
    <div className="animate-pulse rounded-2xl border-[3px] border-line bg-card p-5" aria-hidden>
      <div className="mb-5 h-6 w-24 rounded-full bg-line" />
      <div className="space-y-3">
        {[0, 1].map((i) => (
          <div key={i} className="flex items-center justify-between">
            <div className="h-6 w-40 rounded bg-line" />
            <div className="size-14 rounded-xl bg-line" />
          </div>
        ))}
      </div>
      <div className="mt-6 h-4 w-32 rounded bg-line" />
    </div>
  )
}
