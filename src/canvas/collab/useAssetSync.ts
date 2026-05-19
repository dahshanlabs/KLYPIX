import { useEffect, useRef } from 'react';
import type { RealtimeChannel } from '@supabase/supabase-js';
import { getRealtimeClient } from './supabaseRealtimeClient';
import { useCanvasStore } from '../state/canvasStore';
import type { CanvasAction } from '../state/canvasStore';
import { getAsset, registerAsset, bytesToBase64, base64ToBytes, mimeFromExtension } from '../file/assetRegistry';
import { encrypt, decrypt, importKey } from '../cloud/encryption';

// Phase 4: asset sync.
//
// When a user adds an image / file / video / audio item, the bytes live in
// the local renderer's assetRegistry, NOT in the .klypix on disk until the
// next save. Phases 1-3 sync the item metadata (ADD_ITEM) but receivers
// have no way to retrieve those bytes → the remote canvas shows a broken
// image. This hook closes the gap: every ADD_ITEM with an assetId triggers
// an encrypted 'asset' broadcast carrying the bytes. Receivers decrypt
// and register in their assetRegistry so the next render finds them.
//
// Size cap: ~600KB plaintext, ~800KB after base64 + AES-GCM overhead. Stays
// under Supabase Realtime's default 2MB message limit with margin. Larger
// assets log a warning and DON'T sync — the user can still cloud-share+
// reload to propagate big assets via the existing share flow. Proper
// large-asset sync (storage-bucket-backed + chunked notification) is a
// Phase 4.1 follow-up.

const CHANNEL_PREFIX = 'klypix-canvas-';
const ASSET_PLAINTEXT_CAP = 600 * 1024;

interface AssetPayload {
    /** Sender's deviceId — same id schema as opSync/cursor; skip own echoes. */
    device_id: string;
    /** The assetId the receiver's items will reference. Matches whatever
     *  the ADD_ITEM op carried. */
    asset_id: string;
    /** Extension hint (no dot). Used to recover a mime if `mime` is empty. */
    extension: string;
    /** Mime type — preserved verbatim from the sender's asset registry. */
    mime: string;
    /** Best-effort original filename. Display-only; receiver re-derives if missing. */
    file_name?: string;
    /** Base64-encoded AES-GCM ciphertext + IV concatenated as `iv||ct`. */
    encrypted_b64: string;
}

function getDeviceId(): string {
    const KEY = 'klypix:collab:deviceId';
    let id = localStorage.getItem(KEY);
    if (!id) {
        id = 'cdev_' + Math.random().toString(36).slice(2) + Date.now().toString(36);
        localStorage.setItem(KEY, id);
    }
    return id;
}

/** Inspect a syncable ADD_ITEM and pull out the assetId if present.
 *  Image / file / video / audio carry assetId on the item directly. */
function assetIdFromAction(action: CanvasAction): string | null {
    if (action.type !== 'ADD_ITEM') return null;
    const item = action.item as any;
    if (!item) return null;
    if (item.type === 'image' || item.type === 'file' || item.type === 'video' || item.type === 'audio') {
        return typeof item.assetId === 'string' ? item.assetId : null;
    }
    return null;
}

export interface UseAssetSyncArgs {
    blobId: string | null | undefined;
    /** URL-safe base64 AES key from the share flow (cloudShare.keyB64).
     *  When null, sync is inert — we can't en/decrypt without the key. */
    keyB64: string | null | undefined;
    active: boolean;
}

/**
 * Phase 4 hook. Listens to local ADD_ITEM dispatches via subscribeActions,
 * encrypts + broadcasts the asset bytes; receives peers' asset broadcasts
 * and registers them so the matching items render.
 */
