// Adapter for football-data.org (v4). Turns their match format into rows for
// our `matches` table, so the rest of the app never sees provider-specific data.
// Docs: https://docs.football-data.org

import { MATCH_STATUS } from '../validation/matches.js';

export const SOURCE = 'football-data';

const BASE_URL = 'https://api.football-data.org/v4';

// They don't send an end time. A football match plus half-time and stoppage
// time is roughly 2 hours; this is only used for sorting and display, since
// their own status says when a match is live or finished.
const ESTIMATED_DURATION_MS = 2 * 60 * 60 * 1000;

const STATUS_MAP = {
    SCHEDULED: MATCH_STATUS.SCHEDULED,
    TIMED: MATCH_STATUS.SCHEDULED, // scheduled with a confirmed kick-off time
    POSTPONED: MATCH_STATUS.SCHEDULED,
    IN_PLAY: MATCH_STATUS.LIVE,
    PAUSED: MATCH_STATUS.LIVE, // half-time
    SUSPENDED: MATCH_STATUS.LIVE,
    FINISHED: MATCH_STATUS.FINISHED,
    AWARDED: MATCH_STATUS.FINISHED,
    CANCELLED: MATCH_STATUS.FINISHED,
};

// Converts one football-data.org match into a `matches` row.
// Returns null for matches we can't store yet, e.g. knockout games whose teams
// aren't decided (our home_team and away_team columns are required).
export function toMatchRow(match) {
    const homeTeam = match.homeTeam?.shortName || match.homeTeam?.name;
    const awayTeam = match.awayTeam?.shortName || match.awayTeam?.name;
    const status = STATUS_MAP[match.status];

    if (!homeTeam || !awayTeam || !status || !match.utcDate) return null;

    const startTime = new Date(match.utcDate);

    return {
        source: SOURCE,
        externalId: String(match.id),
        sport: 'Football',
        competition: match.competition?.name ?? null,
        homeTeam,
        awayTeam,
        status,
        startTime,
        endTime: new Date(startTime.getTime() + ESTIMATED_DURATION_MS),
        // fullTime holds the current score while a match is in play
        homeScore: match.score?.fullTime?.home ?? 0,
        awayScore: match.score?.fullTime?.away ?? 0,
    };
}

// Fetches matches between two dates (YYYY-MM-DD, inclusive) across every
// competition on the plan. One request, whatever the number of matches.
export async function fetchMatches({ dateFrom, dateTo, apiKey = process.env.FOOTBALL_DATA_API_KEY }) {
    const url = `${BASE_URL}/matches?dateFrom=${dateFrom}&dateTo=${dateTo}`;

    // The key goes in a header, never in the URL
    const res = await fetch(url, { headers: { 'X-Auth-Token': apiKey } });

    if (!res.ok) {
        const body = await res.text();
        throw new Error(`football-data.org responded ${res.status}: ${body.slice(0, 200)}`);
    }

    const { matches = [] } = await res.json();

    return matches.map(toMatchRow).filter(Boolean);
}
