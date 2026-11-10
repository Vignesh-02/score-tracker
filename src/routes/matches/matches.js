import { Router } from  'express';
import { and, between, desc, eq, gte, isNull, or, sql } from 'drizzle-orm';
import { MATCH_STATUS, createMatchSchema, listMatchesQuerySchema, matchIdParamSchema, updateScoreSchema } from '../../validation/matches.js';
import { getMatchStatus } from '../../utils/match-status.js';
import { syncStatuses } from '../../jobs/status-sync.js';
import { db } from '../../db/db.js';
import { requireAdmin } from '../../auth.js';
import { matches } from '../../db/schema.js';

export const matchRouter = Router();

const MAX_LIMIT = 100;

const DAY_MS = 24 * 60 * 60 * 1000;

// What the dashboard shows: every live match, scheduled matches from a day ago
// (a little late or postponed) to a week ahead, and matches finished in the
// last 2 days. Live first, then upcoming soonest first, then finished most
// recent first, so the limit cuts old results before anything current.
function currentMatches(limit, now = Date.now()) {
    const { LIVE, SCHEDULED, FINISHED } = MATCH_STATUS;

    return db
        .select()
        .from(matches)
        .where(or(
            eq(matches.status, LIVE),
            and(
                eq(matches.status, SCHEDULED),
                or(isNull(matches.startTime), between(matches.startTime, new Date(now - DAY_MS), new Date(now + 7 * DAY_MS))),
            ),
            and(eq(matches.status, FINISHED), gte(matches.startTime, new Date(now - 2 * DAY_MS))),
        ))
        .orderBy(
            sql`case ${matches.status} when ${LIVE} then 0 when ${SCHEDULED} then 1 else 2 end`,
            // Live and upcoming: earliest first. Finished rows all get null here,
            // so the next rule orders them instead.
            sql`case when ${matches.status} <> ${FINISHED} then ${matches.startTime} end asc nulls last`,
            desc(matches.startTime),
        )
        .limit(limit);
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
