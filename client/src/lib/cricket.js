// Helpers for cricket matches. The server stores each innings in
// match.details.innings as { side: 'home' | 'away', number, runs, wickets, overs },
// and the latest status ("India need 32 runs from 18 balls") in details.statusText.

import { STATUS } from './matches.js'

export const isCricket = (match) => match.sport?.toLowerCase() === 'cricket'

export const inningsOf = (match, side) => (match.details?.innings ?? []).filter((i) => i.side === side)

// "245/6", or just "245" when all out
export const formatInnings = ({ runs, wickets }) => (wickets >= 10 ? String(runs) : `${runs}/${wickets}`)

// Which side to light up: the side batting now while live, the winner once
// finished (worked out from "India won by 4 runs"), nobody otherwise.
export function highlightedSide(match) {
  if (match.status === STATUS.LIVE) return match.details?.innings?.at(-1)?.side ?? null

  if (match.status === STATUS.FINISHED) {
    const text = match.details?.statusText?.toLowerCase() ?? ''
    if (!text.includes(' won')) return null
    if (text.startsWith(match.homeTeam.toLowerCase())) return 'home'
    if (text.startsWith(match.awayTeam.toLowerCase())) return 'away'
  }

  return null
}

const FORMATS = { test: 'Test', odi: 'ODI', t20: 'T20', t10: 'T10' }
export const formatLabel = (match) => FORMATS[match.details?.format] ?? null
