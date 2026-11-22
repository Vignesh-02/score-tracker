// An estimated match clock for live football. football-data.org's free plan
// doesn't send the minute, only whether a match is in play (IN_PLAY) or at
// half-time (PAUSED), so the sync notes when it sees each half start and the
// minute is worked out from those times. Usually within a minute or two.
//
// client/src/lib/football-clock.js has a copy of matchMinute for the cards;
// keep the two in step.

import { MATCH_STATUS } from '../validation/matches.js';

const MINUTE_MS = 60_000;

// A status change happens on average half a sync (30s) before we see it, plus
// the provider's own delay
const REPORT_LAG_MS = MINUTE_MS;

// Their free plan doesn't report half-time reliably: on 21 Nov some matches
// stayed IN_PLAY right through it (so the clock read 45+15'), and others went
// back to IN_PLAY about 50 minutes after kick-off, well before the restart.
// So the clock follows the usual shape of a match, using their status only
// where it fits:
// - first half up to FIRST_HALF_MS after kick-off (45 minutes and up to 3 of
//   stoppage), then half-time
// - the second half from a reported restart RESTART_FROM_MS to RESTART_UNTIL_MS
//   after kick-off, otherwise from SECOND_HALF_AFTER_MS (45 minutes, a couple
//   of stoppage and 15 of half-time)
// - PAUSED always shows half-time
const FIRST_HALF_MS = 48 * MINUTE_MS;
const SECOND_HALF_AFTER_MS = 62 * MINUTE_MS;
const RESTART_FROM_MS = 58 * MINUTE_MS;
const RESTART_UNTIL_MS = 80 * MINUTE_MS;

// Beyond 90+15 it's extra time, where the estimate isn't worth showing
const MAX_STOPPAGE = 15;

// Adds `details.clock` ({ kickoffAt, secondHalfAt }) to a live football row
// from the adapter, carrying over what earlier syncs saw. `current` is our
// row before this sync (undefined for a new match).
//
// The clock starts at the scheduled kick-off. Starting it from when the match
// was first seen live would catch the odd late kick-off, but a stale cached
// response can make a match look "not started" until long after it began (Man
// City v Fulham's clock started 81 minutes late that way).
export function withClock(current, row, now = Date.now()) {
    if (row.status !== MATCH_STATUS.LIVE || !row.details?.phase) return row;

    const before = current?.details ?? {};
    const seen = before.clock ?? {};

    // Always the scheduled time, which also corrects clocks saved by the
    // earlier late kick-off rule
    const kickoffAt = row.startTime.toISOString();
    let secondHalfAt = seen.secondHalfAt ?? null;
    if (!secondHalfAt && before.phase === 'PAUSED' && row.details.phase === 'IN_PLAY') {
        secondHalfAt = new Date(now - REPORT_LAG_MS).toISOString();
    }

    return { ...row, details: { ...row.details, clock: { kickoffAt, secondHalfAt } } };
}

// { label, minute, period } for a live football match's details, or null when
// there's nothing to show. label: "23'", "45+2'", "HT", "67'", "90+3'", "ET".
// period: '1H', 'HT', '2H' or 'ET'.
export function matchMinute(details, now = Date.now()) {
    const kickoff = Date.parse(details?.clock?.kickoffAt ?? '');
    if (!Number.isFinite(kickoff)) return null;

    if (details.phase === 'PAUSED') return { label: 'HT', minute: 45, period: 'HT' };
    if (details.phase !== 'IN_PLAY') return null;

    const since = (from) => Math.max(1, Math.floor((now - from) / MINUTE_MS) + 1);

    if (now - kickoff < FIRST_HALF_MS) {
        const minute = since(kickoff);
        return { label: minute <= 45 ? `${minute}'` : `45+${minute - 45}'`, minute, period: '1H' };
    }

    const seen = Date.parse(details.clock.secondHalfAt ?? '');
    const plausible = Number.isFinite(seen) && seen - kickoff >= RESTART_FROM_MS && seen - kickoff <= RESTART_UNTIL_MS;
    const secondHalf = plausible ? seen : kickoff + SECOND_HALF_AFTER_MS;

    if (now < secondHalf) return { label: 'HT', minute: 45, period: 'HT' };

    const minute = 45 + since(secondHalf);
    if (minute <= 90) return { label: `${minute}'`, minute, period: '2H' };
    if (minute <= 90 + MAX_STOPPAGE) return { label: `90+${minute - 90}'`, minute, period: '2H' };
    return { label: 'ET', minute, period: 'ET' };
}
