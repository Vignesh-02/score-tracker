import { Router } from 'express';
import { checkDatabase } from '../db/db.js';
import { getFootballSyncStatus } from '../jobs/football-sync.js';
import { getCricketSyncStatus } from '../jobs/cricket-sync.js';

// This long without a success means scores on screen may be out of date.
// Football syncs every 60s; cricket every 20 min or more (it has a daily budget).
const FOOTBALL_STALE_AFTER_MS = 5 * 60_000;
const CRICKET_STALE_AFTER_MS = 3 * 60 * 60_000;

// Not stale during the first few minutes after start, before its first success
function isStale(sync, staleAfterMs) {
    if (!sync.enabled) return false;
    const lastSuccess = sync.lastSuccessAt ? new Date(sync.lastSuccessAt).getTime() : null;
    return lastSuccess ? Date.now() - lastSuccess > staleAfterMs : process.uptime() * 1000 > staleAfterMs;
}

// Monitors may call this often, so the database check is reused for a few
// seconds rather than querying on every request
const DB_CHECK_CACHE_MS = 5_000;

// GET /health, for uptime monitors, load balancers and process supervisors.
// 200 while the server can serve requests (status 'ok', or 'degraded' when the
// football or cricket sync is behind, since that's a third-party problem and restarting
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
        const football = getFootballSyncStatus();
        const cricket = getCricketSyncStatus();
        const footballStale = isStale(football, FOOTBALL_STALE_AFTER_MS);
        const cricketStale = isStale(cricket, CRICKET_STALE_AFTER_MS);

        const status = !db.ok ? 'down' : footballStale || cricketStale ? 'degraded' : 'ok';

        res.status(db.ok ? 200 : 503).json({
            status,
            uptimeSeconds: Math.round(process.uptime()),
            db,
            footballSync: { ...football, stale: footballStale },
            cricketSync: { ...cricket, stale: cricketStale },
        });
    });

    return router;
}
