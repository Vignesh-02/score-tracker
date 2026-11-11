import { AnimatePresence, motion } from 'motion/react'
import { useMatchSubscription } from '../live/hooks.js'
import { STATUS, isOverdue } from '../lib/matches.js'
import { formatCountdown, formatKickoff } from '../lib/format.js'
import { useNow } from '../lib/useNow.js'

// One cell of the LED board. The leading side is fully lit; the other is dimmer.
function ScoreBox({ value, leading, idle, scored }) {
  const tone = idle ? 'text-muted' : leading ? 'text-amber glow-amber' : 'text-amber-dim'

  return (
    <div
      className={`led-board relative grid h-16 w-14 shrink-0 place-items-center overflow-hidden rounded-md font-score text-5xl leading-none font-bold tabular-nums transition-colors duration-500 ${tone}`}
    >
      {/* The old number rolls out and the new one drops in */}
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
          className="pointer-events-none absolute inset-0 bg-amber mix-blend-screen"
          initial={{ opacity: 0.85 }}
          animate={{ opacity: 0 }}
          transition={{ duration: 1.6, ease: 'easeOut' }}
          aria-hidden
        />
      )}
    </div>
  )
}

function TeamRow({ name, score, leading, idle, scored }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span
        className={`min-w-0 truncate text-xl font-semibold tracking-wide uppercase sm:text-2xl ${
          leading ? 'text-ink' : 'text-ink/80'
        }`}
        title={name}
      >
        {name}
      </span>
      <ScoreBox value={score} leading={leading} idle={idle} scored={scored} />
    </div>
  )
}

function StatusPill({ match, overdue }) {
  const base = 'text-sm font-bold tracking-[0.15em] uppercase'

  if (match.status === STATUS.LIVE) {
    return (
      <span className={`flex items-center gap-2 text-live ${base}`}>
        <span className="relative flex size-2">
          <span className="absolute inline-flex size-full animate-ping rounded-full bg-live opacity-75" />
          <span className="relative inline-flex size-2 rounded-full bg-live shadow-[0_0_8px_var(--color-live)]" />
        </span>
        Live
      </span>
    )
  }

  if (match.status === STATUS.FINISHED) {
    return <span className={`text-muted ${base}`}>{match.sport === 'Football' ? 'FT' : 'Final'}</span>
  }

  if (overdue) return <span className={`text-warn ${base}`}>Awaiting update</span>

  return <span className={`text-amber ${base}`}>Upcoming</span>
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
      initial={{ opacity: 0, scale: 0.97 }}
      animate={{ opacity: 1, scale: 1 }}
      exit={{ opacity: 0, scale: 0.97 }}
      transition={{ type: 'spring', stiffness: 400, damping: 34 }}
      className={`relative flex flex-col overflow-hidden rounded-lg border bg-panel transition-[border-color,box-shadow] duration-500 ${
        scored
          ? 'border-amber shadow-[0_0_32px_-6px_rgb(255_176_0/0.6)]'
          : isLive
            ? 'glow-live border-live/50'
            : 'border-line'
      }`}
      aria-label={`${match.homeTeam} vs ${match.awayTeam}`}
    >
      {/* Top strip: competition on the left, status on the right */}
      <div className="flex items-center justify-between gap-3 border-b border-line px-4 py-2.5">
        <p className="min-w-0 truncate text-sm font-semibold tracking-[0.12em] text-muted uppercase" title={match.competition ?? match.sport}>
          {match.competition ?? match.sport}
        </p>
        <div className="flex shrink-0 items-center gap-2">
          <AnimatePresence>
            {scored && (
              <motion.span
                key={scored.at}
                initial={{ opacity: 0, scale: 0.6 }}
                animate={{ opacity: [1, 0.35, 1, 0.35, 1], scale: 1 }}
                exit={{ opacity: 0, scale: 0.8 }}
                transition={{ duration: 1.2 }}
                className="rounded-sm bg-amber px-2 py-0.5 text-sm font-bold tracking-[0.15em] text-on-amber uppercase"
              >
                {scoredLabel}
              </motion.span>
            )}
          </AnimatePresence>
          <StatusPill match={match} overdue={overdue} />
        </div>
      </div>

      <div className="space-y-2.5 px-4 py-4">
        <TeamRow
          name={match.homeTeam}
          score={showScores ? homeScore : '–'}
          leading={showScores && homeScore > awayScore}
          idle={!showScores}
          scored={scored && scored.side !== 'away' ? scored.at : null}
        />
        <TeamRow
          name={match.awayTeam}
          score={showScores ? awayScore : '–'}
          leading={showScores && awayScore > homeScore}
          idle={!showScores}
          scored={scored && scored.side !== 'home' ? scored.at : null}
        />
      </div>

      <div className="mt-auto border-t border-line px-4 py-2.5 font-mono text-xs text-muted">
        <span className="block truncate">{footerText(match, now, overdue)}</span>
      </div>
    </motion.article>
  )
}

export function MatchCardSkeleton() {
  return (
    <div className="animate-pulse overflow-hidden rounded-lg border border-line bg-panel" aria-hidden>
      <div className="border-b border-line px-4 py-3">
        <div className="h-4 w-32 rounded-sm bg-line" />
      </div>
      <div className="space-y-2.5 px-4 py-4">
        {[0, 1].map((i) => (
          <div key={i} className="flex items-center justify-between">
            <div className="h-6 w-40 rounded-sm bg-line" />
            <div className="led-board h-16 w-14 rounded-md" />
          </div>
        ))}
      </div>
      <div className="border-t border-line px-4 py-3">
        <div className="h-3 w-28 rounded-sm bg-line" />
      </div>
    </div>
  )
}
