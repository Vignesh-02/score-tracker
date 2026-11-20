import { db } from '../db/db.js';
import { competitionStats } from '../db/schema.js';
import { fetchCompetitions, fetchScorers, fetchStandings } from '../providers/football-data.js';

// Keeps each competition's league table and top scorers in `competition_stats`.
//
// football-data.org's free plan allows 10 requests a minute per key, shared
// with the match sync (about 1 a minute). This job makes one request every
// REQUEST_GAP_MS (3 a minute at most), so even a laptop and the server using
// the same key stay under it. With 11 competitions in season, a full refresh
// is 22 requests over about 7 minutes.

// A competition's table is refreshed when it's older than this
const REFRESH_AFTER_MS = 30 * 60_000;
// How often to look for competitions that are due
const CHECK_EVERY_MS = 5 * 60_000;
const REQUEST_GAP_MS = 20_000;
// The competition list (which seasons are on) barely changes
const COMPETITIONS_TTL_MS = 6 * 60 * 60_000;
// A season counts as on this long before its first and after its last match,
// so the final table stays up for a while
const SEASON_MARGIN_MS = 14 * 24 * 60 * 60_000;

// True when the competition's current season is on (or just ended / about to start)
export function isInSeason(competition, now = Date.now()) {
    const { startDate, endDate } = competition.season ?? {};
    if (!startDate || !endDate) return false;
    return Date.parse(startDate) - SEASON_MARGIN_MS <= now && now <= Date.parse(endDate) + SEASON_MARGIN_MS;
}

// Competitions in season whose stats are missing or older than REFRESH_AFTER_MS,
// the longest-waiting first. `updatedAt` maps a code to its last refresh time.
export function dueCompetitions(competitions, updatedAt, now = Date.now()) {
    const lastRefresh = (c) => updatedAt.get(c.code)?.getTime() ?? 0;
    return competitions
        .filter((c) => isInSeason(c, now) && now - lastRefresh(c) >= REFRESH_AFTER_MS)
        .sort((a, b) => lastRefresh(a) - lastRefresh(b));
}

export async function saveCompetitionStats(competition, { standings, scorers }) {
    const row = { ...competition, standings, scorers, updatedAt: new Date() };
    await db.insert(competitionStats).values(row).onConflictDoUpdate({ target: competitionStats.code, set: row });
}

// For GET /health
const syncState = { enabled: false, lastSuccessAt: null, lastErrorAt: null, lastError: null, competitions: null };

export function getFootballStatsSyncStatus() {
    return { ...syncState };
}

// Returns a stop function. Does nothing without an API key, like the match sync.
export function startFootballStatsSync() {
    if (!process.env.FOOTBALL_DATA_API_KEY) return () => {};

    syncState.enabled = true;

    let stopped = false;
    let timer = null;
    let competitions = null;
    let competitionsAt = 0;

    // Waits between requests; resolves early (to false) when the job is stopped
    let wake = null;
    const pause = (ms) => new Promise((resolve) => {
        wake = () => resolve(false);
        timer = setTimeout(() => resolve(true), ms);
    });

    function recordError(e) {
        const reason = e.cause ? ` (${e.cause.code ?? e.cause.message})` : '';
        console.error(`Football stats sync failed: ${e.message}${reason}`);
        syncState.lastErrorAt = new Date().toISOString();
        syncState.lastError = `${e.message}${reason}`;
    }

    async function run() {
        try {
            if (!competitions || Date.now() - competitionsAt > COMPETITIONS_TTL_MS) {
                competitions = await fetchCompetitions();
                competitionsAt = Date.now();
                if (!(await pause(REQUEST_GAP_MS))) return;
            }

            // What's already stored survives restarts, so a restart (or a crash
            // loop) doesn't fetch every table again
            const stored = await db
                .select({ code: competitionStats.code, updatedAt: competitionStats.updatedAt })
                .from(competitionStats);
            const due = dueCompetitions(competitions, new Map(stored.map((r) => [r.code, r.updatedAt])));

            // One competition failing mustn't hold up the rest: it would stay the
            // longest-waiting and come first again every round
            for (const competition of due) {
                try {
                    const standings = await fetchStandings(competition.code);
                    if (!(await pause(REQUEST_GAP_MS))) return;
                    const scorers = await fetchScorers(competition.code);
                    await saveCompetitionStats(competition, { standings, scorers });
                    syncState.lastSuccessAt = new Date().toISOString();
                } catch (e) {
                    recordError(new Error(`${competition.code}: ${e.message}`, { cause: e.cause }));
                    // Over the rate limit (another app sharing the key): stop until the next check
                    if (e.status === 429) break;
                }
                if (!(await pause(REQUEST_GAP_MS))) return;
            }

            syncState.competitions = competitions.filter((c) => isInSeason(c)).length;
        } catch (e) {
            // e.g. a 429 if another app shares the key; the next check retries
            recordError(e);
        }

        if (!stopped) timer = setTimeout(run, CHECK_EVERY_MS);
    }

    run();

    return () => {
        stopped = true;
        clearTimeout(timer);
        wake?.();
    };
}
