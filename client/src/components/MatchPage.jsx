import { useEffect } from 'react'
import { useQuery } from '@tanstack/react-query'
import { AnimatePresence, motion } from 'motion/react'
import { ArrowLeft, ExternalLink } from 'lucide-react'
import { MatchCard, MatchCardSkeleton } from './MatchCard.jsx'
import { Empty, Panel } from './Panel.jsx'
import { Scorecard } from './Scorecard.jsx'
import {
  commentaryQueryKey, competitionQueryKey, competitionsQueryKey, fetchCommentary, fetchCompetition,
  fetchCompetitions, fetchHeadToHead, fetchMatch, fetchScorecard, headToHeadQueryKey, matchQueryKey, scorecardQueryKey,
} from '../lib/api.js'
import { STATUS } from '../lib/matches.js'
import { isCricket } from '../lib/cricket.js'
import { isBasketball, periodLabel } from '../lib/basketball.js'
import { goBack, onAppLinkClick } from '../lib/route.js'
import { useMatchSubscriptions } from '../live/hooks.js'

// ---------- formatting ----------

const fullDateTime = new Intl.DateTimeFormat(undefined, {
  weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit',
})
const shortDate = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short', year: 'numeric' })
const clock = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' })

const STATUS_TEXT = { [STATUS.LIVE]: 'Live', [STATUS.SCHEDULED]: 'Upcoming', [STATUS.FINISHED]: 'Finished' }

// Cricket overs are balls in base 6: 18.2 overs is 18 overs and 2 balls
function runRate({ runs, overs }) {
  const whole = Math.trunc(overs)
  const balls = whole * 6 + Math.round((overs - whole) * 10)
  return balls > 0 ? ((runs * 6) / balls).toFixed(2) : null
}

const ordinal = (n) => ['1st', '2nd', '3rd', '4th'][n - 1] ?? `${n}th`

// A Google search for this match, which shows Google's own match card (line-ups,
// goalscorers, stats). The date pins a finished match down when the teams have
// met before.
function googleMatchUrl(match) {
  const parts = [`${match.homeTeam} vs ${match.awayTeam}`]
  if (match.competition) parts.push(match.competition)
  if (match.status === STATUS.FINISHED && match.startTime) parts.push(shortDate.format(new Date(match.startTime)))
  return `https://www.google.com/search?q=${encodeURIComponent(parts.join(' '))}`
}

// ---------- live updates feed ----------

const EVENT_STYLE = {
  goal: { label: 'Goal', className: 'bg-amber text-on-amber' },
  wicket: { label: 'Wicket', className: 'bg-live text-ink' },
  start: { label: 'Start', className: 'border border-cyan/50 text-cyan' },
  half_time: { label: 'HT', className: 'border border-cyan/50 text-cyan' },
  second_half: { label: '2nd half', className: 'border border-cyan/50 text-cyan' },
  full_time: { label: 'FT', className: 'border border-cyan/50 text-cyan' },
  period_end: { label: 'Quarter', className: 'border border-cyan/50 text-cyan' },
  overtime: { label: 'OT', className: 'border border-warn/60 text-warn' },
  result: { label: 'Result', className: 'border border-cyan/50 text-cyan' },
  score_correction: { label: 'VAR', className: 'border border-warn/60 text-warn' },
  dismissal: { label: 'Out', className: 'bg-live text-ink' },
  milestone: { label: 'Milestone', className: 'bg-amber text-on-amber' },
  status: { label: 'Update', className: 'border border-line text-muted' },
}

function UpdatesFeed({ match }) {
  const feed = useQuery({ queryKey: commentaryQueryKey(match.id), queryFn: () => fetchCommentary(match.id) })
  const live = match.status === STATUS.LIVE

  return (
    <Panel
      title="Live updates"
      action={live && <span className="font-mono text-xs text-live">● updating live</span>}
    >
      {feed.isPending ? (
        <Empty>Loading updates…</Empty>
      ) : feed.error ? (
        <Empty>Couldn't load updates: {feed.error.message}</Empty>
      ) : feed.data.length === 0 ? (
        <Empty>
          {match.status === STATUS.FINISHED
            ? 'No updates were recorded for this match.'
            : isBasketball(match)
              ? 'Tip-off, the end of each quarter and the final score appear here as they happen.'
              : 'Goals, wickets and results appear here as they happen.'}
        </Empty>
      ) : (
        <ol aria-live="polite">
          <AnimatePresence initial={false}>
            {feed.data.map((item) => {
              const style = EVENT_STYLE[item.eventType]
              return (
                <motion.li
                  key={item.id}
                  layout
                  initial={{ opacity: 0, y: -8 }}
                  animate={{ opacity: 1, y: 0 }}
                  className="flex items-start gap-3 border-b border-line/60 px-4 py-3 last:border-0"
                >
                  <time dateTime={item.createdAt} className="w-16 shrink-0 pt-0.5 font-mono text-xs whitespace-nowrap text-muted tabular-nums">
                    {clock.format(new Date(item.createdAt))}
                  </time>
                  {style && (
                    <span className={`shrink-0 rounded-sm px-1.5 text-xs leading-5 font-bold tracking-[0.12em] uppercase ${style.className}`}>
                      {style.label}
                    </span>
                  )}
                  <p className="min-w-0 font-medium tracking-wide">{item.message}</p>
                </motion.li>
              )
            })}
          </AnimatePresence>
        </ol>
      )}
    </Panel>
  )
}

