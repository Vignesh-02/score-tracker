import { z } from 'zod';

// Mirrors the match_status enum in src/db/schema.js
export const MATCH_STATUS = {
  SCHEDULED: 'scheduled',
  LIVE: 'live',
  FINISHED: 'finished',
};

const isoDateTime = z.iso.datetime({ offset: true });

const isValidIsoDate = (value) => isoDateTime.safeParse(value).success;

export const listMatchesQuerySchema = z.object({
  limit: z.coerce.number().int().positive().max(100).optional(),
});

export const matchIdParamSchema = z.object({
  id: z.coerce.number().int().positive(),
});

export const createMatchSchema = z
  .object({
    sport: z.string().trim().min(1, { message: 'sport is required' }),
    homeTeam: z.string().trim().min(1, { message: 'homeTeam is required' }),
    awayTeam: z.string().trim().min(1, { message: 'awayTeam is required' }),
    startTime: z.string().refine(isValidIsoDate, {
      message: 'startTime must be a valid ISO 8601 date string',
    }),
    endTime: z.string().refine(isValidIsoDate, {
      message: 'endTime must be a valid ISO 8601 date string',
    }),
    homeScore: z.coerce.number().int().nonnegative().optional(),
    awayScore: z.coerce.number().int().nonnegative().optional(),
  })
  .superRefine((data, ctx) => {
    const start = new Date(data.startTime);
    const end = new Date(data.endTime);

    if (end <= start) {
      ctx.addIssue({
        code: 'custom',
        path: ['endTime'],
        message: 'endTime must be after startTime',
      });
    }
  });

export const updateScoreSchema = z.object({
  homeScore: z.coerce.number().int().nonnegative(),
  awayScore: z.coerce.number().int().nonnegative(),
});