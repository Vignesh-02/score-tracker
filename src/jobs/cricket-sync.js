import { readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { and, asc, eq, inArray, lt } from 'drizzle-orm';
import { db } from '../db/db.js';
import { matches } from '../db/schema.js';
import { FIXTURE_PAGES, SOURCE, fetchCurrentMatches, fetchFixtures, fetchMatchInfo } from '../providers/cricketdata.js';
import { MATCH_STATUS } from '../validation/matches.js';
import { saveProviderMatches } from './football-sync.js';
import { TABLES_PER_SYNC, syncCricketTables } from './cricket-tables-sync.js';

// CricketData.org allows a number of hits a day (100 free, 2,000 on the
// cheapest paid plan), and one sync costs one hit per page (about 2), plus the
// occasional extras below (fixtures every 6 hours, lookups of matches that
// dropped out of the list). Each sync waits the longer of:
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
    const { nextSyncAt, hitsToday, hitsLimit, hitsAt, fixturesSyncedAt } = syncState;
    try {
        writeFileSync(SCHEDULE_FILE, JSON.stringify({ nextSyncAt, hitsToday, hitsLimit, hitsAt, fixturesSyncedAt }));
    } catch (e) {
        console.warn(`Couldn't save the cricket sync schedule: ${e.message}`);
    }
}

// Last outcome of the sync, for GET /health
const syncState = {
    enabled: false, lastSuccessAt: null, lastErrorAt: null, lastError: null,
    matchesSeen: null, hitsToday: null, hitsLimit: null, hitsAt: null, nextSyncAt: null,
    fixturesSyncedAt: null,
};

