// Adapter for CricketData.org (formerly CricAPI). Turns their match format into
// rows for our `matches` table, so the rest of the app never sees
// provider-specific data. Docs: https://cricketdata.org/how-to-use-cricket-data-api/
//
// Their data has quirks this file smooths over (all seen in real responses):
// - matchStarted can be false for a match already in play, so a score counts too
// - innings labels vary: "India Inning 1", "india Inning 1", or both teams
//   joined ("India,Pakistan Inning 1") for the second side to bat
// - there's no competition field; it's the end of the match name
// - matchType is sometimes missing
// - the response echoes the API key, so raw responses must never be logged

import { MATCH_STATUS } from '../validation/matches.js';

export const SOURCE = 'cricketdata';

const BASE_URL = 'https://api.cricapi.com/v1';

// Safety stop for pagination (25 matches a page); each page costs one hit
const MAX_PAGES = 4;

// They don't send an end time. Rough lengths, used only for sorting and
// display; their own flags say when a match is live or finished.
const HOUR_MS = 60 * 60 * 1000;
const ESTIMATED_DURATION_MS = {
    t10: 2 * HOUR_MS,
    t20: 4 * HOUR_MS,
    odi: 9 * HOUR_MS,
    test: 5 * 24 * HOUR_MS,
};
const DEFAULT_DURATION_MS = 8 * HOUR_MS;

const normalise = (text) => (text ?? '').trim().toLowerCase();

// "Pakistan vs Sri Lanka, 1st Test, Sri Lanka tour of Pakistan, 2026"
//   → "Sri Lanka tour of Pakistan 2026"
// "Pakistan U19 vs Nepal U19, 12th Match, Group A, ACC Mens U19 Asia Cup 2026"
//   → "ACC Mens U19 Asia Cup 2026"
export function parseCompetition(name) {
    const parts = (name ?? '').split(',').map((p) => p.trim()).filter(Boolean);
    if (parts.length < 3) return null;

    const last = parts.at(-1);
    // A bare year ("2026", "2026-27") belongs to the series name before it
    if (/^\d{4}(-\d{2,4})?$/.test(last) && parts.length > 3) return `${parts.at(-2)} ${last}`;
    return last;
}

// Works out which side batted in each innings. `teams` is [home, away].
// Labels that name one team exactly are used as-is; anything else (the joined
// "A,B Inning 1" form) is the side that didn't bat in the previous innings.
export function assignInnings(score = [], teams = []) {
    const [home, away] = teams.map(normalise);
    let previous = null;

    return score.map((s) => {
        const label = normalise(s.inning);
        const number = Number(label.match(/inning\s+(\d+)$/)?.[1] ?? 1);
        const team = label.replace(/\s*inning\s+\d+$/, '');

        let side = team === home ? 'home' : team === away ? 'away' : null;
        if (!side) side = previous === 'home' ? 'away' : 'home';
        previous = side;

        return { side, number, runs: s.r ?? 0, wickets: s.w ?? 0, overs: s.o ?? 0 };
    });
}

function statusOf(match, innings) {
    if (match.matchEnded) return MATCH_STATUS.FINISHED;
    if (match.matchStarted || innings.length > 0) return MATCH_STATUS.LIVE;
    return MATCH_STATUS.SCHEDULED;
}

// Converts one CricketData.org match into a `matches` row. Returns null for
// matches we can't store (no teams or no date).
export function toMatchRow(match) {
    const [homeTeam, awayTeam] = match.teams ?? [];
    const when = match.dateTimeGMT ?? match.date;
    if (!homeTeam || !awayTeam || !when) return null;

    // dateTimeGMT has no time zone suffix, but it is UTC
    const startTime = new Date(/[zZ]|[+-]\d\d:?\d\d$/.test(when) ? when : `${when}Z`);
    if (Number.isNaN(startTime.getTime())) return null;

    const format = match.matchType ? normalise(match.matchType) : null;
    const innings = assignInnings(match.score, [homeTeam, awayTeam]);
    const total = (side) => innings.filter((i) => i.side === side).reduce((sum, i) => sum + i.runs, 0);

    return {
        source: SOURCE,
        externalId: String(match.id),
        sport: 'Cricket',
        competition: parseCompetition(match.name),
        homeTeam,
        awayTeam,
        status: statusOf(match, innings),
        startTime,
        endTime: new Date(startTime.getTime() + (ESTIMATED_DURATION_MS[format] ?? DEFAULT_DURATION_MS)),
        homeScore: total('home'),
        awayScore: total('away'),
        details: {
            format,
            statusText: match.status || null,
            innings,
        },
    };
}

// One page of /currentMatches. The key goes in the query string because that's
// the only way this API accepts it, so the URL must never be logged.
async function requestPage(offset, apiKey) {
    const res = await fetch(`${BASE_URL}/currentMatches?offset=${offset}&apikey=${encodeURIComponent(apiKey)}`);

    if (!res.ok) throw new Error(`CricketData.org responded ${res.status}`);

    const body = await res.json();
    if (body.status !== 'success') {
        // e.g. "hits today exceeded hits limit"
        throw new Error(`CricketData.org: ${String(body.reason ?? body.status).slice(0, 200)}`);
    }

    return { data: body.data ?? [], info: body.info ?? {} };
}

// Fetches every current match (recent, live and about to start), across as
// many pages as needed. Returns the rows plus the account's usage, which the
// sync job uses to pace itself.
export async function fetchCurrentMatches({ apiKey = process.env.CRICKETDATA_API_KEY } = {}) {
    const rows = [];
    let offset = 0;
    let info = {};
    let pages = 0;

    while (pages < MAX_PAGES) {
        const page = await requestPage(offset, apiKey);
        pages++;
        info = page.info;
        rows.push(...page.data.map(toMatchRow).filter(Boolean));

        offset += page.data.length;
        if (page.data.length === 0 || offset >= (info.totalRows ?? 0)) break;
    }

    return {
        rows,
        pages,
        hitsToday: info.hitsToday ?? null,
        hitsLimit: info.hitsLimit ?? null,
    };
}
