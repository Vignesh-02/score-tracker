// End-to-end tests for every HTTP route and the WebSocket server.
// Run with: npm test
//
// Starts the real server on TEST_PORT (separate from the dev server on 8000),
// uses the real database from .env, and deletes every row it creates at the end.

import 'dotenv/config';
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import WebSocket from 'ws';
import { eq, inArray } from 'drizzle-orm';
import { db, pool } from '../src/db/db.js';
import { matches, commentary } from '../src/db/schema.js';
import { toMatchRow } from '../src/providers/football-data.js';
import { catchUpStaleMatches, saveProviderMatches } from '../src/jobs/football-sync.js';

const TEST_PORT = 8765;
const BASE = `http://127.0.0.1:${TEST_PORT}`;
const WS_URL = `ws://127.0.0.1:${TEST_PORT}/ws`;
const HEADERS = { 'User-Agent': 'api-test' };
const ADMIN_HEADERS = { 'x-api-key': process.env.ADMIN_API_KEY };

let server;
const createdMatchIds = [];

// ---------- helpers ----------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Sends the admin key by default, like an admin client would. Pass { admin: false }
// to send the request as an anonymous visitor.
async function request(method, path, body, { admin = true } = {}) {
    const headers = { ...HEADERS, ...(admin && ADMIN_HEADERS) };
    if (body !== undefined) headers['Content-Type'] = 'application/json';

    const res = await fetch(BASE + path, {
        method,
        headers,
        body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
    });

    let json = null;
    try { json = await res.json(); } catch {}

    return { status: res.status, json, contentType: res.headers.get('content-type') ?? '' };
}

function connect(headers = HEADERS) {
    return new Promise((resolve, reject) => {
        const ws = new WebSocket(WS_URL, { headers });
        ws.inbox = [];
        ws.on('message', (data) => ws.inbox.push(JSON.parse(data)));
        ws.on('open', () => resolve(ws));
        ws.on('error', reject);
    });
}

async function waitFor(ws, predicate, timeoutMs = 3000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        const msg = ws.inbox.find(predicate);
        if (msg) return msg;
        await sleep(25);
    }
    return null;
}

async function createMatch(overrides = {}) {
    const now = Date.now();
    const res = await request('POST', '/matches', {
        sport: 'TEST',
        homeTeam: 'TEST Home',
        awayTeam: 'TEST Away',
        startTime: new Date(now - 3600e3).toISOString(),
        endTime: new Date(now + 3600e3).toISOString(),
        ...overrides,
    });
    if (res.json?.data?.id) createdMatchIds.push(res.json.data.id);
    return res;
}

async function waitForServer(base = BASE) {
    for (let i = 0; i < 60; i++) {
        try {
            await fetch(base + '/', { headers: HEADERS });
            return;
        } catch {
            await sleep(250);
        }
    }
    throw new Error('Test server did not start');
}

// ---------- setup / teardown ----------

before(async () => {
    server = spawn('node', ['src/index.js'], {
        // High limits, so the rate limiter doesn't block the rest of the suite
        env: { ...process.env, PORT: String(TEST_PORT), HOST: '127.0.0.1', RATE_LIMIT_MAX: '100000', WS_RATE_LIMIT_MAX: '100000', FOOTBALL_DATA_API_KEY: '', CRICKETDATA_API_KEY: '' },
        stdio: 'ignore',
    });
    await waitForServer();
});

after(async () => {
    if (createdMatchIds.length) {
        await db.delete(commentary).where(inArray(commentary.matchId, createdMatchIds));
        await db.delete(matches).where(inArray(matches.id, createdMatchIds));
    }
    await pool.end();
    server?.kill();
});

// ---------- tests ----------

describe('GET /', () => {
    it('returns 200', async () => {
        const res = await request('GET', '/');
        assert.equal(res.status, 200);
    });

    it('unknown routes return 404', async () => {
        const res = await request('GET', '/does-not-exist');
        assert.equal(res.status, 404);
    });
});

