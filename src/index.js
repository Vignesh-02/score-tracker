import AgentAPI from "apminsight";
AgentAPI.config();

import 'dotenv/config';
import express from 'express';
import { matchRouter } from './routes/matches/matches.js';
import { commentaryRouter } from './routes/commentary.js';
import http from 'http';
import { attachWebSocketServer } from './ws/server.js';
import { securityMiddleware } from './arcjet.js';
import { startStatusSync } from './jobs/status-sync.js';

const app = express();
const PORT = Number(process.env.PORT || 8000);
const HOST = process.env.HOST || '0.0.0.0';

const server = http.createServer(app);

// Arcjet runs before body parsing, so malformed or oversized bodies are
// rate-limited too (a body parse error skips every middleware after it)
app.use(securityMiddleware());

app.use(express.json());

app.use('/matches', matchRouter);
app.use('/matches/:id/commentary', commentaryRouter);

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


const { broadcastMatchCreated, broadcastCommentary, broadcastScoreUpdate, broadcastStatusChange } = attachWebSocketServer(server);


app.locals.broadcastMatchCreated = broadcastMatchCreated;
app.locals.broadcastCommentary = broadcastCommentary;
app.locals.broadcastScoreUpdate = broadcastScoreUpdate;
app.locals.broadcastStatusChange = broadcastStatusChange;

// Every 30s, move matches to live/finished and tell connected clients
startStatusSync({ onChange: broadcastStatusChange });



server.listen(PORT, HOST, () => {
    const baseUrl = HOST === '0.0.0.0' ? `http://localhost:${PORT}` : `http://${HOST}:${PORT}`;

    console.log(`Server is live on ${baseUrl}`);
    console.log(`Websocket server is running on ${baseUrl.replace('http', 'ws')}/ws`);
});
 