// The usage saved before a restart, until the API reports it again
{
    const { hitsToday = null, hitsLimit = null, hitsAt = null, fixturesSyncedAt = null } = loadSaved();
    if (hitsToday != null && hitsLimit != null && hitsAt) Object.assign(syncState, { hitsToday, hitsLimit, hitsAt });
    syncState.fixturesSyncedAt = fixturesSyncedAt;
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

// Whether `cost` more hits leave enough for the score sync today: the same
// margin the scorecard route keeps
function canSpare(cost) {
    const hits = cricketHitsLeft();
    return Boolean(hits) && hits.left - cost >= Math.max(30, Math.round(hits.limit * 0.1));
}

// ---------- upcoming fixtures ----------

// Every few hours (FIXTURE_PAGES hits each time), so matches show as upcoming
// days ahead instead of only once /currentMatches picks them up
const FIXTURES_INTERVAL_MS = 6 * 60 * 60_000;

// As far ahead as GET /matches?view=current shows upcoming matches
const UPCOMING_MS = 14 * 24 * 60 * 60_000;

// The rows of a /matches response worth saving: matches that haven't started,
// within UPCOMING_MS, that we don't have or still have as scheduled.
// `existing` maps externalId → our status. The list can lag behind
// /currentMatches, so it never touches a match already live or finished.
export function pickFixtures(rows, existing, now = Date.now()) {
    return rows.filter((r) => {
        const start = r.startTime.getTime();
        return r.status === MATCH_STATUS.SCHEDULED && start > now && start <= now + UPCOMING_MS
            && (existing.get(r.externalId) ?? MATCH_STATUS.SCHEDULED) === MATCH_STATUS.SCHEDULED;
    });
}

// Saves upcoming fixtures from /matches rows. New ones are inserted; scheduled
// ones get any new time or teams (a "Tbc vs Tbc" final once the semis are done).
export async function saveFixtures(rows, callbacks = {}, now = Date.now()) {
    if (!rows.length) return { created: 0, updated: 0 };

    const ours = await db
        .select({ externalId: matches.externalId, status: matches.status })
        .from(matches)
        .where(and(eq(matches.source, SOURCE), inArray(matches.externalId, rows.map((r) => r.externalId))));

    const picked = pickFixtures(rows, new Map(ours.map((m) => [m.externalId, m.status])), now);
    return saveProviderMatches(picked, callbacks);
}

async function syncFixtures(callbacks) {
    const { rows, hitsToday, hitsLimit } = await fetchFixtures();
    noteCricketHits({ hitsToday, hitsLimit });
    return saveFixtures(rows, callbacks);
}

// ---------- matches that never finish ----------

// CricketData.org sometimes stops updating a match without marking it
// finished: Uganda Women v Rwanda Women was still "live" at 18.4 overs a
// fortnight later, in /currentMatches and /match_info alike. Others drop out of
// /currentMatches before they're marked finished. Either way they'd stay live
// here for good, so:
// - any match still not finished GIVE_UP_AFTER_END_MS after its estimated end
//   is marked finished (settleOverdue, on every sync)
// - a live or scheduled match missing from the list and past its estimated end
//   is looked up by id (1 hit), for the real result if they have one
const CHECK_AFTER_END_MS = 60 * 60_000;
const GIVE_UP_AFTER_END_MS = 12 * 60 * 60_000;
// The estimated end comes from the format; without one (they sometimes leave
// it out, even for four-day matches), allow as long as a Test
const UNKNOWN_FORMAT_LENGTH_MS = 5 * 24 * 60 * 60_000;
// Lookups per sync, and how long before the same match is looked up again
const CHECKS_PER_SYNC = 5;
const RECHECK_AFTER_MS = 6 * 60 * 60_000;

const checkedAt = new Map(); // match id → time of the last lookup

// For tests
export function clearSettleState() {
    checkedAt.clear();
}

// When a match that still isn't reported finished is treated as finished
export function giveUpAt(match) {
    const end = match.details?.format
        ? match.endTime.getTime()
        : match.startTime.getTime() + UNKNOWN_FORMAT_LENGTH_MS;
    return end + GIVE_UP_AFTER_END_MS;
}

// The match as finished, without the last status text ("Uganda Women opt to
// bat"), which would otherwise become the result line in the feed
export const asFinished = (row) => ({ ...row, status: MATCH_STATUS.FINISHED, details: { ...row.details, statusText: null } });

// The rows of a sync, with overdue matches marked finished
export function settleOverdue(rows, now = Date.now()) {
    return rows.map((r) => (r.status !== MATCH_STATUS.FINISHED && now >= giveUpAt(r) ? asFinished(r) : r));
}

// A `matches` row in the shape the adapter produces
const providerRow = (m) => ({
    source: m.source, externalId: m.externalId, sport: m.sport, competition: m.competition,
    homeTeam: m.homeTeam, awayTeam: m.awayTeam, status: m.status, startTime: m.startTime, endTime: m.endTime,
    homeScore: m.homeScore, awayScore: m.awayScore, details: m.details,
});

// `seen`: the externalIds in the latest complete /currentMatches response
export async function settleMissingMatches(seen, callbacks = {}, { now = Date.now(), fetchInfo = fetchMatchInfo } = {}) {
    const candidates = await db
        .select()
        .from(matches)
        .where(and(
            eq(matches.source, SOURCE),
            inArray(matches.status, [MATCH_STATUS.LIVE, MATCH_STATUS.SCHEDULED]),
            lt(matches.endTime, new Date(now - CHECK_AFTER_END_MS)),
        ))
        .orderBy(asc(matches.startTime));

    const due = candidates
        .filter((m) => !seen.has(m.externalId) && now - (checkedAt.get(m.id) ?? 0) >= RECHECK_AFTER_MS)
        .slice(0, CHECKS_PER_SYNC);

    let settled = 0;
    for (const match of due) {
        checkedAt.set(match.id, now);

        let latest = null;
        try {
            const info = await fetchInfo(match.externalId);
            noteCricketHits(info);
            latest = info.row;
        } catch (e) {
            // e.g. they no longer have the match; the time limit still applies
            console.warn(`Couldn't look up cricket match ${match.id}: ${e.message}`);
            if (/exceeded/i.test(e.message)) break;
        }

        let row = latest ?? providerRow(match);
        if (row.status !== MATCH_STATUS.FINISHED && now >= giveUpAt(row)) row = asFinished(row);
        if (row.status === MATCH_STATUS.FINISHED) settled++;

        await saveProviderMatches([row], callbacks);
    }

    return { checked: due.length, settled };
}

// ---------- the sync ----------

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
    let fixturesTriedAt = 0;

    // The occasional jobs after a sync, each only when today's hits allow.
    // Their failures are logged but don't count against the sync itself.
    async function extras(rows, complete) {
        // A match beyond the pages read isn't missing
        if (complete && canSpare(CHECKS_PER_SYNC)) {
            await settleMissingMatches(new Set(rows.map((r) => r.externalId)), callbacks)
                .catch((e) => console.error(`Cricket settle failed: ${e.message}`));
        }

        // Points tables of tournaments with new results (1 hit each)
        if (canSpare(TABLES_PER_SYNC)) {
            await syncCricketTables({ onHits: noteCricketHits })
                .then((n) => { if (n) console.log(`Cricket tables: ${n} refreshed`); })
                .catch((e) => console.error(`Cricket tables sync failed: ${e.message}`));
        }

        const lastFixtures = new Date(syncState.fixturesSyncedAt ?? 0).getTime();
        const due = Date.now() - lastFixtures >= FIXTURES_INTERVAL_MS && Date.now() - fixturesTriedAt >= RETRY_AFTER_ERROR_MS;
        if (due && canSpare(FIXTURE_PAGES)) {
            fixturesTriedAt = Date.now();
            try {
                const { created, updated } = await syncFixtures(callbacks);
                syncState.fixturesSyncedAt = new Date().toISOString();
                save();
                if (created || updated) console.log(`Cricket fixtures: ${created} new, ${updated} updated`);
            } catch (e) {
                console.error(`Cricket fixtures sync failed: ${e.message}`);
            }
        }
    }

    async function sync() {
        let delay = RETRY_AFTER_ERROR_MS;

        try {
            const { rows: fetched, pages, complete, hitsToday, hitsLimit } = await fetchCurrentMatches();
            const rows = settleOverdue(fetched);
            await saveProviderMatches(rows, callbacks);

            Object.assign(syncState, { lastSuccessAt: new Date().toISOString(), matchesSeen: rows.length });
            noteCricketHits({ hitsToday, hitsLimit });
            await extras(rows, complete);

            // From the usage after the extras, which spend hits too
            delay = nextDelay({
                hitsToday: syncState.hitsToday ?? hitsToday, hitsLimit, pagesPerSync: pages, interval: wantedInterval(rows),
            });
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
