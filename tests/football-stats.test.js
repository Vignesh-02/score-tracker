import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { toCompetition, toMatchRow, toScorers, toStandings, fetchStandings } from '../src/providers/football-data.js';
import { dueCompetitions, isInSeason } from '../src/jobs/football-stats-sync.js';

// Real football-data.org responses from November 2026 (Premier League, matchday 11)
const load = (name) => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url)));
const competitionsBody = load('football-data-competitions.json');
const standingsBody = load('football-data-standings-pl.json');
const scorersBody = load('football-data-scorers-pl.json');

const NOV_20 = Date.parse('2026-11-20T12:00:00Z');
const MIN = 60_000;

describe('football-data.org tables and scorers', () => {
    it('converts the competition list', () => {
        const competitions = competitionsBody.competitions.map(toCompetition);
        const pl = competitions.find((c) => c.code === 'PL');
        assert.deepEqual(pl, {
            code: 'PL',
            name: 'Premier League',
            area: 'England',
            emblem: 'https://crests.football-data.org/PL.png',
            season: { startDate: '2026-08-21', endDate: '2027-05-30', currentMatchday: 11 },
        });
    });

    it('keeps only the overall table, with short team names', () => {
        const standings = toStandings(standingsBody);
        assert.equal(standings.length, 1);
        assert.equal(standings[0].stage, 'REGULAR_SEASON');
        assert.equal(standings[0].table.length, 20);
        assert.deepEqual(standings[0].table[0], {
            position: 1, team: 'Arsenal', crest: 'https://crests.football-data.org/57.png',
            played: 10, won: 9, draw: 0, lost: 1, goalsFor: 15, goalsAgainst: 5, goalDifference: 10, points: 27,
        });
    });

    it('converts top scorers, keeping missing assists as null', () => {
        const scorers = toScorers(scorersBody);
        assert.equal(scorers.length, 10);
        assert.deepEqual(scorers[0], {
            player: 'Erling Haaland', team: 'Man City', crest: 'https://crests.football-data.org/65.png',
            played: 10, goals: 9, assists: null, penalties: null,
        });
    });

    it('copes with an empty response', () => {
        assert.deepEqual(toStandings({}), []);
        assert.deepEqual(toScorers({}), []);
    });
});

describe('football stats sync scheduling', () => {
    const competitions = competitionsBody.competitions.map(toCompetition);

    it('skips competitions whose season is over', () => {
        const inSeason = competitions.filter((c) => isInSeason(c, NOV_20)).map((c) => c.code);
        assert.ok(inSeason.includes('PL'));
        assert.ok(inSeason.includes('CL'));
        // The 2026 World Cup ended in July, Euro 2024 in 2024
        assert.ok(!inSeason.includes('WC'));
        assert.ok(!inSeason.includes('EC'));
        assert.equal(isInSeason({ season: null }, NOV_20), false);
    });

    it('keeps a finished season for two weeks', () => {
        const season = { startDate: '2026-08-01', endDate: '2026-11-10' };
        assert.equal(isInSeason({ season }, NOV_20), true);
        assert.equal(isInSeason({ season }, Date.parse('2026-11-30T00:00:00Z')), false);
    });

    it('refreshes missing and old tables, the longest-waiting first', () => {
        const updatedAt = new Map([
            ['PL', new Date(NOV_20 - 5 * MIN)], // fresh
            ['PD', new Date(NOV_20 - 45 * MIN)],
            ['BL1', new Date(NOV_20 - 90 * MIN)],
        ]);
        const due = dueCompetitions(competitions, updatedAt, NOV_20).map((c) => c.code);

        assert.ok(!due.includes('PL'));
        assert.ok(!due.includes('WC'));
        // Never fetched (time 0) first, then BL1 (90 min), then PD (45 min)
        assert.ok(due.indexOf('BL1') < due.indexOf('PD'));
        assert.ok(due.indexOf('SA') < due.indexOf('BL1'));
        assert.equal(due.length, 10);
    });
});

describe('football half-time score', () => {
    const match = (status, halfTime) => ({
        id: 1, utcDate: '2026-11-20T00:30:00Z', status,
        homeTeam: { shortName: 'São Paulo' }, awayTeam: { shortName: 'Fluminense' },
        score: { fullTime: { home: 0, away: 1 }, halfTime },
    });

    it('is saved once the match is finished', () => {
        assert.deepEqual(toMatchRow(match('FINISHED', { home: 0, away: 1 })).details, { halfTime: { home: 0, away: 1 } });
    });

    it('is left out while the match is in play or has no half-time score', () => {
        // No `details` key at all, so a sync leaves the column alone
        assert.ok(!('details' in toMatchRow(match('IN_PLAY', { home: 0, away: 1 }))));
        assert.ok(!('details' in toMatchRow(match('FINISHED', { home: null, away: null }))));
        assert.ok(!('details' in toMatchRow(match('TIMED', undefined))));
    });
});

describe('football-data.org standings errors', () => {
    const withFetch = async (status, run) => {
        const real = globalThis.fetch;
        globalThis.fetch = async () => new Response(JSON.stringify({ message: 'x' }), { status });
        try { return await run(); } finally { globalThis.fetch = real; }
    };

    it('treats a 404 (a cup in its knockout rounds) as no table', async () => {
        assert.deepEqual(await withFetch(404, () => fetchStandings('CLI', { apiKey: 'k' })), []);
    });

    it('still fails on other errors, with the status attached', async () => {
        await withFetch(429, () => assert.rejects(fetchStandings('PL', { apiKey: 'k' }), (e) => e.status === 429));
    });
});
