import './instrument.js';
import 'dotenv/config';
import express from 'express';
import { matchRouter } from './routes/matches/matches.js';
import { commentaryRouter } from './routes/commentary.js';
import http from 'http';
import { attachWebSocketServer } from './ws/server.js';
import { securityMiddleware } from './arcjet.js';
import { httpRateLimit, trustedProxies } from './rate-limit.js';
import { startStatusSync } from './jobs/status-sync.js';
import { startFootballSync } from './jobs/football-sync.js';
import { startCricketSync } from './jobs/cricket-sync.js';
import { startBasketballSync } from './jobs/basketball-sync.js';
import { startFootballStatsSync } from './jobs/football-stats-sync.js';
import { competitionRouter } from './routes/competitions.js';
import { headToHeadRouter } from './routes/head2head.js';
import { scorecardRouter } from './routes/scorecard.js';
import { healthRouter } from './routes/health.js';
import { pool } from './db/db.js';
import { recordMatchEvents } from './live/match-events.js';

const app = express();
const PORT = Number(process.env.PORT || 8000);
const HOST = process.env.HOST || '0.0.0.0';

// How long shutdown may take before the process exits anyway
const SHUTDOWN_TIMEOUT_MS = 10_000;

let shuttingDown = false;

const server = http.createServer(app);

// Lets req.ip be the real visitor behind Nginx
app.set('trust proxy', trustedProxies);

// Before rate limiting and Arcjet, so monitors and load balancers checking it
// often are never blocked. It caches its database check, so it stays cheap.
app.use('/health', healthRouter({ isShuttingDown: () => shuttingDown }));

// Runs first, so requests over the limit don't use up Arcjet's monthly quota
app.use(httpRateLimit);

// Arcjet runs before body parsing, so malformed or oversized bodies are
// checked too (a body parse error skips every middleware after it)
app.use(securityMiddleware());

app.use(express.json());

app.use('/matches', matchRouter);
app.use('/matches/:id/commentary', commentaryRouter);
app.use('/matches/:id/head2head', headToHeadRouter);
app.use('/matches/:id/scorecard', scorecardRouter);
app.use('/competitions', competitionRouter);

app.get('/', (req, res) => {
    res.json({ message: 'Score Tracker API is running' });
});

// Error handler: must be registered after all routes. Express recognises it by
// its 4 arguments and sends any error here, including invalid JSON bodies from
// express.json(), so clients always get JSON instead of Express's HTML error page.
app.use((err, req, res, next) => {
    if (err.type === 'entity.parse.failed') {
        return res.status(400).json({ error: 'Malformed JSON in request body' });
    }

    // Other client errors from Express (e.g. 413 payload too large) are safe to show
    if (err.expose && err.status) {
        return res.status(err.status).json({ error: err.message });
    }

    console.error('Unhandled error:', err);
    res.status(500).json({ error: 'Internal server error' });
});


const {
    broadcastMatchCreated, broadcastCommentary, broadcastScoreUpdate, broadcastStatusChange,
    close: closeWebSockets,
} = attachWebSocketServer(server);


app.locals.broadcastMatchCreated = broadcastMatchCreated;
app.locals.broadcastCommentary = broadcastCommentary;
app.locals.broadcastScoreUpdate = broadcastScoreUpdate;
app.locals.broadcastStatusChange = broadcastStatusChange;

const providerCallbacks = {
    onCreated: broadcastMatchCreated,
    // Kick-off, goals, wickets, quarters and full time become lines in the match page's
    // live updates feed. A failure here mustn't stop the sync saving scores.
    onChange: (match, previous) => recordMatchEvents(previous, match, broadcastCommentary)
        .catch((e) => console.error('Failed to record match events:', e.message)),
    onScoreChange: (match) => broadcastScoreUpdate(match.id, match),
    onStatusChange: broadcastStatusChange,
};

// The background jobs start only once the server is listening (see the end of
// this file). If the port is taken, the process exits before any job runs, so a
// crash loop under systemd can't spend the providers' daily request limits.
let stopStatusSync = () => {};
let stopFootballSync = () => {};
let stopCricketSync = () => {};
let stopBasketballSync = () => {};
let stopFootballStatsSync = () => {};

function startJobs() {
    // Every 30s, move matches to live/finished and tell connected clients
    stopStatusSync = startStatusSync({ onChange: broadcastStatusChange });

    // Every 60s, import European football from football-data.org and broadcast changes
    stopFootballSync = startFootballSync(providerCallbacks);

    // Every 3 min while a match is live, up to 15 min otherwise, slower when the
    // day's requests run low (every 20-40 min on the free plan), import cricket
    // from CricketData.org
    stopCricketSync = startCricketSync(providerCallbacks);

    // Every 30s while an NBA game is on, every 10 min otherwise, import NBA
    // games from BALLDONTLIE
    stopBasketballSync = startBasketballSync(providerCallbacks);

    // League tables and top scorers from football-data.org, each refreshed
    // every 30 min, one request every 20s
    stopFootballStatsSync = startFootballStatsSync();
}


// ---------- shutdown and crash handling ----------

// Runs on deploys and restarts (SIGTERM from systemd, PM2, Docker or
// node --watch) and on Ctrl+C. Stops taking new work, lets in-flight requests
// finish, tells WebSocket clients to reconnect, then closes the database pool.
async function shutdown(reason, exitCode = 0) {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`${reason}: shutting down...`);

    // If anything hangs, exit anyway so the supervisor can start a fresh process
    setTimeout(() => {
        console.error('Shutdown took too long, forcing exit');
        process.exit(exitCode || 1);
    }, SHUTDOWN_TIMEOUT_MS).unref();

    try {
        stopStatusSync();
        stopFootballSync();
        stopCricketSync();
        stopBasketballSync();
        stopFootballStatsSync();
        await closeWebSockets();
        // Stops accepting connections and waits for in-flight requests
        await new Promise((resolve) => server.close(() => resolve()));
        await pool.end();
    } catch (e) {
        console.error('Error during shutdown:', e);
        exitCode ||= 1;
    }

    process.exit(exitCode);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// A promise rejected with no .catch(). Usually a missing await or catch in one
// request or job; log it with its stack and keep serving everyone else.
process.on('unhandledRejection', (reason) => {
    console.error('Unhandled promise rejection:', reason);
});

// A thrown error nothing caught. The process may now be in a broken state, so
// log it and exit; the supervisor (systemd, PM2, Docker) starts a clean one.
process.on('uncaughtException', (err) => {
    console.error('Uncaught exception:', err);
    shutdown('Uncaught exception', 1);
});

server.listen(PORT, HOST, () => {
    const baseUrl = HOST === '0.0.0.0' ? `http://localhost:${PORT}` : `http://${HOST}:${PORT}`;

    console.log(`Server is live on ${baseUrl}`);
    console.log(`Websocket server is running on ${baseUrl.replace('http', 'ws')}/ws`);

    if (!shuttingDown) startJobs();
});
 