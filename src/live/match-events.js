import { db } from '../db/db.js';
import { commentary } from '../db/schema.js';
import { matchMinute } from './football-clock.js';

// Turns a change to a synced match into readable lines for the match page's
// live updates feed ("Goal! Arsenal · Arsenal 2–1 Chelsea"). The providers on
// the free plans only send scores, not events, so these are worked out by
// comparing the match before and after a sync.

const LIVE = 'live';
const FINISHED = 'finished';

const scoreLine = (m) => `${m.homeTeam} ${m.homeScore}–${m.awayScore} ${m.awayTeam}`;
const teamFor = (m, side) => (side === 'home' ? m.homeTeam : m.awayTeam);
const inningsLine = (i) => `${i.runs}/${i.wickets} (${i.overs} ov)`;
const isCricket = (m) => Array.isArray(m.details?.innings) || m.sport?.toLowerCase() === 'cricket';
const isBasketball = (m) => m.sport?.toLowerCase() === 'basketball';

// ---------- basketball ----------

// 1–4 the quarters, 5 the first overtime, 6 the second…
export const periodLabel = (period) => (period <= 4 ? `Q${period}` : period === 5 ? 'OT' : `${period - 4}OT`);

// The score at the end of a period, from the quarter scores when there are
// enough of them, otherwise the score now
function scoreAfter(m, period) {
    const { home = [], away = [] } = m.details?.quarters ?? {};
    if (home.length < period || away.length < period) return scoreLine(m);
    const sum = (list) => list.slice(0, period).reduce((a, b) => a + b, 0);
    return `${m.homeTeam} ${sum(home)}–${sum(away)} ${m.awayTeam}`;
}

// No line per basket (there are 200 a game): the end of each period instead,
// with halftime and overtime called out
function basketballPeriodEvents(previous, next) {
    const events = [];
    const was = previous.details?.period ?? 0;
    const now = next.details?.period ?? 0;
    const halftimeNow = /half/i.test(next.details?.statusText ?? '');
    const halftimeBefore = /half/i.test(previous.details?.statusText ?? '');

    for (let p = Math.max(was, 1); p < now; p++) {
        if (p === 2) {
            // Already said when it went to halftime
            if (!halftimeBefore) events.push({ eventType: 'half_time', team: null, period: 'HT', message: `Halftime: ${scoreAfter(next, 2)}` });
        } else {
            events.push({ eventType: 'period_end', team: null, period: periodLabel(p), message: `End of ${periodLabel(p)}: ${scoreAfter(next, p)}` });
        }
    }

    if (halftimeNow && !halftimeBefore && now <= 2) {
        events.push({ eventType: 'half_time', team: null, period: 'HT', message: `Halftime: ${scoreAfter(next, 2)}` });
    }
    if (now >= 5 && now > was && was >= 1) {
        events.push({ eventType: 'overtime', team: null, period: periodLabel(now), message: `${periodLabel(now)} under way` });
    }

    return events;
}

function footballScoreEvents(previous, next, now) {
    const events = [];

    // The estimated minute ("Goal! Arsenal 23'"), while the clock is running.
    // Not at half-time or the final whistle: a goal reported then was scored
    // some time before.
    const clock = next.status === LIVE ? matchMinute(next.details, now) : null;
    const when = clock && clock.period !== 'HT' && clock.period !== 'ET' ? clock : null;

    for (const side of ['home', 'away']) {
        const key = side === 'home' ? 'homeScore' : 'awayScore';
        const goals = next[key] - previous[key];
        const team = teamFor(next, side);

        for (let i = 0; i < goals; i++) {
            events.push({
                eventType: 'goal', team,
                minute: when?.minute ?? null, period: when?.period ?? null,
                message: `Goal! ${team}${when ? ` ${when.label}` : ''} · ${scoreLine(next)}`,
            });
        }
    }

    // A goal ruled out after the provider already reported it
    if (next.homeScore < previous.homeScore || next.awayScore < previous.awayScore) {
        events.push({ eventType: 'score_correction', team: null, message: `Score corrected: ${scoreLine(next)}` });
    }

    return events;
}

function cricketScoreEvents(previous, next) {
    const before = new Map((previous.details?.innings ?? []).map((i) => [`${i.side}-${i.number}`, i]));
    const events = [];

    for (const innings of next.details?.innings ?? []) {
        const old = before.get(`${innings.side}-${innings.number}`);
        const team = teamFor(next, innings.side);
        const wickets = innings.wickets - (old?.wickets ?? 0);

        if (wickets > 0) {
            const label = wickets === 1 ? 'Wicket!' : `${wickets} wickets!`;
            events.push({ eventType: 'wicket', team, message: `${label} ${team} ${inningsLine(innings)}` });
        } else if (!old || innings.runs !== old.runs) {
            events.push({ eventType: 'score', team, message: `${team} ${inningsLine(innings)}` });
        }
    }

    return events;
}