describe('Error handling', () => {
    it('malformed JSON → 400 as JSON', async () => {
        const res = await request('POST', '/matches', '{bad json');
        assert.equal(res.status, 400);
        assert.ok(res.contentType.includes('application/json'));
        assert.equal(res.json.error, 'Malformed JSON in request body');
    });

    it('body over 100kb → 413 as JSON', async () => {
        const res = await request('POST', '/matches', { x: 'y'.repeat(200_000) });
        assert.equal(res.status, 413);
        assert.ok(res.contentType.includes('application/json'));
    });
});

describe('football-data.org adapter', () => {
    const sample = (overrides = {}) => ({
        id: 575378,
        utcDate: '2026-11-03T17:45:00Z',
        status: 'IN_PLAY',
        competition: { name: 'UEFA Champions League' },
        homeTeam: { name: 'Galatasaray SK', shortName: 'Galatasaray' },
        awayTeam: { name: 'VfB Stuttgart', shortName: 'Stuttgart' },
        score: { fullTime: { home: 1, away: 0 } },
        ...overrides,
    });

    it('maps a match to a row', () => {
        const row = toMatchRow(sample());
        assert.equal(row.source, 'football-data');
        assert.equal(row.externalId, '575378');
        assert.equal(row.sport, 'Football');
        assert.equal(row.competition, 'UEFA Champions League');
        assert.equal(row.homeTeam, 'Galatasaray');
        assert.equal(row.awayTeam, 'Stuttgart');
        assert.equal(row.status, 'live');
        assert.equal(row.homeScore, 1);
        assert.equal(row.awayScore, 0);
        assert.equal(row.startTime.toISOString(), '2026-11-03T17:45:00.000Z');
        assert.ok(row.endTime > row.startTime);
    });

    it('maps their statuses to ours', () => {
        const status = (s) => toMatchRow(sample({ status: s })).status;
        assert.equal(status('TIMED'), 'scheduled');
        assert.equal(status('PAUSED'), 'live');
        assert.equal(status('FINISHED'), 'finished');
    });

    it('defaults missing scores to 0 and skips matches without teams', () => {
        assert.equal(toMatchRow(sample({ score: { fullTime: { home: null, away: null } } })).homeScore, 0);
        assert.equal(toMatchRow(sample({ homeTeam: { name: null } })), null);
    });
});

describe('Provider sync', () => {
    const SOURCE = 'TEST-provider';
    const externalId = `sync-${Date.now()}`;
    // Fixed times, so repeated calls produce identical rows
    const kickoff = Date.now() + 3600e3;
    const row = (overrides = {}) => ({
        source: SOURCE, externalId, sport: 'Football', competition: 'TEST League',
        homeTeam: 'TEST Home', awayTeam: 'TEST Away', status: 'scheduled',
        startTime: new Date(kickoff), endTime: new Date(kickoff + 7200e3),
        homeScore: 0, awayScore: 0, ...overrides,
    });
    const track = (m) => { if (!createdMatchIds.includes(m.id)) createdMatchIds.push(m.id); };

    it('inserts a new match once and reports it', async () => {
        const created = [];
        const first = await saveProviderMatches([row()], { onCreated: (m) => { track(m); created.push(m); } });
        const again = await saveProviderMatches([row()], { onCreated: (m) => created.push(m) });
        assert.deepEqual(first, { created: 1, updated: 0 });
        assert.deepEqual(again, { created: 0, updated: 0 });
        assert.equal(created.length, 1);
    });

    it('updates the same row and reports score and status changes', async () => {
        const scores = [], statuses = [];
        const result = await saveProviderMatches([row({ status: 'live', homeScore: 2 })], {
            onScoreChange: (m) => scores.push(m), onStatusChange: (m) => statuses.push(m),
        });
        assert.deepEqual(result, { created: 0, updated: 1 });
        assert.equal(scores[0].homeScore, 2);
        assert.equal(statuses[0].status, 'live');

        const rows = await db.select().from(matches).where(eq(matches.externalId, externalId));
        assert.equal(rows.length, 1);
    });

    it('reports a change in details (e.g. cricket status text) as a score change, and ignores key order', async () => {
        const id = `${externalId}-details`;
        const details = (statusText) => ({ format: 'test', statusText, innings: [{ side: 'home', number: 1, runs: 290, wickets: 3, overs: 94.2 }] });
        await saveProviderMatches([row({ externalId: id, status: 'live', details: details('Day 1: Stumps') })], { onCreated: track });

        // Same content, keys in another order: nothing to do
        const reordered = { innings: details('Day 1: Stumps').innings, statusText: 'Day 1: Stumps', format: 'test' };
        const unchanged = await saveProviderMatches([row({ externalId: id, status: 'live', details: reordered })]);
        assert.deepEqual(unchanged, { created: 0, updated: 0 });

        const scores = [];
        const changed = await saveProviderMatches([row({ externalId: id, status: 'live', details: details('Day 2: 1st Session') })], {
            onScoreChange: (m) => scores.push(m),
        });
        assert.deepEqual(changed, { created: 0, updated: 1 });
        assert.equal(scores[0].details.statusText, 'Day 2: 1st Session');
    });

    it('is not overridden by the time-based status sync', async () => {
        const now = Date.now();
        const [stale] = await db.insert(matches).values(row({
            externalId: `${externalId}-stale`, status: 'scheduled',
            startTime: new Date(now - 7200e3), endTime: new Date(now - 3600e3),
        })).returning();
        track(stale);

        await request('GET', '/matches?limit=100');
        const [after] = await db.select().from(matches).where(eq(matches.id, stale.id));
        assert.equal(after.status, 'scheduled');
    });
});

