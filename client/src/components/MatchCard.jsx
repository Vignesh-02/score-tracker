import { AnimatePresence, motion } from 'motion/react'
import { STATUS, isOverdue } from '../lib/matches.js'
import { formatInnings, formatLabel, highlightedSide, inningsOf, isCricket } from '../lib/cricket.js'
import { formatCountdown, formatKickoff } from '../lib/format.js'
import { useNow } from '../lib/useNow.js'

const ledTone = (idle, lit) => (idle ? 'text-muted' : lit ? 'text-amber glow-amber' : 'text-amber-dim')

// The amber wash that plays over a score cell when it changes. `at` is the
// update's timestamp, so each new score replays it.
function ScoreFlash({ at }) {
  if (!at) return null
  return (
    <motion.span
      key={at}
      className="pointer-events-none absolute inset-0 bg-amber mix-blend-screen"
      initial={{ opacity: 0.85 }}
      animate={{ opacity: 0 }}
      transition={{ duration: 1.6, ease: 'easeOut' }}
      aria-hidden
    />
  )
}

// The old value rolls out and the new one drops in
function Rolling({ value, className }) {
  return (
    <AnimatePresence mode="popLayout" initial={false}>
      <motion.span
        key={value}
        className={className}
        initial={{ y: '-110%' }}
        animate={{ y: 0 }}
        exit={{ y: '110%' }}
        transition={{ type: 'spring', stiffness: 500, damping: 32 }}
      >
        {value}
      </motion.span>
    </AnimatePresence>
  )
}

// Football: one LED cell with the goals. The leading side is fully lit.
function GoalsBox({ value, lit, idle, scored }) {
  return (
    <div
      className={`led-board relative grid h-16 w-14 shrink-0 place-items-center overflow-hidden rounded-md font-score text-5xl leading-none font-bold tabular-nums transition-colors duration-500 ${ledTone(idle, lit)}`}
    >
      <Rolling value={value} />
      <ScoreFlash at={scored} />
    </div>
  )
}

// Cricket: the current innings ("213/4") with overs underneath, and earlier
// innings in small type before it ("434 & 120/2"). The batting side is lit.
function InningsBox({ innings, lit, idle, live, scored }) {
  const current = innings.at(-1)
  const earlier = innings.slice(0, -1)

  return (
    <div
      className={`led-board relative flex h-16 min-w-26 shrink-0 flex-col items-end justify-center overflow-hidden rounded-md px-3 transition-colors duration-500 ${ledTone(idle || !current, lit)}`}
    >
      <div className="flex items-baseline gap-1.5 font-score leading-none font-bold tabular-nums">
        {earlier.map((i) => (
          <span key={i.number} className="text-lg opacity-70">
            {formatInnings(i)} &amp;
          </span>
        ))}
        {current ? (
          <Rolling value={formatInnings(current)} className="text-4xl" />
        ) : live ? (
          <span className="font-sans text-sm tracking-[0.15em] uppercase">Yet to bat</span>
        ) : (
          <span className="text-4xl">–</span>
        )}
      </div>
      {current && <span className="mt-1 font-mono text-[10px] text-muted">{current.overs} ov</span>}
      <ScoreFlash at={scored} />
    </div>
  )
}

function TeamRow({ name, lit, children }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span
        className={`min-w-0 truncate text-xl font-semibold tracking-wide uppercase sm:text-2xl ${lit ? 'text-ink' : 'text-ink/80'}`}
        title={name}
      >
        {name}
      </span>
      {children}
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
    const label = match.sport === 'Football' ? 'FT' : isCricket(match) ? 'Result' : 'Final'
    return <span className={`text-muted ${base}`}>{label}</span>
  }

  if (overdue) return <span className={`text-warn ${base}`}>Awaiting update</span>

  return <span className={`text-amber ${base}`}>Upcoming</span>
}

function footerText(match, now, overdue) {
  // Cricket's own summary says more than a time: "India need 32 runs from 18 balls"
  if (isCricket(match) && match.status !== STATUS.SCHEDULED && match.details?.statusText) {
    return match.details.statusText
  }

  const kickoff = formatKickoff(match.startTime, now)

  if (match.status === STATUS.LIVE) return `Started ${kickoff}`
  if (match.status === STATUS.FINISHED) return kickoff
  if (overdue || !match.startTime) return `Kick-off ${kickoff}`
  return `${kickoff} · ${formatCountdown(match.startTime, now)}`
}

