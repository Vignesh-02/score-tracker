import { describe, it } from 'node:test';
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { parseClock, toMatchRow } from '../src/providers/balldontlie.js';
import { wantedInterval } from '../src/jobs/basketball-sync.js';
import { describeChange, periodLabel } from '../src/live/match-events.js';
import { gameClock } from '../client/src/lib/basketball.js';
import { conferenceStandings, nbaSeason, playoffSeries, seasonDates } from '../src/live/nba-standings.js';

// The example game from BALLDONTLIE's docs (GET /v1/games)
const finalGame = {
    id: 15907925, date: '2025-01-05', season: 2024, status: 'Final', status_state: 'final', period: 4, time: 'Final',
    postseason: false, postponed: false, home_team_score: 115, visitor_team_score: 105, datetime: '2025-01-05T23:00:00.000Z',
    home_q1: 29, home_q2: 34, home_q3: 28, home_q4: 24, home_ot1: null, home_ot2: null, home_ot3: null,
    visitor_q1: 23, visitor_q2: 25, visitor_q3: 30, visitor_q4: 27, visitor_ot1: null, visitor_ot2: null, visitor_ot3: null,
    ist_stage: null,
    home_team: { id: 6, conference: 'East', division: 'Central', city: 'Cleveland', name: 'Cavaliers', full_name: 'Cleveland Cavaliers', abbreviation: 'CLE' },
    visitor_team: { id: 4, conference: 'East', division: 'Southeast', city: 'Charlotte', name: 'Hornets', full_name: 'Charlotte Hornets', abbreviation: 'CHA' },
};

const liveGame = {
    ...finalGame, status: '3rd Qtr', status_state: 'in_progress', period: 3, time: 'Q3 4:12',
    home_team_score: 80, visitor_team_score: 70, home_q3: 17, home_q4: null, visitor_q3: 22, visitor_q4: null,
};

const scheduledGame = {
    ...finalGame, status: '7:00 pm ET', status_state: 'scheduled', period: 0, time: ' ',
    home_team_score: 0, visitor_team_score: 0,
    home_q1: null, home_q2: null, home_q3: null, home_q4: null, visitor_q1: null, visitor_q2: null, visitor_q3: null, visitor_q4: null,
};

describe('BALLDONTLIE adapter', () => {
    it('converts a finished game', () => {
        const row = toMatchRow(finalGame);
        assert.equal(row.source, 'balldontlie');
        assert.equal(row.externalId, '15907925');
        assert.equal(row.sport, 'Basketball');
        assert.equal(row.competition, 'NBA');
        assert.equal(row.homeTeam, 'Cleveland Cavaliers');
        assert.equal(row.awayTeam, 'Charlotte Hornets');
        assert.equal(row.status, 'finished');
        assert.equal(row.startTime.toISOString(), '2025-01-05T23:00:00.000Z');
        assert.equal(row.endTime.getTime() - row.startTime.getTime(), 2.5 * 3600e3);
        assert.equal(row.homeScore, 115);
        assert.equal(row.awayScore, 105);
        assert.deepEqual(row.details, {
            period: 4, clock: null, statusText: null,
            quarters: { home: [29, 34, 28, 24], away: [23, 25, 30, 27] },
            homeAbbr: 'CLE', awayAbbr: 'CHA', homeConference: 'East', awayConference: 'East', season: 2024, cupStage: null,
        });
    });

    it('converts a live game with its quarter and clock', () => {
        const row = toMatchRow(liveGame);
        assert.equal(row.status, 'live');
        assert.equal(row.details.period, 3);
        assert.equal(row.details.clock, '4:12');
        assert.equal(row.details.statusText, '3rd Qtr');
        assert.deepEqual(row.details.quarters, { home: [29, 34, 17], away: [23, 25, 22] });
    });

    it('reads the clock as they really send it', () => {
        // Seen live on 23 November 2026
        assert.equal(parseClock('Q4 6:47'), '6:47');
        assert.equal(parseClock('Q3 :49.8'), '0:49');
        assert.equal(parseClock('2OT 1:05'), '1:05');
        assert.equal(parseClock('6:47'), '6:47');
        assert.equal(parseClock('Half'), null);
        assert.equal(parseClock('Final'), null);
        assert.equal(parseClock(null), null);
    });

    it('converts a game not yet started', () => {
        const row = toMatchRow(scheduledGame);
        assert.equal(row.status, 'scheduled');
        assert.deepEqual([row.details.period, row.details.clock, row.details.quarters], [0, null, null]);
    });

    it('falls back on the status text when status_state is missing or unknown', () => {
        assert.equal(toMatchRow({ ...liveGame, status_state: undefined }).status, 'live');
        assert.equal(toMatchRow({ ...liveGame, status_state: 'unknown', status: 'Halftime' }).status, 'live');
        assert.equal(toMatchRow({ ...finalGame, status_state: 'unknown' }).status, 'finished');
        assert.equal(toMatchRow({ ...scheduledGame, status_state: undefined }).status, 'scheduled');
    });

    it('marks playoff games and skips games without teams', () => {
        assert.equal(toMatchRow({ ...finalGame, postseason: true }).competition, 'NBA Playoffs');
        assert.equal(toMatchRow({ ...finalGame, home_team: null }), null);
        assert.equal(toMatchRow({ ...finalGame, datetime: null, date: null }), null);
    });
});

