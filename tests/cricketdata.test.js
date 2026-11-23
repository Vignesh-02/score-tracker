import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { assignInnings, fetchFixtures, fetchMatchInfo, parseCompetition, parseGroup, teamGroups, toMatchRow, toPointsTable, toScorecard } from '../src/providers/cricketdata.js';
import { dueSeries, groupOf, seriesFromMatches, splitByGroup } from '../src/jobs/cricket-tables-sync.js';
import {
    asFinished, cricketHitsLeft, giveUpAt, nextDelay, noteCricketHits, pickFixtures, settleOverdue, wantedInterval,
} from '../src/jobs/cricket-sync.js';

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

// Replaces fetch with one returning `pages` in turn, recording the URLs
async function withPages(pages, fn) {
    const realFetch = globalThis.fetch;
    const urls = [];
    globalThis.fetch = async (url) => {
        urls.push(new URL(url));
        const body = pages[urls.length - 1] ?? { status: 'success', data: [], info: {} };
        return new Response(JSON.stringify(body), { status: 200 });
    };
    try {
        return { result: await fn(), urls };
    } finally {
        globalThis.fetch = realFetch;
    }
}

const apiMatch = (id, when, extra = {}) => ({
    id, name: `A vs B, ${id}, Test Cup 2026`, matchType: 't20', status: 'Match starts soon', dateTimeGMT: when,
    teams: ['A', 'B'], score: [], matchStarted: false, matchEnded: false, ...extra,
});

describe('cricket fixtures', () => {
    const now = Date.UTC(2026, 10, 21, 12);
    const row = (id, days, status = 'scheduled') => ({ externalId: id, status, startTime: new Date(now + days * 86400e3) });

    it('reads the given number of pages of /matches', async () => {
        const info = (n) => ({ totalRows: 17000, hitsToday: n, hitsLimit: 2000 });
        const { result, urls } = await withPages([
            { status: 'success', data: [apiMatch('m1', '2026-11-23T10:00:00')], info: info(1) },
            { status: 'success', data: [apiMatch('m2', '2026-11-24T10:00:00')], info: info(2) },
        ], () => fetchFixtures({ pages: 2, apiKey: 'k' }));

        assert.deepEqual(urls.map((u) => [u.pathname, u.searchParams.get('offset')]), [['/v1/matches', '0'], ['/v1/matches', '1']]);
        assert.deepEqual(result.rows.map((r) => r.externalId), ['m1', 'm2']);
        assert.equal(result.hitsToday, 2);
    });

    it('keeps matches that haven\'t started, up to two weeks ahead', () => {
        const picked = pickFixtures([
            row('soon', 1), row('later', 13), row('too-far', 15), row('past', -1), row('live', 0.1, 'live'),
        ], new Map(), now);
        assert.deepEqual(picked.map((r) => r.externalId), ['soon', 'later']);
    });

    it('never touches a match we already have as live or finished', () => {
        const existing = new Map([['a', 'scheduled'], ['b', 'live'], ['c', 'finished']]);
        const picked = pickFixtures([row('a', 1), row('b', 1), row('c', 1)], existing, now);
        assert.deepEqual(picked.map((r) => r.externalId), ['a']);
    });
});

describe('cricket matches that drop out of the list', () => {
    const start = new Date(Date.UTC(2026, 10, 7));
    const end = new Date(start.getTime() + 4 * 3600e3);

    it('gives up 12 hours after the estimated end', () => {
        assert.equal(giveUpAt({ startTime: start, endTime: end, details: { format: 't20' } }), end.getTime() + 12 * 3600e3);
    });

    it('allows as long as a Test when the format is unknown', () => {
        assert.equal(giveUpAt({ startTime: start, endTime: end, details: { format: null } }), start.getTime() + (5 * 24 + 12) * 3600e3);
    });

    it('drops the last status text when marking a match finished', () => {
        const row = asFinished({ status: 'live', details: { format: 't20', statusText: 'Uganda Women opt to bat', innings: [] } });
        assert.equal(row.status, 'finished');
        assert.equal(row.details.statusText, null);
        assert.deepEqual(row.details.innings, []);
    });

    it('marks matches still live long after their estimated end finished, even if the list still has them', () => {
        const live = (format, statusText) => ({ status: 'live', startTime: start, endTime: end, details: { format, statusText } });
        const [t20, unknown] = settleOverdue([live('t20', 'Uganda Women opt to bat'), live(null, 'Day 3: Stumps')], end.getTime() + 13 * 3600e3);
        assert.equal(t20.status, 'finished');
        assert.equal(t20.details.statusText, null);
        assert.equal(unknown.status, 'live');
    });

    it('looks a match up by id', async () => {
        const { result, urls } = await withPages([{
            status: 'success', info: { hitsToday: 5, hitsLimit: 2000 },
            data: apiMatch('m9', '2026-11-07T00:00:00', { matchStarted: true, matchEnded: true, status: 'A won by 5 runs' }),
        }], () => fetchMatchInfo('m9', { apiKey: 'k' }));

        assert.equal(urls[0].pathname, '/v1/match_info');
        assert.equal(urls[0].searchParams.get('id'), 'm9');
        assert.equal(result.row.status, 'finished');
        assert.equal(result.row.details.statusText, 'A won by 5 runs');
        assert.equal(result.hitsToday, 5);
    });
});