function celebrationLabel(match, scored) {
  if (!scored) return null
  if (isCricket(match)) return scored.wicket ? 'Wicket!' : null
  return match.sport === 'Football' ? 'Goal!' : 'Score!'
}

export function MatchCard({ match }) {
  const now = useNow()
  const isLive = match.status === STATUS.LIVE
  const isUpcoming = match.status === STATUS.SCHEDULED
  const overdue = isOverdue(match, now)
  const cricket = isCricket(match)

  const { homeScore, awayScore, _scored: scored } = match
  const label = celebrationLabel(match, scored)
  const format = cricket ? formatLabel(match) : null

  // Which side is lit: football's leader, or cricket's batting side / winner
  const litSide = cricket
    ? highlightedSide(match)
    : isUpcoming ? null : homeScore > awayScore ? 'home' : awayScore > homeScore ? 'away' : null

  const flashFor = (side) => (scored && scored.side !== (side === 'home' ? 'away' : 'home') ? scored.at : null)

  const scoreCell = (side) =>
    cricket ? (
      <InningsBox
        innings={inningsOf(match, side)}
        lit={litSide === side}
        idle={isUpcoming}
        live={isLive}
        scored={flashFor(side)}
      />
    ) : (
      <GoalsBox
        value={isUpcoming ? '–' : side === 'home' ? homeScore : awayScore}
        lit={litSide === side}
        idle={isUpcoming}
        scored={flashFor(side)}
      />
    )

  return (
    <motion.article
      layout
      layoutId={`match-${match.id}`}
      initial={{ opacity: 0, scale: 0.97 }}
      animate={{ opacity: 1, scale: 1 }}
      exit={{ opacity: 0, scale: 0.97 }}
      transition={{ type: 'spring', stiffness: 400, damping: 34 }}
      className={`relative flex flex-col overflow-hidden rounded-lg border bg-panel transition-[border-color,box-shadow] duration-500 ${
        label
          ? 'border-amber shadow-[0_0_32px_-6px_rgb(255_176_0/0.6)]'
          : isLive
            ? 'glow-live border-live/50'
            : 'border-line'
      }`}
      aria-label={`${match.homeTeam} vs ${match.awayTeam}`}
    >
      {/* Top strip: competition (and cricket format) on the left, status on the right */}
      <div className="flex items-center justify-between gap-3 border-b border-line px-4 py-2.5">
        <div className="flex min-w-0 items-center gap-2">
          {format && (
            <span className="shrink-0 rounded-sm border border-cyan/40 px-1.5 text-xs font-bold tracking-[0.15em] text-cyan uppercase">
              {format}
            </span>
          )}
          <p className="min-w-0 truncate text-sm font-semibold tracking-[0.12em] text-muted uppercase" title={match.competition ?? match.sport}>
            {match.competition ?? match.sport}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <AnimatePresence>
            {label && (
              <motion.span
                key={scored.at}
                initial={{ opacity: 0, scale: 0.6 }}
                animate={{ opacity: [1, 0.35, 1, 0.35, 1], scale: 1 }}
                exit={{ opacity: 0, scale: 0.8 }}
                transition={{ duration: 1.2 }}
                className="rounded-sm bg-amber px-2 py-0.5 text-sm font-bold tracking-[0.15em] text-on-amber uppercase"
              >
                {label}
              </motion.span>
            )}
          </AnimatePresence>
          <StatusPill match={match} overdue={overdue} />
        </div>
      </div>

      <div className="space-y-2.5 px-4 py-4">
        <TeamRow name={match.homeTeam} lit={litSide === 'home'}>
          {scoreCell('home')}
        </TeamRow>
        <TeamRow name={match.awayTeam} lit={litSide === 'away'}>
          {scoreCell('away')}
        </TeamRow>
      </div>

      <div
        className={`mt-auto border-t border-line px-4 py-2.5 ${
          cricket && !isUpcoming ? 'text-sm font-medium tracking-wide text-ink/80' : 'font-mono text-xs text-muted'
        }`}
      >
        <span className="block truncate" title={footerText(match, now, overdue)}>
          {footerText(match, now, overdue)}
        </span>
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
