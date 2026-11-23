import { and, asc, eq, gte, lt, lte, ne } from 'drizzle-orm';
import { db } from '../db/db.js';
import { competitionStats, matches } from '../db/schema.js';
import { SOURCE, fetchGame, fetchGames } from '../providers/balldontlie.js';
import { MATCH_STATUS } from '../validation/matches.js';
import { conferenceStandings, nbaSeason, playoffSeries, seasonDates } from '../live/nba-standings.js';
import { saveProviderMatches } from './football-sync.js';
import { saveCompetitionStats } from './football-stats-sync.js';

// Imports NBA games from BALLDONTLIE. The free plan allows 5 requests in each
// calendar minute, so every request here is at least REQUEST_GAP_MS after the
// last (3 a minute at most, leaving room for anything else using the key):
// - every LIVE_INTERVAL_MS while a game is on or about to tip off, otherwise
//   every IDLE_INTERVAL_MS: one request for yesterday, today and tomorrow
//   (their dates are US dates, so a UTC day either side covers them)
// - every FIXTURES_INTERVAL_MS: the next two weeks, up to FIXTURE_PAGES requests
// - every CATCH_UP_INTERVAL_MS: games that left that window unfinished
//   (e.g. the server was down when they ended), one request each
// - once a season: every game so far (about 3 requests in November, 13 by
//   April), so the standings worked out from them cover the whole season
//
// The conference standings and playoff series are worked out from the stored
// games (src/live/nba-standings.js) and saved as the 'NBA' competition, which
// the Tables tab shows, after any sync that changed a game.

const LIVE_INTERVAL_MS = 30_000;
const IDLE_INTERVAL_MS = 10 * 60_000;
const REQUEST_GAP_MS = 20_000;
// After a 429 (another app sharing the key, perhaps)
const RATE_LIMITED_MS = 2 * 60_000;
const FIXTURES_INTERVAL_MS = 6 * 60 * 60_000;
const FIXTURE_PAGES = 3;
const CATCH_UP_INTERVAL_MS = 30 * 60_000;
const CATCH_UP_BATCH = 3;

const DAY_MS = 24 * 60 * 60_000;
const FIXTURE_DAYS = 14;
// Checked every LIVE_INTERVAL_MS from this long before tip-off
const SOON_MS = 15 * 60_000;
// A game still "scheduled" this long after its tip-off time is probably
// delayed, so it's checked often too until then
const OVERDUE_MS = 3 * 60 * 60_000;

const toDate = (time) => new Date(time).toISOString().slice(0, 10);

export const STANDINGS_CODE = 'NBA';
// Enough for a whole season (1,230 games, plus the playoffs) at 100 a page
const BACKFILL_PAGES = 15;

// Works out and saves the season's standings and playoff series from the
// stored games. `backfilled`: the season whose games have all been fetched.
export async function refreshStandings({ now = Date.now(), backfilled = null } = {}) {
    const season = nbaSeason(now);
    const dates = seasonDates(season);
    const games = await db
        .select({
            homeTeam: matches.homeTeam, awayTeam: matches.awayTeam, homeScore: matches.homeScore, awayScore: matches.awayScore,
            status: matches.status, competition: matches.competition, startTime: matches.startTime, details: matches.details,
        })
        .from(matches)
        .where(and(
            eq(matches.source, SOURCE),
            gte(matches.startTime, new Date(`${dates.startDate}T00:00:00Z`)),
            lte(matches.startTime, new Date(`${dates.endDate}T23:59:59Z`)),
        ));

    const standings = conferenceStandings(games);
    const playoffs = playoffSeries(games, standings);

    await saveCompetitionStats(
        { code: STANDINGS_CODE, sport: 'Basketball', name: 'NBA', area: null, emblem: null, season: { ...dates, backfilled } },
        { standings: playoffs ? [...standings, playoffs] : standings, scorers: [] },
    );
    return standings;
}

// The season whose games have all been fetched, as saved with the standings
async function backfilledSeason() {
    const [row] = await db.select({ season: competitionStats.season }).from(competitionStats).where(eq(competitionStats.code, STANDINGS_CODE));
    return row?.season?.backfilled ?? null;
}

// How long until the next sync: fast while any game is live or near tip-off
export function wantedInterval(rows, now = Date.now()) {
    const busy = rows.some((r) => {
        if (r.status === MATCH_STATUS.LIVE) return true;
        if (r.status !== MATCH_STATUS.SCHEDULED) return false;
        const until = r.startTime.getTime() - now;
        return until <= SOON_MS && until >= -OVERDUE_MS;
    });
    return busy ? LIVE_INTERVAL_MS : IDLE_INTERVAL_MS;
}