describe('NBA sync pace', () => {
    const now = Date.parse('2026-11-22T00:00:00Z');
    const game = (status, minutesFromNow) => ({ status, startTime: new Date(now + minutesFromNow * 60_000) });

    it('checks every 30s while a game is on or about to tip off, every 10 min otherwise', () => {
        assert.equal(wantedInterval([game('live', -30)], now), 30_000);
        assert.equal(wantedInterval([game('scheduled', 10)], now), 30_000);
        // Late tip-offs: still "scheduled" after the start time
        assert.equal(wantedInterval([game('scheduled', -60)], now), 30_000);
        assert.equal(wantedInterval([game('scheduled', 120), game('finished', -300)], now), 600_000);
        assert.equal(wantedInterval([], now), 600_000);
    });
});

describe('NBA feed lines', () => {
    const base = toMatchRow(liveGame);
    const at = (overrides, details = {}) => ({ ...base, ...overrides, details: { ...base.details, ...details } });

    it('says tip-off, but nothing for each basket', () => {
        const before = { ...toMatchRow(scheduledGame) };
        const tipOff = at({ homeScore: 2, awayScore: 0 }, { period: 1, clock: '11:40', statusText: '1st Qtr', quarters: { home: [2], away: [0] } });
        assert.deepEqual(describeChange(before, tipOff).map((e) => e.message), ['Tip-off']);
        assert.deepEqual(describeChange(tipOff, { ...tipOff, homeScore: 5 }), []);
    });

    it('marks the end of each quarter with the score then', () => {
        const q1 = at({ homeScore: 29, awayScore: 23 }, { period: 1, clock: '0:30', statusText: '1st Qtr', quarters: { home: [29], away: [23] } });
        const q2 = at({ homeScore: 31, awayScore: 23 }, { period: 2, clock: '11:35', statusText: '2nd Qtr', quarters: { home: [29, 2], away: [23, 0] } });
        assert.deepEqual(describeChange(q1, q2), [
            { eventType: 'period_end', team: null, period: 'Q1', message: 'End of Q1: Cleveland Cavaliers 29–23 Charlotte Hornets' },
        ]);
    });

    it('calls halftime once, whether or not a sync saw it', () => {
        const q2 = at({ homeScore: 63, awayScore: 48 }, { period: 2, clock: '0:05', statusText: '2nd Qtr', quarters: { home: [29, 34], away: [23, 25] } });
        const half = at({ homeScore: 63, awayScore: 48 }, { period: 2, clock: null, statusText: 'Halftime' });
        const q3 = at({ homeScore: 65, awayScore: 48 }, { period: 3, clock: '11:40', statusText: '3rd Qtr', quarters: { home: [29, 34, 2], away: [23, 25, 0] } });

        assert.deepEqual(describeChange(q2, half).map((e) => e.message), ['Halftime: Cleveland Cavaliers 63–48 Charlotte Hornets']);
        assert.deepEqual(describeChange(half, q3), []);
        // Straight from the 2nd quarter to the 3rd
        assert.deepEqual(describeChange(q2, q3).map((e) => e.message), ['Halftime: Cleveland Cavaliers 63–48 Charlotte Hornets']);
    });

    it('calls overtime and the final score', () => {
        const q4 = at({ homeScore: 100, awayScore: 100 }, { period: 4, clock: '0:01', statusText: '4th Qtr' });
        const ot = at({ homeScore: 102, awayScore: 100 }, { period: 5, clock: '4:40', statusText: 'OT' });
        assert.deepEqual(describeChange(q4, ot).map((e) => e.eventType), ['period_end', 'overtime']);
        assert.equal(describeChange(q4, ot)[1].message, 'OT under way');

        const final = at({ status: 'finished', homeScore: 110, awayScore: 104 }, { period: 5, clock: null, statusText: null });
        assert.deepEqual(describeChange(ot, final).map((e) => e.message), ['Final (OT): Cleveland Cavaliers 110–104 Charlotte Hornets']);
    });

    it('labels periods and the live clock', () => {
        assert.deepEqual([1, 4, 5, 6].map(periodLabel), ['Q1', 'Q4', 'OT', '2OT']);
        assert.equal(gameClock({ period: 3, clock: '4:12', statusText: '3rd Qtr' }), 'Q3 4:12');
        assert.equal(gameClock({ period: 2, clock: null, statusText: 'Halftime' }), 'HT');
        assert.equal(gameClock({ period: 1, clock: null, statusText: '1st Qtr' }), 'End Q1');
        assert.equal(gameClock({ period: 5, clock: '1:05' }), 'OT 1:05');
        assert.equal(gameClock({ period: 0 }), null);
    });
});

