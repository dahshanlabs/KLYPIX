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
    /** Optional: fired when a remote UPDATE or DELETE arrives within
     *  ~1.5s of a local edit on the same item — used by the UI to
     *  toast the user that their concurrent edit was overwritten or
     *  the item was deleted out from under them. */
    onConflict?: (info: ConflictInfo) => void;
}

export interface ConflictInfo {
    kind: 'overwritten' | 'deleted';
    /** Item id affected. */
    itemId: string;
}

// How recent a local edit must be for an inbound op on the same item
// to count as a conflict. 1500ms covers typical drag bursts; longer
// would generate false positives for normal sequential editing.
const CONFLICT_WINDOW_MS = 1500;

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

// Phase 7: per-blob high-water mark for server-side ops. Tracks the seq
// of the last op we successfully pulled/applied so the next backfill
// only fetches what's new. Separate from lamport because seqs are
// server-assigned (bigserial) and don't align with the client lamport.
function seqKey(blobId: string): string { return `klypix:opseq:${blobId}`; }
function loadSeq(blobId: string): number {
    try {
        const raw = localStorage.getItem(seqKey(blobId));
        const n = raw ? parseInt(raw, 10) : 0;
        return Number.isFinite(n) ? n : 0;
    } catch { return 0; }
}
function saveSeq(blobId: string, n: number): void {
    try { localStorage.setItem(seqKey(blobId), String(n)); } catch { /* no-op */ }
}

const DRAIN_INTERVAL_MS = 50; // 20Hz, well under Realtime's 30/s

// Phase 10: outbound coalesce window. Actions enqueued within this many
// ms are flushed together, and same-id UPDATEs collapse to the latest.
// Keeps a 60Hz drag burst from blowing the 30/s broadcast rate limit.
const FLUSH_WINDOW_MS = 50;

