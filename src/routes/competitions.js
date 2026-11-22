import { Router } from 'express';
import { inArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../db/db.js';
import { competitionStats } from '../db/schema.js';
import { isInSeason } from '../jobs/football-stats-sync.js';

export const competitionRouter = Router();

// The order competitions are listed in: football first, its leagues in this
// order; any others follow, by name
const ORDER = ['PL', 'PD', 'BL1', 'SA', 'FL1', 'CL', 'DED', 'PPL', 'ELC', 'BSA', 'CLI'];
const SPORT_ORDER = ['Football', 'Cricket'];
const rank = (code) => (ORDER.includes(code) ? ORDER.indexOf(code) : ORDER.length);
const sportRank = (sport) => (SPORT_ORDER.includes(sport) ? SPORT_ORDER.indexOf(sport) : SPORT_ORDER.length);

// football-data.org codes ('PL') or CricketData.org series ids (UUIDs)
const codeParamSchema = z.object({ code: z.string().regex(/^[A-Za-z0-9-]{2,40}$/) });

// Tables change at most every 30 minutes (the stats sync's refresh), so
// browsers and Nginx may reuse a response for a minute
const CACHE_CONTROL = 'public, max-age=60';

// GET /competitions: the competitions that have a table, in season only.
// Cricket series saved without one (bilateral tours) are left out.
competitionRouter.get('/', async (req, res) => {
    try {
        const rows = await db
            .select({
                code: competitionStats.code,
                sport: competitionStats.sport,
                name: competitionStats.name,
                area: competitionStats.area,
                emblem: competitionStats.emblem,
                season: competitionStats.season,
                updatedAt: competitionStats.updatedAt,
                hasTable: sql`jsonb_array_length(${competitionStats.standings}) > 0`,
            })
            .from(competitionStats);

        const data = rows
            .filter((c) => isInSeason(c) && (c.sport === 'Football' || c.hasTable))
            .sort((a, b) => sportRank(a.sport) - sportRank(b.sport) || rank(a.code) - rank(b.code) || a.name.localeCompare(b.name))
            .map(({ hasTable, ...c }) => c);

        res.set('Cache-Control', CACHE_CONTROL).json({ data });
    } catch (e) {
        console.error('Failed to list competitions:', e);
        res.status(500).json({ error: 'Failed to list competitions' });
    }
});

// GET /competitions/:code: one competition's table and top scorers. Football
// codes are upper case, cricket series ids lower case; either matches in any case.
competitionRouter.get('/:code', async (req, res) => {
    const parsed = codeParamSchema.safeParse(req.params);
    if (!parsed.success) {
        return res.status(400).json({ error: 'Invalid competition code' });
    }

    try {
        const { code } = parsed.data;
        const [row] = await db
            .select()
            .from(competitionStats)
            .where(inArray(competitionStats.code, [code.toUpperCase(), code.toLowerCase()]));

        if (!row) return res.status(404).json({ error: 'Competition not found' });

        res.set('Cache-Control', CACHE_CONTROL).json({ data: row });
    } catch (e) {
        console.error('Failed to get competition:', e);
        res.status(500).json({ error: 'Failed to get competition' });
    }
});