describe('Stale provider match catch-up', () => {
    // Replaces fetch for one call, recording the URL; restores it afterwards
    async function withFakeFetch(providerMatches, fn) {
        const realFetch = globalThis.fetch;
        const urls = [];
        globalThis.fetch = async (url) => {
            urls.push(String(url));
            return new Response(JSON.stringify({ matches: providerMatches }), { status: 200 });
        };
        try {
            return { result: await fn(), urls };
        } finally {
            globalThis.fetch = realFetch;
        }
    }

    it('re-fetches an unfinished match outside the sync window by id and finishes it', async () => {
        const externalId = `stale-${Date.now()}`;
        const kickoff = new Date(Date.now() - 5 * 86400e3);
        const [stale] = await db.insert(matches).values({
            source: 'football-data', externalId, sport: 'Football', competition: 'TEST League',
            homeTeam: 'TEST Home', awayTeam: 'TEST Away', status: 'scheduled',
            startTime: kickoff, endTime: new Date(kickoff.getTime() + 7200e3),
        }).returning();
        createdMatchIds.push(stale.id);

        const statusChanges = [];
        const { result, urls } = await withFakeFetch([{
            id: externalId, utcDate: kickoff.toISOString(), status: 'FINISHED',
            competition: { name: 'TEST League' },
            homeTeam: { shortName: 'TEST Home' }, awayTeam: { shortName: 'TEST Away' },
            score: { fullTime: { home: 2, away: 1 } },
        }], () => catchUpStaleMatches({ onStatusChange: (m) => statusChanges.push(m) }));

        assert.equal(urls.length, 1);
        assert.ok(new URL(urls[0]).searchParams.get('ids').split(',').includes(externalId));
        assert.ok(result.updated >= 1);
        assert.ok(statusChanges.some((m) => m.id === stale.id && m.status === 'finished'));

        const [row] = await db.select().from(matches).where(eq(matches.id, stale.id));
        assert.equal(row.status, 'finished');
        assert.equal(row.homeScore, 2);
        assert.equal(row.awayScore, 1);
    });

    it('leaves matches inside the sync window to the regular sync', async () => {
        const externalId = `recent-${Date.now()}`;
        const kickoff = new Date(Date.now() + 3600e3);
        const [upcoming] = await db.insert(matches).values({
            source: 'football-data', externalId, sport: 'Football',
            homeTeam: 'TEST Home', awayTeam: 'TEST Away', status: 'scheduled',
            startTime: kickoff, endTime: new Date(kickoff.getTime() + 7200e3),
        }).returning();
        createdMatchIds.push(upcoming.id);

        const { urls } = await withFakeFetch([], () => catchUpStaleMatches());
        const requested = urls.flatMap((url) => new URL(url).searchParams.get('ids')?.split(',') ?? []);
        assert.ok(!requested.includes(externalId));
    });
});

