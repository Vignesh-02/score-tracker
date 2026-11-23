import { and, eq, gte, lte } from 'drizzle-orm';
import { db } from '../db/db.js';
import { competitionStats, matches } from '../db/schema.js';
import { SOURCE, fetchSeriesGroups, fetchSeriesPoints } from '../providers/cricketdata.js';
import { MATCH_STATUS } from '../validation/matches.js';
import { saveCompetitionStats } from './football-stats-sync.js';

// Keeps the points tables of cricket tournaments in `competition_stats`, next
// to football's league tables. Run by the cricket sync after each sync, when
// today's hits allow (src/jobs/cricket-sync.js).
//
// Each table costs 1 hit, so one is fetched only when it can have changed:
// - a series we've never asked about, once one of its matches has started
// - a series with more finished matches than when its table was fetched
// - once more an hour after that, as CricketData.org can be slow to count a result
// Tournaments played in groups get one table per group: the series' match list
// (1 more hit, kept with the table) says which group each team is in.
// Bilateral tours ("England tour of Australia") have no table and are skipped
// by name. Any other series that comes back without one is saved with an
// empty table, and asked about again a day later, or 6 hours after a new
// result (some tournaments' tables only appear a few days in).

export const TABLES_PER_SYNC = 3;
// How far back and ahead to look for series' matches
const LOOK_BACK_MS = 60 * 24 * 60 * 60_000;
const LOOK_AHEAD_MS = 30 * 24 * 60 * 60_000;
// A series stays listed this long after its last match (as football's seasons do)
const LISTED_AFTER_MS = 14 * 24 * 60 * 60_000;
// After a new result, wait this long before asking, then ask once more an hour later
const AFTER_RESULT_MS = 15 * 60_000;
const RECHECK_AFTER_MS = 60 * 60_000;
const NO_TABLE_RETRY_MS = 24 * 60 * 60_000;
// A series without a table is asked again sooner after a new result: some
// tournaments' tables only appear a few days in
const NO_TABLE_AFTER_RESULT_MS = 6 * 60 * 60_000;
// The match list is fetched again for teams it didn't have at most this often
const GROUPS_RETRY_MS = 24 * 60 * 60_000;

const BILATERAL = /\btour of\b/i;

const time = (d) => (d ? new Date(d).getTime() : null);

// Groups cricket matches by series: { code, name, startDate, endDate, started,
// finished }. `rows` are `matches` rows with details.seriesId.
export function seriesFromMatches(rows) {
    const series = new Map();

    for (const m of rows) {
        const code = m.details?.seriesId;
        if (!code || !m.competition || !m.startTime) continue;

        const s = series.get(code) ?? {
            code, name: m.competition, startDate: null, endDate: null, started: 0, finished: 0,
        };
        const start = time(m.startTime);
        if (s.startDate == null || start < s.startDate) s.startDate = start;
        if (s.endDate == null || start > s.endDate) s.endDate = start;
        if (m.status !== MATCH_STATUS.SCHEDULED) s.started++;
        if (m.status === MATCH_STATUS.FINISHED) s.finished++;
        series.set(code, s);
    }

    return [...series.values()];
}

// The series whose table should be fetched now, most needed first. `stored`
// maps a code to its competition_stats row ({ standings, season, updatedAt }).
// `recheck` on a returned series: fetch it once more an hour after this one.
export function dueSeries(series, stored, now = Date.now()) {
    const due = [];

    for (const s of series) {
        if (s.started === 0 || BILATERAL.test(s.name) || s.endDate + LISTED_AFTER_MS < now) continue;

        const row = stored.get(s.code);
        if (!row) {
            due.push({ series: { ...s, recheck: false }, since: 0 });
            continue;
        }

        const age = now - time(row.updatedAt);
        const hasTable = row.standings?.length > 0;
        const newResult = s.finished > (row.season?.finishedMatches ?? 0) && age >= AFTER_RESULT_MS;
        const recheck = row.season?.recheck === true && age >= RECHECK_AFTER_MS;
        const moreResults = s.finished > (row.season?.finishedMatches ?? 0);
        const retry = !hasTable && (age >= NO_TABLE_RETRY_MS || (moreResults && age >= NO_TABLE_AFTER_RESULT_MS));

        if (hasTable ? newResult || recheck : retry) {
            due.push({ series: { ...s, recheck: newResult }, since: time(row.updatedAt) });
        }
    }

    return due.sort((a, b) => a.since - b.since).map((d) => d.series);
}

const isoDate = (ms) => new Date(ms).toISOString();

