import { ethers } from 'ethers';
import { config } from './config.js';
function canonicalJson(obj) {
    if (obj === null || typeof obj !== 'object')
        return JSON.stringify(obj);
    if (Array.isArray(obj)) {
        return '[' + obj.map(canonicalJson).join(',') + ']';
    }
    const sorted = Object.keys(obj)
        .sort()
        .map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`)
        .join(',');
    return '{' + sorted + '}';
}
const peerAddressCache = new Map();
for (const [domain, address] of Object.entries(config.federation.knownPeerAddresses)) {
    peerAddressCache.set(domain, address);
}
export async function resolvePeerAddress(domain) {
    if (peerAddressCache.has(domain)) {
        return peerAddressCache.get(domain);
    }
    try {
        const url = `https://${domain}/federation/actor`;
        // Use http for localhost instances (fallback for local dev)
        const fetchUrl = domain.startsWith('localhost') || domain.startsWith('127.0.0.1') ? `http://${domain}/federation/actor` : url;
        const res = await fetch(fetchUrl, {
            signal: AbortSignal.timeout(config.federation.outboundTimeoutMs),
            headers: { 'Accept': 'application/json' },
        });
        if (!res.ok) {
            console.warn(`[crypto] GET ${fetchUrl} returned ${res.status}`);
            return null;
        }
        const actor = await res.json();
        if (!actor?.public_address || typeof actor.public_address !== 'string') {
            console.warn(`[crypto] actor from ${domain} missing public_address`);
            return null;
        }
        const address = actor.public_address.toLowerCase();
        peerAddressCache.set(domain, address);
        return address;
    }
    catch (err) {
        console.error(`[crypto] resolvePeerAddress(${domain}) failed:`, err);
        return null;
    }
}
export async function verifySignature(payload, signature, expectedAddress) {
    try {
        if (!signature || signature.length < 130)
            return false;
        const canonical = canonicalJson(payload);
        const recoveredAddress = ethers.verifyMessage(canonical, signature);
        return recoveredAddress.toLowerCase() === expectedAddress.toLowerCase();
    }
    catch (err) {
        return false;
    }
}