describe('Rate limiting', () => {
    const LIMIT_PORT = 8766;
    const LIMIT_BASE = `http://127.0.0.1:${LIMIT_PORT}`;
    const LIMIT_WS = `ws://127.0.0.1:${LIMIT_PORT}/ws`;
    let limited;

    const get = (ip) => fetch(`${LIMIT_BASE}/`, { headers: { ...HEADERS, 'X-Forwarded-For': ip } });

    const tryConnect = (ip) => new Promise((resolve) => {
        const ws = new WebSocket(LIMIT_WS, { headers: { ...HEADERS, 'X-Forwarded-For': ip } });
        ws.on('open', () => { ws.close(); resolve('open'); });
        ws.on('unexpected-response', (req, res) => resolve(res.statusCode));
        ws.on('error', () => resolve('error'));
    });

    before(async () => {
        limited = spawn('node', ['src/index.js'], {
            // No Arcjet here, so these tests only exercise the local limiter
            env: { ...process.env, PORT: String(LIMIT_PORT), HOST: '127.0.0.1', ARCJET_KEY: '', TRUSTED_PROXIES: '127.0.0.1', RATE_LIMIT_MAX: '5', WS_RATE_LIMIT_MAX: '3', FOOTBALL_DATA_API_KEY: '', CRICKETDATA_API_KEY: '' },
            stdio: 'ignore',
        });
        await waitForServer(LIMIT_BASE);
        await sleep(10_500); // let waitForServer's request age out of the window
    });

    after(() => limited?.kill());

    it('never rate limits /health', async () => {
        for (let i = 0; i < 10; i++) {
            const res = await fetch(`${LIMIT_BASE}/health`, { headers: { ...HEADERS, 'X-Forwarded-For': '9.9.9.9' } });
            assert.equal(res.status, 200);
        }
    });

    it('blocks a visitor over the HTTP limit with a JSON 429', async () => {
        for (let i = 0; i < 5; i++) assert.equal((await get('8.8.8.8')).status, 200);

        const res = await get('8.8.8.8');
        assert.equal(res.status, 429);
        assert.deepEqual(await res.json(), { error: 'Too many requests.' });
    });

    it('counts each visitor separately', async () => {
        assert.equal((await get('1.1.1.1')).status, 200);
    });

    it('cannot be bypassed by faking an extra IP', async () => {
        // Nginx appends the real address last, so a client-supplied value is ignored
        const res = await get('203.0.113.7, 8.8.8.8');
        assert.equal(res.status, 429);
    });

    it('blocks a visitor over the WebSocket connection limit', async () => {
        await sleep(2_100);
        const results = [];
        for (let i = 0; i < 4; i++) results.push(await tryConnect('8.8.4.4'));
        assert.deepEqual(results, ['open', 'open', 'open', 429]);
    });

    it('counts WebSocket visitors separately', async () => {
        assert.equal(await tryConnect('9.9.9.9'), 'open');
    });
});

describe('Admin key', () => {
    const writes = [
        ['POST', '/matches', { sport: 'x' }],
        ['PATCH', '/matches/1/score', { homeScore: 1, awayScore: 0 }],
        ['POST', '/matches/1/commentary', { message: 'x' }],
    ];

    for (const [method, path, body] of writes) {
        it(`${method} ${path} without a key → 401`, async () => {
            const res = await request(method, path, body, { admin: false });
            assert.equal(res.status, 401);
        });
    }

    it('wrong key → 401', async () => {
        const res = await fetch(BASE + '/matches', {
            method: 'POST',
            headers: { ...HEADERS, 'Content-Type': 'application/json', 'x-api-key': 'wrong' },
            body: JSON.stringify({ sport: 'x' }),
        });
        assert.equal(res.status, 401);
    });

    it('read routes stay public', async () => {
        assert.equal((await request('GET', '/matches', undefined, { admin: false })).status, 200);
        assert.equal((await request('GET', '/matches/1/commentary', undefined, { admin: false })).status, 200);
    });
});

