import { Router } from 'express';
import { eq } from 'drizzle-orm';
import { db } from '../db/db.js';
import { matches } from '../db/schema.js';
import { matchIdParamSchema } from '../validation/matches.js';
import { SOURCE as FOOTBALL_DATA, fetchHeadToHead } from '../providers/football-data.js';

// GET /matches/:id/head2head: the last meetings of the two teams, for the match
// page. Only football-data.org matches have one.
//
// It's fetched when someone opens a match page, so it's cached, and at most
// FETCHES_PER_MINUTE uncached requests go to football-data.org a minute: its
// free plan allows 10 a minute, shared with the syncs.
export const headToHeadRouter = Router({ mergeParams: true });

// Past meetings only change when these two teams play again
const CACHE_MS = 6 * 60 * 60_000;
const MAX_CACHED = 500;
const FETCHES_PER_MINUTE = 3;

const cache = new Map(); // externalId → { at, promise }
let recentFetches = [];

// For tests
export function clearHeadToHeadCache() {
    cache.clear();
    recentFetches = [];
}

function cachedHeadToHead(externalId, fetcher) {
    const now = Date.now();
    const hit = cache.get(externalId);
    if (hit && now - hit.at < CACHE_MS) return hit.promise;

    recentFetches = recentFetches.filter((t) => now - t < 60_000);
    if (recentFetches.length >= FETCHES_PER_MINUTE) return null;
    recentFetches.push(now);

    // Concurrent requests for the same match share one fetch; a failure isn't cached
    const promise = fetcher(externalId);
    promise.catch(() => cache.delete(externalId));
    cache.set(externalId, { at: now, promise });

    // Map keeps insertion order, so the first key is the oldest
    if (cache.size > MAX_CACHED) cache.delete(cache.keys().next().value);

    return promise;
}

export function createHeadToHeadHandler({ fetcher = fetchHeadToHead } = {}) {
    return async (req, res) => {
        const parsed = matchIdParamSchema.safeParse(req.params);
        if (!parsed.success) {
            return res.status(400).json({ error: 'Invalid match id' });
        }

        try {
            const [match] = await db
                .select({ source: matches.source, externalId: matches.externalId })
                .from(matches)
                .where(eq(matches.id, parsed.data.id));

            if (!match) return res.status(404).json({ error: 'Match not found' });

            // Other sources have no head-to-head: an empty list, not an error
            if (match.source !== FOOTBALL_DATA || !match.externalId || !process.env.FOOTBALL_DATA_API_KEY) {
                return res.json({ data: [] });
            }

            const pending = cachedHeadToHead(match.externalId, fetcher);
            if (!pending) {
                return res.status(503).set('Retry-After', '60').json({ error: 'Head-to-head is busy, try again in a minute' });
            }

            res.set('Cache-Control', 'public, max-age=3600').json({ data: await pending });
        } catch (e) {
            console.error('Failed to get head-to-head:', e.message);
            res.status(502).json({ error: 'Failed to get head-to-head' });
        }
    };
}

headToHeadRouter.get('/', createHeadToHeadHandler());
