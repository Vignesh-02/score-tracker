import { Router } from 'express';
import { eq } from 'drizzle-orm';
import { db } from '../db/db.js';
import { cricketScorecards, matches } from '../db/schema.js';
import { matchIdParamSchema } from '../validation/matches.js';
import { SCORECARD_HITS, SOURCE as CRICKETDATA, fetchScorecard } from '../providers/cricketdata.js';
import { cricketHitsLeft, noteCricketHits } from '../jobs/cricket-sync.js';
import { describeScorecardChange, saveEvents } from '../live/match-events.js';

// GET /matches/:id/scorecard: the batting and bowling card of a CricketData.org
// match, for the match page.
//
// Each fetch costs 10 hits of the day's allowance (100 on the free plan, 2,000
// on the cheapest paid one), shared with the score sync. So scorecards are kept
// in the database and fetched only when someone opens a match page:
// - a finished match's scorecard is fetched once and kept for good
// - a live one is refetched at most every CRICKET_SCORECARD_MINUTES (default 5
//   on a plan with 1,000+ hits a day, 15 on the free plan)
// - no fetch at all when it would leave fewer than KEEP_FOR_SYNC hits today;
//   the last saved scorecard is shown instead, marked stale
//
// Response: { data: { ...scorecard, fetchedAt, final, stale } } or
// { data: null, reason: 'none' | 'not_started' | 'limit' | 'unavailable' }.
export const scorecardRouter = Router({ mergeParams: true });

function liveTtlMs(hitsLeft) {
    const minutes = Number(process.env.CRICKET_SCORECARD_MINUTES) || ((hitsLeft()?.limit ?? 0) >= 1000 ? 5 : 15);
    return minutes * 60_000;
}

// Hits a scorecard must leave for the score sync: the larger of 30 or a tenth
// of the daily limit
const keepForSync = (limit) => Math.max(30, Math.round(limit * 0.1));

// After a failed fetch (often a match CricketData.org has no scorecard for),
// don't spend hits on the same match again for a while
const RETRY_AFTER_FAILURE_MS = 30 * 60_000;

const pending = new Map(); // matchId → promise of the fetch in progress
const failedAt = new Map(); // matchId → time of the last failed fetch

// For tests
export function clearScorecardState() {
    pending.clear();
    failedAt.clear();
}

function hasRoom(hitsLeft) {
    const hits = hitsLeft();
    // Unknown until the first cricket sync reports it (it's saved across
    // restarts): don't guess with 10 hits at a time
    if (!hits) return false;
    return hits.left - SCORECARD_HITS >= keepForSync(hits.limit);
}

const view = (row, extra = {}) => ({ ...row.data, final: row.final, fetchedAt: row.fetchedAt, stale: false, ...extra });

async function refresh(match, stored, { fetcher, broadcastCommentary }) {
    const { scorecard, hitsToday, hitsLimit } = await fetcher(match.externalId);
    noteCricketHits({ hitsToday, hitsLimit });

    const { final, ...data } = scorecard;
    const values = { data, final: final || match.status === 'finished', fetchedAt: new Date() };
    const [row] = await db
        .insert(cricketScorecards)
        .values({ matchId: match.id, ...values })
        .onConflictDoUpdate({ target: cricketScorecards.matchId, set: values })
        .returning();

    // Dismissals and milestones since the last fetch become feed lines. A
    // failure here mustn't lose the scorecard.
    await saveEvents(match.id, describeScorecardChange(stored?.data, data, match), broadcastCommentary)
        .catch((e) => console.error('Failed to record scorecard events:', e.message));

    return row;
}

export function createScorecardHandler({ fetcher = fetchScorecard, hitsLeft = cricketHitsLeft } = {}) {
    return async (req, res) => {
        const parsed = matchIdParamSchema.safeParse(req.params);
        if (!parsed.success) {
            return res.status(400).json({ error: 'Invalid match id' });
        }
        const id = parsed.data.id;

        try {
            const [match] = await db
                .select({
                    id: matches.id, source: matches.source, externalId: matches.externalId, status: matches.status,
                    homeTeam: matches.homeTeam, awayTeam: matches.awayTeam, details: matches.details,
                })
                .from(matches)
                .where(eq(matches.id, id));

            if (!match) return res.status(404).json({ error: 'Match not found' });

            if (match.source !== CRICKETDATA || !match.externalId) return res.json({ data: null, reason: 'none' });
            if (match.status === 'scheduled') return res.json({ data: null, reason: 'not_started' });

            const [stored] = await db.select().from(cricketScorecards).where(eq(cricketScorecards.matchId, id));

            if (stored && (stored.final || Date.now() - stored.fetchedAt.getTime() < liveTtlMs(hitsLeft))) {
                res.set('Cache-Control', stored.final ? 'public, max-age=86400' : 'public, max-age=60');
                return res.json({ data: view(stored) });
            }

            // Reasons not to spend hits: then the saved one (if any) is the best there is
            const noScorecard = match.details?.hasScorecard === false;
            const recentlyFailed = Date.now() - (failedAt.get(id) ?? 0) < RETRY_AFTER_FAILURE_MS;
            const reason = !process.env.CRICKETDATA_API_KEY || noScorecard || recentlyFailed ? 'unavailable'
                : !pending.has(id) && !hasRoom(hitsLeft) ? 'limit'
                : null;

            if (reason) {
                return res.json(stored ? { data: view(stored, { stale: true }) } : { data: null, reason });
            }

            // Visitors opening the same match at once share one fetch
            if (!pending.has(id)) {
                const promise = refresh(match, stored, { fetcher, broadcastCommentary: req.app.locals.broadcastCommentary })
                    .catch((e) => {
                        failedAt.set(id, Date.now());
                        throw e;
                    })
                    .finally(() => pending.delete(id));
                pending.set(id, promise);
            }

            try {
                const row = await pending.get(id);
                res.set('Cache-Control', 'public, max-age=60').json({ data: view(row) });
            } catch (e) {
                console.error('Failed to fetch scorecard:', e.message);
                res.json(stored ? { data: view(stored, { stale: true }) } : { data: null, reason: 'unavailable' });
            }
        } catch (e) {
            console.error('Failed to get scorecard:', e.message);
            res.status(502).json({ error: 'Failed to get scorecard' });
        }
    };
}

scorecardRouter.get('/', createScorecardHandler());
