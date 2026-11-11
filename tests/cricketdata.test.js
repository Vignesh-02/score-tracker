import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { assignInnings, parseCompetition, toMatchRow } from '../src/providers/cricketdata.js';
import { nextDelay } from '../src/jobs/cricket-sync.js';

// A real /currentMatches response (both pages), with the echoed API key removed
const { data: fixture } = JSON.parse(readFileSync(new URL('./fixtures/cricketdata-current.json', import.meta.url)));
const byName = (start) => fixture.find((m) => m.name.startsWith(start));

describe('CricketData.org adapter', () => {
    it('converts every match in a real response', () => {
        const rows = fixture.map(toMatchRow);
        assert.equal(rows.filter(Boolean).length, fixture.length);
        for (const row of rows) {
            assert.equal(row.source, 'cricketdata');
            assert.equal(row.sport, 'Cricket');
            assert.ok(row.startTime instanceof Date && !Number.isNaN(row.startTime.getTime()));
            assert.ok(row.endTime > row.startTime);
        }
    });

    it('takes the competition from the end of the match name', () => {
        assert.equal(parseCompetition('New Zealand vs India, 3rd ODI, India tour of New Zealand 2026'), 'India tour of New Zealand 2026');
        assert.equal(parseCompetition('Pakistan vs Sri Lanka, 1st Test, Sri Lanka tour of Pakistan, 2026'), 'Sri Lanka tour of Pakistan 2026');
        assert.equal(parseCompetition('Pakistan U19 vs Nepal U19, 12th Match, Group A, ACC Mens U19 Asia Cup 2026'), 'ACC Mens U19 Asia Cup 2026');
        assert.equal(parseCompetition('A vs B'), null);
    });

    it('treats the gmt time as UTC', () => {
        const row = toMatchRow(byName('New Zealand vs India, 2nd ODI'));
        assert.equal(row.startTime.toISOString(), '2026-11-07T02:00:00.000Z');
    });

    it('matches innings to teams ignoring case', () => {
        const innings = assignInnings(
            [{ r: 93, w: 7, o: 20, inning: 'united states of america women Inning 1' }],
            ['Uganda Women', 'United States of America Women'],
        );
        assert.equal(innings[0].side, 'away');
    });

    it('gives a joined "A,B Inning 1" label to the side that did not bat before', () => {
        // Pakistan U19 won chasing 209 against India U19's 208
        const row = toMatchRow(byName('India U19 vs Pakistan U19'));
        assert.deepEqual(row.details.innings.map((i) => [i.side, i.runs]), [['home', 208], ['away', 209]]);
        assert.equal(row.homeScore, 208);
        assert.equal(row.awayScore, 209);
    });

    it('counts a match with a score as live even if matchStarted is false', () => {
        const raw = byName('Victoria vs Western Australia');
        assert.equal(raw.matchStarted, false);
        assert.equal(toMatchRow(raw).status, 'live');
    });

    it('marks ended matches finished and keeps the result text', () => {
        const row = toMatchRow(byName('New Zealand vs India, 2nd ODI'));
        assert.equal(row.status, 'finished');
        assert.equal(row.details.statusText, 'India won by 4 runs (DLS method)');
    });

    it('handles an abandoned match with no score', () => {
        const row = toMatchRow(byName('New Zealand vs India, 3rd ODI'));
        assert.equal(row.status, 'finished');
        assert.deepEqual(row.details.innings, []);
        assert.equal(row.homeScore, 0);
    });

    it('marks a match with no score that has not started as scheduled', () => {
        const row = toMatchRow({ id: 'x', name: 'A vs B, 1st T20I, Tour 2027', matchType: 't20', status: 'Match starts at 10:00 GMT', dateTimeGMT: '2027-01-01T10:00:00', teams: ['A', 'B'], matchStarted: false, matchEnded: false });
        assert.equal(row.status, 'scheduled');
        assert.equal(row.details.format, 't20');
    });

    it('skips matches without teams', () => {
        assert.equal(toMatchRow({ id: 'x', name: 'TBC', dateTimeGMT: '2027-01-01T10:00:00', teams: [] }), null);
    });

    it('never stores the API key', () => {
        const raw = { ...byName('New Zealand vs India, 2nd ODI'), apikey: 'SECRET' };
        assert.ok(!JSON.stringify(toMatchRow(raw)).includes('SECRET'));
    });
});

describe('cricket sync pacing', () => {
    const MIN = 60_000;
    const noonUtc = Date.UTC(2026, 10, 11, 12, 0, 0);

    it('spreads the hits left over the rest of the day', () => {
        // 12 hours left, 100 - 10 reserve - 30 used = 60 hits, 2 a sync → 30 syncs → every 24 min
        const delay = nextDelay({ hitsToday: 30, hitsLimit: 100, pagesPerSync: 2, now: noonUtc });
        assert.equal(delay, 24 * MIN);
    });

    it('never syncs more often than every 20 minutes', () => {
        const delay = nextDelay({ hitsToday: 0, hitsLimit: 100, pagesPerSync: 1, now: Date.UTC(2026, 10, 11, 23, 0, 0) });
        assert.equal(delay, 20 * MIN);
    });

    it('waits for the daily reset once the budget is used up', () => {
        const delay = nextDelay({ hitsToday: 89, hitsLimit: 100, pagesPerSync: 2, now: noonUtc });
        assert.equal(delay, 12 * 60 * MIN + 5 * MIN);
    });

    it('falls back to the minimum when usage is unknown', () => {
        assert.equal(nextDelay({ hitsToday: null, hitsLimit: null, pagesPerSync: 2 }), 20 * MIN);
    });
});