describe('POST /matches', () => {
    it('rejects empty fields', async () => {
        const res = await request('POST', '/matches', { sport: '' });
        assert.equal(res.status, 400);
    });

    it('rejects invalid dates', async () => {
        const res = await createMatch({ startTime: 'tomorrow', endTime: 'later' });
        assert.equal(res.status, 400);
    });

    it('rejects endTime before startTime', async () => {
        const res = await createMatch({ startTime: '2026-10-30T20:00:00Z', endTime: '2026-10-30T19:00:00Z' });
        assert.equal(res.status, 400);
    });

    it('creates a match with computed status and default scores', async () => {
        const res = await createMatch();
        assert.equal(res.status, 201);
        assert.equal(res.json.data.status, 'live');
        assert.equal(res.json.data.homeScore, 0);
        assert.equal(res.json.data.awayScore, 0);
    });

    it('saves competition and marks the match as manual', async () => {
        const res = await createMatch({ competition: 'Indian Super League' });
        assert.equal(res.status, 201);
        assert.equal(res.json.data.competition, 'Indian Super League');
        assert.equal(res.json.data.source, 'manual');
        assert.equal(res.json.data.externalId, null);
    });

    it('ignores source and externalId sent by the client', async () => {
        const res = await createMatch({ source: 'football-data', externalId: 'fake-1' });
        assert.equal(res.status, 201);
        assert.equal(res.json.data.source, 'manual');
        assert.equal(res.json.data.externalId, null);
    });

    it('allows only one row per provider match, but any number of manual ones', async () => {
        const row = { sport: 'TEST', homeTeam: 'TEST Home', awayTeam: 'TEST Away', source: 'TEST-provider', externalId: `ext-${Date.now()}` };
        const [first] = await db.insert(matches).values(row).returning();
        createdMatchIds.push(first.id);

        await assert.rejects(db.insert(matches).values(row), (e) => (e.cause?.code ?? e.code) === '23505');

        const manual = await db.insert(matches).values([
            { sport: 'TEST', homeTeam: 'TEST A', awayTeam: 'TEST B' },
            { sport: 'TEST', homeTeam: 'TEST A', awayTeam: 'TEST B' },
        ]).returning();
        createdMatchIds.push(...manual.map((m) => m.id));
        assert.equal(manual.length, 2);
    });

    it('computes scheduled and finished statuses', async () => {
        const now = Date.now();
        const future = await createMatch({ startTime: new Date(now + 3600e3).toISOString(), endTime: new Date(now + 7200e3).toISOString() });
        const past = await createMatch({ startTime: new Date(now - 7200e3).toISOString(), endTime: new Date(now - 3600e3).toISOString() });
        assert.equal(future.json.data.status, 'scheduled');
        assert.equal(past.json.data.status, 'finished');
    });
});

describe('GET /matches', () => {
    it('lists matches newest first', async () => {
        const created = await createMatch();
        const res = await request('GET', '/matches');
        assert.equal(res.status, 200);
        assert.ok(Array.isArray(res.json.data));
        assert.equal(res.json.data[0].id, created.json.data.id);
    });

    it('respects limit', async () => {
        const res = await request('GET', '/matches?limit=1');
        assert.equal(res.json.data.length, 1);
    });

    for (const limit of ['abc', '0', '201', '2.5']) {
        it(`rejects limit=${limit}`, async () => {
            const res = await request('GET', `/matches?limit=${limit}`);
            assert.equal(res.status, 400);
        });
    }

    it('view=current lists live, then upcoming up to 2 weeks ahead, then latest results', async () => {
        const now = Date.now();
        const hour = 3600e3, day = 86400e3;
        // A non-manual source, so the time-based status sync leaves these alone
        const base = { source: 'TEST-view', sport: 'TEST', homeTeam: 'TEST', awayTeam: 'TEST' };
        const at = (offset) => ({ startTime: new Date(now + offset), endTime: new Date(now + offset + hour) });
        const rows = await db.insert(matches).values([
            { ...base, homeTeam: 'TEST live', status: 'live', ...at(-hour) },
            { ...base, homeTeam: 'TEST soon', status: 'scheduled', ...at(3 * day) },
            { ...base, homeTeam: 'TEST next week', status: 'scheduled', ...at(9 * day) },
            { ...base, homeTeam: 'TEST too far', status: 'scheduled', ...at(20 * day) },
            // Just finished, so it's always among the most recent results
            { ...base, homeTeam: 'TEST just finished', status: 'finished', startTime: new Date(now - 2 * hour), endTime: new Date(now - 60e3) },
            { ...base, homeTeam: 'TEST ancient', status: 'finished', ...at(-60 * day) },
        ]).returning();
        rows.forEach((r) => createdMatchIds.push(r.id));

        const res = await request('GET', '/matches?view=current&limit=200');
        assert.equal(res.status, 200);
        assert.ok(res.json.data.length <= 200);
        const order = res.json.data.filter((m) => m.source === 'TEST-view').map((m) => m.homeTeam);
        assert.deepEqual(order, ['TEST live', 'TEST soon', 'TEST next week', 'TEST just finished']);
    });

    it('view=current keeps room for results when the limit is small', async () => {
        const res = await request('GET', '/matches?view=current&limit=3');
        assert.equal(res.status, 200);
        assert.ok(res.json.data.length <= 3);
    });

    it('rejects an unknown view', async () => {
        const res = await request('GET', '/matches?view=everything');
        assert.equal(res.status, 400);
    });

    it('fixes a stale status and saves it to the DB', async () => {
        const now = Date.now();
        const [stale] = await db.insert(matches).values({
            sport: 'TEST', homeTeam: 'TEST stale', awayTeam: 'TEST stale', status: 'scheduled',
            startTime: new Date(now - 7200e3), endTime: new Date(now - 3600e3),
        }).returning();
        createdMatchIds.push(stale.id);

        const res = await request('GET', '/matches?limit=100');
        assert.equal(res.json.data.find((m) => m.id === stale.id).status, 'finished');

        const [row] = await db.select().from(matches).where(eq(matches.id, stale.id));
        assert.equal(row.status, 'finished');
    });
});