// A real /series_points response (Womens Big Bash League 2026), key removed
const { data: wbblPoints } = JSON.parse(readFileSync(new URL('./fixtures/cricketdata-points-wbbl.json', import.meta.url)));

describe('CricketData.org points tables', () => {
    it('keeps the series id of each match', () => {
        const row = toMatchRow(fixture[0]);
        assert.equal(row.details.seriesId, fixture[0].series_id);
        assert.equal(toMatchRow({ ...fixture[0], series_id: undefined }).details.seriesId, null);
    });

    it('adds points and orders a real table by points, then wins', () => {
        const table = toPointsTable(wbblPoints);
        assert.deepEqual(table.map((t) => [t.position, t.team, t.points]), [
            [1, 'Sydney Sixers Women', 14],
            [2, 'Perth Scorchers Women', 12],
            [3, 'Adelaide Strikers Women', 10],
            [4, 'Brisbane Heat Women', 8],
            [5, 'Sydney Thunder Women', 6],
            [6, 'Melbourne Renegades Women', 5],
            [7, 'Melbourne Stars Women', 4],
            [8, 'Hobart Hurricanes Women', 3],
        ]);
        assert.deepEqual(table[7], {
            position: 8, team: 'Hobart Hurricanes Women', crest: wbblPoints[2].img,
            played: 8, won: 1, lost: 6, tied: 0, noResult: 1, points: 3,
        });
    });

    it('breaks a tie on points by wins', () => {
        const table = toPointsTable([
            { teamname: 'B', matches: 3, wins: 1, loss: 0, ties: 0, nr: 2 },
            { teamname: 'A', matches: 3, wins: 2, loss: 1, ties: 0, nr: 0 },
        ]);
        assert.deepEqual(table.map((t) => [t.team, t.points]), [['A', 4], ['B', 4]]);
        assert.deepEqual(toPointsTable(null), []);
    });

    const NOW = Date.parse('2026-11-22T12:00:00Z');
    const HOUR = 3600e3;
    const match = (seriesId, competition, status, hoursAgo) => ({
        competition, status, details: { seriesId },
        startTime: new Date(NOW - hoursAgo * HOUR), endTime: new Date(NOW - (hoursAgo - 4) * HOUR),
    });

    it('groups matches by series', () => {
        const [s] = seriesFromMatches([
            match('s1', 'TEST Cup', 'finished', 50),
            match('s1', 'TEST Cup', 'live', 1),
            match('s1', 'TEST Cup', 'scheduled', -24),
            { ...match(null, 'No series', 'finished', 5) },
        ]);
        assert.equal(s.code, 's1');
        assert.equal(s.started, 2);
        assert.equal(s.finished, 1);
        assert.equal(s.startDate, NOW - 50 * HOUR);
        assert.equal(s.endDate, NOW + 24 * HOUR);
    });

    it('asks for a table only when it can have changed', () => {
        const series = seriesFromMatches([
            match('new', 'TEST New Cup', 'live', 1),
            match('notyet', 'TEST Later Cup', 'scheduled', -5),
            match('tour', 'TEST A tour of TEST B', 'finished', 10),
            match('result', 'TEST Result Cup', 'finished', 5),
            match('quiet', 'TEST Quiet Cup', 'finished', 100),
            match('none', 'TEST Odd Series', 'finished', 100),
            match('ended', 'TEST Old Cup', 'finished', 24 * 20),
        ]);
        const row = (finishedMatches, hoursAgo, hasTable = true, recheck = false) => ({
            standings: hasTable ? [{ table: [{}] }] : [], season: { finishedMatches, recheck }, updatedAt: new Date(NOW - hoursAgo * HOUR),
        });
        const stored = new Map([
            ['result', row(0, 3)],
            ['quiet', row(1, 3)],
            ['none', row(0, 3, false)],
        ]);
        const due = dueSeries(series, stored, NOW);
        assert.deepEqual(due.map((s) => [s.code, s.recheck]), [['new', false], ['result', true]]);

        // After a result: asked once more an hour later, in case it was counted late
        stored.set('result', row(1, 0.5, true, true));
        assert.deepEqual(dueSeries(series, stored, NOW).map((s) => s.code), ['new']);
        stored.set('result', row(1, 2, true, true));
        assert.deepEqual(dueSeries(series, stored, NOW).map((s) => [s.code, s.recheck]), [['new', false], ['result', false]]);
        // ...and not again after that
        stored.set('result', row(1, 2, true, false));
        assert.deepEqual(dueSeries(series, stored, NOW).map((s) => s.code), ['new']);

        // A series without a table is asked about again a day later
        stored.set('none', row(0, 25, false));
        assert.ok(dueSeries(series, stored, NOW).some((s) => s.code === 'none'));

        // ...or 6 hours after a new result: tables can appear a few days in
        stored.set('none', row(0, 5, false));
        assert.ok(!dueSeries(series, stored, NOW).some((s) => s.code === 'none'));
        stored.set('none', row(0, 7, false));
        assert.ok(dueSeries(series, stored, NOW).some((s) => s.code === 'none'));
        stored.set('none', row(1, 7, false));
        assert.ok(!dueSeries(series, stored, NOW).some((s) => s.code === 'none'));
    });
});

