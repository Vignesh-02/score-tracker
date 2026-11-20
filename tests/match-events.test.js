import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describeChange, describeScorecardChange } from '../src/live/match-events.js';
import { toHeadToHead } from '../src/providers/football-data.js';

const football = (overrides = {}) => ({
    id: 1, sport: 'Football', homeTeam: 'Arsenal', awayTeam: 'Chelsea',
    status: 'live', homeScore: 1, awayScore: 1, details: null, ...overrides,
});

const innings = (side, number, runs, wickets, overs) => ({ side, number, runs, wickets, overs });
const cricket = (overrides = {}) => ({
    id: 2, sport: 'Cricket', homeTeam: 'India', awayTeam: 'New Zealand', status: 'live', homeScore: 0, awayScore: 0,
    details: { format: 'odi', statusText: 'India opt to bat', innings: [innings('home', 1, 150, 3, 30)] },
    ...overrides,
});

const messages = (events) => events.map((e) => e.message);

describe('match events for the live updates feed', () => {
    it('says nothing when nothing worth saying changed', () => {
        assert.deepEqual(describeChange(football(), football({ competition: 'Renamed' })), []);
    });

    it('reports kick-off, goals and full time in order', () => {
        const scheduled = football({ status: 'scheduled', homeScore: 0, awayScore: 0 });
        const live = football({ status: 'live', homeScore: 1, awayScore: 0 });
        const finished = football({ status: 'finished', homeScore: 2, awayScore: 0, details: { halfTime: { home: 1, away: 0 } } });

        assert.deepEqual(messages(describeChange(scheduled, live)), ['Kick-off', 'Goal! Arsenal · Arsenal 1–0 Chelsea']);
        assert.deepEqual(messages(describeChange(live, finished)), [
            'Goal! Arsenal · Arsenal 2–0 Chelsea',
            'Full time: Arsenal 2–0 Chelsea (HT 1–0)',
        ]);
    });

    it('skips kick-off when a sync only sees the match after it ended', () => {
        const scheduled = football({ status: 'scheduled', homeScore: 0, awayScore: 0 });
        const finished = football({ status: 'finished', homeScore: 0, awayScore: 0 });
        assert.deepEqual(messages(describeChange(scheduled, finished)), ['Full time: Arsenal 0–0 Chelsea']);
    });

    it('names the team that scored', () => {
        const [event] = describeChange(football(), football({ awayScore: 2 }));
        assert.equal(event.eventType, 'goal');
        assert.equal(event.team, 'Chelsea');
        assert.equal(event.message, 'Goal! Chelsea · Arsenal 1–2 Chelsea');
    });

    it('reports a goal taken away as a correction', () => {
        const [event] = describeChange(football({ homeScore: 2 }), football({ homeScore: 1 }));
        assert.equal(event.eventType, 'score_correction');
        assert.equal(event.message, 'Score corrected: Arsenal 1–1 Chelsea');
    });

    it('reports cricket wickets and runs per innings', () => {
        const wicket = describeChange(cricket(), cricket({ details: { innings: [innings('home', 1, 162, 4, 33.2)] } }));
        assert.deepEqual(messages(wicket), ['Wicket! India 162/4 (33.2 ov)']);

        const two = describeChange(cricket(), cricket({ details: { innings: [innings('home', 1, 170, 5, 35)] } }));
        assert.deepEqual(messages(two), ['2 wickets! India 170/5 (35 ov)']);

        const runs = describeChange(cricket(), cricket({ details: { innings: [innings('home', 1, 180, 3, 35)] } }));
        assert.deepEqual(messages(runs), ['India 180/3 (35 ov)']);
    });

    it('reports a new innings and the cricket result', () => {
        const before = cricket({ details: { innings: [innings('home', 1, 280, 10, 50)] } });
        const after = cricket({
            status: 'finished',
            details: { statusText: 'New Zealand won by 6 wkts', innings: [innings('home', 1, 280, 10, 50), innings('away', 1, 281, 4, 47.3)] },
        });

        assert.deepEqual(messages(describeChange(before, after)), [
            '4 wickets! New Zealand 281/4 (47.3 ov)',
            'New Zealand won by 6 wkts',
        ]);
    });
});

