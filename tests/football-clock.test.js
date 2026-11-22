import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { matchMinute, withClock } from '../src/live/football-clock.js';
import { matchMinute as clientMatchMinute } from '../client/src/lib/football-clock.js';
import { toMatchRow } from '../src/providers/football-data.js';

const MIN = 60_000;
const kickoff = Date.UTC(2026, 10, 21, 15);
const iso = (t) => new Date(t).toISOString();
const live = (phase, extra = {}) => ({
    status: 'live', sport: 'Football', startTime: new Date(kickoff), details: { phase }, ...extra,
});
const clock = (kickoffAt, secondHalfAt = null) => ({ kickoffAt: iso(kickoffAt), secondHalfAt: secondHalfAt && iso(secondHalfAt) });

describe('football-data.org live phase', () => {
    const match = (status) => ({
        id: 1, utcDate: iso(kickoff), status, homeTeam: { shortName: 'Arsenal' }, awayTeam: { shortName: 'Chelsea' },
        score: { fullTime: { home: 1, away: 0 }, halfTime: { home: 1, away: 0 } },
    });

    it('keeps their status while live, and only the half-time score once finished', () => {
        assert.deepEqual(toMatchRow(match('IN_PLAY')).details, { phase: 'IN_PLAY' });
        assert.deepEqual(toMatchRow(match('PAUSED')).details, { phase: 'PAUSED' });
        assert.deepEqual(toMatchRow(match('FINISHED')).details, { halfTime: { home: 1, away: 0 } });
        assert.equal(toMatchRow(match('TIMED')).details, undefined);
    });
});

describe('estimated football clock', () => {
    it('starts from the scheduled kick-off', () => {
        const scheduled = { status: 'scheduled', details: null };
        const row = withClock(scheduled, live('IN_PLAY'), kickoff + 2 * MIN);
        assert.deepEqual(row.details.clock, clock(kickoff));
    });

    it('starts from the scheduled kick-off even when first seen live long after', () => {
        // e.g. a stale cached response said "not started" until then
        const scheduled = { status: 'scheduled', details: null };
        const row = withClock(scheduled, live('IN_PLAY'), kickoff + 81 * MIN);
        assert.deepEqual(row.details.clock, clock(kickoff));
    });

    it('replaces a kick-off time saved later than the scheduled one', () => {
        const before = { status: 'live', details: { phase: 'IN_PLAY', clock: clock(kickoff + 81 * MIN) } };
        assert.deepEqual(withClock(before, live('IN_PLAY'), kickoff + 85 * MIN).details.clock, clock(kickoff));
    });

    it('notes the second half when half-time ends, and keeps both times', () => {
        const atHalfTime = { status: 'live', details: { phase: 'PAUSED', clock: clock(kickoff) } };
        const restarted = withClock(atHalfTime, live('IN_PLAY'), kickoff + 64 * MIN);
        assert.deepEqual(restarted.details.clock, clock(kickoff, kickoff + 63 * MIN));

        const later = withClock(restarted, live('IN_PLAY'), kickoff + 90 * MIN);
        assert.deepEqual(later.details.clock, restarted.details.clock);
    });

    it('leaves rows that aren\'t live football alone', () => {
        const cricket = { status: 'live', details: { format: 't20', innings: [] } };
        assert.equal(withClock(undefined, cricket), cricket);
        const finished = { status: 'finished', details: { halfTime: { home: 0, away: 0 } } };
        assert.equal(withClock(undefined, finished), finished);
    });

    it('shows the minute through both halves and stoppage time', () => {
        const firstHalf = { phase: 'IN_PLAY', clock: clock(kickoff) };
        const secondHalf = { phase: 'IN_PLAY', clock: clock(kickoff, kickoff + 62 * MIN) };
        const at = (details, minutes) => matchMinute(details, kickoff + minutes * MIN)?.label;

        assert.equal(at(firstHalf, 0), "1'");
        assert.equal(at(firstHalf, 22.5), "23'");
        assert.equal(at(firstHalf, 46), "45+2'");
        assert.equal(at({ ...firstHalf, phase: 'PAUSED' }, 50), 'HT');
        assert.equal(at(secondHalf, 62), "46'");
        assert.equal(at(secondHalf, 83.5), "67'");
        assert.equal(at(secondHalf, 110), "90+4'");
        assert.equal(at(secondHalf, 140), 'ET');
    });

    it('shows half-time from 48 minutes in, even when they still say in play', () => {
        // Swansea v West Brom stayed IN_PLAY through half-time and read 45+16'
        const details = { phase: 'IN_PLAY', clock: clock(kickoff) };
        assert.equal(matchMinute(details, kickoff + 47 * MIN).label, "45+3'");
        assert.equal(matchMinute(details, kickoff + 48 * MIN).label, 'HT');
        assert.equal(matchMinute(details, kickoff + 61 * MIN).label, 'HT');
        assert.equal(matchMinute(details, kickoff + 62 * MIN).label, "46'");
    });

    it('ignores a reported restart too soon after kick-off', () => {
        // Stoke v Birmingham "restarted" 49 minutes in
        const details = { phase: 'IN_PLAY', clock: clock(kickoff, kickoff + 49 * MIN) };
        assert.equal(matchMinute(details, kickoff + 55 * MIN).label, 'HT');
        assert.equal(matchMinute(details, kickoff + 70 * MIN).label, "54'");
    });

    it('assumes the second half began 62 minutes in when half-time wasn\'t seen', () => {
        const details = { phase: 'IN_PLAY', clock: clock(kickoff) };
        assert.equal(matchMinute(details, kickoff + 80 * MIN).label, "64'");
    });

    it('shows nothing without a clock or while suspended', () => {
        assert.equal(matchMinute(null), null);
        assert.equal(matchMinute({ phase: 'IN_PLAY' }), null);
        assert.equal(matchMinute({ phase: 'SUSPENDED', clock: clock(kickoff) }), null);
    });

    it('gives the same minutes as the copy in the client', () => {
        const cases = [
            [{ phase: 'IN_PLAY', clock: clock(kickoff) }, [0, 10, 46, 48, 55, 70, 100]],
            [{ phase: 'IN_PLAY', clock: clock(kickoff, kickoff + 49 * MIN) }, [50, 70]],
            [{ phase: 'IN_PLAY', clock: clock(kickoff, kickoff + 63 * MIN) }, [64, 90, 110, 150]],
            [{ phase: 'PAUSED', clock: clock(kickoff) }, [50]],
        ];
        for (const [details, minutes] of cases) {
            for (const m of minutes) {
                assert.deepEqual(clientMatchMinute(details, kickoff + m * MIN), matchMinute(details, kickoff + m * MIN));
            }
        }
    });
});
