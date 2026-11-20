import { useState } from 'react'
import { Empty, Panel } from './Panel.jsx'
import { STATUS } from '../lib/matches.js'
import { updatedAgo } from '../lib/time.js'
import { useNow } from '../lib/useNow.js'

// The batting and bowling card of a cricket match, one innings at a time.
// `query` is the scorecard query from the match page: { data, reason }.

const ordinal = (n) => ['1st', '2nd', '3rd', '4th'][n - 1] ?? `${n}th`

const head = 'px-2 py-2 text-right font-bold'
const cell = 'px-2 py-2 text-right font-mono tabular-nums'

// No extras row: the scorecard can be a few minutes behind the live score, so
// working them out from the two would be wrong
function Batting({ innings, total }) {
  return (
    <>
    <table className="w-full table-fixed text-sm">
      <thead className="border-b border-line text-xs text-muted uppercase">
        <tr>
          <th scope="col" className="px-4 py-2 text-left font-bold">Batter</th>
          <th scope="col" className={`${head} w-11 text-amber`}><abbr title="Runs">R</abbr></th>
          <th scope="col" className={`${head} w-11`}><abbr title="Balls">B</abbr></th>
          <th scope="col" className={`${head} hidden w-10 sm:table-cell`}>4s</th>
          <th scope="col" className={`${head} hidden w-10 sm:table-cell`}>6s</th>
          <th scope="col" className={`${head} w-16 pr-4`}><abbr title="Strike rate">SR</abbr></th>
        </tr>
      </thead>
      <tbody>
        {innings.batting.map((b) => (
          <tr key={b.name} className="border-b border-line/60">
            <th scope="row" className="px-4 py-2 text-left font-normal">
              <span className={`block truncate font-semibold ${b.out ? '' : 'text-amber'}`}>
                {b.name}{!b.out && <span aria-label="not out">*</span>}
              </span>
              {b.dismissal && <span className="block truncate text-xs text-muted">{b.dismissal}</span>}
            </th>
            <td className={`${cell} font-bold`}>{b.runs}</td>
            <td className={cell}>{b.balls}</td>
            <td className={`${cell} hidden sm:table-cell`}>{b.fours}</td>
            <td className={`${cell} hidden sm:table-cell`}>{b.sixes}</td>
            <td className={`${cell} pr-4 text-muted`}>{b.strikeRate ?? '–'}</td>
          </tr>
        ))}
      </tbody>
    </table>
    {/* Outside the table: a row spanning columns hidden on phones would widen it */}
    {total && (
      <div className="flex items-baseline justify-between gap-3 border-b border-line px-4 py-2 text-sm">
        <span className="font-bold tracking-[0.12em] uppercase">Total</span>
        <span className="font-mono font-bold whitespace-nowrap">
          {total.runs}/{total.wickets} <span className="font-normal text-muted">({total.overs} ov)</span>
        </span>
      </div>
    )}
    </>
  )
}

function Bowling({ innings }) {
  return (
    <table className="w-full table-fixed text-sm">
      <thead className="border-b border-line text-xs text-muted uppercase">
        <tr>
          <th scope="col" className="px-4 py-2 text-left font-bold">Bowler</th>
          <th scope="col" className={`${head} w-11`}><abbr title="Overs">O</abbr></th>
          <th scope="col" className={`${head} hidden w-10 sm:table-cell`}><abbr title="Maidens">M</abbr></th>
          <th scope="col" className={`${head} w-11`}><abbr title="Runs">R</abbr></th>
          <th scope="col" className={`${head} w-11 text-amber`}><abbr title="Wickets">W</abbr></th>
          <th scope="col" className={`${head} w-16 pr-4`}><abbr title="Economy">Econ</abbr></th>
        </tr>
      </thead>
      <tbody>
        {innings.bowling.map((b) => (
          <tr key={b.name} className="border-b border-line/60 last:border-0">
            <th scope="row" className="truncate px-4 py-2 text-left font-semibold">{b.name}</th>
            <td className={cell}>{b.overs}</td>
            <td className={`${cell} hidden sm:table-cell`}>{b.maidens}</td>
            <td className={cell}>{b.runs}</td>
            <td className={`${cell} font-bold text-amber`}>{b.wickets}</td>
            <td className={`${cell} pr-4 text-muted`}>{b.economy ?? '–'}</td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

export function Scorecard({ match, query }) {
  const now = useNow()
  const innings = query.data?.data?.innings ?? []
  const [picked, setPicked] = useState(null)

  if (query.isPending) return <Panel title="Scorecard"><Empty>Loading scorecard…</Empty></Panel>
  if (query.error) return <Panel title="Scorecard"><Empty>Couldn't load the scorecard: {query.error.message}</Empty></Panel>

  const { data, reason } = query.data

  if (!data) {
    // Only worth saying when there will be one later; otherwise no panel at all
    if (reason !== 'limit') return null
    return (
      <Panel title="Scorecard">
        <Empty>The scorecard is paused for now to save today's data allowance. The score above still updates.</Empty>
      </Panel>
    )
  }

  if (innings.length === 0) {
    return <Panel title="Scorecard"><Empty>The scorecard appears once the first ball is bowled.</Empty></Panel>
  }

  // The innings being played (the last) unless another was picked
  const index = picked != null && picked < innings.length ? picked : innings.length - 1
  const current = innings[index]
  const teamFor = (side) => (side === 'home' ? match.homeTeam : match.awayTeam)
  const total = (match.details?.innings ?? []).find((i) => i.side === current.side && i.number === current.number)
  const updated = `Updated ${updatedAgo(data.fetchedAt, now)}`

  return (
    <Panel
      title="Scorecard"
      action={
        <span className="font-mono text-xs text-muted">
          {data.final ? 'Final' : data.stale ? `${updated} · paused to save data` : updated}
        </span>
      }
    >
      {innings.length > 1 && (
        <div role="tablist" aria-label="Innings" className="flex gap-1 overflow-x-auto border-b border-line px-3 py-2">
          {innings.map((i, n) => (
            <button
              key={`${i.side}-${i.number}`}
              type="button"
              role="tab"
              aria-selected={n === index}
              onClick={() => setPicked(n)}
              className={`shrink-0 rounded-sm px-2.5 py-1 text-sm font-bold tracking-[0.08em] whitespace-nowrap transition ${
                n === index ? 'bg-amber text-on-amber' : 'text-muted hover:text-ink'
              }`}
            >
              {teamFor(i.side)}{match.details?.format === 'test' ? ` · ${ordinal(i.number)}` : ''}
            </button>
          ))}
        </div>
      )}

      <h3 className="sr-only">{teamFor(current.side)} batting</h3>
      <Batting innings={current} total={total} />

      {current.bowling.length > 0 && (
        <>
          <h3 className="border-b border-line px-4 pt-4 pb-2 text-xs font-bold tracking-[0.15em] text-muted uppercase">
            {teamFor(current.side === 'home' ? 'away' : 'home')} bowling
          </h3>
          <Bowling innings={current} />
        </>
      )}

      {match.status === STATUS.LIVE && !data.stale && (
        <p className="border-t border-line px-4 py-2 text-xs text-muted">Refreshes every few minutes while the match is live.</p>
      )}
    </Panel>
  )
}
