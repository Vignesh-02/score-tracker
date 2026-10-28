import { Router } from "express";
import { desc, eq } from 'drizzle-orm';
import { matchIdParamSchema } from '../validation/matches.js';
import { createCommentarySchema, listCommentaryQuerySchema } from '../validation/commentary.js';
import { db } from '../db/db.js';
import { commentary } from '../db/schema.js';

// mergeParams lets this router read :id from the parent path '/matches/:id/commentary'
export const commentaryRouter = Router({ mergeParams: true });

const MAX_LIMIT = 100;

commentaryRouter.get('/', async (req, res) => {
    const parsedParams = matchIdParamSchema.safeParse(req.params);

    if(!parsedParams.success){
        return res.status(400).json({ error: 'Invalid match id', details: parsedParams.error.issues });
    }

    const parsedQuery = listCommentaryQuerySchema.safeParse(req.query);

    if(!parsedQuery.success){
        return res.status(400).json({ error: 'Invalid query', details: parsedQuery.error.issues });
    }

    const limit = Math.min(parsedQuery.data.limit ?? 50, MAX_LIMIT);

    try{
        // SELECT * FROM commentary WHERE match_id = :id ORDER BY created_at DESC LIMIT :limit;
        const data = await db
            .select()
            .from(commentary)
            .where(eq(commentary.matchId, parsedParams.data.id))
            .orderBy(desc(commentary.createdAt))
            .limit(limit);

        res.json({ data });

    }catch(e){
        console.error('Failed to list commentary:', e);
        res.status(500).json({ error: 'Failed to list commentary' });
    }
})

commentaryRouter.post('/', async (req, res) => {
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
        const { minute, ...rest } = parsedBody.data;
        const [result] = await db.insert(commentary).values({
            matchId,
            minute,
            ...rest,
        }).returning();

        // matchId must be a number to match the keys subscribers used
        res.app.locals.broadcastCommentary?.(matchId, result);

        res.status(201).json({ data: result });

    }catch(e){
        // 23503 = foreign key violation: no match with this id
        if((e.cause?.code ?? e.code) === '23503'){
            return res.status(404).json({ error: 'Match not found' });
        }

        console.error('Failed to create commentary:', e);
        return res.status(500).json({ error: 'Failed to create commentary' });
    }
})
