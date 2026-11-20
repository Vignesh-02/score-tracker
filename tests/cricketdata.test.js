import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { assignInnings, parseCompetition, toMatchRow, toScorecard } from '../src/providers/cricketdata.js';
import { cricketHitsLeft, nextDelay, noteCricketHits, wantedInterval } from '../src/jobs/cricket-sync.js';

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

    it('notes whether CricketData.org has a scorecard for the match', () => {
        const raw = byName('New Zealand vs India, 2nd ODI');
        assert.equal(toMatchRow({ ...raw, fantasyEnabled: true }).details.hasScorecard, true);
        assert.equal(toMatchRow({ ...raw, fantasyEnabled: false }).details.hasScorecard, false);
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

    it('on the free plan, the budget sets the pace even with a match live', () => {
        const delay = nextDelay({ hitsToday: 30, hitsLimit: 100, pagesPerSync: 2, interval: 3 * MIN, now: noonUtc });
        assert.equal(delay, 24 * MIN);
    });

    it('on a paid plan, syncs every 3 minutes while a match is live and 15 otherwise', () => {
        assert.equal(nextDelay({ hitsToday: 500, hitsLimit: 2000, pagesPerSync: 2, interval: 3 * MIN, now: noonUtc }), 3 * MIN);
        assert.equal(nextDelay({ hitsToday: 500, hitsLimit: 2000, pagesPerSync: 2, interval: 15 * MIN, now: noonUtc }), 15 * MIN);
    });

    it('slows down on a paid plan too when the day\'s hits run low', () => {
        // 12 hours left, 2000 - 10 reserve - 1950 used = 40 hits → 20 syncs → every 36 min
        assert.equal(nextDelay({ hitsToday: 1950, hitsLimit: 2000, pagesPerSync: 2, interval: 3 * MIN, now: noonUtc }), 36 * MIN);
    });

    it('waits for the daily reset once the budget is used up', () => {
        const delay = nextDelay({ hitsToday: 89, hitsLimit: 100, pagesPerSync: 2, now: noonUtc });
        assert.equal(delay, 12 * 60 * MIN + 5 * MIN);
    });

    it('waits 15 minutes when usage is unknown', () => {
        assert.equal(nextDelay({ hitsToday: null, hitsLimit: null, pagesPerSync: 2, interval: 3 * MIN }), 15 * MIN);
    });

    it('wants 3 minutes while live, else wakes just after the next start, at most 15 minutes', () => {
        const at = (minutes) => new Date(noonUtc + minutes * MIN);
        assert.equal(wantedInterval([{ status: 'live' }, { status: 'finished' }], noonUtc), 3 * MIN);
        assert.equal(wantedInterval([{ status: 'scheduled', startTime: at(8) }], noonUtc), 9 * MIN);
        assert.equal(wantedInterval([{ status: 'scheduled', startTime: at(1) }], noonUtc), 3 * MIN);
        assert.equal(wantedInterval([{ status: 'scheduled', startTime: at(90) }, { status: 'finished' }], noonUtc), 15 * MIN);
        assert.equal(wantedInterval([], noonUtc), 15 * MIN);
    });
});

describe('CricketData.org scorecard', () => {
    // A real /match_scorecard response (Uganda Women v Rwanda Women, live, 20 Nov 2026),
    // with the echoed API key and usage info removed
    const { data } = JSON.parse(readFileSync(new URL('./fixtures/cricketdata-scorecard.json', import.meta.url)));
    const card = toScorecard(data);

    it('keeps the venue and toss, with the team name as written in teams', () => {
        assert.equal(card.venue, 'Entebbe Cricket Oval, Entebbe');
        assert.deepEqual(card.toss, { team: 'Uganda Women', choice: 'bat' });
        assert.equal(card.final, false);
    });

    it('gives each innings its side, batters and bowlers', () => {
        assert.equal(card.innings.length, 1);
        const [innings] = card.innings;
        assert.equal(innings.side, 'home');
        assert.equal(innings.number, 1);
        assert.equal(innings.batting.length, 7);
        assert.deepEqual(innings.batting[0], {
            name: 'Janet Mbabazi', dismissal: 'lbw b Rosine Irera', out: true,
            runs: 3, balls: 7, fours: 0, sixes: 0, strikeRate: 42.86,
        });
        // Not out batters say "batting" and aren't out
        assert.equal(innings.batting.filter((b) => !b.out).length, 2);
        assert.deepEqual(innings.bowling.find((b) => b.name === 'Marie Bimenyimana'), {
            name: 'Marie Bimenyimana', overs: 3.4, maidens: 0, runs: 12, wickets: 4, noBalls: 0, wides: 0, economy: 3.3,
        });
    });

    it('copes with a response that has no scorecard yet', () => {
        assert.deepEqual(toScorecard({ teams: ['A', 'B'] }), { venue: null, toss: null, final: false, innings: [] });
    });
});

describe('cricket hits left today', () => {
    it('counts down from the latest usage reported', () => {
        const noon = Date.UTC(2026, 10, 11, 12);
        noteCricketHits({ hitsToday: 40, hitsLimit: 100 }, { at: noon, save: false });
        assert.deepEqual(cricketHitsLeft(noon + 60_000), { left: 60, limit: 100 });
    });

    it('starts again from the full limit after midnight UTC', () => {
        noteCricketHits({ hitsToday: 95, hitsLimit: 100 }, { at: Date.UTC(2026, 10, 11, 23), save: false });
        assert.deepEqual(cricketHitsLeft(Date.UTC(2026, 10, 12, 0, 30)), { left: 100, limit: 100 });
    });
});