// Real responses for the Syed Mushtaq Ali Trophy Elite 2026 (23 November):
// its points table (32 teams, no groups) and its match list
const smatPoints = JSON.parse(readFileSync(new URL('./fixtures/cricketdata-points-smat.json', import.meta.url))).data;
const smatInfo = JSON.parse(readFileSync(new URL('./fixtures/cricketdata-series-smat.json', import.meta.url))).data;

describe('Cricket tables played in groups', () => {
    it('reads the group from a match name', () => {
        assert.equal(parseGroup('Delhi vs Railways, Elite Group B, Syed Mushtaq Ali Trophy Elite 2026'), 'Elite Group B');
        assert.equal(parseGroup('Pakistan U19 vs Nepal U19, 12th Match, Group A, ACC Mens U19 Asia Cup 2026'), 'Group A');
        assert.equal(parseGroup('Tbc vs Tbc, Final, Syed Mushtaq Ali Trophy Elite 2026'), null);
    });

    it('puts each team in its first group, not a later stage', () => {
        const groups = teamGroups(smatInfo.matchList);
        assert.equal(Object.keys(groups).length, 32);
        assert.equal(groups.delhi, 'Elite Group B');
        assert.equal(groups.andhra, 'Elite Group C');
        // Spelt two ways in their match list
        assert.equal(groups['jammu and kashmir'], 'Elite Group B');
        assert.deepEqual([...new Set(Object.values(groups))].sort(), ['Elite Group A', 'Elite Group B', 'Elite Group C', 'Elite Group D']);
        assert.deepEqual(teamGroups([]), {});
    });

    it('splits a real table into its four groups of eight', () => {
        const standings = splitByGroup(toPointsTable(smatPoints), teamGroups(smatInfo.matchList));
        assert.deepEqual(standings.map((s) => [s.group, s.table.length]), [
            ['Elite Group A', 8], ['Elite Group B', 8], ['Elite Group C', 8], ['Elite Group D', 8],
        ]);
        for (const s of standings) assert.deepEqual(s.table.map((t) => t.position), [1, 2, 3, 4, 5, 6, 7, 8]);
    });

    it('finds a team whose name is spelt differently in the match list', () => {
        // Seen in the ACC Mens Asia Cup Rising Stars 2026
        const groups = { 'Hong Kong': 'Group A', 'India A': 'Group B', India: 'Group C' };
        assert.equal(groupOf(groups, 'Hong Kong China'), 'Group A');
        assert.equal(groupOf(groups, 'india a'), 'Group B');
        // Not a guess between two
        assert.equal(groupOf({ 'Hong Kong': 'A', 'Hong Kong China Women': 'B' }, 'Hong Kong China'), null);
        assert.equal(groupOf(groups, 'Nepal'), null);
    });

    it('keeps one table when there are no groups, and lists unknown teams last', () => {
        const table = toPointsTable(wbblPoints);
        assert.deepEqual(splitByGroup(table, {}), [{ stage: null, group: null, table }]);
        const split = splitByGroup(toPointsTable(smatPoints), { andhra: 'Group 1', assam: 'Group 2' });
        assert.deepEqual(split.map((s) => [s.group, s.table.length]), [['Group 1', 1], ['Group 2', 1], ['Other teams', 30]]);
    });
});
