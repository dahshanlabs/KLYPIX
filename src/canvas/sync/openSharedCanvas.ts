// Orchestrates "open a shared canvas in the desktop": download encrypted
// bytes from Supabase storage, decrypt with the collaborator-side key,
// write to a local .klypix file under userData/shared-canvases/, then let
// the normal openByPath flow take over.
//
// This is the manual side of Phase 7 sync. Once a collaborator opens a
// shared canvas, they can edit + Ctrl+S locally; the file is registered
// in cloudShareStore (keyed by local filePath) so future "Update cloud
// copy" pushes go back to the same blob. Automatic background pull/push
// is a follow-up — for now collaborators sync by closing + reopening.

import { pull } from '../cloud/syncClient';
import { electronCloudTransport } from '../cloud/electronTransport';
import { setCloudShare } from '../cloud/cloudShareStore';

export interface OpenSharedInput {
    blobId: string;
    keyB64: string;
    titleHint?: string | null;
}

export type OpenSharedResult =
    | { ok: true; filePath: string }
    | { ok: false; reason: 'download-failed' | 'decrypt-failed' | 'write-failed' | 'ipc-missing'; error?: string };

export async function openSharedCanvas(input: OpenSharedInput): Promise<OpenSharedResult> {
    const bridge: any = (window as any).electron?.cloud;
    const writer: any = (window as any).electron?.cloud?.writeSharedToDisk;
    if (!bridge?.download || typeof writer !== 'function') {
        return { ok: false, reason: 'ipc-missing' };
    }

    // 1. Download + decrypt. syncClient.pull does both — it pipes the
    //    download through unpack() which strips the envelope header + IV
    //    and runs AES-GCM decrypt with the collaborator-side key.
    let plaintext: Uint8Array;
    try {
        plaintext = await pull(input.blobId, input.keyB64, electronCloudTransport);
    } catch (e: any) {
        const msg = e?.message || String(e);
        if (/Decryption failed|wrong key/i.test(msg)) {
            return { ok: false, reason: 'decrypt-failed', error: msg };
        }
        return { ok: false, reason: 'download-failed', error: msg };
    }

    // 2. Write the decrypted .klypix bytes to userData/shared-canvases/.
    //    Main returns the absolute path; the renderer opens it via the
    //    normal openByPath IPC, so the rest of the canvas system is
    //    unchanged.
    let writeRes: { ok: boolean; filePath?: string; error?: string };
    try {
        const bytesBase64 = uint8ToBase64(plaintext);
        writeRes = await writer({
            blobId: input.blobId,
            bytesBase64,
            preferredName: input.titleHint || undefined,
        });
    } catch (e: any) {
        return { ok: false, reason: 'write-failed', error: e?.message || String(e) };
    }
    if (!writeRes.ok || !writeRes.filePath) {
        return { ok: false, reason: 'write-failed', error: writeRes.error };
    }

    // 3. Register the file→cloud-blob mapping in cloudShareStore so future
    //    Ctrl+S → Share → "Update cloud copy" knows where to push back.
    //    Same shape that owners use after sharing.
    setCloudShare(writeRes.filePath, {
        blobId: input.blobId,
        keyB64: input.keyB64,
        // shareToken unset — collaborator-side opens don't need to mint a
        // share-by-URL link. If they want to share onward, they can use
        // the normal Share flow which fills this in.
        shareUrl: '',
        lastPushedAt: Date.now(),
    });

    return { ok: true, filePath: writeRes.filePath };
}

// btoa + manual byte → base64 loop. Uint8Array → base64 without TextDecoder
// shenanigans. Browsers cap btoa() input length so we chunk.
function uint8ToBase64(bytes: Uint8Array): string {
    const CHUNK = 0x8000;
    let bin = '';
    for (let i = 0; i < bytes.length; i += CHUNK) {
        bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
    }
    return btoa(bin);
}