describe('PATCH /matches/:id/score', () => {
    let matchId;
    before(async () => { matchId = (await createMatch()).json.data.id; });

    it('rejects an invalid id', async () => {
        const res = await request('PATCH', '/matches/abc/score', { homeScore: 1, awayScore: 0 });
        assert.equal(res.status, 400);
    });

    it('rejects negative scores', async () => {
        const res = await request('PATCH', `/matches/${matchId}/score`, { homeScore: -1, awayScore: 0 });
        assert.equal(res.status, 400);
    });

    it('rejects a missing score', async () => {
        const res = await request('PATCH', `/matches/${matchId}/score`, { homeScore: 1 });
        assert.equal(res.status, 400);
    });

    it('returns 404 for a match that does not exist', async () => {
        const res = await request('PATCH', '/matches/999999/score', { homeScore: 1, awayScore: 0 });
        assert.equal(res.status, 404);
    });

    it('updates the score (and coerces numeric strings)', async () => {
        const res = await request('PATCH', `/matches/${matchId}/score`, { homeScore: 2, awayScore: '1' });
        assert.equal(res.status, 200);
        assert.equal(res.json.data.homeScore, 2);
        assert.equal(res.json.data.awayScore, 1);
    });
});

describe('POST /matches/:id/commentary', () => {
    let matchId;
    before(async () => { matchId = (await createMatch()).json.data.id; });

    const cases = [
        ['an invalid id', 'abc', { message: 'x' }],
        ['a missing message', null, { minute: 5 }],
        ['a blank message', null, { message: '   ' }],
        ['a negative minute', null, { message: 'x', minute: -1 }],
        ['non-string tags', null, { message: 'x', tags: [1] }],
    ];

    for (const [name, id, body] of cases) {
        it(`rejects ${name}`, async () => {
            const res = await request('POST', `/matches/${id ?? matchId}/commentary`, body);
            assert.equal(res.status, 400);
        });
    }

    it('returns 404 for a match that does not exist', async () => {
        const res = await request('POST', '/matches/999999/commentary', { message: 'x' });
        assert.equal(res.status, 404);
    });

    it('creates commentary with all fields saved', async () => {
        const res = await request('POST', `/matches/${matchId}/commentary`, {
            minute: 12, sequence: 1, period: '1H', eventType: 'goal', actor: 'Tester',
            team: 'TEST Home', message: 'TEST goal', metadata: { xg: 0.3 }, tags: ['goal'],
        });
        assert.equal(res.status, 201);
        assert.equal(res.json.data.matchId, matchId);
        assert.equal(res.json.data.minute, 12);
        assert.deepEqual(res.json.data.metadata, { xg: 0.3 });
        assert.deepEqual(res.json.data.tags, ['goal']);
    });
});

