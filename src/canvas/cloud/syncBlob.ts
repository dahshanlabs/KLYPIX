// Encrypted-blob wire format for cloud-synced canvases.
//
// `pack(zipBytes, key)` takes the bytes of a `.any` ZIP (output of
// anyFormat.serialize → JSZip) and produces an envelope ready to upload to
// any storage backend (Supabase Storage, Firebase, S3, custom). Inverse:
// `unpack(envelope, key)` returns the original bytes for the loader.
//
// Wire format (single Uint8Array):
//
//     [0]      magic byte 'K' (0x4B)
//     [1]      magic byte 'X' (0x58)
//     [2]      schema version (1)
//     [3]      reserved (0)
//     [4..15]  IV (12 bytes, AES-GCM)
//     [16..]   ciphertext (includes the GCM auth tag)
//
// The 4-byte header is unencrypted so a server / CLI can detect a malformed
// upload without having the key. It's not authenticated — a tampered header
// causes decrypt to fail when the IV doesn't match the auth tag.
//
// What is NOT encrypted: nothing useful. Filename, canvas title, item count,
// even the existence of attached images — all of that lives inside the .any
// ZIP and is encrypted with everything else. Server only learns the size of
// the blob and the upload time.

import { encrypt, decrypt, type EncryptedBlob } from './encryption';

const MAGIC_K = 0x4B;
const MAGIC_X = 0x58;
const WIRE_VERSION = 1;
const HEADER_LEN = 4;
const IV_LEN = 12;

/**
 * Pack `.any` ZIP bytes + a key into an upload-ready envelope. The returned
 * Uint8Array is the entire wire payload — write it as-is to your cloud
 * backend's "blob upload" endpoint.
 */
export async function pack(zipBytes: Uint8Array, key: CryptoKey): Promise<Uint8Array> {
    const blob = await encrypt(key, zipBytes);
    return concat(headerBytes(), blob.iv, blob.ciphertext);
}

/**
 * Unpack an envelope back into the original `.any` ZIP bytes. Throws on
 * format mismatch (wrong magic, unknown version) before attempting decrypt
 * so callers can distinguish "this isn't a KLYPIX cloud blob at all" from
 * "wrong key / tampered."
 */
export async function unpack(envelope: Uint8Array, key: CryptoKey): Promise<Uint8Array> {
    if (envelope.length < HEADER_LEN + IV_LEN + 16 /* min GCM auth tag */) {
        throw new Error('Envelope too short to be a KLYPIX cloud blob');
    }
    if (envelope[0] !== MAGIC_K || envelope[1] !== MAGIC_X) {
        throw new Error('Not a KLYPIX cloud blob (bad magic bytes)');
    }
    const version = envelope[2];
    if (version !== WIRE_VERSION) {
        throw new Error(`Unsupported envelope version ${version}; this build supports ${WIRE_VERSION}`);
    }
    const iv = envelope.slice(HEADER_LEN, HEADER_LEN + IV_LEN);
    const ciphertext = envelope.slice(HEADER_LEN + IV_LEN);
    const blob: EncryptedBlob = { iv, ciphertext };
    return decrypt(key, blob);
}

function headerBytes(): Uint8Array {
    return new Uint8Array([MAGIC_K, MAGIC_X, WIRE_VERSION, 0]);
}

function concat(...parts: Uint8Array[]): Uint8Array {
    let total = 0;
    for (const p of parts) total += p.length;
    const out = new Uint8Array(total);
    let offset = 0;
    for (const p of parts) {
        out.set(p, offset);
        offset += p.length;
    }
    return out;
}
