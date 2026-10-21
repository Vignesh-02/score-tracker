import { Router } from  'express';
import { desc } from 'drizzle-orm';
import { createMatchSchema, listMatchesQuerySchema } from '../../validation/matches.js';
import { getMatchStatus } from '../../utils/match-status.js';
import { db } from '../../db/db.js';
import { matches } from '../../db/schema.js';

export const matchRouter = Router();

const MAX_LIMIT = 100;

matchRouter.get('/', async (req,res) => {
    const parsed = listMatchesQuerySchema.safeParse(req.query);

    if(!parsed.success){
        return res.status(400).json({ error: "Invalid query", details: JSON.stringify(parsed.error)});   
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
        return res.status(400).json({ error: 'Invalid payload', details: JSON.stringify(parsed.error)});
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
        
        res.status(201).json({ data: event })

    }catch(e){

        return res.status(400).json({ error: 'Invalid payload', details: JSON.stringify(parsed.error)});

    }
})