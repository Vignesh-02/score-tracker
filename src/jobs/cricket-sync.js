import { readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fetchCurrentMatches } from '../providers/cricketdata.js';
import { saveProviderMatches } from './football-sync.js';

// CricketData.org allows a number of hits a day (100 free, 2,000 on the
// cheapest paid plan), and one sync costs one hit per page (about 2). Each sync
// waits the longer of:
// - LIVE_INTERVAL_MS while a match is live, IDLE_INTERVAL_MS otherwise (but
//   waking for the next start), and
// - the hits left today spread evenly over the hours left.
// On the free plan the second one decides (every 20-40 min); on a paid plan the
// first. The counter comes from the API and is per key, so a laptop and the
// server using the same key share the budget automatically.
const LIVE_INTERVAL_MS = 3 * 60_000;
const IDLE_INTERVAL_MS = 15 * 60_000;

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

// The shortest wait the matches call for: LIVE_INTERVAL_MS while one is live,
// otherwise until shortly after the next one starts, at most IDLE_INTERVAL_MS.
export function wantedInterval(rows, now = Date.now()) {
    if (rows.some((r) => r.status === 'live')) return LIVE_INTERVAL_MS;

    const nextStart = Math.min(...rows
        .filter((r) => r.status === 'scheduled' && r.startTime?.getTime() > now)
        .map((r) => r.startTime.getTime()));
    const untilStart = nextStart - now + 60_000;
    return Math.max(LIVE_INTERVAL_MS, Math.min(IDLE_INTERVAL_MS, untilStart));
}

// How long to wait before the next sync, given today's usage.
export function nextDelay({ hitsToday, hitsLimit, pagesPerSync, interval = IDLE_INTERVAL_MS, now = Date.now() }) {
    if (hitsToday == null || hitsLimit == null) return Math.max(interval, IDLE_INTERVAL_MS);

    const cost = Math.max(1, pagesPerSync);
    const syncsLeft = Math.floor((hitsLimit - RESERVE_HITS - hitsToday) / cost);
    const untilReset = nextUtcMidnight(now) - now;

    if (syncsLeft <= 0) return untilReset + AFTER_RESET_MS;
    return Math.max(interval, Math.round(untilReset / syncsLeft));
}

// When the next sync is due, and the day's usage, saved so a restart doesn't
// sync straight away (each sync costs ~2 of the day's hits, and node --watch
// restarts on every save) and still knows how many hits are left for
// scorecards. Under systemd it goes in STATE_DIRECTORY (/var/lib/score-tracker,
// from StateDirectory= in the service file), which survives restarts. Not /tmp
// there: PrivateTmp gives every start a fresh one.
const SCHEDULE_FILE = join(process.env.STATE_DIRECTORY || tmpdir(), 'score-tracker-cricket-sync.json');

function loadSaved() {
    try {
        return JSON.parse(readFileSync(SCHEDULE_FILE, 'utf8'));
    } catch {
        return {}; // first run, or the file was cleared
    }
}

function loadNextSyncAt() {
    const at = new Date(loadSaved().nextSyncAt).getTime();
    return Number.isFinite(at) ? at : null;
}

function save() {
    const { nextSyncAt, hitsToday, hitsLimit, hitsAt } = syncState;
    try {
        writeFileSync(SCHEDULE_FILE, JSON.stringify({ nextSyncAt, hitsToday, hitsLimit, hitsAt }));
    } catch (e) {
        console.warn(`Couldn't save the cricket sync schedule: ${e.message}`);
    }
}

// Last outcome of the sync, for GET /health
const syncState = {
    enabled: false, lastSuccessAt: null, lastErrorAt: null, lastError: null,
    matchesSeen: null, hitsToday: null, hitsLimit: null, hitsAt: null, nextSyncAt: null,
};

// The usage saved before a restart, until the API reports it again
{
    const { hitsToday = null, hitsLimit = null, hitsAt = null } = loadSaved();
    if (hitsToday != null && hitsLimit != null && hitsAt) Object.assign(syncState, { hitsToday, hitsLimit, hitsAt });
}

export function getCricketSyncStatus() {
    return { ...syncState };
}

// The latest usage the API reported, from the sync or a scorecard fetch.
// Saved for the next start unless { save: false } (tests).
export function noteCricketHits({ hitsToday, hitsLimit }, { at = Date.now(), save: persist = true } = {}) {
    if (hitsToday == null || hitsLimit == null) return;
    Object.assign(syncState, { hitsToday, hitsLimit, hitsAt: new Date(at).toISOString() });
    if (persist) save();
}

// { left, limit }: hits left today as far as we know, or null before the first
// response. Counts reset at midnight UTC, so a figure from before then is out of date.
export function cricketHitsLeft(now = Date.now()) {
    const { hitsToday, hitsLimit, hitsAt } = syncState;
    if (hitsToday == null || hitsLimit == null) return null;
    const reset = new Date(hitsAt).getTime() < nextUtcMidnight(now) - 24 * 60 * 60_000;
    return { left: reset ? hitsLimit : hitsLimit - hitsToday, limit: hitsLimit };
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

            Object.assign(syncState, { lastSuccessAt: new Date().toISOString(), matchesSeen: rows.length });
            noteCricketHits({ hitsToday, hitsLimit });
            delay = nextDelay({ hitsToday, hitsLimit, pagesPerSync: pages, interval: wantedInterval(rows) });
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
        save();
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
