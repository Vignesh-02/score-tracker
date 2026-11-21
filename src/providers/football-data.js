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

    const row = {
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
        providerUpdatedAt: match.lastUpdated ? new Date(match.lastUpdated) : null,
    };

    // While it's live, their own status: IN_PLAY, PAUSED (half-time) or
    // SUSPENDED. The sync turns it into an estimated clock (src/live/football-clock.js).
    if (status === MATCH_STATUS.LIVE) row.details = { phase: match.status };

    // The half-time score, once the match is over. While it's in play we can't
    // tell the first half from the second, so it isn't shown yet.
    const halfTime = match.score?.halfTime;
    if (status === MATCH_STATUS.FINISHED && halfTime?.home != null && halfTime?.away != null) {
        row.details = { halfTime: { home: halfTime.home, away: halfTime.away } };
    }

    return row;
}

// GET one football-data.org path (e.g. '/matches?ids=1,2'). One request.
async function request(path, apiKey) {
    // The key goes in a header, never in the URL
    const res = await fetch(`${BASE_URL}${path}`, { headers: { 'X-Auth-Token': apiKey } });

    if (!res.ok) {
        const body = await res.text();
        const error = new Error(`football-data.org responded ${res.status}: ${body.slice(0, 200)}`);
        error.status = res.status;
        throw error;
    }

    return res.json();
}

// GET /matches with the given query, converted to rows. One request.
async function requestMatches(query, apiKey) {
    const { matches = [] } = await request(`/matches?${query}`, apiKey);
    return matches.map(toMatchRow).filter(Boolean);
}

// Fetches matches between two dates (YYYY-MM-DD, inclusive) across every
// competition on the plan. One request, whatever the number of matches.
export function fetchMatches({ dateFrom, dateTo, apiKey = process.env.FOOTBALL_DATA_API_KEY }) {
    return requestMatches(`dateFrom=${dateFrom}&dateTo=${dateTo}`, apiKey);
}

// Fetches specific matches by their football-data.org ids, whatever their date.
// Used to finish off matches that fell out of the date window. One request.
export function fetchMatchesByIds(ids, { apiKey = process.env.FOOTBALL_DATA_API_KEY } = {}) {
    return requestMatches(`ids=${ids.map(encodeURIComponent).join(',')}`, apiKey);
}

// ---------- league tables and top scorers ----------

const teamName = (team) => team?.shortName || team?.name || null;

// One competition from GET /competitions
export function toCompetition(competition) {
    const season = competition.currentSeason;
    return {
        code: competition.code,
        name: competition.name,
        area: competition.area?.name ?? null,
        emblem: competition.emblem ?? null,
        season: season
            ? { startDate: season.startDate, endDate: season.endDate, currentMatchday: season.currentMatchday ?? null }
            : null,
    };
}

// GET /competitions: every competition on the plan, with its current season. One request.
export async function fetchCompetitions({ apiKey = process.env.FOOTBALL_DATA_API_KEY } = {}) {
    const { competitions = [] } = await request('/competitions', apiKey);
    return competitions.map(toCompetition);
}

// The overall table of each stage and group (football-data.org also sends
// home-only and away-only tables, which we don't show)
export function toStandings(body) {
    return (body.standings ?? [])
        .filter((s) => s.type === 'TOTAL')
        .map((s) => ({
            stage: s.stage ?? null,
            group: s.group ?? null,
            table: (s.table ?? []).map((r) => ({
                position: r.position,
                team: teamName(r.team),
                crest: r.team?.crest ?? null,
                played: r.playedGames,
                won: r.won,
                draw: r.draw,
                lost: r.lost,
                goalsFor: r.goalsFor,
                goalsAgainst: r.goalsAgainst,
                goalDifference: r.goalDifference,
                points: r.points,
            })),
        }));
}

// Assists and penalties are null on the free plan
export function toScorers(body) {
    return (body.scorers ?? []).map((s) => ({
        player: s.player?.name ?? null,
        team: teamName(s.team),
        crest: s.team?.crest ?? null,
        played: s.playedMatches ?? null,
        goals: s.goals ?? 0,
        assists: s.assists ?? null,
        penalties: s.penalties ?? null,
    }));
}

// The current season's table for one competition, e.g. 'PL'. One request.
// A cup in its knockout rounds has no table: football-data.org answers 404
// (the Copa Libertadores in November), so that's an empty list, not an error.
export async function fetchStandings(code, { apiKey = process.env.FOOTBALL_DATA_API_KEY } = {}) {
    try {
        return toStandings(await request(`/competitions/${encodeURIComponent(code)}/standings`, apiKey));
    } catch (e) {
        if (e.status === 404) return [];
        throw e;
    }
}

// The current season's top scorers for one competition. One request.
export async function fetchScorers(code, { limit = 10, apiKey = process.env.FOOTBALL_DATA_API_KEY } = {}) {
    return toScorers(await request(`/competitions/${encodeURIComponent(code)}/scorers?limit=${limit}`, apiKey));
}

// ---------- head-to-head ----------

// Earlier meetings of the two teams in a match, newest first, finished ones only
export function toHeadToHead(body, { excludeId } = {}) {
    return (body.matches ?? [])
        .filter((m) => m.status === 'FINISHED' && String(m.id) !== String(excludeId))
        .map((m) => ({
            date: m.utcDate,
            competition: m.competition?.name ?? null,
            homeTeam: teamName(m.homeTeam),
            awayTeam: teamName(m.awayTeam),
            homeScore: m.score?.fullTime?.home ?? null,
            awayScore: m.score?.fullTime?.away ?? null,
        }))
        .sort((a, b) => Date.parse(b.date) - Date.parse(a.date));
}

// The last `limit` meetings of the teams in football-data.org match `externalId`
// (the match itself is left out). One request.
export async function fetchHeadToHead(externalId, { limit = 5, apiKey = process.env.FOOTBALL_DATA_API_KEY } = {}) {
    const body = await request(`/matches/${encodeURIComponent(externalId)}/head2head?limit=${limit + 1}`, apiKey);
    return toHeadToHead(body, { excludeId: externalId }).slice(0, limit);
}