export function useAssetSync({ blobId, keyB64, active }: UseAssetSyncArgs): void {
    const { subscribeActions } = useCanvasStore();
    const channelRef = useRef<RealtimeChannel | null>(null);
    const keyRef = useRef<CryptoKey | null>(null);

    useEffect(() => {
        if (!blobId || !keyB64) return;
        let cancelled = false;
        const supabase = getRealtimeClient();
        const channelName = `${CHANNEL_PREFIX}${blobId}`;
        const deviceId = getDeviceId();

        // Resolve the AES key asynchronously. Until it's ready, queue any
        // outbound broadcasts (no inbound work — we can't decrypt yet).
        const queue: AssetPayload[] = [];
        const flushQueue = () => {
            while (queue.length > 0) {
                const p = queue.shift()!;
                channelRef.current?.send({ type: 'broadcast', event: 'asset', payload: p });
            }
        };

        importKey(keyB64).then(key => {
            if (cancelled) return;
            keyRef.current = key;
            flushQueue();
        }).catch(err => {
            console.warn('[assetSync] failed to import canvas key:', err);
        });

        const channel = supabase.channel(channelName, {
            config: { broadcast: { self: false, ack: false } },
        });
        channelRef.current = channel;

        channel.on('broadcast', { event: 'asset' }, async (msg: any) => {
            const p = msg?.payload as AssetPayload | undefined;
            if (!p || typeof p.device_id !== 'string') return;
            if (p.device_id === deviceId) return;
            if (typeof p.asset_id !== 'string' || typeof p.encrypted_b64 !== 'string') return;
            // Skip if we already have this asset (the local user added the
            // same image, or we already received it). Registering the same
            // id over is harmless but wastes a decrypt.
            if (getAsset(p.asset_id)) return;
            const key = keyRef.current;
            if (!key) {
                console.warn('[assetSync] received asset before key import; skipping');
                return;
            }
            try {
                const raw = base64ToBytes(p.encrypted_b64);
                // First 12 bytes are the IV; rest is ciphertext.
                if (raw.byteLength < 13) throw new Error('asset payload too short');
                const iv = raw.subarray(0, 12);
                const ciphertext = raw.subarray(12);
                const plaintext = await decrypt(key, { iv: new Uint8Array(iv), ciphertext: new Uint8Array(ciphertext) });
                registerAsset({
                    id: p.asset_id,
                    mime: p.mime || mimeFromExtension(p.extension || 'bin'),
                    extension: p.extension || 'bin',
                    bytes: plaintext,
                    fileName: p.file_name,
                });
            } catch (err) {
                console.warn('[assetSync] failed to apply remote asset:', err);
            }
        });

        channel.subscribe();

        const unsubscribe = subscribeActions((action) => {
            if ((action as any).__remote) return;
            if (!active) return;
            const assetId = assetIdFromAction(action);
            if (!assetId) return;
            const asset = getAsset(assetId);
            if (!asset) return;
            if (asset.bytes.byteLength > ASSET_PLAINTEXT_CAP) {
                console.warn(`[assetSync] asset ${assetId} (${asset.bytes.byteLength} bytes) exceeds inline cap — peer will see a broken item until the next save+reshare. Larger-asset sync via storage bucket is Phase 4.1.`);
                return;
            }
            const key = keyRef.current;
            // Build payload (queued if key not yet ready).
            (async () => {
                try {
                    const k = key ?? await importKey(keyB64);
                    keyRef.current = k;
                    const { ciphertext, iv } = await encrypt(k, asset.bytes);
                    // Pack iv||ciphertext into one base64 string.
                    const combined = new Uint8Array(iv.byteLength + ciphertext.byteLength);
                    combined.set(iv, 0);
                    combined.set(ciphertext, iv.byteLength);
                    const payload: AssetPayload = {
                        device_id: deviceId,
                        asset_id: assetId,
                        extension: asset.extension,
                        mime: asset.mime,
                        file_name: asset.fileName,
                        encrypted_b64: bytesToBase64(combined),
                    };
                    if (keyRef.current && channelRef.current) {
                        channelRef.current.send({ type: 'broadcast', event: 'asset', payload });
                    } else {
                        queue.push(payload);
                    }
                } catch (err) {
                    console.warn('[assetSync] failed to encrypt/send asset:', err);
                }
            })();
        });

        return () => {
            cancelled = true;
            unsubscribe();
            channelRef.current = null;
            try { supabase.removeChannel(channel); } catch { /* ignored */ }
        };
    }, [blobId, keyB64, active, subscribeActions]);
}
