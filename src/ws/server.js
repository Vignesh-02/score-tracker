import { WebSocket, WebSocketServer } from "ws";

function sendJson(socket, payload) {

    // This is a guard function
    if(socket.readyState !== WebSocket.OPEN) return;

    socket.send(JSON.stringify(payload));
}

// function broadcast(wss, payload){
//         for (const client of wss.clients){
//             if(client.readyState !== WebSocket.OPEN) continue;

//             client.send(JSON.stringify(payload));
            
//         }
//     }

function broadcastToAll(wss, payload) {
    for (const client of wss.clients)  {
        if(client.readyState !== WebSocket.OPEN) continue;

        client.send(JSON.stringify(payload));
    }
}

// attaching the websocket to the http server

// we use the same server for both the websocket and the backend server.
// This simplifies deployment and networking.
// export function attachWebSocketServer(server){
//     const wss = new WebSocketServer({
//         server,
//         // This keeps the ws traffic separated from the rest API routes
//         path: '/ws',
//         // defies the maximum size allowed for a single incoming websocket message
//         maxPayload: 1024 * 1024, //(1 MB)
//         // This also acts as a security measure against memory abuse or flooding
//     });

//     wss.on('connection', (socket) => {
//         sendJson(socket, { type: 'welcome'});

//         socket.on('error', console.error);
//     });

//      function broadcastMatchCreated(match){
//         broadcast(wss, { type: 'match_created', data: match});
//      }

//      return { broadcastMatchCreated }
// }

export function attachWebSocketServer(server) {
    const wss = new WebSocketServer({ noServer: true, path: '/ws', maxPayload: 1024 * 1024 });

    server.on('upgrade', async (req, socket, head) => {
        const { pathname } = new URL(req.url, `http://${req.headers.host}`);

        if (pathname !== '/ws') {
            return;
        }

        if (wsArcjet) {
            try {
                const decision = await wsArcjet.protect(req);

                if (decision.isDenied()) {
                    if (decision.reason.isRateLimit()) {
                        socket.write('HTTP/1.1 429 Too Many Requests\r\n\r\n');
                    } else {
                        socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
                    }
                    socket.destroy();
                    return;
                }
            } catch (e) {
                console.error('WS upgrade protection error', e);
                socket.write('HTTP/1.1 500 Internal Server Error\r\n\r\n');
                socket.destroy();
                return;
            }
        }

        wss.handleUpgrade(req, socket, head, (ws) => {
            wss.emit('connection', ws, req);
        });
    });

    wss.on('connection', async (socket, req) => {
        socket.isAlive = true;
        socket.on('pong', () => { socket.isAlive = true; });

        socket.subscriptions = new Set();

        sendJson(socket, { type: 'welcome' });

        socket.on('message', (data) => {
            handleMessage(socket, data);
        });

        socket.on('error', () => {
            socket.terminate();
        });

        socket.on('close', () => {
            cleanupSubscriptions(socket);
        })

        socket.on('error', console.error);
    });

    const interval = setInterval(() => {
        wss.clients.forEach((ws) => {
            if (ws.isAlive === false) return ws.terminate();

            ws.isAlive = false;
            ws.ping();
        })}, 30000);

    wss.on('close', () => clearInterval(interval));

    function broadcastMatchCreated(match) {
        broadcastToAll(wss, { type: 'match_created', data: match });
    }

    // function broadcastCommentary(matchId, comment) {
    //     broadcastToMatch(matchId, { type: 'commentary', data: comment });
    // }

    return { broadcastMatchCreated };
}