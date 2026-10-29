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

const TEST_PORT = 8765;
const BASE = `http://127.0.0.1:${TEST_PORT}`;
const WS_URL = `ws://127.0.0.1:${TEST_PORT}/ws`;
const HEADERS = { 'User-Agent': 'api-test' };

let server;
const createdMatchIds = [];

// ---------- helpers ----------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function request(method, path, body) {
    const headers = { ...HEADERS };
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

async function waitForServer() {
    for (let i = 0; i < 60; i++) {
        try {
            await fetch(BASE + '/', { headers: HEADERS });
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
        env: { ...process.env, PORT: String(TEST_PORT), HOST: '127.0.0.1' },
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

    for (const limit of ['abc', '0', '101', '2.5']) {
        it(`rejects limit=${limit}`, async () => {
            const res = await request('GET', `/matches?limit=${limit}`);
            assert.equal(res.status, 400);
        });
    }

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
