import { WebSocket, WebSocketServer } from "ws";

function sendJson(socket, payload) {

    // This is a guard function
    if(socket.readyState !== WebSocket.OPEN) return;

    socket.send(JSON.stringify(payload));
}

function broadcast(wss, payload){
        for (const client of wss.clients){
            if(client.readyState !== WebSocket.OPEN) continue;

            client.send(JSON.stringify(payload));
            
        }
    }


// attaching the websocket to the http server

// we use the same server for both the websocket and the backend server.
// This simplifies deployment and networking.
export function attachWebSocketServer(server){
    const wss = new WebSocketServer({
        server,
        // This keeps the ws traffic separated from the rest API routes
        path: '/ws',
        // defies the maximum size allowed for a single incoming websocket message
        maxPayload: 1024 * 1024, //(1 MB)
        // This also acts as a security measure against memory abuse or flooding
    });

    wss.on('connection', (socket) => {
        sendJson(socket, { type: 'welcome'});

        socket.on('error', console.error);
    });

     function broadcastMatchCreated(match){
        broadcast(wss, { type: 'match_created', data: match});
     }

     return { broadcastMatchCreated }
}