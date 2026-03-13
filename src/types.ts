// =============================================================================
// Graphene ws-server: Message type definitions
// =============================================================================

/** A user sends this to initiate a DM */
export interface OutboundDM {
    type: 'dm';
    /** DID of the recipient (can be on the same or a different instance) */
    to_did: string;
    content: string;
}

/** Delivered to the recipient's socket */
export interface InboundDM {
    type: 'dm';
    id: string;
    from_did: string;
    to_did: string;
    content: string;
    created_at: string;
    /** Originating instance domain, e.g. "api.my-server.com" */
    from_instance: string;
}

/** Acknowledgement sent back to the sender after storage */
export interface AckMessage {
    type: 'ack';
    message_id: string;
    to_did: string;
}

/** Error pushed to the sender if delivery fails */
export interface ErrorMessage {
    type: 'error';
    reason: string;
}

/** Payload sent between instances to deliver a cross-server DM */
export interface FederatedDMPayload {
    id: string;
    from_did: string;
    to_did: string;
    content: string;
    created_at: string;
    from_instance: string;
    /** Receiving instance must match this to prevent mis-routing */
    to_instance: string;
}

/** Any client-sent message */
export type ClientMessage = OutboundDM;