// Games of ours not finished whose tip-off is before the regular window
export async function staleGames(now = Date.now(), limit = CATCH_UP_BATCH) {
    const windowStart = new Date(toDate(now - DAY_MS));
    return db
        .select({ externalId: matches.externalId })
        .from(matches)
        .where(and(eq(matches.source, SOURCE), ne(matches.status, MATCH_STATUS.FINISHED), lt(matches.startTime, windowStart)))
        .orderBy(asc(matches.startTime))
        .limit(limit);
}

// For GET /health
const syncState = { enabled: false, lastSuccessAt: null, lastErrorAt: null, lastError: null, gamesSeen: null, standingsAt: null };

export function getBasketballSyncStatus() {
    return { ...syncState };
}

// Does nothing without an API key. Returns a stop function.
export function startBasketballSync(callbacks = {}) {
    if (!process.env.BALLDONTLIE_API_KEY) {
        console.warn('BALLDONTLIE_API_KEY is missing. NBA sync is disabled.');
        return () => {};
    }

    syncState.enabled = true;
    let stopped = false;
    let timer = null;
    let lastRequestAt = 0;
    let fixturesAt = 0;
    let catchUpAt = 0;
    let backfillTriedAt = 0;
    let backfilled = null;

    // Waits until REQUEST_GAP_MS after the last request; false once stopped
    let wake = null;
    function nextRequest() {
        const wait = Math.max(0, lastRequestAt + REQUEST_GAP_MS - Date.now());
        return new Promise((resolve) => {
            wake = () => resolve(false);
            setTimeout(() => {
                lastRequestAt = Date.now();
                resolve(!stopped);
            }, wait);
        });
    }

    function recordError(what, e) {
        const reason = e.cause ? ` (${e.cause.code ?? e.cause.message})` : '';
        console.error(`NBA ${what} failed: ${e.message}${reason}`);
        syncState.lastErrorAt = new Date().toISOString();
        syncState.lastError = `${e.message}${reason}`;
    }

    async function sync() {
        let delay = IDLE_INTERVAL_MS;
        const now = Date.now();

        try {
            if (!(await nextRequest())) return;
            const { rows } = await fetchGames({ dates: [toDate(now - DAY_MS), toDate(now), toDate(now + DAY_MS)] });
            const saved = await saveProviderMatches(rows, callbacks);
            Object.assign(syncState, { lastSuccessAt: new Date().toISOString(), gamesSeen: rows.length });
            delay = wantedInterval(rows);

            // The season so far, once, without telling viewers about each old game
            const season = nbaSeason(now);
            backfilled ??= await backfilledSeason();
            if (backfilled !== season && now - backfillTriedAt >= CATCH_UP_INTERVAL_MS) {
                backfillTriedAt = now;
                if (!(await nextRequest())) return;
                const { rows: past, complete } = await fetchGames({
                    startDate: seasonDates(season).startDate, endDate: toDate(now), maxPages: BACKFILL_PAGES, pause: nextRequest,
                });
                await saveProviderMatches(past, {});
                if (complete) backfilled = season;
                await refreshStandings({ now, backfilled });
                syncState.standingsAt = new Date().toISOString();
                console.log(`NBA: ${past.length} games of the ${season} season so far fetched for the standings`);
            } else if (saved.created || saved.updated || !syncState.standingsAt) {
                await refreshStandings({ now, backfilled });
                syncState.standingsAt = new Date().toISOString();
            }

            if (now - fixturesAt >= FIXTURES_INTERVAL_MS) {
                fixturesAt = now;
                if (!(await nextRequest())) return;
                const { rows: fixtures } = await fetchGames({
                    startDate: toDate(now + 2 * DAY_MS),
                    endDate: toDate(now + FIXTURE_DAYS * DAY_MS),
                    maxPages: FIXTURE_PAGES,
                    pause: nextRequest,
                });
                await saveProviderMatches(fixtures, callbacks);
            }

            if (now - catchUpAt >= CATCH_UP_INTERVAL_MS) {
                catchUpAt = now;
                for (const { externalId } of await staleGames(now)) {
                    if (!(await nextRequest())) return;
                    const row = await fetchGame(externalId);
                    if (row) await saveProviderMatches([row], callbacks);
                }
            }
        } catch (e) {
            recordError('sync', e);
            if (e.status === 429) delay = RATE_LIMITED_MS;
        }

        if (!stopped) timer = setTimeout(sync, delay);
    }

    sync();

    return () => {
        stopped = true;
        clearTimeout(timer);
        wake?.();
    };
}