// The feed lines for one change, oldest first. [] when nothing worth saying changed.
export function describeChange(previous, next, now = Date.now()) {
    const cricket = isCricket(next);
    const basketball = isBasketball(next);
    const events = [];

    if (previous.status !== LIVE && next.status === LIVE) {
        events.push({ eventType: 'start', team: null, message: cricket ? 'Match started' : basketball ? 'Tip-off' : 'Kick-off' });
    }

    if (basketball) {
        if (next.status !== FINISHED) events.push(...basketballPeriodEvents(previous, next));
        if (previous.status !== FINISHED && next.status === FINISHED) {
            const period = next.details?.period ?? 4;
            const ot = period > 4 ? ` (${periodLabel(period)})` : '';
            events.push({ eventType: 'full_time', team: null, message: `Final${ot}: ${scoreLine(next)}` });
        }
        return events;
    }

    events.push(...(cricket ? cricketScoreEvents(previous, next) : footballScoreEvents(previous, next, now)));

    // Football's half-time and the start of the second half, from the provider's status
    if (!cricket && previous.status === LIVE && next.status === LIVE) {
        const was = previous.details?.phase;
        const phase = next.details?.phase;
        if (was === 'IN_PLAY' && phase === 'PAUSED') {
            events.push({ eventType: 'half_time', team: null, period: 'HT', message: `Half-time: ${scoreLine(next)}` });
        } else if (was === 'PAUSED' && phase === 'IN_PLAY') {
            events.push({ eventType: 'second_half', team: null, period: '2H', message: 'Second half under way' });
        }
    }

    // The toss, innings breaks and chases ("India need 32 runs from 18 balls").
    // At the finish the result line below says it instead.
    const statusText = next.details?.statusText;
    if (cricket && next.status === LIVE && statusText && statusText !== previous.details?.statusText) {
        events.push({ eventType: 'status', team: null, message: statusText });
    }

    if (previous.status !== FINISHED && next.status === FINISHED) {
        if (cricket) {
            events.push({ eventType: 'result', team: null, message: next.details?.statusText || 'Match finished' });
        } else {
            const ht = next.details?.halfTime;
            const halfTime = ht ? ` (HT ${ht.home}–${ht.away})` : '';
            events.push({ eventType: 'full_time', team: null, message: `Full time: ${scoreLine(next)}${halfTime}` });
        }
    }

    return events;
}

// ---------- from cricket scorecards ----------

const MILESTONES = [[200, 'Double hundred'], [150, '150'], [100, 'Hundred'], [50, 'Fifty']];

// Lines for what happened between two fetches of a scorecard: dismissals with
// the batter's score, fifties and hundreds, and five-wicket hauls. Nothing on
// the first fetch, when there's no earlier scorecard to compare with.
export function describeScorecardChange(previous, next, match) {
    if (!previous) return [];

    const before = new Map((previous.innings ?? []).map((i) => [`${i.side}-${i.number}`, i]));
    const events = [];

    for (const innings of next.innings ?? []) {
        const old = before.get(`${innings.side}-${innings.number}`);
        const batting = teamFor(match, innings.side);
        const bowling = teamFor(match, innings.side === 'home' ? 'away' : 'home');
        const oldBatter = new Map((old?.batting ?? []).map((b) => [b.name, b]));
        const oldBowler = new Map((old?.bowling ?? []).map((b) => [b.name, b]));

        for (const b of innings.batting) {
            const was = oldBatter.get(b.name);
            const [, label] = MILESTONES.find(([runs]) => b.runs >= runs && (was?.runs ?? 0) < runs) ?? [];
            if (label) {
                events.push({ eventType: 'milestone', team: batting, actor: b.name, message: `${label} for ${b.name} · ${b.runs} off ${b.balls}` });
            }
            if (b.out && !was?.out) {
                // "Out: Janet Mbabazi lbw b Rosine Irera · 3 (7)"
                const how = b.dismissal ? ` ${b.dismissal}` : '';
                events.push({ eventType: 'dismissal', team: batting, actor: b.name, message: `Out: ${b.name}${how} · ${b.runs} (${b.balls})` });
            }
        }

        for (const b of innings.bowling) {
            if (b.wickets >= 5 && (oldBowler.get(b.name)?.wickets ?? 0) < 5) {
                events.push({ eventType: 'milestone', team: bowling, actor: b.name, message: `${b.wickets} wickets for ${b.name} · ${b.wickets}/${b.runs}` });
            }
        }
    }

    return events;
}

// ---------- saving ----------

// Saves feed lines for a match and sends each to the match's subscribers
export async function saveEvents(matchId, events, broadcastCommentary) {
    if (events.length === 0) return [];

    const rows = await db
        .insert(commentary)
        .values(events.map((e) => ({ matchId, ...e })))
        .returning();

    for (const row of rows) broadcastCommentary?.(matchId, row);
    return rows;
}

// Saves the lines for one change to a synced match
export function recordMatchEvents(previous, next, broadcastCommentary) {
    return saveEvents(next.id, describeChange(previous, next), broadcastCommentary);
}
