// NBA conference standings and playoff series, worked out from the games we
// store. BALLDONTLIE's free plan has games but not standings (that's their
// $39.99/month plan), and the games are enough for wins, losses, games
// behind, home and away records, the last 10 and the streak.
//
// Teams level on win percentage are ordered by their head-to-head record when
// two are tied, then by name. The NBA's full tie-breakers (division leaders,
// conference record, …) aren't applied, so a tied team can be a place out.

const FINISHED = 'finished';

// The season a date falls in, as BALLDONTLIE numbers them: 2026 is 2026-27,
// from October to the Finals in June
export function nbaSeason(time = Date.now()) {
    const d = new Date(time);
    return d.getUTCMonth() >= 7 ? d.getUTCFullYear() : d.getUTCFullYear() - 1;
}

export const seasonDates = (season) => ({ startDate: `${season}-10-01`, endDate: `${season + 1}-06-30` });

const sides = (g) => [
    { team: g.homeTeam, abbr: g.details?.homeAbbr, conference: g.details?.homeConference, points: g.homeScore, home: true },
    { team: g.awayTeam, abbr: g.details?.awayAbbr, conference: g.details?.awayConference, points: g.awayScore, home: false },
];

const pct = (w, l) => (w + l === 0 ? 0 : w / (w + l));

// Regular-season games count, except the NBA Cup final
const countsForStandings = (g) => g.competition === 'NBA' && g.status === FINISHED && g.details?.cupStage !== 'Championship';

// [{ stage: 'REGULAR_SEASON', group: 'East' | 'West', table: [{ position,
//   team, abbr, won, lost, pct, gamesBehind, home, away, lastTen, streak }] }]
// `games` are `matches` rows of one season.
export function conferenceStandings(games) {
    const teams = new Map();
    const headToHead = new Map(); // "A|B" → wins of A over B

    const finished = games.filter(countsForStandings).sort((a, b) => a.startTime - b.startTime);

    for (const g of finished) {
        const [home, away] = sides(g);
        if (home.points === away.points) continue;

        for (const side of [home, away]) {
            const other = side === home ? away : home;
            const win = side.points > other.points;
            const t = teams.get(side.team) ?? {
                team: side.team, abbr: side.abbr ?? null, conference: side.conference ?? null,
                won: 0, lost: 0, homeW: 0, homeL: 0, awayW: 0, awayL: 0, results: [],
            };
            t.conference ??= side.conference ?? null;
            if (win) t.won++; else t.lost++;
            if (side.home) { if (win) t.homeW++; else t.homeL++; } else if (win) t.awayW++; else t.awayL++;
            t.results.push(win ? 'W' : 'L');
            teams.set(side.team, t);

            if (win) headToHead.set(`${side.team}|${other.team}`, (headToHead.get(`${side.team}|${other.team}`) ?? 0) + 1);
        }
    }

    const h2h = (a, b) => headToHead.get(`${a}|${b}`) ?? 0;

    return ['East', 'West'].map((conference) => {
        const list = [...teams.values()].filter((t) => t.conference === conference);

        list.sort((a, b) => {
            const byPct = pct(b.won, b.lost) - pct(a.won, a.lost);
            if (byPct !== 0) return byPct;
            const tied = list.filter((t) => pct(t.won, t.lost) === pct(a.won, a.lost));
            if (tied.length === 2) {
                const byH2h = h2h(b.team, a.team) - h2h(a.team, b.team);
                if (byH2h !== 0) return byH2h;
            }
            return b.won - a.won || a.team.localeCompare(b.team);
        });

        const leader = list[0];
        const table = list.map((t, i) => {
            const last = t.results.at(-1);
            let run = 0;
            for (let j = t.results.length - 1; j >= 0 && t.results[j] === last; j--) run++;
            const lastTen = t.results.slice(-10);
            const wins10 = lastTen.filter((r) => r === 'W').length;

            return {
                position: i + 1,
                team: t.team,
                abbr: t.abbr,
                won: t.won,
                lost: t.lost,
                pct: Math.round(pct(t.won, t.lost) * 1000) / 1000,
                gamesBehind: ((leader.won - t.won) + (t.lost - leader.lost)) / 2,
                home: `${t.homeW}-${t.homeL}`,
                away: `${t.awayW}-${t.awayL}`,
                lastTen: `${wins10}-${lastTen.length - wins10}`,
                streak: last ? `${last}${run}` : null,
            };
        });

        return { stage: 'REGULAR_SEASON', group: conference, table };
    }).filter((s) => s.table.length > 0);
}

const ROUNDS = ['First round', 'Conference semifinals', 'Conference finals', 'NBA Finals'];

// The playoffs as series: { stage: 'PLAYOFFS', group: null, series: [{ round,
// conference, teams: [{ team, abbr, wins, seed }], games, winner }] }, or null
// before they start. Play-in games (one game between two of a conference's
// 7th–10th placed teams) are listed with round 'Play-in'.
export function playoffSeries(games, standings) {
    const postseason = games
        .filter((g) => g.competition === 'NBA Playoffs' && g.status === FINISHED)
        .sort((a, b) => a.startTime - b.startTime);
    if (postseason.length === 0) return null;

    const seed = new Map();
    for (const s of standings) for (const row of s.table) seed.set(row.team, { position: row.position, conference: s.group });

    const pairs = new Map();
    for (const g of postseason) {
        const [home, away] = sides(g);
        const key = [home.team, away.team].sort().join('|');
        const pair = pairs.get(key) ?? {
            first: g.startTime,
            teams: new Map([home, away].map((s) => [s.team, { team: s.team, abbr: s.abbr ?? null, wins: 0 }])),
            conferences: new Set(),
            games: 0,
        };
        pair.games++;
        const winner = home.points > away.points ? home : away;
        pair.teams.get(winner.team).wins++;
        for (const s of [home, away]) if (s.conference) pair.conferences.add(s.conference);
        pairs.set(key, pair);
    }

    const isPlayIn = (pair) => {
        if (pair.games !== 1) return false;
        const seeds = [...pair.teams.keys()].map((t) => seed.get(t));
        return seeds.every((s) => s && s.position >= 7 && s.position <= 10) && seeds[0].conference === seeds[1].conference;
    };

    // A team's nth series (after the play-in) is round n
    const roundOf = new Map();
    const seriesCount = new Map();
    const ordered = [...pairs.entries()].sort((a, b) => a[1].first - b[1].first);
    for (const [key, pair] of ordered) {
        if (isPlayIn(pair)) {
            roundOf.set(key, 'Play-in');
            continue;
        }
        const n = Math.max(...[...pair.teams.keys()].map((t) => seriesCount.get(t) ?? 0));
        for (const t of pair.teams.keys()) seriesCount.set(t, n + 1);
        roundOf.set(key, ROUNDS[Math.min(n, ROUNDS.length - 1)]);
    }

    const series = ordered.map(([key, pair]) => {
        const round = roundOf.get(key);
        const teams = [...pair.teams.values()]
            .map((t) => ({ ...t, seed: seed.get(t.team)?.position ?? null }))
            .sort((a, b) => (a.seed ?? 99) - (b.seed ?? 99));
        const needed = round === 'Play-in' ? 1 : 4;
        const winner = teams.find((t) => t.wins >= needed)?.team ?? null;
        const conference = pair.conferences.size === 1 ? [...pair.conferences][0] : null;
        return { round, conference, teams, games: pair.games, winner };
    });

    return { stage: 'PLAYOFFS', group: null, series };
}
