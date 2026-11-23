// Adapter for BALLDONTLIE's NBA API (v1). Turns their game format into rows for
// our `matches` table, so the rest of the app never sees provider-specific data.
// Docs: https://docs.balldontlie.io
//
// The free plan has teams, players and games (scores are live while a game is
// in progress) at 5 requests a minute. Each game carries its period, the clock
// within it and the score of each quarter.

import { MATCH_STATUS } from '../validation/matches.js';

export const SOURCE = 'balldontlie';

const BASE_URL = 'https://api.balldontlie.io/v1';

// The most games one request can return
export const PER_PAGE = 100;

// They don't send an end time. An NBA game takes about 2.5 hours; this is only
// used for sorting and display, since their status says when one is over.
const ESTIMATED_DURATION_MS = 2.5 * 60 * 60 * 1000;

// status_state: their lifecycle, simpler to rely on than `status`, which is
// "7:00 pm ET" before tip-off, then "1st Qtr" … "Final"
const STATUS_MAP = {
    scheduled: MATCH_STATUS.SCHEDULED,
    postponed: MATCH_STATUS.SCHEDULED,
    delayed: MATCH_STATUS.SCHEDULED,
    in_progress: MATCH_STATUS.LIVE,
    suspended: MATCH_STATUS.LIVE,
    final: MATCH_STATUS.FINISHED,
    canceled: MATCH_STATUS.FINISHED,
    abandoned: MATCH_STATUS.FINISHED,
};

// The lifecycle from `status` when status_state is missing or "unknown"
function statusFromText(status) {
    if (/^final/i.test(status ?? '')) return MATCH_STATUS.FINISHED;
    if (/qtr|half|ot\b|overtime/i.test(status ?? '')) return MATCH_STATUS.LIVE;
    return MATCH_STATUS.SCHEDULED;
}

const QUARTERS = ['q1', 'q2', 'q3', 'q4', 'ot1', 'ot2', 'ot3'];

// Points per quarter (and overtime) so far, e.g. [29, 34, 28]
function quarterScores(game, side) {
    return QUARTERS.map((q) => game[`${side}_${q}`]).filter((points) => points != null);
}

// Their `time` while live is "Q4 6:47", "Q3 :49.8" or "2OT 1:05" (not the
// bare "6:47" their docs describe). Returns "6:47", "0:49", or null between
// periods ("Half", "End Q1") and when it isn't a clock.
export function parseClock(time) {
    const rest = (time ?? '').trim().replace(/^(Q\d|\d*OT)\s*/i, '');
    const found = rest.match(/^(\d*):(\d{2})/);
    if (!found) return null;
    return `${Number(found[1] || 0)}:${found[2]}`;
}

// Converts one BALLDONTLIE game into a `matches` row. Returns null for games
// we can't store (no teams or no date).
export function toMatchRow(game) {
    const homeTeam = game.home_team?.full_name;
    const awayTeam = game.visitor_team?.full_name;
    // `datetime` is the tip-off in UTC; older games only have a date
    const when = game.datetime ?? (game.date ? `${game.date}T00:00:00Z` : null);
    if (!homeTeam || !awayTeam || !when) return null;

    const startTime = new Date(when);
    if (Number.isNaN(startTime.getTime())) return null;

    const status = STATUS_MAP[game.status_state] ?? statusFromText(game.status);
    const quarters = { home: quarterScores(game, 'home'), away: quarterScores(game, 'visitor') };

    return {
        source: SOURCE,
        externalId: String(game.id),
        sport: 'Basketball',
        competition: game.postseason ? 'NBA Playoffs' : 'NBA',
        homeTeam,
        awayTeam,
        status,
        startTime,
        endTime: new Date(startTime.getTime() + ESTIMATED_DURATION_MS),
        homeScore: game.home_team_score ?? 0,
        awayScore: game.visitor_team_score ?? 0,
        details: {
            // 0 before tip-off, 1–4 the quarters, 5+ overtime
            period: status === MATCH_STATUS.SCHEDULED ? 0 : game.period ?? 0,
            // Time left in the period ("3:44"); null between periods and when not live
            clock: status === MATCH_STATUS.LIVE ? parseClock(game.time) : null,
            // Their status while live: "2nd Qtr", "Halftime"
            statusText: status === MATCH_STATUS.LIVE ? game.status || null : null,
            quarters: quarters.home.length || quarters.away.length ? quarters : null,
            homeAbbr: game.home_team?.abbreviation ?? null,
            awayAbbr: game.visitor_team?.abbreviation ?? null,
            // For the conference standings (src/live/nba-standings.js)
            homeConference: game.home_team?.conference ?? null,
            awayConference: game.visitor_team?.conference ?? null,
            season: game.season ?? null,
            // NBA Cup round ("East Group A", "Championship"); the final doesn't
            // count in the standings
            cupStage: game.ist_stage ?? null,
        },
    };
}

// One request. The key goes in the Authorization header.
async function call(path, params, apiKey) {
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
        for (const v of [value].flat()) if (v != null) query.append(key, v);
    }

    const res = await fetch(`${BASE_URL}/${path}?${query}`, { headers: { Authorization: apiKey } });
    if (!res.ok) {
        const error = new Error(`BALLDONTLIE responded ${res.status}`);
        error.status = res.status;
        throw error;
    }
    return res.json();
}

// Games on the given dates (YYYY-MM-DD, US dates as they list them), or from
// startDate to endDate. One request per page of 100; `maxPages` caps it.
export async function fetchGames({ dates, startDate, endDate, maxPages = 1, apiKey = process.env.BALLDONTLIE_API_KEY, pause } = {}) {
    const rows = [];
    let cursor;
    let pages = 0;

    while (pages < maxPages) {
        if (pages > 0) await pause?.();
        const body = await call('games', {
            'dates[]': dates, start_date: startDate, end_date: endDate, per_page: PER_PAGE, cursor,
        }, apiKey);
        pages++;
        rows.push(...(body.data ?? []).map(toMatchRow).filter(Boolean));

        cursor = body.meta?.next_cursor;
        if (!cursor) break;
    }

    return { rows, pages, complete: !cursor };
}

// One game by id
export async function fetchGame(id, { apiKey = process.env.BALLDONTLIE_API_KEY } = {}) {
    const body = await call(`games/${encodeURIComponent(id)}`, {}, apiKey);
    return body.data ? toMatchRow(body.data) : null;
}