// Action types whose outbound entries can be "replaced by newer for the
// same target id" instead of all being sent. The receiver's reducer only
// cares about the final value; intermediate states are visual noise.
const COALESCE_KEYS: Partial<Record<CanvasAction['type'], (a: CanvasAction) => string>> = {
    UPDATE_ITEM: (a) => `UPDATE_ITEM:${(a as { type: 'UPDATE_ITEM'; id: string }).id}`,
    UPDATE_LINE: (a) => `UPDATE_LINE:${(a as { type: 'UPDATE_LINE'; id: string }).id}`,
    UPDATE_STROKE: (a) => `UPDATE_STROKE:${(a as { type: 'UPDATE_STROKE'; id: string }).id}`,
    UPDATE_CONNECTION: (a) => `UPDATE_CONNECTION:${(a as { type: 'UPDATE_CONNECTION'; id: string }).id}`,
    REORDER_ITEMS: () => 'REORDER_ITEMS',  // last reorder wins
};

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
export function useOpSync({ blobId, active, onConflict }: UseOpSyncArgs): void {
    const { dispatch, subscribeActions } = useCanvasStore();
    const channelRef = useRef<RealtimeChannel | null>(null);
    // Lamport clock — persisted per-blob so it survives reload. On mount
    // we load the saved value so post-reload sends carry monotonically
    // higher ticks than anything we queued before.
    const lamportRef = useRef(0);
    const connectedRef = useRef(false);
    const drainingRef = useRef(false);
    // Recent local edits keyed by item id, used for conflict detection.
    // Pruned opportunistically; expected size stays small (<20 entries).
    const recentLocalEditsRef = useRef<Map<string, { at: number; type: 'update' | 'delete' }>>(new Map());
    const onConflictRef = useRef(onConflict);
    onConflictRef.current = onConflict;

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
        // After successful broadcast we also persist to canvas_ops so the
        // server-side log catches up — without this, an op typed offline
        // wouldn't be visible to a peer joining via backfill.
        const drainQueue = async (): Promise<void> => {
            if (drainingRef.current) return;
            drainingRef.current = true;
            const drainedForPersist: QueuedOp[] = [];
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
                        drainedForPersist.push(head);
                    } catch (err) {
                        console.warn('[opSync] drain send failed, keeping in queue:', err);
                        break;
                    }
                    await new Promise(r => setTimeout(r, DRAIN_INTERVAL_MS));
                }
            } finally {
                drainingRef.current = false;
                // Phase 7: persist the drained batch to canvas_ops so the
                // server log includes ops that were typed while offline.
                // Done at the end of drain rather than per-op to keep the
                // db round-trip count low.
                if (drainedForPersist.length > 0) {
                    void persistOpsToServerStandalone(drainedForPersist);
                }
            }
        };

        // Standalone push (used by drainQueue). Mirrors persistOpsToServer
        // defined below, but available before the flush helper closes over it.
        const persistOpsToServerStandalone = async (batch: QueuedOp[]): Promise<void> => {
            const cloudApi: any = (window as any).electron?.cloud;
            if (!cloudApi?.pushOps || batch.length === 0) return;
            try {
                const res = await cloudApi.pushOps({
                    blobId,
                    deviceId,
                    ops: batch.map(q => q.action),
                });
                if (res?.seqs && Array.isArray(res.seqs) && res.seqs.length > 0) {
                    const max = Math.max(...res.seqs as number[]);
                    if (max > loadSeq(blobId)) saveSeq(blobId, max);
                }
            } catch (err) {
                console.warn('[opSync] drainage pushOps failed:', err);
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
            // Conflict detection (Phase 9): if this remote op touches an
            // item the local user edited within CONFLICT_WINDOW_MS, fire
            // the onConflict callback so the UI can warn them. Done BEFORE
            // dispatch so the toast describes what's about to be overwritten,
            // not what already was.
            const now = Date.now();
            const recent = recentLocalEditsRef.current;
            const checkConflict = (itemId: string, remoteKind: 'overwritten' | 'deleted') => {
                const entry = recent.get(itemId);
                if (!entry) return;
                if (now - entry.at > CONFLICT_WINDOW_MS) return;
                try { onConflictRef.current?.({ kind: remoteKind, itemId }); } catch { /* swallow */ }
            };
            if (action.type === 'UPDATE_ITEM') {
                checkConflict(action.id, 'overwritten');
            } else if (action.type === 'DELETE_ITEMS') {
                for (const id of action.ids) checkConflict(id, 'deleted');
            }
            // Mark + dispatch. The listener below will see __remote and skip.
            (action as any).__remote = true;
            try {
                dispatch(action);
            } catch (err) {
                console.warn('[opSync] failed to apply remote op:', err, action);
            }
        });

        // Phase 7: late-joiner backfill from canvas_ops. On subscribe we
        // pull every op with seq > our high-water mark and apply them.
        // Closes the "joined mid-session, missed the last 60 minutes of
        // edits" gap that pure-broadcast collab can't solve.
        const backfillFromServer = async (): Promise<void> => {
            const cloudApi: any = (window as any).electron?.cloud;
            if (!cloudApi?.pullOps) return;
            try {
                let sinceSeq = loadSeq(blobId);
                // Loop until we get a short page (the server caps at 500
                // per call). For most reconnects this is a single round-trip.
                for (let pages = 0; pages < 50; pages++) {
                    const rows: Array<{ seq: number; device_id: string; op: any }> = await cloudApi.pullOps({ blobId, sinceSeq });
                    if (!Array.isArray(rows) || rows.length === 0) break;
                    for (const row of rows) {
                        // Skip our own historical ops — they're already in
                        // our state from the moment we dispatched them.
                        if (row.device_id === deviceId) {
                            if (row.seq > sinceSeq) sinceSeq = row.seq;
                            continue;
                        }
                        const action = row.op as CanvasAction;
                        if (action && typeof action === 'object' && 'type' in action) {
                            (action as any).__remote = true;
                            try {
                                dispatch(action);
                            } catch (err) {
                                console.warn('[opSync] backfill apply failed:', err, action);
                            }
                        }
                        if (row.seq > sinceSeq) sinceSeq = row.seq;
                    }
                    saveSeq(blobId, sinceSeq);
                    if (rows.length < 500) break;
                }
            } catch (err) {
                // Most likely: not signed in / RLS blocked / network drop.
                // Either way, broadcasting still works — backfill is best-effort.
                console.warn('[opSync] backfill failed (non-fatal):', err);
            }
        };

        channel.subscribe((status) => {
            if (status === 'SUBSCRIBED') {
                connectedRef.current = true;
                // Pull-then-drain order: get the server's view of history
                // first, THEN flush our local queue. This way our queued
                // ops carry higher lamports than anything we just imported.
                void (async () => {
                    await backfillFromServer();
                    await drainQueue();
                })();
            } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
                connectedRef.current = false;
            }
        });

        // Outbound: every local action that's syncable + not flagged remote.
        const unsubscribe = subscribeActions((action) => {
            if ((action as any).__remote) return;
            if (!SYNCABLE_ACTIONS.has(action.type)) return;
            if (!active) return; // background tab — don't broadcast
            // Phase 9: record this edit so an incoming remote op on the
            // same item within CONFLICT_WINDOW_MS can be detected as a
            // conflict. Opportunistically prune entries past the window
            // so the map doesn't grow forever.
            const now = Date.now();
            const recent = recentLocalEditsRef.current;
            for (const [k, v] of recent) {
                if (now - v.at > CONFLICT_WINDOW_MS * 2) recent.delete(k);
            }
            if (action.type === 'UPDATE_ITEM') {
                recent.set(action.id, { at: now, type: 'update' });
            } else if (action.type === 'DELETE_ITEMS') {
                for (const id of action.ids) recent.set(id, { at: now, type: 'delete' });
            }
            const tick = bumpLamport();
            // If not connected, skip the send attempt entirely — go straight
            // to the persistent queue so the drain-on-reconnect path is the
            // only flush. No coalescing here because the queue is the
            // authoritative log; receivers will apply each entry in order.
            if (!connectedRef.current) {
                enqueue({ lamport: tick, action, queuedAt: Date.now() });
                return;
            }
            // Phase 10: buffer the op for coalesced flush. Drag bursts that
            // fire 60Hz UPDATE_ITEM per frame collapse to ~20Hz of "latest
            // value per item" — receivers see smooth motion without us
            // exceeding the broadcast rate limit.
            pushToOutboundBuffer({ lamport: tick, action, queuedAt: Date.now() });
        });

        // Outbound flush buffer + coalesce machinery. Lives inside the
        // effect so it's torn down with the channel.
        const outboundBuffer: QueuedOp[] = [];
        const outboundIndex = new Map<string, number>();  // coalesce key → index in outboundBuffer
        let flushTimer: number | null = null;

        const pushToOutboundBuffer = (q: QueuedOp): void => {
            const coalesceFn = COALESCE_KEYS[q.action.type as CanvasAction['type']];
            if (coalesceFn) {
                const key = coalesceFn(q.action);
                const prevIdx = outboundIndex.get(key);
                if (prevIdx != null && prevIdx < outboundBuffer.length) {
                    // Replace the older entry in-place — keeps overall
                    // ordering stable so unrelated ops between them
                    // (e.g. ADD then UPDATE) preserve their sequence.
                    outboundBuffer[prevIdx] = q;
                } else {
                    outboundIndex.set(key, outboundBuffer.length);
                    outboundBuffer.push(q);
                }
            } else {
                outboundBuffer.push(q);
            }
            if (flushTimer == null) {
                flushTimer = window.setTimeout(() => { flushTimer = null; void flushBuffer(); }, FLUSH_WINDOW_MS);
            }
        };

        const flushBuffer = async (): Promise<void> => {
            if (outboundBuffer.length === 0) return;
            // Snapshot and clear so subsequent enqueues build the next batch.
            const batch = outboundBuffer.slice();
            outboundBuffer.length = 0;
            outboundIndex.clear();
            if (!connectedRef.current) {
                // Lost connection while buffering — push everything to the
                // persistent queue and let the reconnect drain handle it.
                for (const q of batch) enqueue(q);
                return;
            }
            // Send in order. A single send failure pushes the rest to the
            // persistent queue so order is preserved across reconnects.
            for (let i = 0; i < batch.length; i++) {
                const q = batch[i];
                const payload: OpPayload = {
                    device_id: deviceId,
                    lamport: q.lamport,
                    action: q.action,
                };
                try {
                    await channel.send({ type: 'broadcast', event: 'op', payload });
                } catch (err) {
                    console.warn('[opSync] flush send failed; queuing rest:', err);
                    for (let j = i; j < batch.length; j++) enqueue(batch[j]);
                    return;
                }
            }
            // Phase 7: persist successfully-broadcast ops to canvas_ops so
            // future joiners (or this same user reloading later) can
            // backfill via pullOps. Best-effort — failure logs and moves
            // on; broadcast already happened so peers got the live update.
            void persistOpsToServer(batch);
        };

        const persistOpsToServer = async (batch: QueuedOp[]): Promise<void> => {
            const cloudApi: any = (window as any).electron?.cloud;
            if (!cloudApi?.pushOps) return;
            if (batch.length === 0) return;
            try {
                const res = await cloudApi.pushOps({
                    blobId,
                    deviceId,
                    ops: batch.map(q => q.action),
                });
                // Server returns the assigned seqs in order. Track the
                // max as our high-water so backfill on next reconnect
                // doesn't re-pull our own writes.
                if (res?.seqs && Array.isArray(res.seqs) && res.seqs.length > 0) {
                    const max = Math.max(...res.seqs as number[]);
                    if (max > loadSeq(blobId)) saveSeq(blobId, max);
                }
            } catch (err) {
                console.warn('[opSync] pushOps failed (non-fatal — broadcast succeeded):', err);
            }
        };

        return () => {
            unsubscribe();
            channelRef.current = null;
            // Best-effort flush of any pending outbound buffer to the
            // persistent queue so unmount during a drag doesn't drop
            // mid-flight UPDATE_ITEMs.
            if (flushTimer != null) {
                window.clearTimeout(flushTimer);
                flushTimer = null;
            }
            for (const q of outboundBuffer) enqueue(q);
            outboundBuffer.length = 0;
            outboundIndex.clear();
            try { supabase.removeChannel(channel); } catch { /* ignored */ }
        };
    }, [blobId, active, dispatch, subscribeActions]);
}
