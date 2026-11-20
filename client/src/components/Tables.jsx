import { useQuery } from '@tanstack/react-query'
import { ChevronDown } from 'lucide-react'
import { competitionQueryKey, competitionsQueryKey, fetchCompetition, fetchCompetitions } from '../lib/api.js'
import { STATUS } from '../lib/matches.js'
import { useNow } from '../lib/useNow.js'
import { updatedAgo } from '../lib/time.js'

// The server refreshes each table every 30 minutes
const STALE_MS = 5 * 60_000

// 'GROUP_A' → 'Group A', 'LEAGUE_STAGE' → 'League stage'
const humanize = (value) => {
  const text = value.toLowerCase().replaceAll('_', ' ')
  return text.charAt(0).toUpperCase() + text.slice(1).replace(/ ([a-z])$/, (m) => m.toUpperCase())
}

// A heading for each table when a competition has more than one (groups, stages)
function tableTitle(standing, count) {
  if (count === 1) return null
  return humanize(standing.group ?? standing.stage ?? '')
}

function Crest({ src }) {
  return src ? (
    <img src={src} alt="" loading="lazy" className="size-5 shrink-0 object-contain" />
  ) : (
    <span className="size-5 shrink-0" />
  )
}

function LiveDot() {
  return (
    <span className="relative flex size-2 shrink-0" title="Playing now">
      <span className="absolute inline-flex size-full animate-ping rounded-full bg-live opacity-75" />
      <span className="relative inline-flex size-2 rounded-full bg-live" />
      <span className="sr-only">Playing now</span>
    </span>
  )
}

// Fixed-width number columns (table-fixed), so the team name gets the rest
const head = 'px-1.5 py-2 font-bold tracking-[0.15em] text-muted uppercase sm:px-2'
const th = `${head} w-9 text-right sm:w-11`
const td = 'px-1.5 py-2 text-right font-mono tabular-nums sm:px-2'

