import { Router } from  'express';
import { and, asc, between, desc, eq, gte, isNull, or, sql } from 'drizzle-orm';
import { MATCH_STATUS, createMatchSchema, listMatchesQuerySchema, matchIdParamSchema, updateScoreSchema } from '../../validation/matches.js';
import { getMatchStatus } from '../../utils/match-status.js';
import { syncStatuses } from '../../jobs/status-sync.js';
import { db } from '../../db/db.js';
import { requireAdmin } from '../../auth.js';
import { matches } from '../../db/schema.js';

export const matchRouter = Router();

const MAX_LIMIT = 100;

const DAY_MS = 24 * 60 * 60 * 1000;

// How far ahead the dashboard looks for upcoming matches. Two weeks covers an
// international break, when most leagues pause for 10 days or so.
const UPCOMING_DAYS = 14;

// Finished matches always shown, newest first, however long ago they were
// played, so a quiet week still shows the last matchday of every league
const RECENT_RESULTS = 40;

// Results older than this are never "current", even if nothing newer exists
const RESULTS_MAX_AGE_DAYS = 30;

// What the dashboard shows, in this order:
//   1. every live match
//   2. scheduled matches from a day ago (a little late or postponed) to
//      UPCOMING_DAYS ahead, soonest first
//   3. the RECENT_RESULTS most recent finished matches, newest first
// When there are more than `limit`, the furthest-away upcoming matches are cut
// first, so results and live games always fit.
async function currentMatches(limit, now = Date.now()) {
    const { LIVE, SCHEDULED, FINISHED } = MATCH_STATUS;

    const [live, upcoming, finished] = await Promise.all([
        db.select().from(matches)
            .where(eq(matches.status, LIVE))
            .orderBy(asc(matches.startTime))
            .limit(limit),
        db.select().from(matches)
            .where(and(
                eq(matches.status, SCHEDULED),
                or(isNull(matches.startTime), between(matches.startTime, new Date(now - DAY_MS), new Date(now + UPCOMING_DAYS * DAY_MS))),
            ))
            .orderBy(sql`${matches.startTime} asc nulls last`)
            .limit(limit),
        db.select().from(matches)
            .where(and(eq(matches.status, FINISHED), gte(matches.startTime, new Date(now - RESULTS_MAX_AGE_DAYS * DAY_MS))))
            .orderBy(desc(matches.startTime))
            .limit(Math.min(RECENT_RESULTS, limit)),
    ]);

    const results = finished.slice(0, Math.max(0, limit - live.length));
    const upcomingRoom = Math.max(0, limit - live.length - results.length);

    return [...live, ...upcoming.slice(0, upcomingRoom), ...results];
}

matchRouter.get('/', async (req,res) => {
    const parsed = listMatchesQuerySchema.safeParse(req.query);

    if(!parsed.success){
        return res.status(400).json({ error: "Invalid query", details: parsed.error.issues });   
    }

    const limit = Math.min(parsed.data.limit ?? 50, MAX_LIMIT)

    try{
        const data = parsed.data.view === 'current'
            ? await currentMatches(limit)
            // This is Drizzle ORM, and it reads almost like SQL:
            // SELECT * FROM matches ORDER BY created_at DESC LIMIT 50;
            : await db.select().from(matches).orderBy(desc(matches.createdAt)).limit(limit);

        // The background job syncs every 30s; this makes the list exact right now.
        // Changes found here are broadcast too, so clients never miss one.
        await syncStatuses(data, res.app.locals.broadcastStatusChange);

        res.json({ data })

    } catch(e){
        console.error('Failed to list matches:', e);
        res.status(500).json({ error: 'Failed to list matches'});
    }
})

matchRouter.post('/', requireAdmin, async (req,res) => {
    const parsed = createMatchSchema.safeParse(req.body);

    if(!parsed.success){
        return res.status(400).json({ error: 'Invalid payload', details: parsed.error.issues });
    }

    const { data : { startTime, endTime, homeScore, awayScore }} = parsed;

    try{
        const [event] = await db.insert(matches).values({
            ...parsed.data,
            startTime: new Date(startTime),
            endTime: new Date(endTime),
            homeScore: homeScore ?? 0,
            awayScore: awayScore ?? 0,
            status: getMatchStatus(startTime, endTime),
        }).returning();
        
        if(res.app.locals.broadcastMatchCreated){
            res.app.locals.broadcastMatchCreated(event);
        }

        res.status(201).json({ data: event })

    }catch(e){
        console.error('Failed to create match:', e);
        return res.status(500).json({ error: 'Failed to create match' });
    }
})


matchRouter.patch('/:id/score', requireAdmin, async (req,res) => {
    const parsedParams = matchIdParamSchema.safeParse(req.params);

    if(!parsedParams.success){
        return res.status(400).json({ error: 'Invalid match id', details: parsedParams.error.issues });
    }

    const parsedBody = updateScoreSchema.safeParse(req.body);

    if(!parsedBody.success){
        return res.status(400).json({ error: 'Invalid payload', details: parsedBody.error.issues });
    }

    const matchId = parsedParams.data.id;

    try{
        // UPDATE matches SET home_score = ..., away_score = ... WHERE id = :id RETURNING *;
        const [updated] = await db
            .update(matches)
            .set(parsedBody.data)
            .where(eq(matches.id, matchId))
            .returning();

        if(!updated){
            return res.status(404).json({ error: 'Match not found' });
        }

        // matchId must be a number to match the keys subscribers used
        res.app.locals.broadcastScoreUpdate?.(matchId, updated);

        res.json({ data: updated });

    }catch(e){
        console.error('Failed to update score:', e);
        res.status(500).json({ error: 'Failed to update score' });
    }
})
