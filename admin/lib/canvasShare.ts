// Web-side counterpart to src/canvas/cloud/{encryption,syncBlob,syncClient}.ts.
//
// The desktop produces share URLs in the form
//     https://klypix.com/c/<token>#<keyB64>
// This module is the browser-side resolver:
//
//   1. Parse the path token + fragment key
//   2. Anonymous Supabase query: canvas_share_tokens → blob_id
//   3. Anonymous storage download: <blob_id>.bin
//   4. Strip the envelope header + IV, AES-GCM decrypt with the key from
//      the URL fragment
//
// The fragment never leaves the user's browser; Supabase only ever sees the
// token and the (encrypted) bytes.

import { supabase } from './supabase';

// --- URL-safe base64 helpers (mirror src/canvas/cloud/encryption.ts) ----

function urlBase64ToBytes(s: string): Uint8Array {
    const padded = s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4);
    const bin = atob(padded);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
}

// --- Envelope format (mirror src/canvas/cloud/syncBlob.ts) ----

const MAGIC_K = 0x4B;
const MAGIC_X = 0x58;
const WIRE_VERSION = 1;
const HEADER_LEN = 4;
const IV_LEN = 12;

async function importKey(keyB64Url: string): Promise<CryptoKey> {
    const raw = urlBase64ToBytes(keyB64Url);
    if (raw.byteLength !== 32) {
        throw new Error(`Invalid key length: expected 32 bytes, got ${raw.byteLength}`);
    }
    return crypto.subtle.importKey('raw', raw as BufferSource, 'AES-GCM', false, ['decrypt']);
}

async function unpack(envelope: Uint8Array, key: CryptoKey): Promise<Uint8Array> {
    if (envelope.length < HEADER_LEN + IV_LEN + 16) {
        throw new Error('Envelope too short to be a KLYPIX cloud blob');
    }
    if (envelope[0] !== MAGIC_K || envelope[1] !== MAGIC_X) {
        throw new Error('Not a KLYPIX cloud blob (bad magic bytes)');
    }
    if (envelope[2] !== WIRE_VERSION) {
        throw new Error(`Unsupported envelope version ${envelope[2]}`);
    }
    const iv = envelope.slice(HEADER_LEN, HEADER_LEN + IV_LEN);
    const ciphertext = envelope.slice(HEADER_LEN + IV_LEN);
    try {
        const plaintext = await crypto.subtle.decrypt(
            { name: 'AES-GCM', iv: iv as BufferSource },
            key,
            ciphertext as BufferSource,
        );
        return new Uint8Array(plaintext);
    } catch {
        throw new Error('Decryption failed: wrong key or tampered blob');
    }
}

// --- High-level: token + key → decrypted .klypix bytes ----

export interface LoadedSharedCanvas {
    bytes: Uint8Array;
    blobId: string;
    /** Size of the encrypted envelope on the server, useful for telemetry /
     *  "Downloading 2.4 MB" UI. */
    encryptedSize: number;
}

export type LoadError =
    | 'invalid-token'      // token not found, expired, or revoked
    | 'download-failed'    // storage download blew up
    | 'decrypt-failed'     // bytes downloaded but key is wrong / blob tampered
    | 'config-missing';    // admin/.env.local not set up

export class CanvasShareError extends Error {
    constructor(public code: LoadError, message: string) {
        super(message);
    }
}

/**
 * Resolve a share URL's token + key into decrypted canvas bytes.
 *
 * Failure modes are surfaced as `CanvasShareError` with a discriminated
 * `code` so the UI can show actionable messages:
 *   - invalid-token  → "This link is invalid, expired, or revoked"
 *   - download-failed → "Couldn't reach the server, try again"
 *   - decrypt-failed → "This link is corrupted (wrong key)"
 *   - config-missing → "The viewer isn't configured (admin: set env vars)"
 */
export async function loadSharedCanvas(token: string, keyB64: string): Promise<LoadedSharedCanvas> {
    // 1. Resolve token → blob_id. Anonymous query allowed by the
    //    "anon can resolve valid share tokens" RLS policy.
    const { data: tokenRow, error: tokenErr } = await supabase
        .from('canvas_share_tokens')
        .select('blob_id')
        .eq('token', token)
        .maybeSingle();

    if (tokenErr) {
        // Most likely "relation does not exist" → migrations not applied.
        if (/does not exist|placeholder/i.test(tokenErr.message)) {
            throw new CanvasShareError('config-missing', tokenErr.message);
        }
        throw new CanvasShareError('download-failed', tokenErr.message);
    }
    if (!tokenRow) {
        throw new CanvasShareError('invalid-token', 'Token not found, expired, or revoked');
    }

    // 2. Download encrypted bytes. Anonymous storage access allowed by the
    //    "anon can read shared canvas objects" RLS policy.
    const { data: blob, error: dlErr } = await supabase
        .storage
        .from('canvases')
        .download(`${tokenRow.blob_id}.bin`);

    if (dlErr || !blob) {
        throw new CanvasShareError('download-failed', dlErr?.message ?? 'No data returned');
    }

    const envelope = new Uint8Array(await blob.arrayBuffer());

    // 3. Decrypt client-side. The key never touched the server.
    try {
        const key = await importKey(keyB64);
        const plaintext = await unpack(envelope, key);
        return {
            bytes: plaintext,
            blobId: tokenRow.blob_id,
            encryptedSize: envelope.byteLength,
        };
    } catch (e: any) {
        throw new CanvasShareError('decrypt-failed', e?.message ?? 'Decryption failed');
    }
}

/** Trigger a browser download of the decrypted .klypix file. */
export function downloadAsKlypixFile(bytes: Uint8Array, filename: string): void {
    // Cast to ArrayBuffer for Blob's type signature
    const blob = new Blob([bytes as BlobPart], { type: 'application/octet-stream' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename.endsWith('.klypix') ? filename : `${filename}.klypix`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Format a byte count as a short human string ("2.4 MB"). */
export function formatBytes(n: number): string {
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
    if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
    return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}
