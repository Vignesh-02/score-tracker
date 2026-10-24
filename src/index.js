import express from 'express';
import { matchRouter } from './routes/matches/matches.js';
import http from 'http';
import { attachWebSocketServer } from './ws/server.js';

const app = express();
const PORT = Number(process.env.PORT || 8000);
const HOST = process.env.HOST || '0.0.0.0';

const server = http.createServer(app);

app.use(express.json());

app.get('/', (req, res) => {
    res.json({ message: 'Score Tracker API is running' });
});

app.use('/matches', matchRouter)

const { broadcastMatchCreated } = attachWebSocketServer(server);


app.locals.broadcastMatchCreated = broadcastMatchCreated;



server.listen(PORT, HOST, () => {
    const baseUrl = HOST === '0.0.0.0' ? `http://localhost:${PORT}` : `http://${HOST}:${PORT}`;

    console.log(`Server is live on http://localhost:${PORT}`);
    console.log(`Websocket server is running on ${baseUrl.replace('http', 'ws')}/ws`);
});
 