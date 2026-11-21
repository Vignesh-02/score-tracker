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

// Seen going live more than this after the scheduled time: a late kick-off,
// so the clock starts from when it was seen instead
const LATE_KICKOFF_MS = 5 * MINUTE_MS;

// Without having seen half-time (e.g. the server started during the second
// half), assume the second half began this long after kick-off: 45 minutes,
// a couple of stoppage and 15 of half-time
const SECOND_HALF_AFTER_MS = 62 * MINUTE_MS;

// Beyond 90+15 it's extra time, where the estimate isn't worth showing
const MAX_STOPPAGE = 15;

// Adds `details.clock` ({ kickoffAt, secondHalfAt }) to a live football row
// from the adapter, carrying over what earlier syncs saw. `current` is our
// row before this sync (undefined for a new match).
export function withClock(current, row, now = Date.now()) {
    if (row.status !== MATCH_STATUS.LIVE || !row.details?.phase) return row;

    const before = current?.details ?? {};
    const seen = before.clock ?? {};

    let { kickoffAt, secondHalfAt = null } = seen;
    if (!kickoffAt) {
        const start = row.startTime.getTime();
        const late = current?.status === MATCH_STATUS.SCHEDULED && now - start > LATE_KICKOFF_MS;
        kickoffAt = new Date(late ? now - REPORT_LAG_MS : start).toISOString();
    }
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

    const seenSecondHalf = Date.parse(details.clock.secondHalfAt ?? '');
    const secondHalf = Number.isFinite(seenSecondHalf) ? seenSecondHalf
        : now - kickoff > SECOND_HALF_AFTER_MS ? kickoff + SECOND_HALF_AFTER_MS
        : null;

    if (secondHalf == null) {
        const minute = since(kickoff);
        return { label: minute <= 45 ? `${minute}'` : `45+${minute - 45}'`, minute, period: '1H' };
    }

    const minute = 45 + since(secondHalf);
    if (minute <= 90) return { label: `${minute}'`, minute, period: '2H' };
    if (minute <= 90 + MAX_STOPPAGE) return { label: `90+${minute - 90}'`, minute, period: '2H' };
    return { label: 'ET', minute, period: 'ET' };
}
