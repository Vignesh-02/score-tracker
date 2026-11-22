import { pgTable, serial, text, integer, timestamp, pgEnum, jsonb, uniqueIndex, boolean } from 'drizzle-orm/pg-core';

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
  // with home_score/away_score holding each side's total runs. For football:
  // { phase, clock } while live (src/live/football-clock.js), { halfTime } once finished.
  details: jsonb('details'),
  // When the provider last changed the match (football-data.org's lastUpdated),
  // as of the last time we saved a change. Older responses are ignored: their
  // cache sometimes serves one from before kick-off mid-match.
  providerUpdatedAt: timestamp('provider_updated_at'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
}, (table) => [
  // One row per provider match, so syncing updates it instead of adding duplicates.
  // Manual matches have no externalId, and Postgres allows any number of nulls here.
  uniqueIndex('matches_source_external_id_idx').on(table.source, table.externalId),
]);

// One row per competition: its latest league table, and for football its top
// scorers. Football comes from football-data.org (src/jobs/football-stats-sync.js),
// cricket points tables from CricketData.org (src/jobs/cricket-tables-sync.js).
// Kept in the database so a restart doesn't have to fetch them all again.
export const competitionStats = pgTable('competition_stats', {
  // football-data.org's code ('PL', 'CL') or CricketData.org's series id (a UUID)
  code: text('code').primaryKey(),
  // 'Football' or 'Cricket', as in matches.sport
  sport: text('sport').notNull().default('Football'),
  name: text('name').notNull(),
  // e.g. 'England', 'Europe'
  area: text('area'),
  emblem: text('emblem'),
  // Football: { startDate, endDate, currentMatchday }. Cricket: { startDate,
  // endDate } of the series' matches we know of, and finishedMatches, the
  // number finished when the table was fetched.
  season: jsonb('season'),
  // [{ stage, group, table: [...] }]; one entry per group. Football rows:
  // { position, team, crest, played, won, draw, lost, goalsFor, goalsAgainst,
  // goalDifference, points }. Cricket rows (one table): { position, team,
  // crest, played, won, lost, tied, noResult, points }. Empty for a cricket
  // series without a table (a bilateral tour), so it isn't asked for again.
  standings: jsonb('standings').notNull(),
  // Football: [{ player, team, crest, played, goals, assists, penalties }],
  // most goals first. Always empty for cricket.
  scorers: jsonb('scorers').notNull(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
});

// The latest batting and bowling scorecard of a cricket match, from
// CricketData.org. Each fetch costs 10 of the day's hits, so it's kept: a
// finished match's scorecard is fetched once, a live one at most every few
// minutes (see src/routes/scorecard.js).
export const cricketScorecards = pgTable('cricket_scorecards', {
  matchId: integer('match_id')
    .primaryKey()
    .references(() => matches.id, { onDelete: 'cascade' }),
  // { venue, toss, innings: [{ side, number, batting: [...], bowling: [...] }] }
  // (toScorecard in src/providers/cricketdata.js)
  data: jsonb('data').notNull(),
  // The match had ended, so this scorecard won't change again
  final: boolean('final').notNull().default(false),
  fetchedAt: timestamp('fetched_at').notNull().defaultNow(),
});

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