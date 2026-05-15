// End-to-end encryption helpers for cloud-synced canvas blobs.
//
// Pattern: client generates a 256-bit AES-GCM key. Plaintext canvas bytes
// (the .any ZIP) are encrypted client-side. Only the ciphertext + a random
// IV are uploaded — the server never sees the key or the plaintext.
//
// Sharing works by embedding the key in a URL fragment:
//
//     klypix://canvas/<blob-id>#<base64-key>
//
// URL fragments are not sent to servers (browsers + most HTTP clients strip
// them on request). The recipient pastes the link, KLYPIX downloads the
// ciphertext blob by id, and decrypts locally with the key from the
// fragment. No server in the path ever sees both halves.
//
// Same approach used by Excalidraw+, ProtonDrive share links, etc.

const ALGO = 'AES-GCM';
const KEY_LENGTH_BITS = 256;
const IV_LENGTH_BYTES = 12; // GCM standard; reusing an IV with the same key breaks confidentiality

/**
 * Generate a fresh AES-GCM key. Each canvas should get its own key — never
 * reuse keys across canvases. Throwaway browser CryptoKey objects do not
 * leave the renderer until the caller explicitly calls `exportKey`.
 */
export async function generateKey(): Promise<CryptoKey> {
    return crypto.subtle.generateKey(
        { name: ALGO, length: KEY_LENGTH_BITS },
        true, // extractable — needed so we can encode it for share URLs
        ['encrypt', 'decrypt'],
    );
}

/**
 * Export a key as a URL-safe base64 string (no padding) suitable for
 * embedding in a URL fragment. Roundtrips through `importKey`.
 */
export async function exportKey(key: CryptoKey): Promise<string> {
    const raw = await crypto.subtle.exportKey('raw', key);
    return bytesToUrlBase64(new Uint8Array(raw));
}

/**
 * Import a previously-exported key. Inverse of `exportKey`. Throws if the
 * input isn't valid base64 or isn't 32 bytes.
 */
export async function importKey(urlBase64: string): Promise<CryptoKey> {
    const raw = urlBase64ToBytes(urlBase64);
    if (raw.byteLength !== KEY_LENGTH_BITS / 8) {
        throw new Error(`Invalid key length: expected ${KEY_LENGTH_BITS / 8} bytes, got ${raw.byteLength}`);
    }
    return crypto.subtle.importKey('raw', raw as BufferSource, ALGO, true, ['encrypt', 'decrypt']);
}

export interface EncryptedBlob {
    ciphertext: Uint8Array;  // AES-GCM ciphertext including the auth tag
    iv: Uint8Array;          // random 12-byte IV — must be uploaded alongside ciphertext
}

/**
 * Encrypt arbitrary bytes (e.g. the `.any` ZIP produced by anyFormat.serialize)
 * with the supplied key. Generates a fresh IV on every call — never reuse
 * the same (key, IV) pair on different plaintexts.
 */
export async function encrypt(key: CryptoKey, plaintext: Uint8Array): Promise<EncryptedBlob> {
    const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH_BYTES));
    const ciphertext = new Uint8Array(
        await crypto.subtle.encrypt(
            { name: ALGO, iv: iv as BufferSource },
            key,
            plaintext as BufferSource,
        ),
    );
    return { ciphertext, iv };
}

/**
 * Decrypt a previously-encrypted blob. Throws if authentication fails (wrong
 * key, tampered ciphertext, or wrong IV). The thrown error is intentionally
 * generic so callers can't infer which of the three went wrong.
 */
export async function decrypt(key: CryptoKey, blob: EncryptedBlob): Promise<Uint8Array> {
    try {
        const plaintext = await crypto.subtle.decrypt(
            { name: ALGO, iv: blob.iv as BufferSource },
            key,
            blob.ciphertext as BufferSource,
        );
        return new Uint8Array(plaintext);
    } catch {
        throw new Error('Decryption failed: wrong key or tampered blob');
    }
}

// --- URL-safe base64 (RFC 4648 §5, no padding) ---------------------------
// crypto.subtle exports raw bytes; we encode for URL fragments using the
// URL-safe alphabet (replace + → -, / → _, drop trailing = padding).

function bytesToUrlBase64(bytes: Uint8Array): string {
    let bin = '';
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function urlBase64ToBytes(s: string): Uint8Array {
    const padded = s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4);
    const bin = atob(padded);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
}
