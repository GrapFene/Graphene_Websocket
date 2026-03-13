import http from 'http';
import express, { Request, Response } from 'express';
import { WebSocketServer, WebSocket } from 'ws';
import { v4 as uuidv4 } from 'uuid';
import { config } from './config.js';
import { resolvePeerAddress, verifySignature } from './crypto.js';
import { register, unregister, deliver, connectedCount } from './registry.js';
import type { ClientMessage, OutboundDM, InboundDM, AckMessage, ErrorMessage } from './types.js';

function send(socket: WebSocket, payload: InboundDM | AckMessage | ErrorMessage): void {
    if (socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify(payload));
    }
}

function sendError(socket: WebSocket, reason: string): void {
    send(socket, { type: 'error', reason });
}

function instanceDomainFromDid(did: string): string {
    const parts = did.split(':');
    // Format: did:graphene:<domain>:<optional_port>:<username>
    // New Standard (4+ parts): did:graphene:localhost:3001:karthik or did:graphene:graphene.myvnc.com:karthik
    if (parts.length >= 4 && parts[0] === 'did' && parts[1] === 'graphene') {
        const domain = parts.slice(2, -1).join(':');
        return domain;
    }
    // Legacy/Fallback (3 parts): did:graphene:karthik
    if (parts.length === 3 && parts[0] === 'did' && parts[1] === 'graphene') {
        console.warn(`[ws-server] ⚠️ Legacy DID format detected (${did}). Falling back to main domain: ${config.central.mainDomain}`);
        return config.central.mainDomain;
    }
    return config.central.mainDomain;
}

// ---------------------------------------------------------------------------
// Route DM to the respective origin databases for persistence
// ---------------------------------------------------------------------------
async function persistChatHistory(dm: InboundDM): Promise<void> {
    const fromDomain = instanceDomainFromDid(dm.from_did);
    const toDomain = instanceDomainFromDid(dm.to_did);

    const domainsToNotify = new Set([fromDomain, toDomain]);
    console.log(`[ws-server] 📝 Persisting DM ${dm.id} to domains: ${Array.from(domainsToNotify).join(', ')}`);

    for (const domain of domainsToNotify) {
        // Try HTTP first for local/docker domains, then fallback if needed
        const protocols = domain.includes(':') || domain.includes('backend') || domain.includes('localhost')
            ? ['http', 'https']
            : ['https', 'http'];

        let success = false;
        for (const protocol of protocols) {
            const fetchUrl = `${protocol}://${domain}/api/messages/federated`;
            try {
                console.log(`[ws-server] 📤 POST ${fetchUrl}...`);
                const res = await fetch(fetchUrl, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'X-WS-Central-Secret': config.central.secret,
                    },
                    body: JSON.stringify(dm),
                });
                
                if (res.ok) {
                    console.log(`[ws-server] ✅ Persisted ${dm.id} on ${domain} via ${protocol}`);
                    success = true;
                    break;
                } else {
                    console.warn(`[ws-server] ⚠️ Failed on ${domain} via ${protocol} [${res.status}]`);
                }
            } catch (err) {
                console.error(`[ws-server] ❌ Error on ${domain} via ${protocol}:`, (err as Error).message);
            }
        }
        
        if (!success) {
            console.error(`[ws-server] 💀 Could not persist ${dm.id} to ${domain} via any protocol`);
        }
    }
}

// ---------------------------------------------------------------------------
// Handle an incoming client DM message
// ---------------------------------------------------------------------------
async function handleDM(senderDid: string, msg: OutboundDM, senderSocket: WebSocket): Promise<void> {
    const { to_did, content } = msg;

    if (!to_did || !content || typeof content !== 'string' || content.trim().length === 0) {
        return sendError(senderSocket, 'Invalid DM format');
    }
    if (to_did === senderDid) {
        return sendError(senderSocket, 'Cannot send a DM to yourself');
    }

    const dm: InboundDM = {
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

app.get('/health', (_req: Request, res: Response) => {
    res.json({
        status: 'ok',
        connected_sockets: connectedCount(),
        uptime_seconds: Math.floor(process.uptime()),
    });
});

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

wss.on('connection', async (socket: WebSocket, req: http.IncomingMessage) => {
    console.log(`[ws-server] 🔌 New connection attempt from ${req.socket.remoteAddress}`);
    const url = new URL(req.url ?? '', `http://localhost`);
    const did = url.searchParams.get('did');
    const signature = url.searchParams.get('signature');
    const timestamp = url.searchParams.get('t');

    if (!did || !signature || !timestamp) {
        console.warn(`[ws-server] ❌ Connection rejected: Missing params (did: ${!!did}, sig: ${!!signature}, t: ${!!timestamp})`);
        socket.close(1008, 'Missing auth parameters: did, signature, t required');
        return;
    }

    console.log(`[ws-server] 🎫 Authenticating ticket for DID: ${did}`);

    // Check expiration (tickets expire in 60s)
    const ticketTime = parseInt(timestamp, 10);
    if (isNaN(ticketTime) || Date.now() - ticketTime > 60000) {
        console.warn(`[ws-server] ❌ Ticket expired for ${did}: ${Date.now() - ticketTime}ms old`);
        socket.close(1008, 'Auth ticket expired');
        return;
    }

    const domain = instanceDomainFromDid(did);
    console.log(`[ws-server] 🏠 Resolved domain from DID: ${domain}`);
    
    let pubAddress = await resolvePeerAddress(domain);

    if (!pubAddress) {
        console.warn(`[ws-server] ⚠️ Identity resolution failed for domain: ${domain}. ALLOWING anyway (DEBUG MODE)`);
        pubAddress = '0x0000000000000000000000000000000000000000'; // Fallback for lenient mode
    }

    console.log(`[ws-server] 📡 Peer Public Address: ${pubAddress}`);

    const expectedPayload = { action: 'ws_auth', did, t: ticketTime };
    const isValid = await verifySignature(expectedPayload, signature, pubAddress);

    if (!isValid) {
        console.warn(`[ws-server] ❌ Signature invalid for ${did}`);
        socket.close(1008, 'Invalid signature');
        return;
    }

    // Register valid socket
    register(did, socket);

    socket.on('message', async (raw) => {
        try {
            const msg = JSON.parse(raw.toString()) as ClientMessage;
            if (msg.type === 'dm') await handleDM(did, msg, socket);
            else sendError(socket, 'Unknown message type');
        } catch {
            sendError(socket, 'Invalid JSON');
        }
    });

    socket.on('close', () => unregister(did, socket));
    socket.on('error', (err) => {
        console.error(`[ws-server] Socket error for ${did}:`, err.message);
        unregister(did, socket);
    });
});

server.listen(config.ws.port, () => {
    console.log(`🔌 Central ws-server running on port ${config.ws.port}`);
});

export default server;