// ---------- match info ----------

function InfoRow({ label, children }) {
  return (
    <div className="flex justify-between gap-4 border-b border-line/60 px-4 py-2.5 last:border-0">
      <dt className="shrink-0 text-sm font-bold tracking-[0.12em] text-muted uppercase">{label}</dt>
      <dd className="min-w-0 text-right">{children}</dd>
    </div>
  )
}

function MatchInfo({ match, scorecard }) {
  const cricket = isCricket(match)
  const halfTime = match.details?.halfTime
  const innings = match.details?.innings ?? []

  return (
    <Panel title="Match info">
      <dl>
        <InfoRow label="Competition">{match.competition ?? match.sport}</InfoRow>
        <InfoRow label={cricket ? 'Starts' : isBasketball(match) ? 'Tip-off' : 'Kick-off'}>
          {match.startTime ? fullDateTime.format(new Date(match.startTime)) : 'To be confirmed'}
        </InfoRow>
        {scorecard?.venue && <InfoRow label="Venue">{scorecard.venue}</InfoRow>}
        <InfoRow label="Status">{STATUS_TEXT[match.status] ?? match.status}</InfoRow>
        {scorecard?.toss && (
          <InfoRow label="Toss">
            {scorecard.toss.team}{scorecard.toss.choice ? `, chose to ${scorecard.toss.choice}` : ''}
          </InfoRow>
        )}
        {halfTime && (
          <InfoRow label="Half-time">
            <span className="font-mono">{halfTime.home}–{halfTime.away}</span>
          </InfoRow>
        )}
        {cricket && match.details?.statusText && match.status !== STATUS.SCHEDULED && (
          <InfoRow label="Summary">{match.details.statusText}</InfoRow>
        )}
        {innings.map((i) => {
          const rate = runRate(i)
          const team = i.side === 'home' ? match.homeTeam : match.awayTeam
          return (
            <InfoRow key={`${i.side}-${i.number}`} label={`${ordinal(i.number)} inns`}>
              <span className="font-semibold">{team}</span>{' '}
              <span className="font-mono">
                {i.runs}/{i.wickets} ({i.overs} ov){rate && <span className="text-muted"> · RR {rate}</span>}
              </span>
            </InfoRow>
          )
        })}
      </dl>
    </Panel>
  )
}

// ---------- quarter-by-quarter score (basketball) ----------

