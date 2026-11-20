import { Router } from 'express';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../db/db.js';
import { competitionStats } from '../db/schema.js';
import { isInSeason } from '../jobs/football-stats-sync.js';

export const competitionRouter = Router();

// The order competitions are listed in; any others follow, by name
const ORDER = ['PL', 'PD', 'BL1', 'SA', 'FL1', 'CL', 'DED', 'PPL', 'ELC', 'BSA', 'CLI'];
const rank = (code) => (ORDER.includes(code) ? ORDER.indexOf(code) : ORDER.length);

const codeParamSchema = z.object({ code: z.string().regex(/^[A-Za-z0-9]{2,6}$/) });

// Tables change at most every 30 minutes (the stats sync's refresh), so
// browsers and Nginx may reuse a response for a minute
const CACHE_CONTROL = 'public, max-age=60';

// GET /competitions: the competitions that have a table, in season only
competitionRouter.get('/', async (req, res) => {
    try {
        const rows = await db
            .select({
                code: competitionStats.code,
                name: competitionStats.name,
                area: competitionStats.area,
                emblem: competitionStats.emblem,
                season: competitionStats.season,
                updatedAt: competitionStats.updatedAt,
            })
            .from(competitionStats);

        const data = rows
            .filter((c) => isInSeason(c))
            .sort((a, b) => rank(a.code) - rank(b.code) || a.name.localeCompare(b.name));

        res.set('Cache-Control', CACHE_CONTROL).json({ data });
    } catch (e) {
        console.error('Failed to list competitions:', e);
        res.status(500).json({ error: 'Failed to list competitions' });
    }
});

// GET /competitions/:code: one competition's table and top scorers
competitionRouter.get('/:code', async (req, res) => {
    const parsed = codeParamSchema.safeParse(req.params);
    if (!parsed.success) {
        return res.status(400).json({ error: 'Invalid competition code' });
    }

    try {
        const [row] = await db
            .select()
            .from(competitionStats)
            .where(eq(competitionStats.code, parsed.data.code.toUpperCase()));

        if (!row) return res.status(404).json({ error: 'Competition not found' });

        res.set('Cache-Control', CACHE_CONTROL).json({ data: row });
    } catch (e) {
        console.error('Failed to get competition:', e);
        res.status(500).json({ error: 'Failed to get competition' });
    }
});
