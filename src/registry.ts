// =============================================================================
// Graphene ws-server: Connection Registry
// =============================================================================
// Maps a user's DID to their active WebSocket connection.
// A user can only have one active connection (new connections replace old ones).

import type { WebSocket } from 'ws';

const registry = new Map<string, WebSocket>();

/** Register (or replace) a socket for a DID. */
export function register(did: string, socket: WebSocket): void {
    const existing = registry.get(did);
    if (existing && existing.readyState === 1 /* OPEN */) {
        // Close the old connection gracefully
        try { existing.close(1000, 'Replaced by new connection'); } catch { }
    }
    registry.set(did, socket);
    console.log(`[registry] ✅ ${did} connected (total: ${registry.size})`);
}

/** Unregister a socket when it closes. */
export function unregister(did: string, socket: WebSocket): void {
    if (registry.get(did) === socket) {
        registry.delete(did);
        console.log(`[registry] ❌ ${did} disconnected (total: ${registry.size})`);
    }
}

/** Deliver a payload to a locally-connected user. Returns true if delivered. */
export function deliver(did: string, payload: object): boolean {
    const socket = registry.get(did);
    if (!socket || socket.readyState !== 1 /* OPEN */) {
        return false;
    }
    socket.send(JSON.stringify(payload));
    return true;
}

/** Check whether a DID has an active local socket. */
export function isConnected(did: string): boolean {
    const socket = registry.get(did);
    return Boolean(socket && socket.readyState === 1 /* OPEN */);
}

/** Return the number of currently connected sockets (for health checks). */
export function connectedCount(): number {
    return registry.size;
}
