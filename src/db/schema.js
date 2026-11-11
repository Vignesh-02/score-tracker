import { pgTable, serial, text, integer, timestamp, pgEnum, jsonb, uniqueIndex } from 'drizzle-orm/pg-core';

export const matchStatusEnum = pgEnum('match_status', ['scheduled', 'live', 'finished']);

export const matches = pgTable('matches', {
  id: serial('id').primaryKey(),
  sport: text('sport').notNull(),
  // e.g. 'Indian Super League', 'Premier League'
  competition: text('competition'),
  homeTeam: text('home_team').notNull(),
  awayTeam: text('away_team').notNull(),
  status: matchStatusEnum('status').notNull().default('scheduled'),
  startTime: timestamp('start_time'),
  endTime: timestamp('end_time'),
  homeScore: integer('home_score').notNull().default(0),
  awayScore: integer('away_score').notNull().default(0),
  // Where the match came from: 'manual' (entered through the admin routes) or a
  // provider such as 'football-data'. Plain text, so adding a provider needs no migration.
  source: text('source').notNull().default('manual'),
  // The provider's own match id; null for manual matches
  externalId: text('external_id'),
  // Sport-specific extras that don't fit the columns above. For cricket:
  // { format, statusText, innings: [{ side, number, runs, wickets, overs }] },
  // with home_score/away_score holding each side's total runs. Null for football.
  details: jsonb('details'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
}, (table) => [
  // One row per provider match, so syncing updates it instead of adding duplicates.
  // Manual matches have no externalId, and Postgres allows any number of nulls here.
  uniqueIndex('matches_source_external_id_idx').on(table.source, table.externalId),
]);

export const commentary = pgTable('commentary', {
  id: serial('id').primaryKey(),
  matchId: integer('match_id')
    .notNull()
    .references(() => matches.id),
  minute: integer('minute'),
  sequence: integer('sequence'),
  period: text('period'),
  eventType: text('event_type'),
  actor: text('actor'),
  team: text('team'),
  message: text('message').notNull(),
  metadata: jsonb('metadata'),
  tags: text('tags').array(),
  createdAt: timestamp('created_at').notNull().defaultNow(),
});