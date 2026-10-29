import { Router } from  'express';
import { desc, eq } from 'drizzle-orm';
import { createMatchSchema, listMatchesQuerySchema, matchIdParamSchema, updateScoreSchema } from '../../validation/matches.js';
import { getMatchStatus } from '../../utils/match-status.js';
import { syncStatuses } from '../../jobs/status-sync.js';
import { db } from '../../db/db.js';
import { matches } from '../../db/schema.js';

export const matchRouter = Router();

const MAX_LIMIT = 100;

matchRouter.get('/', async (req,res) => {
    const parsed = listMatchesQuerySchema.safeParse(req.query);

    if(!parsed.success){
        return res.status(400).json({ error: "Invalid query", details: parsed.error.issues });   
    }

    const limit = Math.min(parsed.data.limit ?? 50, MAX_LIMIT)

    try{
        const data = await db.select().from(matches).orderBy(desc(matches.createdAt)).limit(limit);

        // This is Drizzle ORM, and it reads almost like SQL:

        // SELECT * FROM matches ORDER BY created_at DESC LIMIT 50;

        // The background job syncs every 30s; this makes the list exact right now.
        // Changes found here are broadcast too, so clients never miss one.
        await syncStatuses(data, res.app.locals.broadcastStatusChange);

        res.json({ data })

    } catch(e){
        console.error('Failed to list matches:', e);
        res.status(500).json({ error: 'Failed to list matches'});
    }
})

matchRouter.post('/', async (req,res) => {
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


matchRouter.patch('/:id/score', async (req,res) => {
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