function QuarterScores({ match }) {
  const { home = [], away = [] } = match.details?.quarters ?? {}
  const periods = Math.max(home.length, away.length)
  if (periods === 0) return null

  const cell = 'px-2 py-2 text-right font-mono tabular-nums'
  const total = (side) => (side === 'home' ? match.homeScore : match.awayScore)
  const abbr = (side) => (side === 'home' ? match.details?.homeAbbr : match.details?.awayAbbr)

  return (
    <Panel title="Score by quarter">
      <table className="w-full text-sm">
        <thead className="border-b border-line text-xs text-muted uppercase">
          <tr>
            <th scope="col" className="px-4 py-2 text-left">Team</th>
            {Array.from({ length: periods }, (_, i) => (
              <th key={i} scope="col" className={cell}>{periodLabel(i + 1)}</th>
            ))}
            <th scope="col" className="px-4 py-2 text-right text-amber">T</th>
          </tr>
        </thead>
        <tbody>
          {[['home', home], ['away', away]].map(([side, points]) => {
            const name = side === 'home' ? match.homeTeam : match.awayTeam
            return (
              <tr key={side} className="border-b border-line/60 last:border-0">
                <th scope="row" className="px-4 py-2 text-left font-semibold" title={name}>{abbr(side) ?? name}</th>
                {Array.from({ length: periods }, (_, i) => (
                  <td key={i} className={cell}>{points[i] ?? '–'}</td>
                ))}
                <td className="px-4 py-2 text-right font-mono font-bold text-amber tabular-nums">{total(side)}</td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </Panel>
  )
}

// ---------- league table snippet (football) ----------

function TeamStandings({ match }) {
  const competitions = useQuery({ queryKey: competitionsQueryKey, queryFn: fetchCompetitions, staleTime: 5 * 60_000 })
  const competition = competitions.data?.find((c) => c.name === match.competition)
  const detail = useQuery({
    queryKey: competitionQueryKey(competition?.code),
    queryFn: () => fetchCompetition(competition.code),
    enabled: Boolean(competition),
    staleTime: 5 * 60_000,
  })

  const teams = [match.homeTeam, match.awayTeam]
  const rows = (detail.data?.standings ?? [])
    .flatMap((s) => s.table)
    .filter((row) => teams.includes(row.team))
    .sort((a, b) => a.position - b.position)

  // Cups in a knockout round, competitions without a table, other sports
  if (rows.length === 0) return null

  const tableLink = `/?tab=tables&sport=Football&competition=${encodeURIComponent(match.competition)}`

  return (
    <Panel
      title="League table"
      action={
        <a href={tableLink} onClick={onAppLinkClick} className="text-xs font-bold tracking-[0.12em] text-amber uppercase hover:underline">
          Full table
        </a>
      }
    >
      <table className="w-full text-sm">
        <thead className="border-b border-line text-xs text-muted uppercase">
          <tr>
            <th scope="col" className="px-4 py-2 text-left">#</th>
            <th scope="col" className="py-2 text-left">Team</th>
            <th scope="col" className="px-2 py-2 text-right"><abbr title="Played">P</abbr></th>
            <th scope="col" className="px-2 py-2 text-right"><abbr title="Goal difference">GD</abbr></th>
            <th scope="col" className="px-4 py-2 text-right text-amber"><abbr title="Points">Pts</abbr></th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.team} className="border-b border-line/60 last:border-0">
              <td className="px-4 py-2 font-mono text-muted">{row.position}</td>
              <th scope="row" className="py-2 text-left font-semibold">
                <span className="flex items-center gap-2">
                  {row.crest && <img src={row.crest} alt="" className="size-5 object-contain" />}
                  {row.team}
                </span>
              </th>
              <td className="px-2 py-2 text-right font-mono">{row.played}</td>
              <td className="px-2 py-2 text-right font-mono">{row.goalDifference > 0 ? `+${row.goalDifference}` : row.goalDifference}</td>
              <td className="px-4 py-2 text-right font-mono font-bold text-amber">{row.points}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </Panel>
  )
}

// ---------- head-to-head (football-data.org matches) ----------

function HeadToHead({ match }) {
  const h2h = useQuery({
    queryKey: headToHeadQueryKey(match.id),
    queryFn: () => fetchHeadToHead(match.id),
    staleTime: 60 * 60_000,
    retry: 1,
  })

  if (h2h.isPending) return <Panel title="Head-to-head"><Empty>Loading…</Empty></Panel>
  if (h2h.error) return <Panel title="Head-to-head"><Empty>{h2h.error.message}</Empty></Panel>
  if (h2h.data.length === 0) return null

  // Wins counted by team, whichever side they played on
  const tally = { [match.homeTeam]: 0, [match.awayTeam]: 0, draws: 0 }
  for (const m of h2h.data) {
    if (m.homeScore == null || m.awayScore == null) continue
    if (m.homeScore === m.awayScore) tally.draws++
    else {
      const winner = m.homeScore > m.awayScore ? m.homeTeam : m.awayTeam
      if (winner in tally) tally[winner]++
    }
  }

  return (
    <Panel title={`Last ${h2h.data.length} meetings`}>
      <div className="grid grid-cols-3 border-b border-line text-center">
        {[
          [match.homeTeam, tally[match.homeTeam]],
          ['Draws', tally.draws],
          [match.awayTeam, tally[match.awayTeam]],
        ].map(([label, value]) => (
          <div key={label} className="px-2 py-3">
            <p className="font-score text-3xl leading-none font-bold text-amber">{value}</p>
            <p className="mt-1 truncate text-xs font-bold tracking-[0.12em] text-muted uppercase" title={label}>{label}</p>
          </div>
        ))}
      </div>
      <ol>
        {h2h.data.map((m) => (
          <li key={m.date} className="border-b border-line/60 px-4 py-2.5 last:border-0">
            <div className="flex items-center justify-between gap-3">
              <span className="min-w-0 flex-1 truncate text-right font-semibold">{m.homeTeam}</span>
              <span className="shrink-0 rounded-sm bg-board px-2 font-mono font-bold text-amber tabular-nums">
                {m.homeScore ?? '–'}–{m.awayScore ?? '–'}
              </span>
              <span className="min-w-0 flex-1 truncate font-semibold">{m.awayTeam}</span>
            </div>
            <p className="mt-0.5 text-center font-mono text-xs text-muted">
              {shortDate.format(new Date(m.date))}{m.competition ? ` · ${m.competition}` : ''}
            </p>
          </li>
        ))}
      </ol>
    </Panel>
  )
}

// ---------- the page ----------

function BackLink() {
  return (
    <button
      type="button"
      onClick={goBack}
      className="flex items-center gap-2 text-sm font-bold tracking-[0.15em] text-muted uppercase transition hover:text-ink"
    >
      <ArrowLeft className="size-4" aria-hidden />
      All matches
    </button>
  )
}

export function MatchPage({ id }) {
  const { data: match, isPending, error } = useQuery({ queryKey: matchQueryKey(id), queryFn: () => fetchMatch(id) })

  // score_update and commentary for this match arrive while the page is open
  useMatchSubscriptions([id])

  // The server decides when a fresh one is worth its cost; checking every few
  // minutes picks up each new one while live
  const live = match?.status === STATUS.LIVE
  const scorecard = useQuery({
    queryKey: scorecardQueryKey(id, match?.status),
    queryFn: () => fetchScorecard(id),
    enabled: Boolean(match) && isCricket(match) && match.status !== STATUS.SCHEDULED,
    refetchInterval: live ? 3 * 60_000 : false,
    staleTime: live ? 60_000 : Infinity,
    retry: 1,
  })

  useEffect(() => {
    if (!match) return
    const score = isCricket(match) || match.status === STATUS.SCHEDULED ? ' vs ' : ` ${match.homeScore}–${match.awayScore} `
    document.title = `${match.homeTeam}${score}${match.awayTeam} · KhelScores`
    return () => {
      document.title = 'KhelScores'
    }
  }, [match])

  if (isPending) {
    return (
      <div className="space-y-6">
        <BackLink />
        <div className="max-w-xl"><MatchCardSkeleton /></div>
      </div>
    )
  }

  if (error) {
    return (
      <div className="space-y-6">
        <BackLink />
        <div className="rounded-lg border border-dashed border-line p-10 text-center">
          <p className="text-xl font-bold tracking-[0.15em] uppercase">
            {error.message === 'Match not found' ? 'Match not found' : "Couldn't load this match"}
          </p>
          <p className="mt-1 text-muted">{error.message === 'Match not found' ? 'It may have been removed.' : error.message}</p>
        </div>
      </div>
    )
  }

  const football = match.sport?.toLowerCase() === 'football'

  return (
    <div className="space-y-6">
      <BackLink />

      <div className="grid items-start gap-4 lg:grid-cols-[3fr_2fr]">
        <div className="min-w-0 space-y-4">
          <MatchCard match={match} link={false} />
          {isCricket(match) && match.status !== STATUS.SCHEDULED && <Scorecard match={match} query={scorecard} />}
          <UpdatesFeed match={match} />
        </div>

        <div className="min-w-0 space-y-4">
          <a
            href={googleMatchUrl(match)}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center justify-between gap-3 rounded-lg border border-amber/60 bg-amber/5 px-4 py-3 transition hover:bg-amber/10"
          >
            <span>
              <span className="block font-bold tracking-[0.12em] text-amber uppercase">Full match centre on Google</span>
              <span className="block text-sm text-muted">
                {football
                  ? 'Line-ups, goalscorers and match stats'
                  : isBasketball(match)
                    ? 'Box score, play-by-play and player stats'
                    : 'Ball-by-ball commentary and player stats'}
              </span>
            </span>
            <ExternalLink className="size-5 shrink-0 text-amber" aria-hidden />
            <span className="sr-only">(opens in a new tab)</span>
          </a>

          <MatchInfo match={match} scorecard={scorecard.data?.data} />
          {isBasketball(match) && <QuarterScores match={match} />}
          {football && <TeamStandings match={match} />}
          {match.source === 'football-data' && <HeadToHead match={match} />}
        </div>
      </div>
    </div>
  )
}
