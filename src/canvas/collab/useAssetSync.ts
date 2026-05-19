import { useEffect, useRef } from 'react';
import type { RealtimeChannel } from '@supabase/supabase-js';
import { acquireCanvasChannel } from './channelRegistry';
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

const ASSET_PLAINTEXT_CAP = 600 * 1024;

// Phase 8: chunked-send config. Anything over the inline cap gets sliced
// into CHUNK_SIZE base64 segments, broadcast as 'asset.chunk' events with
// (asset_id, seq, total). Receiver collects + reassembles + decrypts in
// one shot. Stays under Realtime's 2MB-per-message limit while supporting
// up to ~10MB practically (20 chunks × 500KB at 30/s → finishes in <1s).
const CHUNK_PLAINTEXT_CAP = 10 * 1024 * 1024;
const CHUNK_SIZE = 400 * 1024;
const REASSEMBLY_TIMEOUT_MS = 30_000;

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

        // Phase 14: acquire the shared canvas channel via the registry.
        // useCanvasCollab + useOpSync use the SAME channel via the same
        // registry call, so asset broadcasts share one subscription
        // (was the root cause of inconsistent delivery in two-PC tests).
        const acquired = acquireCanvasChannel(blobId);
        const channel = acquired.channel;
        const deviceId = acquired.deviceId;
        channelRef.current = channel;

        // Inline (small) asset receiver.
        channel.on('broadcast', { event: 'asset' }, async (msg: any) => {
            if (cancelled) return;
            const p = msg?.payload as AssetPayload | undefined;
            if (!p || typeof p.device_id !== 'string') return;
            if (p.device_id === deviceId) return;
            if (typeof p.asset_id !== 'string' || typeof p.encrypted_b64 !== 'string') return;
            if (getAsset(p.asset_id)) return;
            const key = keyRef.current;
            if (!key) {
                console.warn('[assetSync] received asset before key import; skipping');
                return;
            }
            try {
                const raw = base64ToBytes(p.encrypted_b64);
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

        // Phase 8: chunked asset receiver. Collects (seq, chunk_b64) entries
        // keyed by asset_id; reassembles once `total` chunks are in. A 30s
        // timeout discards orphaned partials (e.g. sender disconnected
        // mid-send) so the Map doesn't leak.
        interface PartialAsset {
            total: number;
            chunks: Map<number, string>;
            mime: string;
            extension: string;
            file_name?: string;
            startedAt: number;
        }
        const reassemblyBuf = new Map<string, PartialAsset>();
        const sweepReassembly = window.setInterval(() => {
            const now = Date.now();
            for (const [id, p] of reassemblyBuf) {
                if (now - p.startedAt > REASSEMBLY_TIMEOUT_MS) reassemblyBuf.delete(id);
            }
        }, 5000);

        channel.on('broadcast', { event: 'asset.chunk' }, async (msg: any) => {
            if (cancelled) return;
            const p = msg?.payload as {
                device_id: string;
                asset_id: string;
                seq: number;
                total: number;
                chunk_b64: string;
                extension: string;
                mime: string;
                file_name?: string;
            } | undefined;
            if (!p || typeof p.device_id !== 'string') return;
            if (p.device_id === deviceId) return;
            if (getAsset(p.asset_id)) return;
            let partial = reassemblyBuf.get(p.asset_id);
            if (!partial) {
                partial = {
                    total: p.total,
                    chunks: new Map(),
                    mime: p.mime,
                    extension: p.extension,
                    file_name: p.file_name,
                    startedAt: Date.now(),
                };
                reassemblyBuf.set(p.asset_id, partial);
            }
            partial.chunks.set(p.seq, p.chunk_b64);
            if (partial.chunks.size < partial.total) return;

            // All chunks in — reassemble + decrypt + register.
            reassemblyBuf.delete(p.asset_id);
            const key = keyRef.current;
            if (!key) {
                console.warn('[assetSync] chunked asset complete but no key — discarding');
                return;
            }
            try {
                // Concatenate base64 chunks in order, then decode + decrypt.
                const ordered: string[] = [];
                for (let i = 0; i < partial.total; i++) {
                    const c = partial.chunks.get(i);
                    if (c == null) throw new Error(`missing chunk ${i}`);
                    ordered.push(c);
                }
                const combinedB64 = ordered.join('');
                const raw = base64ToBytes(combinedB64);
                if (raw.byteLength < 13) throw new Error('reassembled payload too short');
                const iv = raw.subarray(0, 12);
                const ciphertext = raw.subarray(12);
                const plaintext = await decrypt(key, { iv: new Uint8Array(iv), ciphertext: new Uint8Array(ciphertext) });
                registerAsset({
                    id: p.asset_id,
                    mime: partial.mime || mimeFromExtension(partial.extension || 'bin'),
                    extension: partial.extension || 'bin',
                    bytes: plaintext,
                    fileName: partial.file_name,
                });
            } catch (err) {
                console.warn('[assetSync] chunked reassembly failed:', err);
            }
        });

        // Note: channel.subscribe() is called ONCE inside acquireCanvasChannel.
        // We don't need status callbacks here — outbound sends just no-op if
        // the underlying channel isn't connected yet.

        const unsubscribe = subscribeActions((action) => {
            if ((action as any).__remote) return;
            if (!active) return;
            const assetId = assetIdFromAction(action);
            if (!assetId) return;
            const asset = getAsset(assetId);
            if (!asset) return;
            if (asset.bytes.byteLength > CHUNK_PLAINTEXT_CAP) {
                console.warn(`[assetSync] asset ${assetId} (${asset.bytes.byteLength} bytes) exceeds ${CHUNK_PLAINTEXT_CAP / 1024 / 1024}MB ceiling — peer sees broken item until save+reshare.`);
                return;
            }
            const useChunked = asset.bytes.byteLength > ASSET_PLAINTEXT_CAP;
            (async () => {
                try {
                    const k = keyRef.current ?? await importKey(keyB64);
                    keyRef.current = k;
                    const { ciphertext, iv } = await encrypt(k, asset.bytes);
                    const combined = new Uint8Array(iv.byteLength + ciphertext.byteLength);
                    combined.set(iv, 0);
                    combined.set(ciphertext, iv.byteLength);
                    const combinedB64 = bytesToBase64(combined);

                    if (!useChunked) {
                        // Small: one broadcast.
                        const payload: AssetPayload = {
                            device_id: deviceId,
                            asset_id: assetId,
                            extension: asset.extension,
                            mime: asset.mime,
                            file_name: asset.fileName,
                            encrypted_b64: combinedB64,
                        };
                        if (keyRef.current && channelRef.current) {
                            channelRef.current.send({ type: 'broadcast', event: 'asset', payload });
                        } else {
                            queue.push(payload);
                        }
                        return;
                    }

                    // Large: chunk the base64 string. Sending sliced base64
                    // (not sliced bytes) means each chunk decodes cleanly on
                    // its own — no padding/boundary fiddliness across chunks
                    // since the receiver concatenates BEFORE decoding.
                    const total = Math.ceil(combinedB64.length / CHUNK_SIZE);
                    for (let seq = 0; seq < total; seq++) {
                        const start = seq * CHUNK_SIZE;
                        const end = Math.min(start + CHUNK_SIZE, combinedB64.length);
                        const chunkPayload = {
                            device_id: deviceId,
                            asset_id: assetId,
                            seq,
                            total,
                            chunk_b64: combinedB64.slice(start, end),
                            extension: asset.extension,
                            mime: asset.mime,
                            file_name: asset.fileName,
                        };
                        if (channelRef.current) {
                            await channelRef.current.send({ type: 'broadcast', event: 'asset.chunk', payload: chunkPayload });
                        }
                        // Tiny inter-chunk delay to stay under Realtime's
                        // 30/s rate cap when shipping ~20 chunks.
                        await new Promise(r => setTimeout(r, 50));
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
            window.clearInterval(sweepReassembly);
            // Release our refCount on the shared channel — the registry
            // tears the channel down when refCount hits 0.
            acquired.release();
        };
    }, [blobId, keyB64, active, subscribeActions]);
}