describe('cricket status lines', () => {
    it('reports the toss, chases and breaks while live', () => {
        const before = cricket();
        const after = cricket({ details: { ...before.details, statusText: 'New Zealand need 40 runs in 25 balls' } });
        assert.deepEqual(messages(describeChange(before, after)), ['New Zealand need 40 runs in 25 balls']);
        assert.deepEqual(describeChange(after, after), []);
    });

    it('leaves the status to the result line at the finish', () => {
        const before = cricket();
        const after = cricket({ status: 'finished', details: { ...before.details, statusText: 'India won by 10 runs' } });
        assert.deepEqual(messages(describeChange(before, after)), ['India won by 10 runs']);
    });
});

describe('scorecard lines for the live updates feed', () => {
    const match = { homeTeam: 'India', awayTeam: 'New Zealand' };
    const batter = (name, runs, balls, out = false, dismissal = out ? 'c Latham b Henry' : 'batting') => ({ name, runs, balls, out, dismissal });
    const bowler = (name, wickets, runs) => ({ name, wickets, runs });
    const card = (batting, bowling = []) => ({ innings: [{ side: 'home', number: 1, batting, bowling }] });

    it('says nothing on the first fetch', () => {
        assert.deepEqual(describeScorecardChange(null, card([batter('Rohit', 80, 60)]), match), []);
    });

    it('reports dismissals with the batter\'s score', () => {
        const before = card([batter('Rohit', 30, 25), batter('Gill', 10, 12)]);
        const after = card([batter('Rohit', 34, 28, true), batter('Gill', 12, 15), batter('Kohli', 0, 1)]);
        const [event] = describeScorecardChange(before, after, match);
        assert.deepEqual(event, { eventType: 'dismissal', team: 'India', actor: 'Rohit', message: 'Out: Rohit c Latham b Henry · 34 (28)' });
    });

    it('reports fifties, hundreds and five-wicket hauls once', () => {
        const before = card([batter('Rohit', 45, 40), batter('Gill', 98, 90)], [bowler('Henry', 4, 30)]);
        const after = card([batter('Rohit', 52, 44), batter('Gill', 101, 93)], [bowler('Henry', 5, 34)]);
        assert.deepEqual(messages(describeScorecardChange(before, after, match)), [
            'Fifty for Rohit · 52 off 44',
            'Hundred for Gill · 101 off 93',
            '5 wickets for Henry · 5/34',
        ]);
        assert.deepEqual(describeScorecardChange(after, after, match), []);
    });

    it('counts a batter new to the card from zero', () => {
        const after = card([batter('Pant', 55, 30)]);
        assert.deepEqual(messages(describeScorecardChange(card([]), after, match)), ['Fifty for Pant · 55 off 30']);
    });
});

describe('football-data.org head-to-head', () => {
    // A real response for São Paulo v Fluminense (match 555087, 20 Nov 2026)
    const body = JSON.parse(readFileSync(new URL('./fixtures/football-data-head2head.json', import.meta.url)));

    it('leaves out the match itself and keeps the newest first', () => {
        const meetings = toHeadToHead(body, { excludeId: '555087' });
        assert.equal(meetings.length, 5);
        assert.deepEqual(meetings[0], {
            date: '2026-05-16T22:00:00Z', competition: 'Campeonato Brasileiro Série A',
            homeTeam: 'Fluminense', awayTeam: 'São Paulo', homeScore: 2, awayScore: 1,
        });
        assert.ok(meetings.every((m, i) => i === 0 || m.date <= meetings[i - 1].date));
    });
});
