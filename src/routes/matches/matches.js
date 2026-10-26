import { Router } from  'express';
import { desc } from 'drizzle-orm';
import { createMatchSchema, listMatchesQuerySchema, matchIdParamSchema, createCommentarySchema } from '../../validation/matches.js';
import { getMatchStatus } from '../../utils/match-status.js';
import { db } from '../../db/db.js';
import { matches, commentary } from '../../db/schema.js';

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

matchRouter.post('/:id/commentary', async (req,res) => {
    // req.params.id is a string ("5"); the schema coerces it to a number (5)
    const parsedParams = matchIdParamSchema.safeParse(req.params);

    if(!parsedParams.success){
        return res.status(400).json({ error: 'Invalid match id', details: parsedParams.error.issues });
    }

    const parsedBody = createCommentarySchema.safeParse(req.body);

    if(!parsedBody.success){
        return res.status(400).json({ error: 'Invalid payload', details: parsedBody.error.issues });
    }

    const matchId = parsedParams.data.id;

    try{
        const [comment] = await db.insert(commentary).values({
            ...parsedBody.data,
            matchId,
        }).returning();

        // matchId must be a number to match the keys subscribers used
        res.app.locals.broadcastCommentary?.(matchId, comment);

        res.status(201).json({ data: comment })

    }catch(e){
        // 23503 = foreign key violation: no match with this id
        if((e.cause?.code ?? e.code) === '23503'){
            return res.status(404).json({ error: 'Match not found' });
        }

        console.error('Failed to create commentary:', e);
        return res.status(500).json({ error: 'Failed to create commentary' });
    }
})
