// Top-level "share this canvas to the cloud" orchestrator.
//
// Bridges the user-facing flow (Share button click) to the existing syncClient
// engine that handles encryption + upload. Decision tree:
//
//   1. Canvas must be saved to disk first (we share the file bytes, not the
//      in-memory state — keeps "what's shared" === "what's on disk").
//   2. If this filePath has an existing cloud share → pushUpdate (replace
//      the existing blob, preserve the share URL).
//   3. If not → pushNew (creates a fresh blob + key + share URL).
//
// E2E encryption: the encryption key is in the URL fragment (#...) which
// browsers never send to the server. The server stores opaque ciphertext.
// Even with full DB access, Supabase cannot decrypt user canvases.

import { pushNew, pushUpdate, formatShareUrl } from './syncClient';
import { electronCloudTransport } from './electronTransport';
import { getCloudShare, setCloudShare, type CloudShare } from './cloudShareStore';

export type ShareResult =
    | { ok: true; share: CloudShare; isNew: boolean }
    | { ok: false; reason: 'unsaved' | 'auth-required' | 'read-failed' | 'upload-failed'; error?: string };

export interface ShareInput {
    filePath: string | null;
    title?: string;
}

/**
 * Share the current canvas. Returns the share record (URL + key + blobId)
 * on success, or a discriminated reason on failure so the UI can route to
 * the right remedy (save first / sign in / retry).
 */
export async function shareCurrentCanvas(input: ShareInput): Promise<ShareResult> {
    if (!input.filePath) {
        return { ok: false, reason: 'unsaved' };
    }

    // 1. Read raw .klypix bytes from disk.
    const electron: any = (window as any).electron;
    if (!electron?.canvas?.readRawBytes) {
        return { ok: false, reason: 'read-failed', error: 'readRawBytes IPC not available' };
    }
    const readRes = await electron.canvas.readRawBytes(input.filePath);
    if (!readRes?.ok || !readRes.bytesBase64) {
        return { ok: false, reason: 'read-failed', error: readRes?.error };
    }
    // Decode base64 → Uint8Array. Browsers don't have Buffer; use atob.
    const binStr = atob(readRes.bytesBase64);
    const zipBytes = new Uint8Array(binStr.length);
    for (let i = 0; i < binStr.length; i++) zipBytes[i] = binStr.charCodeAt(i);

    // 2. Existing share for this filePath? Update vs new.
    const existing = getCloudShare(input.filePath);
    const titleHint = input.title || null;

    try {
        if (existing) {
            const meta = await pushUpdate(existing.blobId, zipBytes, existing.keyB64, titleHint, electronCloudTransport);
            // Legacy entries (minted before share tokens existed) lack a
            // shareToken — back-fill one so the new https share URL works.
            // Re-uses an existing token if present so the URL stays stable
            // across "Update cloud copy" clicks.
            const shareToken = existing.shareToken
                ?? await electronCloudTransport.createShareToken(existing.blobId);
            const next: CloudShare = {
                blobId: existing.blobId,
                keyB64: existing.keyB64,
                shareToken,
                shareUrl: formatShareUrl(shareToken, existing.keyB64),
                lastPushedAt: Date.now(),
            };
            setCloudShare(input.filePath, next);
            void meta;
            return { ok: true, share: next, isNew: false };
        }

        const result = await pushNew(zipBytes, titleHint, electronCloudTransport);
        const next: CloudShare = {
            blobId: result.id,
            keyB64: result.keyB64,
            shareToken: result.shareToken,
            shareUrl: result.shareUrl,
            lastPushedAt: Date.now(),
        };
        setCloudShare(input.filePath, next);
        return { ok: true, share: next, isNew: true };
    } catch (err: any) {
        const msg = err?.message || String(err);
        // Translate the auth-error sentinel from cloudHandlers.ts.
        if (/sign[-\s]?in|CLOUD_AUTH_REQUIRED|requires sign-in/i.test(msg)) {
            return { ok: false, reason: 'auth-required', error: msg };
        }
        return { ok: false, reason: 'upload-failed', error: msg };
    }
}

/** Re-derive the share URL for an already-uploaded canvas without re-uploading.
 *  Used when the user wants to copy the URL again without paying the network cost. */
export function getExistingShareUrl(filePath: string | null): string | null {
    if (!filePath) return null;
    const share = getCloudShare(filePath);
    return share?.shareUrl ?? null;
}
