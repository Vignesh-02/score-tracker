import 'dotenv/config';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';

// The app uses Neon's pooled endpoint (the "-pooler" host): it's built for many
// short-lived connections from app servers and copes better with compute
// restarts. Migrations (drizzle.config.js) keep the direct DATABASE_URL.
const connectionString = process.env.DATABASE_URL_POOLED || process.env.DATABASE_URL;

if (!connectionString) {
  throw new Error('DATABASE_URL_POOLED or DATABASE_URL must be set');
}

export const pool = new Pool({
  connectionString,
  max: Number(process.env.DB_POOL_MAX || 10),
  // Give up on a connection attempt after 10s, so a database outage makes
  // requests fail with an error instead of hanging forever
  connectionTimeoutMillis: 10_000,
  // Close connections idle for 30s; the sync jobs open new ones as needed
  idleTimeoutMillis: 30_000,
  // TCP keep-alive notices dead connections (e.g. after a network change) sooner
  keepAlive: true,
});

// Neon closes idle connections (e.g. when the compute suspends or restarts).
// pg reports that as an 'error' on the pool, and an unhandled 'error' event
// crashes the whole server. The pool already drops the broken connection and
// opens a new one on the next query, so logging it is all that's needed.
pool.on('error', (err) => {
  console.error('Postgres idle connection error:', err.message);
});

export const db = drizzle(pool);

// For GET /health: true if the database answers a trivial query in time
export async function checkDatabase(timeoutMs = 3000) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('Database check timed out')), timeoutMs);
  });

  try {
    await Promise.race([pool.query('select 1'), timeout]);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  } finally {
    clearTimeout(timer);
  }
}
