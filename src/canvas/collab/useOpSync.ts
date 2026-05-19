import { useEffect, useRef } from 'react';
import type { RealtimeChannel } from '@supabase/supabase-js';
import { getRealtimeClient } from './supabaseRealtimeClient';
import { useCanvasStore } from '../state/canvasStore';
import type { CanvasAction } from '../state/canvasStore';

// Phase 3: op-log streaming.
//
// Every action that mutates the persistent canvas state gets broadcast on
// the same 'klypix-canvas-<blobId>' channel as a 'op' event. Other devices
// receive and apply it, tagged with __remote so the listener doesn't
// re-broadcast (which would loop forever).
//
// Conflict model is intentionally simple for v1:
//   - Lamport clock per-device → ordering across devices is approximate
//     (we don't store per-item versions yet, so true LWW per-field comes
//     later). For now: last-arriving update wins on UPDATE_ITEM. Cursor
//     awareness in Phase 2 means real conflicts are rare in practice —
//     users see where each other is working.
//   - ADD_ITEM is idempotent by id (the reducer no-ops if the id exists).
//   - DELETE_ITEMS is destructive — a late update on a deleted item is
//     dropped by the reducer because the item is already gone.
//
// What we DON'T sync (intentionally local-only):
//   - View / pan / zoom / tool selection / current colors etc.
//   - Local UI state (editing, drawing, focused container, capsule anchor)
//   - File path / save state / autosave state
//   - RESTORE (undo/redo replays the user's local action history; replicating
//     undo across devices is a Phase ∞ problem — skip for now).
//
// Same channel as presence + cursors keeps the network footprint tight —
// one Realtime subscription handles everything.

const CHANNEL_PREFIX = 'klypix-canvas-';

// Action types that mutate persistent state and should be broadcast.
// Anything not listed here stays local. Update this list if you add a
// new mutating reducer action.
const SYNCABLE_ACTIONS = new Set<CanvasAction['type']>([
    'ADD_ITEM',
    'UPDATE_ITEM',
    'DELETE_ITEMS',
    'ADD_CONNECTION',
    'UPDATE_CONNECTION',
    'DELETE_CONNECTIONS',
    'ADD_LINE',
    'UPDATE_LINE',
    'DELETE_LINES',
    'ADD_STROKE',
    'UPDATE_STROKE',
    'DELETE_STROKES',
    'REORDER_ITEMS',
    'DUPLICATE_ITEMS',
    'UNGROUP_CONTAINER',
    'INCREMENT_GROUP_COUNTER',
]);

interface OpPayload {
    /** Sender's deviceId. Used to skip own ops on the broadcast loop. */
    device_id: string;
    /** Lamport tick for approximate causal ordering. */
    lamport: number;
    /** The canvas action verbatim, JSON-serialized. */
    action: CanvasAction;
}

/** Stable per-device id — same key used by useCanvasCollab so a peer's
 *  cursor + ops share an identity. */
function getDeviceId(): string {
    const KEY = 'klypix:collab:deviceId';
    let id = localStorage.getItem(KEY);
    if (!id) {
        id = 'cdev_' + Math.random().toString(36).slice(2) + Date.now().toString(36);
        localStorage.setItem(KEY, id);
    }
    return id;
}

export interface UseOpSyncArgs {
    blobId: string | null | undefined;
    /** Tab visibility / canvas mode active. When false we still RECEIVE
     *  remote ops (so the local state stays current) but we stop sending
     *  to avoid background tabs spamming the channel. */
    active: boolean;
}

// ── Offline op queue (Phase 6) ─────────────────────────────────────
// Per-blob persisted queue of ops the local user dispatched while the
// channel was down. Survives reload (localStorage) so a crash + reload
// doesn't lose work. Drained one-at-a-time at ~20Hz on reconnect to
// stay under Supabase Realtime's 30/s cap.

interface QueuedOp { lamport: number; action: CanvasAction; queuedAt: number }

function opQueueKey(blobId: string): string { return `klypix:opqueue:${blobId}`; }
function lamportKey(blobId: string): string { return `klypix:lamport:${blobId}`; }

function loadQueue(blobId: string): QueuedOp[] {
    try {
        const raw = localStorage.getItem(opQueueKey(blobId));
        if (!raw) return [];
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed : [];
    } catch { return []; }
}
function saveQueue(blobId: string, q: QueuedOp[]): void {
    try {
        if (q.length === 0) localStorage.removeItem(opQueueKey(blobId));
        else localStorage.setItem(opQueueKey(blobId), JSON.stringify(q));
    } catch (err) {
        // Quota exceeded — drop oldest half. Better to lose some history
        // than fail the next dispatch's queue write.
        console.warn('[opSync] queue write failed; trimming', err);
        try {
            const half = q.slice(Math.floor(q.length / 2));
            localStorage.setItem(opQueueKey(blobId), JSON.stringify(half));
        } catch { /* give up */ }
    }
}
function loadLamport(blobId: string): number {
    try {
        const raw = localStorage.getItem(lamportKey(blobId));
        const n = raw ? parseInt(raw, 10) : 0;
        return Number.isFinite(n) ? n : 0;
    } catch { return 0; }
}
function saveLamport(blobId: string, n: number): void {
    try { localStorage.setItem(lamportKey(blobId), String(n)); } catch { /* no-op */ }
}

const DRAIN_INTERVAL_MS = 50; // 20Hz, well under Realtime's 30/s

