import dotenv from 'dotenv';
dotenv.config();

function required(key: string): string {
    const val = process.env[key];
    if (!val || val.trim() === '') {
        process.stderr.write(`[FATAL] Missing required env var: ${key}\n`);
        process.exit(1);
    }
    return val;
}

export const config = {
    ws: {
        port: parseInt(process.env.WS_PORT || '4000', 10),
    },
    central: {
        // Shared secret that all backends use to authenticate requests fetching messages
        // or pushing cross-server delivered messages TO the ws-server.
        secret: required('CENTRAL_WS_SECRET'),
        // Optional prefix for main instance if local DIDs don't have domain.
        mainDomain: process.env.MAIN_INSTANCE_DOMAIN || 'localhost',
    },
    federation: {
        outboundTimeoutMs: 5000,
        // Optional pre-seeded addresses of known peers
        knownPeerAddresses: Object.fromEntries(
            (process.env.KNOWN_PEER_ADDRESSES || '')
                .split(',')
                .map(s => s.trim())
                .filter(Boolean)
                .map(s => {
                    const idx = s.indexOf(':0x');
                    return idx !== -1 ? [s.slice(0, idx), s.slice(idx + 1).toLowerCase()] : null;
                })
                .filter((e): e is [string, string] => e !== null)
        ),
    }
} as const;
