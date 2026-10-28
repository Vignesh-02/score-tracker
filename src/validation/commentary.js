import { z } from 'zod';

export const listCommentaryQuerySchema = z.object({
  limit: z.coerce.number().int().positive().max(100).optional(),
});

export const createCommentarySchema = z.object({
  minute: z.coerce.number().int().nonnegative().optional(),
  sequence: z.coerce.number().int().nonnegative().optional(),
  period: z.string().trim().optional(),
  eventType: z.string().trim().optional(),
  actor: z.string().trim().optional(),
  team: z.string().trim().optional(),
  message: z.string().trim().min(1, { message: 'message is required' }),
  metadata: z.record(z.string(), z.unknown()).optional(),
  tags: z.array(z.string()).optional(),
});
