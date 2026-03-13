import http from 'http';
import express from 'express';
import { WebSocketServer, WebSocket } from 'ws';
import { v4 as uuidv4 } from 'uuid';
import { config } from './config.js';
import { resolvePeerAddress, verifySignature } from './crypto.js';
import { register, unregister, deliver, connectedCount } from './registry.js';
function send(socket, payload) {
    if (socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify(payload));
    }
}
function sendError(socket, reason) {
    send(socket, { type: 'error', reason });
}
function instanceDomainFromDid(did) {
    const parts = did.split(':');
    if (parts.length >= 4 && parts[0] === 'did' && parts[1] === 'graphene') {
        return parts[2];
    }
    return config.central.mainDomain;
}
// ---------------------------------------------------------------------------
// Route DM to the respective origin databases for persistence
// ---------------------------------------------------------------------------
async function persistChatHistory(dm) {
    const fromDomain = instanceDomainFromDid(dm.from_did);
    const toDomain = instanceDomainFromDid(dm.to_did);
    const domainsToNotify = new Set([fromDomain, toDomain]);
    for (const domain of domainsToNotify) {
        // Use http for localhost instances (fallback for local dev)
        const fetchUrl = domain.startsWith('localhost') || domain.startsWith('127.0.0.1')
            ? `http://${domain}/messages/federated`
            : `https://${domain}/messages/federated`;
        try {
            const res = await fetch(fetchUrl, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'X-WS-Central-Secret': config.central.secret,
                },
                body: JSON.stringify(dm),
            });
            if (!res.ok) {
                console.warn(`[ws-server] Failed to persist message ${dm.id} on ${domain} [${res.status}]`);
            }
            else {
                console.log(`[ws-server] Persisted message ${dm.id} on ${domain}`);
            }
        }
        catch (err) {
            console.error(`[ws-server] Network error persisting to ${domain}:`, err.message);
        }
    }
}
// ---------------------------------------------------------------------------
// Handle an incoming client DM message
// ---------------------------------------------------------------------------
async function handleDM(senderDid, msg, senderSocket) {
    const { to_did, content } = msg;
    if (!to_did || !content || typeof content !== 'string' || content.trim().length === 0) {
        return sendError(senderSocket, 'Invalid DM format');
    }
    if (to_did === senderDid) {
        return sendError(senderSocket, 'Cannot send a DM to yourself');
    }
    const dm = {
        type: 'dm',
        id: uuidv4(),
        from_did: senderDid,
        to_did,
        content: content.trim(),
        created_at: new Date().toISOString(),
        from_instance: instanceDomainFromDid(senderDid),
    };
    // 1. Live delivery if recipient is currently connected to the central WS server
    const delivered = deliver(to_did, dm);
    console.log(`[ws-server] DM ${dm.id} from ${senderDid} to ${to_did} (live: ${delivered})`);
    // 2. Persist the chat history on the corresponding backends
    await persistChatHistory(dm);
    // 3. Ack the sender
    send(senderSocket, { type: 'ack', message_id: dm.id, to_did });
}
// ---------------------------------------------------------------------------
// Express HTTP app (same port as WS server)
// ---------------------------------------------------------------------------
const app = express();
app.use(express.json());
app.get('/health', (_req, res) => {
    res.json({
        status: 'ok',
        connected_sockets: connectedCount(),
        uptime_seconds: Math.floor(process.uptime()),
    });
});
const server = http.createServer(app);
const wss = new WebSocketServer({ server });
wss.on('connection', async (socket, req) => {
    const url = new URL(req.url ?? '', `http://localhost`);
    const did = url.searchParams.get('did');
    const signature = url.searchParams.get('signature');
    const timestamp = url.searchParams.get('t');
    if (!did || !signature || !timestamp) {
        socket.close(1008, 'Missing auth parameters: did, signature, t required');
        return;
    }
    // Check expiration (tickets expire in 60s)
    const ticketTime = parseInt(timestamp, 10);
    if (isNaN(ticketTime) || Date.now() - ticketTime > 60000) {
        socket.close(1008, 'Auth ticket expired');
        return;
    }
    const domain = instanceDomainFromDid(did);
    const pubAddress = await resolvePeerAddress(domain);
    if (!pubAddress) {
        socket.close(1008, `Could not resolve public key for domain: ${domain}`);
        return;
    }
    const expectedPayload = { action: 'ws_auth', did, t: ticketTime };
    const isValid = await verifySignature(expectedPayload, signature, pubAddress);
    if (!isValid) {
        socket.close(1008, 'Invalid signature');
        return;
    }
    // Register valid socket
    register(did, socket);
    socket.on('message', async (raw) => {
        try {
            const msg = JSON.parse(raw.toString());
            if (msg.type === 'dm')
                await handleDM(did, msg, socket);
            else
                sendError(socket, 'Unknown message type');
        }
        catch {
            sendError(socket, 'Invalid JSON');
        }
    });
    socket.on('close', () => unregister(did));
    socket.on('error', (err) => {
        console.error(`[ws-server] Socket error for ${did}:`, err.message);
        unregister(did);
    });
});
server.listen(config.ws.port, () => {
    console.log(`🔌 Central ws-server running on port ${config.ws.port}`);
});
export default server;