describe('GET /matches/:id/commentary', () => {
    let matchId;
    before(async () => {
        matchId = (await createMatch()).json.data.id;
        await request('POST', `/matches/${matchId}/commentary`, { message: 'first', minute: 1 });
        await sleep(20);
        await request('POST', `/matches/${matchId}/commentary`, { message: 'second', minute: 2 });
    });

    it('lists only this match, newest first', async () => {
        const res = await request('GET', `/matches/${matchId}/commentary`);
        assert.equal(res.status, 200);
        assert.equal(res.json.data.length, 2);
        assert.equal(res.json.data[0].message, 'second');
        assert.ok(res.json.data.every((c) => c.matchId === matchId));
    });

    it('respects limit', async () => {
        const res = await request('GET', `/matches/${matchId}/commentary?limit=1`);
        assert.equal(res.json.data.length, 1);
    });

    it('rejects limit over 100', async () => {
        const res = await request('GET', `/matches/${matchId}/commentary?limit=500`);
        assert.equal(res.status, 400);
    });

    it('rejects an invalid id', async () => {
        const res = await request('GET', '/matches/abc/commentary');
        assert.equal(res.status, 400);
    });

    it('returns an empty list for a match with no commentary', async () => {
        const res = await request('GET', '/matches/999999/commentary');
        assert.equal(res.status, 200);
        assert.deepEqual(res.json.data, []);
    });
});

describe('WebSocket /ws', () => {
    it('sends welcome on connect', async () => {
        const ws = await connect();
        assert.ok(await waitFor(ws, (m) => m.type === 'welcome'));
        ws.close();
    });

    it('accepts clients without a User-Agent', async () => {
        const ws = await connect({});
        assert.ok(await waitFor(ws, (m) => m.type === 'welcome'));
        ws.close();
    });

    it('rejects other paths', async () => {
        const result = await new Promise((resolve) => {
            const ws = new WebSocket(`ws://127.0.0.1:${TEST_PORT}/other`, { headers: HEADERS });
            ws.on('open', () => { ws.close(); resolve('opened'); });
            ws.on('error', () => resolve('rejected'));
        });
        assert.equal(result, 'rejected');
    });

    it('replies with errors for invalid messages', async () => {
        const ws = await connect();
        ws.send('not json');
        assert.ok(await waitFor(ws, (m) => m.message === 'Invalid JSON'));
        ws.send(JSON.stringify({ type: 'hello' }));
        assert.ok(await waitFor(ws, (m) => m.message === 'Unknown message'));
        ws.inbox.length = 0;
        ws.send(JSON.stringify({ type: 'subscribe', matchId: '6' }));
        assert.ok(await waitFor(ws, (m) => m.message === 'Unknown message'));
        ws.close();
    });

    it('broadcasts match_created to every client', async () => {
        const a = await connect();
        const b = await connect();
        const id = (await createMatch()).json.data.id;
        assert.ok(await waitFor(a, (m) => m.type === 'match_created' && m.data.id === id));
        assert.ok(await waitFor(b, (m) => m.type === 'match_created' && m.data.id === id));
        a.close(); b.close();
    });

    it('sends score_update and commentary only to that match\'s subscribers', async () => {
        const id = (await createMatch()).json.data.id;
        const subscriber = await connect();
        const other = await connect();

        subscriber.send(JSON.stringify({ type: 'subscribe', matchId: id }));
        other.send(JSON.stringify({ type: 'subscribe', matchId: 999999 }));
        assert.ok(await waitFor(subscriber, (m) => m.type === 'subscribed'));
        assert.ok(await waitFor(other, (m) => m.type === 'subscribed'));

        await request('PATCH', `/matches/${id}/score`, { homeScore: 1, awayScore: 0 });
        await request('POST', `/matches/${id}/commentary`, { message: 'TEST broadcast' });

        assert.ok(await waitFor(subscriber, (m) => m.type === 'score_update' && m.data.homeScore === 1));
        assert.ok(await waitFor(subscriber, (m) => m.type === 'commentary' && m.data.message === 'TEST broadcast'));
        await sleep(300);
        assert.ok(!other.inbox.some((m) => m.type === 'score_update' || m.type === 'commentary'));

        subscriber.close(); other.close();
    });

    it('stops sending after unsubscribe', async () => {
        const id = (await createMatch()).json.data.id;
        const ws = await connect();
        ws.send(JSON.stringify({ type: 'subscribe', matchId: id }));
        assert.ok(await waitFor(ws, (m) => m.type === 'subscribed'));
        ws.send(JSON.stringify({ type: 'unsubscribe', matchId: id }));
        assert.ok(await waitFor(ws, (m) => m.type === 'unsubscribed'));

        ws.inbox.length = 0;
        await request('PATCH', `/matches/${id}/score`, { homeScore: 5, awayScore: 5 });
        await sleep(400);
        assert.ok(!ws.inbox.some((m) => m.type === 'score_update'));
        ws.close();
    });

    it('broadcasts status_change when a stale match is synced', async () => {
        const ws = await connect();
        const now = Date.now();
        const [stale] = await db.insert(matches).values({
            sport: 'TEST', homeTeam: 'TEST stale ws', awayTeam: 'TEST stale ws', status: 'scheduled',
            startTime: new Date(now - 7200e3), endTime: new Date(now - 3600e3),
        }).returning();
        createdMatchIds.push(stale.id);

        await request('GET', '/matches?limit=100');
        const msg = await waitFor(ws, (m) => m.type === 'status_change' && m.data.id === stale.id);
        assert.ok(msg, 'expected a status_change broadcast');
        assert.equal(msg.data.status, 'finished');
        ws.close();
    });
});