function StandingsTable({ standing, title, liveTeams }) {
  return (
    <div className="overflow-hidden rounded-lg border border-line bg-panel">
      {title && (
        <p className="border-b border-line px-4 py-2.5 text-sm font-bold tracking-[0.15em] text-muted uppercase">{title}</p>
      )}
      <table className="w-full table-fixed text-sm">
        <thead className="border-b border-line text-xs">
          <tr>
            <th scope="col" className={`${head} w-9 pl-3 text-left sm:w-12 sm:pl-4`}>
              <abbr title="Position">#</abbr>
            </th>
            <th scope="col" className={`${head} text-left`}>Team</th>
            <th scope="col" className={th}><abbr title="Played">P</abbr></th>
            <th scope="col" className={`${th} hidden sm:table-cell`}><abbr title="Won">W</abbr></th>
            <th scope="col" className={`${th} hidden sm:table-cell`}><abbr title="Drawn">D</abbr></th>
            <th scope="col" className={`${th} hidden sm:table-cell`}><abbr title="Lost">L</abbr></th>
            <th scope="col" className={`${head} hidden w-16 text-right md:table-cell`}><abbr title="Goals for and against">Goals</abbr></th>
            <th scope="col" className={th}><abbr title="Goal difference">GD</abbr></th>
            <th scope="col" className={`${head} w-10 pr-3 text-right text-amber sm:w-12 sm:pr-4`}><abbr title="Points">Pts</abbr></th>
          </tr>
        </thead>
        <tbody>
          {standing.table.map((row) => {
            const live = liveTeams.has(row.team)
            return (
              <tr key={row.team} className="border-b border-line/60 last:border-0 hover:bg-line/30">
                <td className={`${td} pl-3 text-left text-muted sm:pl-4`}>{row.position}</td>
                <th scope="row" className="px-1.5 py-2 text-left font-semibold tracking-wide sm:px-2">
                  <span className="flex items-center gap-2">
                    <Crest src={row.crest} />
                    <span className="min-w-0 truncate" title={row.team}>{row.team}</span>
                    {live && <LiveDot />}
                  </span>
                </th>
                <td className={td}>{row.played}</td>
                <td className={`${td} hidden sm:table-cell`}>{row.won}</td>
                <td className={`${td} hidden sm:table-cell`}>{row.draw}</td>
                <td className={`${td} hidden sm:table-cell`}>{row.lost}</td>
                <td className={`${td} hidden text-muted md:table-cell`}>
                  {row.goalsFor}:{row.goalsAgainst}
                </td>
                <td className={td}>{row.goalDifference > 0 ? `+${row.goalDifference}` : row.goalDifference}</td>
                <td className={`${td} pr-3 font-bold text-amber sm:pr-4`}>{row.points}</td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

function TopScorers({ scorers }) {
  const showAssists = scorers.some((s) => s.assists != null)

  return (
    <div className="overflow-hidden rounded-lg border border-line bg-panel">
      <div className="flex items-center gap-3 border-b border-line px-4 py-2.5 text-sm font-bold tracking-[0.15em] text-muted uppercase">
        <p className="flex-1">Top scorers</p>
        {showAssists && <abbr title="Assists" className="w-8 text-right text-xs">Ast</abbr>}
        <abbr title="Goals" className="w-8 text-right text-xs">Goals</abbr>
      </div>
      {scorers.length === 0 ? (
        <p className="px-4 py-6 text-center text-muted">No goals yet this season.</p>
      ) : (
        <ol>
          {scorers.map((s, i) => (
            <li key={`${s.player}-${s.team}`} className="flex items-center gap-3 border-b border-line/60 px-4 py-2 last:border-0">
              <span className="w-5 shrink-0 font-mono text-sm text-muted tabular-nums">{i + 1}</span>
              <Crest src={s.crest} />
              <span className="min-w-0 flex-1">
                <span className="block truncate font-semibold tracking-wide">{s.player}</span>
                <span className="block truncate text-xs text-muted">{s.team}</span>
              </span>
              {showAssists && (
                <span className="w-8 shrink-0 text-right font-mono text-sm text-muted tabular-nums">
                  {s.assists ?? '–'}
                </span>
              )}
              <span className="w-8 shrink-0 text-right font-score text-2xl leading-none font-bold text-amber tabular-nums">
                {s.goals}
              </span>
            </li>
          ))}
        </ol>
      )}
    </div>
  )
}

function TablesSkeleton() {
  return (
    <div className="grid animate-pulse gap-4 lg:grid-cols-[2fr_1fr]" aria-hidden>
      <div className="h-96 rounded-lg border border-line bg-panel" />
      <div className="h-64 rounded-lg border border-line bg-panel" />
    </div>
  )
}

function Message({ title, children }) {
  return (
    <div className="rounded-lg border border-dashed border-line p-10 text-center">
      <p className="text-xl font-bold tracking-[0.15em] uppercase">{title}</p>
      {children && <p className="mt-1 text-muted">{children}</p>}
    </div>
  )
}

// The Tables tab: pick a competition, see its table(s) and top scorers. The
// choice is the same `competition` filter the match tabs use, so switching to
// Results afterwards shows that competition's results.
export function Tables({ competitionName, onSelect, matches }) {
  const now = useNow()
  const list = useQuery({ queryKey: competitionsQueryKey, queryFn: fetchCompetitions, staleTime: STALE_MS })
  const competitions = list.data ?? []
  const selected = competitions.find((c) => c.name === competitionName) ?? competitions[0]

  const detail = useQuery({
    queryKey: competitionQueryKey(selected?.code),
    queryFn: () => fetchCompetition(selected.code),
    enabled: Boolean(selected),
    staleTime: STALE_MS,
    refetchInterval: STALE_MS,
  })

  if (list.isPending) return <TablesSkeleton />
  if (list.error) return <Message title="Couldn't load tables">{list.error.message}</Message>
  if (competitions.length === 0) {
    return <Message title="No tables yet">League tables appear here a few minutes after the server starts.</Message>
  }

  // Teams in this competition playing right now get a live dot
  const liveTeams = new Set(
    (matches ?? [])
      .filter((m) => m.status === STATUS.LIVE && m.competition === selected.name)
      .flatMap((m) => [m.homeTeam, m.awayTeam]),
  )

  const data = detail.data
  const standings = data?.standings ?? []
  const matchday = data?.season?.currentMatchday

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <label className="relative w-full sm:w-auto">
          <span className="sr-only">Competition</span>
          <select
            value={selected.name}
            onChange={(e) => onSelect(e.target.value)}
            className="w-full appearance-none rounded-md border border-line bg-panel py-1.5 pr-9 pl-3.5 text-sm font-bold tracking-wider uppercase transition hover:border-muted focus:border-amber focus:outline-none sm:w-auto"
          >
            {competitions.map((c) => (
              <option key={c.code} value={c.name}>
                {c.name}{c.area ? ` · ${c.area}` : ''}
              </option>
            ))}
          </select>
          <ChevronDown className="pointer-events-none absolute top-1/2 right-3 size-4 -translate-y-1/2 text-muted" aria-hidden />
        </label>
        {data && (
          <p className="font-mono text-xs text-muted">
            {matchday ? `Matchday ${matchday} · ` : ''}Updated {updatedAgo(data.updatedAt, now)}
          </p>
        )}
      </div>

      {detail.isPending ? (
        <TablesSkeleton />
      ) : detail.error ? (
        <Message title="Couldn't load this table">{detail.error.message}</Message>
      ) : (
        <div className="grid items-start gap-4 lg:grid-cols-[2fr_1fr]">
          <div className="min-w-0 space-y-4">
            {standings.length === 0 ? (
              <Message title="No table for this competition">It may be in a knockout round.</Message>
            ) : (
              standings.map((s) => (
                <StandingsTable
                  key={`${s.stage}-${s.group}`}
                  standing={s}
                  title={tableTitle(s, standings.length)}
                  liveTeams={liveTeams}
                />
              ))
            )}
          </div>
          <TopScorers scorers={data.scorers ?? []} />
        </div>
      )}
    </div>
  )
}
