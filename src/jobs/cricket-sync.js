import { readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fetchCurrentMatches } from '../providers/cricketdata.js';
import { saveProviderMatches } from './football-sync.js';

// CricketData.org's free plan allows 100 hits a day, and one sync costs one hit
// per page (about 2). So instead of a fixed timer, each sync spreads the hits
// left today evenly over the hours left, never more often than MIN_INTERVAL_MS.
// The counter comes from the API and is per key, so a laptop and the server
// using the same key share the budget automatically.
const MIN_INTERVAL_MS = 20 * 60_000;

// Hits kept back for manual testing and for any other copy of the app
const RESERVE_HITS = 10;

// After a failure (network, or the daily limit already used up)
const RETRY_AFTER_ERROR_MS = 60 * 60_000;

// Hits reset at midnight UTC; wait a few minutes past it to be safe
const AFTER_RESET_MS = 5 * 60_000;

function nextUtcMidnight(now) {
    const d = new Date(now);
    return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1);
}

// How long to wait before the next sync, given today's usage.
export function nextDelay({ hitsToday, hitsLimit, pagesPerSync, now = Date.now() }) {
    if (hitsToday == null || hitsLimit == null) return MIN_INTERVAL_MS;

    const cost = Math.max(1, pagesPerSync);
    const syncsLeft = Math.floor((hitsLimit - RESERVE_HITS - hitsToday) / cost);
    const untilReset = nextUtcMidnight(now) - now;

    if (syncsLeft <= 0) return untilReset + AFTER_RESET_MS;
    return Math.max(MIN_INTERVAL_MS, Math.round(untilReset / syncsLeft));
}

// When the next sync is due, saved so a restart doesn't sync straight away:
// each immediate sync would cost ~2 of the day's 100 hits, and node --watch
// restarts on every save. Under systemd it goes in STATE_DIRECTORY
// (/var/lib/score-tracker, from StateDirectory= in the service file), which
// survives restarts. Not /tmp there: PrivateTmp gives every start a fresh one.
const SCHEDULE_FILE = join(process.env.STATE_DIRECTORY || tmpdir(), 'score-tracker-cricket-sync.json');

function loadNextSyncAt() {
    try {
        const { nextSyncAt } = JSON.parse(readFileSync(SCHEDULE_FILE, 'utf8'));
        const at = new Date(nextSyncAt).getTime();
        return Number.isFinite(at) ? at : null;
    } catch {
        return null; // first run, or the file was cleared
    }
}

function saveNextSyncAt(at) {
    try {
        writeFileSync(SCHEDULE_FILE, JSON.stringify({ nextSyncAt: new Date(at).toISOString() }));
    } catch (e) {
        console.warn(`Couldn't save the cricket sync schedule: ${e.message}`);
    }
}

// Last outcome of the sync, for GET /health
const syncState = {
    enabled: false, lastSuccessAt: null, lastErrorAt: null, lastError: null,
    matchesSeen: null, hitsToday: null, hitsLimit: null, nextSyncAt: null,
};

export function getCricketSyncStatus() {
    return { ...syncState };
}

// Polls CricketData.org and saves changes, calling the same callbacks as the
// football sync so changes are broadcast. Does nothing without an API key.
// Returns a stop function.
export function startCricketSync(callbacks = {}) {
    if (!process.env.CRICKETDATA_API_KEY) {
        console.warn('CRICKETDATA_API_KEY is missing. Cricket sync is disabled.');
        return () => {};
    }

    syncState.enabled = true;
    let timer = null;
    let stopped = false;

    async function sync() {
        let delay = RETRY_AFTER_ERROR_MS;

        try {
            const { rows, pages, hitsToday, hitsLimit } = await fetchCurrentMatches();
            await saveProviderMatches(rows, callbacks);

            Object.assign(syncState, {
                lastSuccessAt: new Date().toISOString(),
                matchesSeen: rows.length,
                hitsToday,
                hitsLimit,
            });
            delay = nextDelay({ hitsToday, hitsLimit, pagesPerSync: pages });
        } catch (e) {
            // The day's hits are gone (perhaps used by another copy of the app
            // with the same key): retrying hourly would fail all day
            if (/exceeded/i.test(e.message)) delay = nextUtcMidnight(Date.now()) - Date.now() + AFTER_RESET_MS;

            const reason = e.cause ? ` (${e.cause.code ?? e.cause.message})` : '';
            console.error(`Cricket sync failed: ${e.message}${reason}`);
            syncState.lastErrorAt = new Date().toISOString();
            syncState.lastError = `${e.message}${reason}`;
        }

        if (stopped) return;
        schedule(Date.now() + delay);
    }

    function schedule(at) {
        syncState.nextSyncAt = new Date(at).toISOString();
        saveNextSyncAt(at);
        timer = setTimeout(sync, Math.max(0, at - Date.now()));
    }

    // Picks up the schedule from before a restart; syncs now if it's due or unknown
    const savedAt = loadNextSyncAt();
    if (savedAt && savedAt > Date.now()) {
        syncState.nextSyncAt = new Date(savedAt).toISOString();
        timer = setTimeout(sync, savedAt - Date.now());
    } else {
        sync();
    }

    return () => {
        stopped = true;
        clearTimeout(timer);
    };
}
