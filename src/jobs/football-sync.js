import { and, eq, inArray } from 'drizzle-orm';
import { db } from '../db/db.js';
import { matches } from '../db/schema.js';
import { fetchMatches } from '../providers/football-data.js';

// football-data.org's free plan allows 10 requests a minute; this uses 1
const DEFAULT_INTERVAL_MS = 60_000;

const DAY_MS = 24 * 60 * 60 * 1000;
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

// Polls football-data.org on a timer. Does nothing without an API key, so
// tests and environments without one aren't affected. Returns a stop function.
export function startFootballSync({ intervalMs = DEFAULT_INTERVAL_MS, ...callbacks } = {}) {
    if (!process.env.FOOTBALL_DATA_API_KEY) {
        console.warn('FOOTBALL_DATA_API_KEY is missing. Football sync is disabled.');
        return () => {};
    }

    let running = false;

    async function tick() {
        if (running) return;
        running = true;

        try {
            const now = Date.now();
            // Yesterday to tomorrow: catches matches that kicked off before midnight UTC
            const rows = await fetchMatches({ dateFrom: toDate(now - DAY_MS), dateTo: toDate(now + DAY_MS) });
            await saveProviderMatches(rows, callbacks);
        } catch (e) {
            console.error('Football sync failed:', e.message);
        } finally {
            running = false;
        }
    }

    tick();
    const timer = setInterval(tick, intervalMs);

    return () => clearInterval(timer);
}