/**
 * Connects the canvas store's action stream to a Supabase Realtime
 * channel. Sends syncable actions outbound; applies inbound ops via the
 * normal dispatch path so the reducer is a single source of truth for
 * how state changes (no parallel "apply remote" code path that could
 * drift from the local one).
 *
 * Phase 6: outbound ops broadcast when connected, otherwise enqueue to
 * localStorage. On reconnect (channel status flips to SUBSCRIBED), the
 * queue drains at 20Hz so a long offline burst doesn't immediately
 * blow the channel's rate limit.
 */
export function useOpSync({ blobId, active }: UseOpSyncArgs): void {
    const { dispatch, subscribeActions } = useCanvasStore();
    const channelRef = useRef<RealtimeChannel | null>(null);
    // Lamport clock — persisted per-blob so it survives reload. On mount
    // we load the saved value so post-reload sends carry monotonically
    // higher ticks than anything we queued before.
    const lamportRef = useRef(0);
    const connectedRef = useRef(false);
    const drainingRef = useRef(false);

    useEffect(() => {
        if (!blobId) return;
        const supabase = getRealtimeClient();
        const channelName = `${CHANNEL_PREFIX}${blobId}`;
        const deviceId = getDeviceId();

        // Hydrate lamport from persisted value so a fresh tab continues
        // from where the previous session left off.
        lamportRef.current = Math.max(lamportRef.current, loadLamport(blobId));

        const bumpLamport = (): number => {
            lamportRef.current += 1;
            saveLamport(blobId, lamportRef.current);
            return lamportRef.current;
        };

        const enqueue = (q: QueuedOp): void => {
            const cur = loadQueue(blobId);
            cur.push(q);
            saveQueue(blobId, cur);
        };

        // Drain the offline queue one op at a time so the catch-up burst
        // doesn't trip Realtime's rate limit. Stops early if we disconnect
        // mid-drain (left-over ops stay queued for the next reconnect).
        const drainQueue = async (): Promise<void> => {
            if (drainingRef.current) return;
            drainingRef.current = true;
            try {
                while (connectedRef.current) {
                    const cur = loadQueue(blobId);
                    if (cur.length === 0) break;
                    const head = cur[0];
                    const channel = channelRef.current;
                    if (!channel) break;
                    try {
                        await channel.send({
                            type: 'broadcast',
                            event: 'op',
                            payload: { device_id: deviceId, lamport: head.lamport, action: head.action } satisfies OpPayload,
                        });
                        // Successful send — pop the head and persist.
                        cur.shift();
                        saveQueue(blobId, cur);
                    } catch (err) {
                        console.warn('[opSync] drain send failed, keeping in queue:', err);
                        break;
                    }
                    await new Promise(r => setTimeout(r, DRAIN_INTERVAL_MS));
                }
            } finally {
                drainingRef.current = false;
            }
        };

        // Open (or reuse) the channel. If useCanvasCollab opened one with
        // the same name in the same client, Supabase de-dups — both end up
        // sharing the underlying connection.
        const channel = supabase.channel(channelName, {
            config: { broadcast: { self: false, ack: false } },
        });
        channelRef.current = channel;

        // Inbound op handler: parse + apply via wrapped dispatch. We tag
        // the action with `__remote: true` so the outbound listener below
        // can skip it (preventing a re-broadcast loop). The reducer
        // ignores the tag — it's a passthrough marker only the listener
        // checks.
        channel.on('broadcast', { event: 'op' }, (msg: any) => {
            const p = msg?.payload as OpPayload | undefined;
            if (!p || typeof p.device_id !== 'string') return;
            if (p.device_id === deviceId) return; // self-echo guard
            // Bump our lamport beyond what we've seen so subsequent local
            // sends carry a higher tick. Persist immediately so a crash
            // doesn't roll back to an older tick on reload.
            if (typeof p.lamport === 'number' && p.lamport > lamportRef.current) {
                lamportRef.current = p.lamport;
                saveLamport(blobId, lamportRef.current);
            }
            const action = p.action as CanvasAction;
            if (!action || typeof action !== 'object' || !('type' in action)) return;
            // Mark + dispatch. The listener below will see __remote and skip.
            (action as any).__remote = true;
            try {
                dispatch(action);
            } catch (err) {
                console.warn('[opSync] failed to apply remote op:', err, action);
            }
        });

        channel.subscribe((status) => {
            if (status === 'SUBSCRIBED') {
                connectedRef.current = true;
                // Reconnect catch-up: flush any ops queued while offline.
                void drainQueue();
            } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
                connectedRef.current = false;
            }
        });

        // Outbound: every local action that's syncable + not flagged remote.
        const unsubscribe = subscribeActions((action) => {
            if ((action as any).__remote) return;
            if (!SYNCABLE_ACTIONS.has(action.type)) return;
            if (!active) return; // background tab — don't broadcast
            const tick = bumpLamport();
            const payload: OpPayload = {
                device_id: deviceId,
                lamport: tick,
                action,
            };
            // If not connected, skip the send attempt entirely — go straight
            // to the queue so the drain-on-reconnect path is the only flush.
            if (!connectedRef.current) {
                enqueue({ lamport: tick, action, queuedAt: Date.now() });
                return;
            }
            channel.send({
                type: 'broadcast',
                event: 'op',
                payload,
            }).catch((err: unknown) => {
                // Send failed despite "connected" — likely a transient
                // hiccup. Queue so the next drain picks it up.
                console.warn('[opSync] send failed; queuing for retry:', err);
                enqueue({ lamport: tick, action, queuedAt: Date.now() });
            });
        });

        return () => {
            unsubscribe();
            channelRef.current = null;
            try { supabase.removeChannel(channel); } catch { /* ignored */ }
        };
    }, [blobId, active, dispatch, subscribeActions]);
}
