// Speed test for CricketData.org: watches one live match and prints the time
// whenever its score changes, so you can compare against Cricbuzz/TV.
//
//   node --env-file=.env scripts/cricket-latency.js            # list live matches (1 hit)
//   node --env-file=.env scripts/cricket-latency.js <match-id> # watch one match
//
// Options (env): EVERY_SECONDS (default 60), FOR_MINUTES (default 20).
// Each check costs 1 hit of the 100 a day, so the default run uses about 20.
// The API echoes the key in responses, so this never prints raw responses.

const BASE_URL = 'https://api.cricapi.com/v1';
const apiKey = process.env.CRICKETDATA_API_KEY;
const everySeconds = Number(process.env.EVERY_SECONDS ?? 60);
const forMinutes = Number(process.env.FOR_MINUTES ?? 20);

if (!apiKey) {
    console.error('CRICKETDATA_API_KEY is empty in .env (is the file saved?)');
    process.exit(1);
}

async function call(path, params = {}) {
    const query = new URLSearchParams({ ...params, apikey: apiKey });
    const res = await fetch(`${BASE_URL}/${path}?${query}`);
    if (!res.ok) throw new Error(`CricketData.org responded ${res.status}`);
    const body = await res.json();
    if (body.status !== 'success') throw new Error(`CricketData.org: ${String(body.reason ?? body.status).slice(0, 200)}`);
    return { data: body.data, hits: `${body.info?.hitsToday ?? '?'}/${body.info?.hitsLimit ?? '?'}` };
}

const clock = () => new Date().toLocaleTimeString('en-GB');
const scoreOf = (m) => (m.score ?? []).map((s) => `${s.inning}: ${s.r}/${s.w} (${s.o} ov)`).join(' | ') || 'no score yet';

async function listLive() {
    const { data, hits } = await call('currentMatches', { offset: 0 });
    const live = data.filter((m) => m.matchStarted && !m.matchEnded);

    console.log(`Hits used today: ${hits}\n`);
    if (live.length === 0) return console.log('No live matches on the first page right now. Try again during a match.');

    console.log('Live matches (id, then name):');
    for (const m of live) console.log(`  ${m.id}  ${m.name}${m.fantasyEnabled ? '  [scorecard]' : ''}\n      ${scoreOf(m)}`);
    console.log('\nWatch one with: node --env-file=.env scripts/cricket-latency.js <id>');
}

async function watch(id) {
    const end = Date.now() + forMinutes * 60_000;
    let last = null;

    console.log(`Checking every ${everySeconds}s for ${forMinutes} min. Note the Cricbuzz time of each change next to these.\n`);

    while (Date.now() < end) {
        try {
            const { data, hits } = await call('match_info', { id });
            const score = scoreOf(data);
            if (score !== last) {
                console.log(`${clock()}  CHANGED  ${score}   [${data.status}]  (hits ${hits})`);
                last = score;
            } else {
                console.log(`${clock()}  same     (hits ${hits})`);
            }
            if (data.matchEnded) return console.log('Match ended.');
        } catch (e) {
            console.log(`${clock()}  error: ${e.message}`);
            if (/exceeded/i.test(e.message)) return;
        }
        await new Promise((r) => setTimeout(r, everySeconds * 1000));
    }
}

await (process.argv[2] ? watch(process.argv[2]) : listLive());