describe('GET /health', () => {
    it('reports the database and football sync status', async () => {
        const res = await request('GET', '/health', undefined, { admin: false });
        assert.equal(res.status, 200);
        assert.equal(res.json.status, 'ok');
        assert.deepEqual(res.json.db, { ok: true });
        // The test server runs without a football-data.org key
        assert.equal(res.json.footballSync.enabled, false);
        assert.equal(res.json.footballSync.stale, false);
    });
});

describe('Shutdown and crash handling', () => {
    // Starts a separate server. `preload` is code run inside it via --import,
    // used to simulate errors without adding test code to the app. The errors
    // are triggered by SIGUSR2 once the server is up, so the app's handlers
    // are installed by then.
    async function startServer(port, preload) {
        const args = preload
            ? ['--import', `data:text/javascript,${encodeURIComponent(preload)}`, 'src/index.js']
            : ['src/index.js'];
        const child = spawn('node', args, {
            env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', FOOTBALL_DATA_API_KEY: '', CRICKETDATA_API_KEY: '' },
            stdio: 'ignore',
        });
        const exited = new Promise((resolve) => child.on('exit', (code) => resolve(code)));
        await waitForServer(`http://127.0.0.1:${port}`);
        return { child, exited };
    }

    it('on SIGTERM, tells WebSocket clients to reconnect and exits cleanly', async () => {
        const port = 8767;
        const { child, exited } = await startServer(port);

        const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: HEADERS });
        await new Promise((resolve) => ws.on('open', resolve));
        const closed = new Promise((resolve) => ws.on('close', (code) => resolve(code)));

        child.kill('SIGTERM');

        assert.equal(await closed, 1001);
        assert.equal(await exited, 0);
    });

    it('keeps serving after an unhandled promise rejection', async () => {
        const port = 8768;
        const { child } = await startServer(port, "process.on('SIGUSR2', () => { Promise.reject(new Error('TEST rejection')) })");
        try {
            child.kill('SIGUSR2');
            await sleep(500);
            const res = await fetch(`http://127.0.0.1:${port}/`, { headers: HEADERS });
            assert.equal(res.status, 200);
        } finally {
            child.kill();
        }
    });

    it('exits with code 1 after an uncaught exception, so a supervisor restarts it', async () => {
        const { child, exited } = await startServer(8769, "process.on('SIGUSR2', () => setImmediate(() => { throw new Error('TEST crash') }))");
        child.kill('SIGUSR2');
        assert.equal(await exited, 1);
    });
});