// Fetches and saves up to `limit` due tables. `onHits` gets each response's
// usage (the cricket sync's noteCricketHits). Returns how many were fetched.
// A team's group. Names are compared ignoring case, and a name that extends
// another counts as the same team: the table's "Hong Kong China" is the match
// list's "Hong Kong".
export function groupOf(groups, team) {
    const lower = new Map(Object.entries(groups ?? {}).map(([name, group]) => [name.toLowerCase(), group]));
    const name = team.toLowerCase();
    if (lower.has(name)) return lower.get(name);
    const close = [...lower.keys()].filter((k) => name.startsWith(`${k} `) || k.startsWith(`${name} `));
    return close.length === 1 ? lower.get(close[0]) : null;
}

// One table per group when the teams are in two or more groups (`groups`:
// lower-cased team name → group, from teamGroups), positions
// counted within each; teams with no known group go in a last table.
// Otherwise one table.
export function splitByGroup(table, groups) {
    const names = new Set(Object.values(groups ?? {}));
    if (names.size < 2) return [{ stage: null, group: null, table }];

    const byGroup = new Map([...names].sort().map((g) => [g, []]));
    const other = [];
    for (const row of table) (byGroup.get(groupOf(groups, row.team)) ?? other).push(row);
    if (other.length) byGroup.set('Other teams', other);

    return [...byGroup]
        .filter(([, rows]) => rows.length > 0)
        .map(([group, rows]) => ({ stage: null, group, table: rows.map((row, i) => ({ ...row, position: i + 1 })) }));
}

export async function syncCricketTables({
    limit = TABLES_PER_SYNC, now = Date.now(), fetchPoints = fetchSeriesPoints, fetchGroups = fetchSeriesGroups, onHits,
} = {}) {
    const rows = await db
        .select({
            competition: matches.competition, status: matches.status, startTime: matches.startTime,
            details: matches.details,
        })
        .from(matches)
        .where(and(
            eq(matches.source, SOURCE),
            gte(matches.startTime, new Date(now - LOOK_BACK_MS)),
            lte(matches.startTime, new Date(now + LOOK_AHEAD_MS)),
        ));

    const stored = await db
        .select({ code: competitionStats.code, standings: competitionStats.standings, season: competitionStats.season, updatedAt: competitionStats.updatedAt })
        .from(competitionStats)
        .where(eq(competitionStats.sport, 'Cricket'));
    const storedByCode = new Map(stored.map((r) => [r.code, r]));

    const due = dueSeries(seriesFromMatches(rows), storedByCode, now).slice(0, limit);

    let fetched = 0;
    for (const s of due) {
        let table;
        try {
            const result = await fetchPoints(s.code);
            onHits?.({ hitsToday: result.hitsToday, hitsLimit: result.hitsLimit });
            table = result.table;
        } catch (e) {
            // Out of hits, or a network or server error: try again next time.
            // Anything else ("CricketData.org: <reason>") is taken as this
            // series having no table, so the same hit isn't spent every sync.
            if (/exceeded/i.test(e.message) || !e.message.startsWith('CricketData.org: ')) throw e;
            console.error(`Cricket table for ${s.name}: ${e.message}`);
            table = [];
        }
        fetched++;

        // Which group each team is in: kept from before, fetched the first
        // time, and again (at most daily) if a team is missing from it
        const before = storedByCode.get(s.code)?.season ?? {};
        let groups = before.groups ?? null;
        let groupsAt = before.groupsAt ?? null;
        const missing = groups && table.some((t) => !groupOf(groups, t.team));
        const groupsDue = table.length > 2 && (!groups || (missing && now - (time(groupsAt) ?? 0) >= GROUPS_RETRY_MS));
        if (groupsDue) {
            try {
                const result = await fetchGroups(s.code);
                onHits?.({ hitsToday: result.hitsToday, hitsLimit: result.hitsLimit });
                groups = result.groups;
                groupsAt = isoDate(now);
            } catch (e) {
                if (/exceeded/i.test(e.message)) throw e;
                console.error(`Cricket groups for ${s.name}: ${e.message}`);
            }
        }

        // A table of two is a bilateral series under another name
        const standings = table.length > 2 ? splitByGroup(table, groups) : [];
        await saveCompetitionStats(
            {
                code: s.code, sport: 'Cricket', name: s.name, area: null, emblem: null,
                season: {
                    startDate: isoDate(s.startDate), endDate: isoDate(s.endDate), finishedMatches: s.finished, recheck: s.recheck,
                    groups, groupsAt,
                },
            },
            { standings, scorers: [] },
        );
    }

    return fetched;
}
