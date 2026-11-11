import { and, asc, eq, inArray, lt, ne } from 'drizzle-orm';
import { db } from '../db/db.js';
import { matches } from '../db/schema.js';
import { SOURCE, fetchMatches, fetchMatchesByIds } from '../providers/football-data.js';
import { MATCH_STATUS } from '../validation/matches.js';

// football-data.org's free plan allows 10 requests a minute; this uses 1, plus
// up to 2 every SLOW_INTERVAL_MS (the far-ahead fixtures and stale matches)
const DEFAULT_INTERVAL_MS = 60_000;
const SLOW_INTERVAL_MS = 10 * 60_000;

// Ids per catch-up request, oldest first; any more wait for the next catch-up
const CATCH_UP_BATCH = 50;

const DAY_MS = 24 * 60 * 60 * 1000;
// Every tick: yesterday to NEAR_DAYS ahead, where scores and kick-off times
// change. Every SLOW_INTERVAL_MS: the rest of the way to FAR_DAYS ahead, which
// GET /matches?view=current lists as upcoming. Two requests because
// football-data.org allows date ranges of up to 10 days.
const NEAR_DAYS = 7;
const FAR_DAYS = 14;
const toDate = (time) => new Date(time).toISOString().slice(0, 10);

const sameTime = (a, b) => (a?.getTime() ?? null) === (b?.getTime() ?? null);

// Saves provider rows (from an adapter's fetchMatches) into `matches`:
// inserts new ones and updates changed ones, then calls the matching callback
// so the change can be broadcast. Unchanged matches cost no writes.
export async function saveProviderMatches(rows, { onCreated, onScoreChange, onStatusChange } = {}) {
    const result = { created: 0, updated: 0 };
    if (!rows.length) return result;

    const { source } = rows[0];
    const existing = await db
        .select()
        .from(matches)
        .where(and(eq(matches.source, source), inArray(matches.externalId, rows.map((r) => r.externalId))));
    const byExternalId = new Map(existing.map((m) => [m.externalId, m]));

    for (const row of rows) {
        const current = byExternalId.get(row.externalId);

        if (!current) {
            // The unique (source, external_id) index makes a duplicate insert a
            // no-op, e.g. if two syncs overlap
            const [created] = await db.insert(matches).values(row).onConflictDoNothing().returning();
            if (created) {
                result.created++;
                onCreated?.(created);
            }
            continue;
        }

        const scoreChanged = current.homeScore !== row.homeScore || current.awayScore !== row.awayScore;
        const statusChanged = current.status !== row.status;
        const detailsChanged = current.homeTeam !== row.homeTeam || current.awayTeam !== row.awayTeam
            || current.competition !== row.competition || !sameTime(current.startTime, row.startTime);

        if (!scoreChanged && !statusChanged && !detailsChanged) continue;

        const [updated] = await db.update(matches).set(row).where(eq(matches.id, current.id)).returning();
        result.updated++;

        if (scoreChanged) onScoreChange?.(updated);
        if (statusChanged) onStatusChange?.(updated);
    }

    return result;
}

// The regular sync only asks from yesterday onwards, so a match that leaves
// that window before it finishes (e.g. the server was down when it ended) would
// stay live or scheduled forever. This re-fetches such matches by id.
export async function catchUpStaleMatches(callbacks = {}, { now = Date.now() } = {}) {
    // Midnight UTC yesterday: the start of the regular sync's window
    const windowStart = new Date(toDate(now - DAY_MS));

    const stale = await db
        .select({ externalId: matches.externalId })
        .from(matches)
        .where(and(
            eq(matches.source, SOURCE),
            ne(matches.status, MATCH_STATUS.FINISHED),
            lt(matches.startTime, windowStart),
        ))
        .orderBy(asc(matches.startTime))
        .limit(CATCH_UP_BATCH);

    if (stale.length === 0) return { checked: 0, created: 0, updated: 0 };

    const rows = await fetchMatchesByIds(stale.map((m) => m.externalId));
    const result = await saveProviderMatches(rows, callbacks);

    return { checked: stale.length, ...result };
}

// Polls football-data.org on a timer. Does nothing without an API key, so
// tests and environments without one aren't affected. Returns a stop function.
// Last outcome of the sync, for GET /health. A stale lastSuccessAt means the
// scores on screen may be out of date even though the server is up.
const syncState = { enabled: false, lastSuccessAt: null, lastErrorAt: null, lastError: null, matchesSeen: null };

export function getFootballSyncStatus() {
    return { ...syncState };
}

export function startFootballSync({ intervalMs = DEFAULT_INTERVAL_MS, ...callbacks } = {}) {
    if (!process.env.FOOTBALL_DATA_API_KEY) {
        console.warn('FOOTBALL_DATA_API_KEY is missing. Football sync is disabled.');
        return () => {};
    }

    syncState.enabled = true;

    let running = false;
    let lastSlowRun = 0;

    async function tick() {
        if (running) return;
        running = true;

        try {
            const now = Date.now();
            // From yesterday, to catch matches that kicked off before midnight UTC
            const rows = await fetchMatches({ dateFrom: toDate(now - DAY_MS), dateTo: toDate(now + NEAR_DAYS * DAY_MS) });
            await saveProviderMatches(rows, callbacks);

            syncState.lastSuccessAt = new Date().toISOString();
            syncState.matchesSeen = rows.length;

            // Runs on the first tick, then every SLOW_INTERVAL_MS
            if (now - lastSlowRun >= SLOW_INTERVAL_MS) {
                lastSlowRun = now;
                const farRows = await fetchMatches({
                    dateFrom: toDate(now + (NEAR_DAYS + 1) * DAY_MS),
                    dateTo: toDate(now + FAR_DAYS * DAY_MS),
                });
                await saveProviderMatches(farRows, callbacks);
                await catchUpStaleMatches(callbacks, { now });
            }
        } catch (e) {
            // Network errors only say "fetch failed"; the reason (e.g. ENOTFOUND,
            // ECONNRESET, a timeout) is in e.cause
            const reason = e.cause ? ` (${e.cause.code ?? e.cause.message})` : '';
            console.error(`Football sync failed: ${e.message}${reason}`);

            syncState.lastErrorAt = new Date().toISOString();
            syncState.lastError = `${e.message}${reason}`;
        } finally {
            running = false;
        }
    }

    tick();
    const timer = setInterval(tick, intervalMs);

    return () => clearInterval(timer);
}
