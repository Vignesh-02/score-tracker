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

// Cricket: CricketData.org sends played, won, lost, tied and no result; the
// points (2 a win, 1 for a tie or no result) and the order are worked out on
// the server, without net run rate
function PointsTable({ standing, liveTeams }) {
  return (
    <div className="overflow-hidden rounded-lg border border-line bg-panel">
      {standing.group && (
        <p className="border-b border-line px-4 py-2.5 text-sm font-bold tracking-[0.15em] text-muted uppercase">{standing.group}</p>
      )}
      <table className="w-full table-fixed text-sm">
        <thead className="border-b border-line text-xs">
          <tr>
            <th scope="col" className={`${head} w-9 pl-3 text-left sm:w-12 sm:pl-4`}>
              <abbr title="Position">#</abbr>
            </th>
            <th scope="col" className={`${head} text-left`}>Team</th>
            <th scope="col" className={th}><abbr title="Played">P</abbr></th>
            <th scope="col" className={th}><abbr title="Won">W</abbr></th>
            <th scope="col" className={th}><abbr title="Lost">L</abbr></th>
            <th scope="col" className={`${th} hidden sm:table-cell`}><abbr title="Tied">T</abbr></th>
            <th scope="col" className={`${th} hidden sm:table-cell`}><abbr title="No result">NR</abbr></th>
            <th scope="col" className={`${head} w-10 pr-3 text-right text-amber sm:w-12 sm:pr-4`}><abbr title="Points">Pts</abbr></th>
          </tr>
        </thead>
        <tbody>
          {standing.table.map((row) => (
            <tr key={row.team} className="border-b border-line/60 last:border-0 hover:bg-line/30">
              <td className={`${td} pl-3 text-left text-muted sm:pl-4`}>{row.position}</td>
              <th scope="row" className="px-1.5 py-2 text-left font-semibold tracking-wide sm:px-2">
                <span className="flex items-center gap-2">
                  <Crest src={row.crest} />
                  <span className="min-w-0 truncate" title={row.team}>{row.team}</span>
                  {liveTeams.has(row.team) && <LiveDot />}
                </span>
              </th>
              <td className={td}>{row.played}</td>
              <td className={td}>{row.won}</td>
              <td className={td}>{row.lost}</td>
              <td className={`${td} hidden sm:table-cell`}>{row.tied}</td>
              <td className={`${td} hidden sm:table-cell`}>{row.noResult}</td>
              <td className={`${td} pr-3 font-bold text-amber sm:pr-4`}>{row.points}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function PointsNote() {
  return (
    <div className="rounded-lg border border-line bg-panel px-4 py-3 text-sm text-muted">
      <p className="font-bold tracking-[0.15em] uppercase">About this table</p>
      <p className="mt-2">2 points for a win, 1 for a tie or no result. Some tournaments award points differently.</p>
      <p className="mt-2">
        Net run rate isn't available, so teams level on points are ordered by wins and may differ from the official
        table.
      </p>
    </div>
  )
}

// Basketball: one table per conference, worked out on the server from the
// season's games. 1–6 go to the playoffs, 7–10 to the play-in.
function NbaTable({ standing, liveTeams }) {
  const gb = (value) => (value === 0 ? '–' : value.toFixed(1))
  const pct = (value) => value.toFixed(3).replace(/^0/, '')

  return (
    <div className="overflow-hidden rounded-lg border border-line bg-panel">
      <p className="border-b border-line px-4 py-2.5 text-sm font-bold tracking-[0.15em] text-muted uppercase">
        {standing.group === 'East' ? 'Eastern' : 'Western'} Conference
      </p>
      <table className="w-full table-fixed text-sm">
        <thead className="border-b border-line text-xs">
          <tr>
            <th scope="col" className={`${head} w-9 pl-3 text-left sm:w-12 sm:pl-4`}>
              <abbr title="Position">#</abbr>
            </th>
            <th scope="col" className={`${head} text-left`}>Team</th>
            <th scope="col" className={th}><abbr title="Won">W</abbr></th>
            <th scope="col" className={th}><abbr title="Lost">L</abbr></th>
            <th scope="col" className={`${head} w-12 text-right sm:w-14`}><abbr title="Win percentage">Pct</abbr></th>
            <th scope="col" className={`${th} hidden sm:table-cell`}><abbr title="Games behind the leader">GB</abbr></th>
            <th scope="col" className={`${head} hidden w-14 text-right md:table-cell`}>Home</th>
            <th scope="col" className={`${head} hidden w-14 text-right md:table-cell`}>Away</th>
            <th scope="col" className={`${head} hidden w-14 text-right lg:table-cell`}><abbr title="Last 10 games">L10</abbr></th>
            <th scope="col" className={`${head} w-12 pr-3 text-right sm:w-14 sm:pr-4`}><abbr title="Streak">Strk</abbr></th>
          </tr>
        </thead>
        <tbody>
          {standing.table.map((row) => (
            <tr
              key={row.team}
              className={`hover:bg-line/30 ${
                row.position === 6 ? 'border-b-2 border-dashed border-line' : row.position === 10 ? 'border-b-2 border-line' : 'border-b border-line/60 last:border-0'
              }`}
            >
              <td className={`${td} pl-3 text-left text-muted sm:pl-4`}>{row.position}</td>
              <th scope="row" className="px-1.5 py-2 text-left font-semibold tracking-wide sm:px-2">
                <span className="flex items-center gap-2">
                  <span className="min-w-0 truncate" title={row.team}>
                    <span className="sm:hidden">{row.abbr ?? row.team}</span>
                    <span className="hidden sm:inline">{row.team}</span>
                  </span>
                  {liveTeams.has(row.team) && <LiveDot />}
                </span>
              </th>
              <td className={td}>{row.won}</td>
              <td className={td}>{row.lost}</td>
              <td className={`${td} font-bold text-amber`}>{pct(row.pct)}</td>
              <td className={`${td} hidden sm:table-cell`}>{gb(row.gamesBehind)}</td>
              <td className={`${td} hidden text-muted md:table-cell`}>{row.home}</td>
              <td className={`${td} hidden text-muted md:table-cell`}>{row.away}</td>
              <td className={`${td} hidden text-muted lg:table-cell`}>{row.lastTen}</td>
              <td className={`${td} pr-3 sm:pr-4 ${row.streak?.startsWith('W') ? 'text-ink' : 'text-muted'}`}>{row.streak ?? '–'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

const ROUND_ORDER = ['NBA Finals', 'Conference finals', 'Conference semifinals', 'First round', 'Play-in']

// The playoffs as series, latest round first: "BOS 3–2 MIA"
function NbaPlayoffs({ series }) {
  const rounds = ROUND_ORDER.map((round) => [round, series.filter((s) => s.round === round)]).filter(([, list]) => list.length > 0)

  return (
    <div className="overflow-hidden rounded-lg border border-line bg-panel">
      <p className="border-b border-line px-4 py-2.5 text-sm font-bold tracking-[0.15em] text-muted uppercase">Playoffs</p>
      {rounds.map(([round, list]) => (
        <div key={round} className="border-b border-line/60 last:border-0">
          <p className="px-4 pt-3 pb-1 text-xs font-bold tracking-[0.15em] text-amber uppercase">{round}</p>
          <ul>
            {list.map((s) => {
              const [a, b] = s.teams
              const leader = a.wins === b.wins ? null : a.wins > b.wins ? a : b
              const status = s.winner
                ? `${s.winner === a.team ? a.abbr ?? a.team : b.abbr ?? b.team} ${s.round === 'Play-in' ? 'won' : `win ${Math.max(a.wins, b.wins)}–${Math.min(a.wins, b.wins)}`}`
                : leader
                  ? `${leader.abbr ?? leader.team} lead ${Math.max(a.wins, b.wins)}–${Math.min(a.wins, b.wins)}`
                  : `Tied ${a.wins}–${b.wins}`
              return (
                <li key={`${a.team}-${b.team}`} className="flex items-center gap-3 px-4 py-2 text-sm">
                  <span className="min-w-0 flex-1 truncate font-semibold tracking-wide">
                    {[a, b].map((t, i) => (
                      <span key={t.team} className={s.winner && s.winner !== t.team ? 'text-muted line-through' : ''}>
                        {i > 0 && <span className="text-muted no-underline"> v </span>}
                        {t.seed && <span className="font-mono text-xs text-muted">{t.seed} </span>}
                        {t.abbr ?? t.team}
                      </span>
                    ))}
                  </span>
                  <span className={`shrink-0 font-mono text-xs ${s.winner ? 'text-muted' : 'text-amber'}`}>{status}</span>
                </li>
              )
            })}
          </ul>
        </div>
      ))}
    </div>
  )
}

function NbaNote() {
  return (
    <div className="rounded-lg border border-line bg-panel px-4 py-3 text-sm text-muted">
      <p className="font-bold tracking-[0.15em] uppercase">About these tables</p>
      <p className="mt-2">1–6 go to the playoffs, 7–10 to the play-in.</p>
      <p className="mt-2">
        Worked out from this season's results. Teams level on win percentage are ordered by head-to-head; the NBA's
        other tie-breakers aren't applied, so a tied team may be a place out.
      </p>
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

const SPORT_LABELS = { Football: 'Football', Cricket: 'Cricket', Basketball: 'NBA' }

// Football or cricket, when both have tables
function SportSwitch({ sports, value, onChange }) {
  return (
    <div className="flex rounded-md border border-line bg-panel p-0.5" role="group" aria-label="Sport">
      {sports.map((sport) => (
        <button
          key={sport}
          type="button"
          onClick={() => onChange(sport)}
          aria-pressed={sport === value}
          className={`rounded-sm px-3 py-1 text-sm font-bold tracking-wider uppercase transition ${
            sport === value ? 'bg-amber text-on-amber' : 'text-muted hover:text-ink'
          }`}
        >
          {SPORT_LABELS[sport] ?? sport}
        </button>
      ))}
    </div>
  )
}

// The Tables tab: pick a sport and competition, see its table(s) and, for
// football, top scorers. The choice is the same sport and `competition`
// filters the match tabs use, so switching to Results afterwards shows that
// competition's results.
export function Tables({ competitionName, sportName, onSelect, matches }) {
  const now = useNow()
  const list = useQuery({ queryKey: competitionsQueryKey, queryFn: fetchCompetitions, staleTime: STALE_MS })
  const competitions = list.data ?? []
  const selected =
    competitions.find((c) => c.name === competitionName) ??
    competitions.find((c) => c.sport === sportName) ??
    competitions[0]
  const sports = [...new Set(competitions.map((c) => c.sport))]
  const sameSport = competitions.filter((c) => c.sport === selected?.sport)
  const cricket = selected?.sport === 'Cricket'
  const basketball = selected?.sport === 'Basketball'

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
    return <Message title="No tables yet">Tables appear here a few minutes after the server starts.</Message>
  }

  // Teams in this competition playing right now get a live dot
  const liveTeams = new Set(
    (matches ?? [])
      // NBA playoff games are listed as 'NBA Playoffs'
      .filter((m) => m.status === STATUS.LIVE && (m.competition === selected.name || (basketball && m.competition?.startsWith('NBA'))))
      .flatMap((m) => [m.homeTeam, m.awayTeam]),
  )

  const data = detail.data
  const standings = (data?.standings ?? []).filter((s) => s.stage !== 'PLAYOFFS')
  const playoffs = data?.standings?.find((s) => s.stage === 'PLAYOFFS')
  const matchday = data?.season?.currentMatchday

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        {sports.length > 1 && (
          <SportSwitch
            sports={sports}
            value={selected.sport}
            onChange={(sport) => onSelect(competitions.find((c) => c.sport === sport))}
          />
        )}
        <label className="relative w-full sm:w-auto">
          <span className="sr-only">Competition</span>
          <select
            value={selected.name}
            onChange={(e) => onSelect(sameSport.find((c) => c.name === e.target.value))}
            className="w-full appearance-none rounded-md border border-line bg-panel py-1.5 pr-9 pl-3.5 text-sm font-bold tracking-wider uppercase transition hover:border-muted focus:border-amber focus:outline-none sm:w-auto"
          >
            {sameSport.map((c) => (
              <option key={c.code} value={c.name}>
                {c.name}{c.area ? ` · ${c.area}` : ''}
              </option>
            ))}
          </select>
          <ChevronDown className="pointer-events-none absolute top-1/2 right-3 size-4 -translate-y-1/2 text-muted" aria-hidden />
        </label>
        {data && (
          <p className="font-mono text-xs text-muted">
            {matchday && !cricket && !basketball ? `Matchday ${matchday} · ` : ''}Updated {updatedAgo(data.updatedAt, now)}
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
            ) : cricket ? (
              standings.map((s) => <PointsTable key={s.group ?? 'all'} standing={s} liveTeams={liveTeams} />)
            ) : basketball ? (
              standings.map((s) => <NbaTable key={s.group} standing={s} liveTeams={liveTeams} />)
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
          {cricket ? (
            <PointsNote />
          ) : basketball ? (
            <div className="space-y-4">
              {playoffs && <NbaPlayoffs series={playoffs.series} />}
              <NbaNote />
            </div>
          ) : (
            <TopScorers scorers={data.scorers ?? []} />
          )}
        </div>
      )}
    </div>
  )
}
