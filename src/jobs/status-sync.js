import { and, eq, ne } from 'drizzle-orm';
import { db } from '../db/db.js';
import { matches } from '../db/schema.js';
import { syncMatchStatus } from '../utils/match-status.js';
import { MATCH_STATUS } from '../validation/matches.js';

const DEFAULT_INTERVAL_MS = 30_000;

// Brings each match's status up to date with the current time and calls
// onChange(match) for every match whose status actually changed.
export async function syncStatuses(matchList, onChange) {
    await Promise.all(matchList.map(async (match) => {
        const previous = match.status;
        let changed = false;

        await syncMatchStatus(match, async (status) => {
            // Only update if the status is still what we read. If the job and a
            // GET /matches request sync the same match at once, only one of them
            // updates the row, so the change is broadcast exactly once.
            const rows = await db
                .update(matches)
                .set({ status })
                .where(and(eq(matches.id, match.id), eq(matches.status, previous)))
                .returning({ id: matches.id });

            changed = rows.length > 0;
        });

        if (changed) onChange?.(match);
    }));
}

// Runs syncStatuses on a timer so statuses change (and get broadcast) even when
// nobody is calling GET /matches. Returns a function that stops the job.
export function startStatusSync({ onChange, intervalMs = DEFAULT_INTERVAL_MS } = {}) {
    let running = false;

    async function tick() {
        // Skip this tick if the previous one is still running (e.g. slow DB)
        if (running) return;
        running = true;

        try {
            // A finished match can't change status again, so leave those out
            const active = await db
                .select()
                .from(matches)
                .where(ne(matches.status, MATCH_STATUS.FINISHED));

            await syncStatuses(active, onChange);
        } catch (e) {
            console.error('Status sync failed:', e);
        } finally {
            running = false;
        }
    }

    tick();
    const timer = setInterval(tick, intervalMs);

    return () => clearInterval(timer);
}
