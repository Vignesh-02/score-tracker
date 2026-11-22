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
            // CricketData.org only has scorecards for "fantasy enabled" matches
            hasScorecard: Boolean(match.fantasyEnabled),
            // The tournament or tour it belongs to, for its points table
            seriesId: match.series_id ? String(match.series_id) : null,
        },
    };
}

// One call to the API. The key goes in the query string because that's the
// only way this API accepts it, so the URL must never be logged.
async function call(path, params, apiKey) {
    const query = new URLSearchParams({ ...params, apikey: apiKey });
    const res = await fetch(`${BASE_URL}/${path}?${query}`);

    if (!res.ok) throw new Error(`CricketData.org responded ${res.status}`);

    const body = await res.json();
    if (body.status !== 'success') {
        // e.g. "hits today exceeded hits limit"
        throw new Error(`CricketData.org: ${String(body.reason ?? body.status).slice(0, 200)}`);
    }

    return { data: body.data, info: body.info ?? {} };
}

// One page of /currentMatches
async function requestPage(offset, apiKey) {
    const { data, info } = await call('currentMatches', { offset }, apiKey);
    return { data: data ?? [], info };
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
        // false when MAX_PAGES stopped it early: then a match missing from
        // `rows` may just be on a page that wasn't read
        complete: offset >= (info.totalRows ?? 0),
        hitsToday: info.hitsToday ?? null,
        hitsLimit: info.hitsLimit ?? null,
    };
}

// ---------- fixtures and single matches ----------

// /currentMatches only holds matches from about a day before to a day after
// now. /matches lists every match CricketData.org has (17,000+), ordered by
// series rather than date, with the latest series first, so its first few
// pages hold most fixtures for the next week or two.
export const FIXTURE_PAGES = 3;

export async function fetchFixtures({ pages = FIXTURE_PAGES, apiKey = process.env.CRICKETDATA_API_KEY } = {}) {
    const rows = [];
    let offset = 0;
    let info = {};
    let read = 0;

    while (read < pages) {
        const page = await call('matches', { offset }, apiKey);
        const data = page.data ?? [];
        read++;
        info = page.info;
        rows.push(...data.map(toMatchRow).filter(Boolean));

        offset += data.length;
        if (data.length === 0 || offset >= (info.totalRows ?? 0)) break;
    }

    return { rows, pages: read, hitsToday: info.hitsToday ?? null, hitsLimit: info.hitsLimit ?? null };
}

// One match by id (1 hit). `row` is null if they sent nothing usable.
export async function fetchMatchInfo(externalId, { apiKey = process.env.CRICKETDATA_API_KEY } = {}) {
    const { data, info } = await call('match_info', { id: externalId }, apiKey);
    return { row: data ? toMatchRow(data) : null, hitsToday: info.hitsToday ?? null, hitsLimit: info.hitsLimit ?? null };
}

// ---------- points tables ----------

// A series' points table (1 hit). CricketData.org sends played, won, lost,
// tied and no-result per team, in alphabetical order, with no points or net
// run rate. Points here are the usual 2 a win and 1 for a tie or no result;
// teams level on points are ordered by wins, then name, since the official
// tie-breaker (net run rate) isn't available.
export const WIN_POINTS = 2;
export const SHARED_POINTS = 1;

// [{ position, team, crest, played, won, lost, tied, noResult, points }]
export function toPointsTable(data) {
    const rows = (Array.isArray(data) ? data : [])
        .filter((t) => t?.teamname)
        .map((t) => {
            const won = t.wins ?? 0;
            const tied = t.ties ?? 0;
            const noResult = t.nr ?? 0;
            return {
                team: t.teamname.trim(),
                crest: t.img || null,
                played: t.matches ?? 0,
                won,
                lost: t.loss ?? 0,
                tied,
                noResult,
                points: won * WIN_POINTS + (tied + noResult) * SHARED_POINTS,
            };
        })
        .sort((a, b) => b.points - a.points || b.won - a.won || a.team.localeCompare(b.team));

    return rows.map((row, i) => ({ position: i + 1, ...row }));
}

export async function fetchSeriesPoints(seriesId, { apiKey = process.env.CRICKETDATA_API_KEY } = {}) {
    const { data, info } = await call('series_points', { id: seriesId }, apiKey);
    return { table: toPointsTable(data), hitsToday: info.hitsToday ?? null, hitsLimit: info.hitsLimit ?? null };
}

// ---------- scorecards ----------

// A scorecard costs 10 hits (the response's info.hitsUsed), against 1 for a
// page of currentMatches, so the scorecard route rations them.
export const SCORECARD_HITS = 10;

const playerName = (p) => p?.name?.trim() || 'Unknown';

// Converts a /match_scorecard response into what the match page shows:
// { venue, toss: { team, choice }, final, innings: [{ side, number, batting, bowling }] }
// Batting rows: { name, dismissal ("c X b Y", "batting", "not out"), out, runs, balls, fours, sixes, strikeRate }
// Bowling rows: { name, overs, maidens, runs, wickets, noBalls, wides, economy }
export function toScorecard(data) {
    const teams = data.teams ?? [];
    const cards = data.scorecard ?? [];
    const sides = assignInnings(cards.map((c) => ({ inning: c.inning })), teams);

    // The toss winner comes lower-cased ("uganda women")
    const tossTeam = teams.find((t) => normalise(t) === normalise(data.tossWinner)) ?? data.tossWinner;

    return {
        venue: data.venue || null,
        toss: data.tossWinner ? { team: tossTeam, choice: data.tossChoice || null } : null,
        final: Boolean(data.matchEnded),
        innings: cards.map((card, i) => ({
            side: sides[i].side,
            number: sides[i].number,
            batting: (card.batting ?? []).map((b) => ({
                name: playerName(b.batsman),
                dismissal: b['dismissal-text'] || null,
                out: Boolean(b.dismissal),
                runs: b.r ?? 0,
                balls: b.b ?? 0,
                fours: b['4s'] ?? 0,
                sixes: b['6s'] ?? 0,
                strikeRate: b.sr ?? null,
            })),
            bowling: (card.bowling ?? []).map((b) => ({
                name: playerName(b.bowler),
                overs: b.o ?? 0,
                maidens: b.m ?? 0,
                runs: b.r ?? 0,
                wickets: b.w ?? 0,
                noBalls: b.nb ?? 0,
                wides: b.wd ?? 0,
                economy: b.eco ?? null,
            })),
        })),
    };
}

export async function fetchScorecard(externalId, { apiKey = process.env.CRICKETDATA_API_KEY } = {}) {
    const { data, info } = await call('match_scorecard', { id: externalId }, apiKey);
    return {
        scorecard: toScorecard(data ?? {}),
        hitsToday: info.hitsToday ?? null,
        hitsLimit: info.hitsLimit ?? null,
    };
}
