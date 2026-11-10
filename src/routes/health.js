import { Router } from 'express';
import { checkDatabase } from '../db/db.js';
import { getFootballSyncStatus } from '../jobs/football-sync.js';

// The sync runs every 60s; this long without a success means scores on screen
// may be out of date
const SYNC_STALE_AFTER_MS = 5 * 60_000;

// Monitors may call this often, so the database check is reused for a few
// seconds rather than querying on every request
const DB_CHECK_CACHE_MS = 5_000;

// GET /health, for uptime monitors, load balancers and process supervisors.
// 200 while the server can serve requests (status 'ok', or 'degraded' when the
// football sync is behind, since that's a third-party problem and restarting
// won't fix it). 503 when the database is unreachable or the server is shutting
// down, so traffic moves elsewhere.
export function healthRouter({ isShuttingDown }) {
    const router = Router();
    let cachedDb = null;
    let cachedAt = 0;

    async function databaseStatus() {
        if (!cachedDb || Date.now() - cachedAt > DB_CHECK_CACHE_MS) {
            cachedDb = await checkDatabase();
            cachedAt = Date.now();
        }
        return cachedDb;
    }

    router.get('/', async (req, res) => {
        // No caching by browsers or proxies; every check should be fresh
        res.set('Cache-Control', 'no-store');

        if (isShuttingDown()) {
            return res.status(503).json({ status: 'shutting_down' });
        }

        const db = await databaseStatus();
        const sync = getFootballSyncStatus();

        const lastSuccess = sync.lastSuccessAt ? new Date(sync.lastSuccessAt).getTime() : null;
        const uptimeMs = process.uptime() * 1000;
        // Not stale during the first few minutes after start, before its first success
        const syncStale = sync.enabled && (lastSuccess
            ? Date.now() - lastSuccess > SYNC_STALE_AFTER_MS
            : uptimeMs > SYNC_STALE_AFTER_MS);

        const status = !db.ok ? 'down' : syncStale ? 'degraded' : 'ok';

        res.status(db.ok ? 200 : 503).json({
            status,
            uptimeSeconds: Math.round(process.uptime()),
            db,
            footballSync: { ...sync, stale: syncStale },
        });
    });

    return router;
}
