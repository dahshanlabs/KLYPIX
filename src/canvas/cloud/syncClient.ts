// High-level cloud-sync client for canvases.
//
// Layers it sits on top of:
//   * encryption.ts — generates the per-canvas key, encrypts plaintext bytes
//   * syncBlob.ts   — wraps ciphertext + IV in a wire envelope
//   * CloudTransport (injected) — actually moves bytes to/from the backend
//
// The CloudTransport seam keeps this file free of electron / Supabase /
// fetch specifics. Production wires it to an electron IPC bridge that talks
// to Supabase Storage from the main process. Tests can inject an in-memory
// transport without touching the network.
//
// Share-link format:
//
//     https://klypix.com/c/<share-token>#<base64-key>
//
// Two secrets, distinct purposes:
//   * The TOKEN (path segment) gates server-side access — present a valid,
//     non-revoked token and the bytes can be downloaded. Owner can revoke.
//   * The KEY (URL fragment) gates DECRYPTION. The fragment never reaches
//     any server; browsers strip it on every outgoing request. Even with
//     full DB access, the operator cannot decrypt user canvases.
//
// One canvas can have many tokens (one per recipient or invite); the key
// is per-canvas and stable across share rotations.

import { generateKey, exportKey, importKey } from './encryption';
import { pack, unpack } from './syncBlob';

// --- Transport interface ---------------------------------------------------

export interface BlobMeta {
    id: string;              // server-assigned UUID
    title_hint: string | null;
    byte_size: number;
    created_at: string;      // ISO 8601
    updated_at: string;      // ISO 8601
}

/**
 * Boundary between this module and the world. Whoever calls into syncClient
 * supplies an implementation that knows how to talk to Supabase / Firebase /
 * S3 / a local file (for tests). syncClient itself has no idea what's on
 * the other side.
 *
 * `upload` is "create new"; `replace` is "update existing by id". They're
 * separate so the backend can enforce different RLS policies if needed.
 */
export interface CloudTransport {
    upload(envelope: Uint8Array, titleHint: string | null): Promise<BlobMeta>;
    replace(id: string, envelope: Uint8Array, titleHint: string | null): Promise<BlobMeta>;
    download(id: string): Promise<Uint8Array>;
    list(): Promise<BlobMeta[]>;
    delete(id: string): Promise<void>;
    /** Mint a share token for an existing blob. Caller must own the blob —
     *  RLS enforces that at the database. Returns the token string the
     *  client embeds in the share URL. */
    createShareToken(blobId: string): Promise<string>;
}

// --- High-level operations -------------------------------------------------

export interface PushResult {
    id: string;
    keyB64: string;
    shareToken: string;
    shareUrl: string;
    meta: BlobMeta;
}

/**
 * Encrypt + upload a canvas as a new cloud blob. Generates a fresh AES key
 * just for this canvas — never reuse a key across canvases.
 *
 * `zipBytes` is the output of useAnyFile.serializeToZip (or whatever
 * produces the existing `.any` ZIP byte payload). Pass NULL for `titleHint`
 * if the user wants no plaintext label on the server.
 *
 * Returns the share URL the caller can show, copy, or persist.
 */
export async function pushNew(
    zipBytes: Uint8Array,
    titleHint: string | null,
    transport: CloudTransport,
): Promise<PushResult> {
    const key = await generateKey();
    const envelope = await pack(zipBytes, key);
    const meta = await transport.upload(envelope, titleHint);
    const keyB64 = await exportKey(key);
    const shareToken = await transport.createShareToken(meta.id);
    return {
        id: meta.id,
        keyB64,
        shareToken,
        shareUrl: formatShareUrl(shareToken, keyB64),
        meta,
    };
}

/**
 * Re-encrypt + upload an updated version of an existing cloud canvas using
 * the SAME key as the previous push. Caller is responsible for tracking the
 * key (typically stored in a side-table next to the blob id, in the user's
 * local KLYPIX state — never sent to the server).
 *
 * Note: re-encrypting with the same key is safe in AES-GCM because pack()
 * generates a fresh random IV on every call, so the (key, IV) pair stays
 * unique per upload.
 */
export async function pushUpdate(
    id: string,
    zipBytes: Uint8Array,
    keyB64: string,
    titleHint: string | null,
    transport: CloudTransport,
): Promise<BlobMeta> {
    const key = await importKey(keyB64);
    const envelope = await pack(zipBytes, key);
    return transport.replace(id, envelope, titleHint);
}

/**
 * Download + decrypt a canvas given its blob id and the base64 key. Returns
 * the original `.any` ZIP bytes that the caller can feed into
 * useAnyFile's existing import path.
 */
export async function pull(
    id: string,
    keyB64: string,
    transport: CloudTransport,
): Promise<Uint8Array> {
    const [envelope, key] = await Promise.all([
        transport.download(id),
        importKey(keyB64),
    ]);
    return unpack(envelope, key);
}

// --- Share URL helpers -----------------------------------------------------
//
// Web share URLs: https://klypix.com/c/<token>#<keyB64>
// Both segments are URL-safe base64 (no '+', '/', or '=' — token from Node
// randomBytes.toString('base64url'), keyB64 from encryption.ts bytesToUrlBase64).

const SHARE_URL_HOST = 'https://klypix.com';
const SHARE_URL_PATH = '/c/';
const SHARE_URL_PREFIX = `${SHARE_URL_HOST}${SHARE_URL_PATH}`;

export function formatShareUrl(token: string, keyB64: string): string {
    return `${SHARE_URL_PREFIX}${token}#${keyB64}`;
}

export interface ParsedShareUrl {
    /** The share token from the URL path. NOT the blob id — resolve via
     *  the canvas_share_tokens table to get the underlying blob_id. */
    token: string;
    keyB64: string;
}

/**
 * Parse a `https://klypix.com/c/<token>#<key>` URL. Throws with a clear
 * message if the input doesn't match — callers should catch and show
 * "this isn't a valid canvas share link" UX.
 *
 * Note: this only parses the URL. Resolving the token to a blob id
 * requires a Supabase round-trip and is the web viewer's job, not this
 * function's.
 */
export function parseShareUrl(url: string): ParsedShareUrl {
    if (!url.startsWith(SHARE_URL_PREFIX)) {
        throw new Error('Not a KLYPIX canvas share URL');
    }
    const rest = url.slice(SHARE_URL_PREFIX.length);
    const hashIdx = rest.indexOf('#');
    if (hashIdx < 0) {
        throw new Error('Share URL missing decryption key (no `#` fragment)');
    }
    const token = rest.slice(0, hashIdx);
    const keyB64 = rest.slice(hashIdx + 1);
    if (!token || !keyB64) {
        throw new Error('Share URL has empty token or key');
    }
    // Token is base64url — reject path separators or spaces that would
    // indicate a malformed URL.
    if (token.includes('/') || token.includes(' ')) {
        throw new Error('Share URL token contains invalid characters');
    }
    return { token, keyB64 };
}