// A real GET /v1/games response (22 November 2026: yesterday's finals and
// today's games before tip-off)
const { data: realGames } = JSON.parse(readFileSync(new URL('./fixtures/balldontlie-games.json', import.meta.url)));

describe('BALLDONTLIE adapter on a real response', () => {
    it('converts every game', () => {
        const rows = realGames.map(toMatchRow);
        assert.equal(rows.filter(Boolean).length, realGames.length);
        assert.deepEqual(rows.map((r) => r.status).sort(), [...Array(6).fill('finished'), ...Array(7).fill('scheduled')]);
    });

    it('keeps the quarter scores of a finished game and none before tip-off', () => {
        const [final] = realGames.map(toMatchRow);
        assert.equal(final.homeTeam, 'Philadelphia 76ers');
        assert.deepEqual(final.details.quarters, { home: [29, 31, 38, 34], away: [30, 29, 33, 37] });
        const upcoming = toMatchRow(realGames.find((g) => g.status_state === 'scheduled'));
        // Before tip-off their status is the start time and `time` is null
        assert.deepEqual([upcoming.details.period, upcoming.details.clock, upcoming.details.quarters], [0, null, null]);
    });
});

describe('NBA standings from games', () => {
    const teams = {
        BOS: 'East', NYK: 'East', MIA: 'East', ATL: 'East', CHI: 'East', DET: 'East', ORL: 'East', IND: 'East', TOR: 'East', CHA: 'East',
        LAL: 'West', GSW: 'West',
    };
    let day = 0;
    const game = (home, homeScore, away, awayScore, competition = 'NBA', extra = {}) => ({
        homeTeam: home, awayTeam: away, homeScore, awayScore, status: 'finished', competition,
        startTime: new Date(Date.UTC(2026, 9, 21) + day++ * 86400e3),
        details: { homeAbbr: home, awayAbbr: away, homeConference: teams[home], awayConference: teams[away], ...extra },
    });

    it('counts wins, losses, games behind, home and away, last 10 and streak', () => {
        day = 0;
        const games = [
            game('BOS', 110, 'NYK', 100),
            game('NYK', 99, 'BOS', 105),
            game('MIA', 90, 'BOS', 95),
            game('NYK', 120, 'MIA', 101),
            game('LAL', 100, 'GSW', 98),
            { ...game('BOS', 100, 'NYK', 90), status: 'live' },
            // The NBA Cup final doesn't count
            game('NYK', 130, 'BOS', 90, 'NBA', { cupStage: 'Championship' }),
        ];
        const [east, west] = conferenceStandings(games);
        assert.equal(east.group, 'East');
        assert.deepEqual(east.table[0], {
            position: 1, team: 'BOS', abbr: 'BOS', won: 3, lost: 0, pct: 1, gamesBehind: 0,
            home: '1-0', away: '2-0', lastTen: '3-0', streak: 'W3',
        });
        assert.deepEqual(east.table.map((t) => [t.team, t.won, t.lost, t.gamesBehind, t.streak]), [
            ['BOS', 3, 0, 0, 'W3'], ['NYK', 1, 2, 2, 'W1'], ['MIA', 0, 2, 2.5, 'L2'],
        ]);
        assert.deepEqual(west.table.map((t) => t.team), ['LAL', 'GSW']);
    });

    it('breaks a two-team tie by head-to-head', () => {
        day = 0;
        // ATL and CHI both 2-1; CHI won their game, so CHI is above despite the name
        const games = [
            game('CHI', 100, 'ATL', 90),
            game('ATL', 100, 'ORL', 90),
            game('ORL', 90, 'ATL', 100),
            game('CHI', 100, 'ORL', 90),
            game('ORL', 100, 'CHI', 90),
        ];
        assert.deepEqual(conferenceStandings(games)[0].table.map((t) => [t.team, t.won, t.lost]), [['CHI', 2, 1], ['ATL', 2, 1], ['ORL', 1, 3]]);
    });

    it('returns no playoffs before they start', () => {
        assert.equal(playoffSeries([game('BOS', 1, 'NYK', 0)], []), null);
    });

    it('turns playoff games into series, with the play-in and later rounds', () => {
        // Seeds 1–10 in the East: BOS 1 … CHA 10
        const order = ['BOS', 'NYK', 'MIA', 'ATL', 'CHI', 'DET', 'ORL', 'IND', 'TOR', 'CHA'];
        const standings = [{ group: 'East', table: order.map((team, i) => ({ team, position: i + 1 })) }];
        day = 200;
        const po = (home, hs, away, as) => game(home, hs, away, as, 'NBA Playoffs');
        const games = [
            po('ORL', 100, 'IND', 90), // play-in 7 v 8
            po('TOR', 100, 'CHA', 90), // play-in 9 v 10
            po('BOS', 110, 'IND', 100), po('BOS', 110, 'IND', 100), po('IND', 110, 'BOS', 100), po('IND', 90, 'BOS', 100), po('BOS', 120, 'IND', 100),
            po('ATL', 100, 'CHI', 90),
            po('BOS', 100, 'ATL', 90),
        ];
        const { series } = playoffSeries(games, standings);
        const find = (a, b) => series.find((s) => s.teams.some((t) => t.team === a) && s.teams.some((t) => t.team === b));

        assert.equal(find('ORL', 'IND').round, 'Play-in');
        assert.equal(find('ORL', 'IND').winner, 'ORL');
        assert.equal(find('TOR', 'CHA').round, 'Play-in');

        const r1 = find('BOS', 'IND');
        assert.equal(r1.round, 'First round');
        assert.deepEqual(r1.teams.map((t) => [t.team, t.seed, t.wins]), [['BOS', 1, 4], ['IND', 8, 1]]);
        assert.equal(r1.winner, 'BOS');
        assert.equal(r1.conference, 'East');

        assert.equal(find('ATL', 'CHI').round, 'First round');
        assert.equal(find('ATL', 'CHI').winner, null);
        assert.equal(find('BOS', 'ATL').round, 'Conference semifinals');
    });

    it('knows the season and its dates', () => {
        assert.equal(nbaSeason(Date.UTC(2026, 10, 22)), 2026);
        assert.equal(nbaSeason(Date.UTC(2027, 4, 1)), 2026);
        assert.deepEqual(seasonDates(2026), { startDate: '2026-10-01', endDate: '2027-06-30' });
    });
});
