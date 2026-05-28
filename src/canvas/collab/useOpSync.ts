import { useEffect, useRef } from 'react';
import type { RealtimeChannel } from '@supabase/supabase-js';
import { acquireCanvasChannel } from './channelRegistry';
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
// Phase 14: same channel as presence + cursors via the channelRegistry
// shared-channel model — one underlying subscription handles everything
// (presence, cursors, ops, assets) so broadcast delivery is consistent.

// Action types that mutate persistent state and should be broadcast.
// Anything not listed here stays local. Update this list if you add a
// new mutating reducer action.
const SYNCABLE_ACTIONS = new Set<CanvasAction['type']>([
    'ADD_ITEM',
    'UPDATE_ITEM',
    'UPDATE_ITEMS_BULK',
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

export interface UseOpSyncArgs {
    blobId: string | null | undefined;
    /** Tab visibility / canvas mode active. When false we still RECEIVE
     *  remote ops (so the local state stays current) but we stop sending
     *  to avoid background tabs spamming the channel. */
    active: boolean;
    /** True when the user is signed in. When false, we still broadcast over
     *  Realtime and queue offline ops, but skip the canvas_ops REST
     *  reads/writes (pullOps/pushOps) — those would only return
     *  CLOUD_AUTH_REQUIRED noise in the console. */
    authed: boolean;
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
    // UPDATE_ITEMS_BULK: each frame of a multi-drag/multi-rotate emits one
    // of these covering the same N items. Coalescing key is the SORTED set
    // of ids it touches — so successive frames replace each other in the
    // outbound buffer just like UPDATE_ITEM does per-id.
    UPDATE_ITEMS_BULK: (a) => {
        const upd = (a as { type: 'UPDATE_ITEMS_BULK'; updates: Array<{ id: string }> }).updates;
        return 'UPDATE_ITEMS_BULK:' + upd.map(u => u.id).sort().join(',');
    },
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
export function useOpSync({ blobId, active, authed, onConflict }: UseOpSyncArgs): void {
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
    const recentLocalEditsRef = useRef<Map<string, { at: number; type: 'update' | 'delete'; fields?: Set<string> }>>(new Map());
    const onConflictRef = useRef(onConflict);
    onConflictRef.current = onConflict;
    // Mirror authed into a ref so the cloudApi guards inside the effect see
    // the live signed-in state without remounting the channel on every
    // sign-in / sign-out (which would tear down Realtime mid-session).
    const authedRef = useRef(authed);
    authedRef.current = authed;

    useEffect(() => {
        if (!blobId) return;
        let cancelled = false;

        // Hydrate lamport from persisted value so a fresh tab continues
        // from where the previous session left off.
        lamportRef.current = Math.max(lamportRef.current, loadLamport(blobId));

        // Phase 22.5: debounced persistence to take synchronous localStorage
        // writes off the keystroke hot path. Each UPDATE_ITEM previously
        // bumped lamport AND (if offline) re-serialized the entire op queue
        // — 1–5 ms of main-thread blocking I/O PER KEYSTROKE. On battery the
        // disk slows further; typing felt visibly laggy.
        //
        // Now we keep both in memory and flush at most every 500 ms.
        // Worst-case loss on hard crash: 500 ms of lamport progression
        // (self-heals on first inbound remote op via the existing
        // `if (p.lamport > lamportRef.current)` clamp) + up to ~5–10 chars
        // of queued work — acceptable tradeoff for ~50 ms/sec of main
        // thread reclaimed. The beforeunload handler flushes synchronously
        // so normal window close still persists everything.
        const PERSIST_DEBOUNCE_MS = 500;

        // Lamport debounce. lamportRef itself stays authoritative in memory.
        let lamportSaveTimer: number | null = null;
        let lamportDirty = false;
        const scheduleLamportSave = () => {
            lamportDirty = true;
            if (lamportSaveTimer != null) return;
            lamportSaveTimer = window.setTimeout(() => {
                lamportSaveTimer = null;
                if (lamportDirty) {
                    saveLamport(blobId, lamportRef.current);
                    lamportDirty = false;
                }
            }, PERSIST_DEBOUNCE_MS);
        };
        const flushLamportNow = () => {
            if (lamportSaveTimer != null) {
                window.clearTimeout(lamportSaveTimer);
                lamportSaveTimer = null;
            }
            if (lamportDirty) {
                saveLamport(blobId, lamportRef.current);
                lamportDirty = false;
            }
        };

        // Offline queue cache. Single load on mount; every enqueue/drain
        // mutates the in-memory array and schedules a debounced flush.
        // Persisted form on disk catches up at most PERSIST_DEBOUNCE_MS late.
        const queueCache: QueuedOp[] = loadQueue(blobId);
        let queueSaveTimer: number | null = null;
        let queueDirty = false;
        const scheduleQueueSave = () => {
            queueDirty = true;
            if (queueSaveTimer != null) return;
            queueSaveTimer = window.setTimeout(() => {
                queueSaveTimer = null;
                if (queueDirty) {
                    saveQueue(blobId, queueCache);
                    queueDirty = false;
                }
            }, PERSIST_DEBOUNCE_MS);
        };
        const flushQueueNow = () => {
            if (queueSaveTimer != null) {
                window.clearTimeout(queueSaveTimer);
                queueSaveTimer = null;
            }
            if (queueDirty) {
                saveQueue(blobId, queueCache);
                queueDirty = false;
            }
        };

        // Synchronous flush on page-hide / unload so a tab close doesn't
        // strand pending writes. The pagehide event fires reliably across
        // all unmount paths Electron uses (window close, app quit, F5).
        const beforeUnload = () => {
            flushLamportNow();
            flushQueueNow();
        };
        window.addEventListener('pagehide', beforeUnload);
        window.addEventListener('beforeunload', beforeUnload);

        const bumpLamport = (): number => {
            lamportRef.current += 1;
            scheduleLamportSave();
            return lamportRef.current;
        };

        const enqueue = (q: QueuedOp): void => {
            queueCache.push(q);
            scheduleQueueSave();
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
                    // Read + mutate the in-memory cache directly — no more
                    // per-op localStorage round-trip. The debounced save
                    // covers durability.
                    if (queueCache.length === 0) break;
                    const head = queueCache[0];
                    const channel = channelRef.current;
                    if (!channel) break;
                    try {
                        await channel.send({
                            type: 'broadcast',
                            event: 'op',
                            payload: { device_id: deviceId, lamport: head.lamport, action: head.action } satisfies OpPayload,
                        });
                        // Successful send — pop the head and schedule a save.
                        queueCache.shift();
                        scheduleQueueSave();
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
            if (!authedRef.current) return; // skip REST writes when signed out
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

        // Phase 14: acquire the shared canvas channel via the registry.
        // useCanvasCollab + useAssetSync use the SAME channel via the same
        // registry call, so broadcasts hit one shared subscription instead
        // of competing across three channel objects (was the root cause of
        // the "items not syncing across PCs" bug in the real two-PC test).
        const onStatus = (status: string) => {
            if (cancelled) return;
            if (status === 'SUBSCRIBED') {
                connectedRef.current = true;
                // Pull-then-drain order: get the server's view of history
                // first, THEN flush our local queue. This way our queued
                // ops carry higher lamports than anything we just imported.
                // queueMicrotask defers past the synchronous tail of this
                // useEffect so backfillFromServer/drainQueue (defined below)
                // are in scope — required because the registry fires this
                // callback synchronously when the channel is already
                // subscribed by another hook.
                queueMicrotask(() => {
                    if (cancelled) return;
                    void (async () => {
                        if (cancelled) return;
                        await backfillFromServer();
                        if (cancelled) return;
                        await drainQueue();
                    })();
                });
            } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
                connectedRef.current = false;
            }
        };
        const acquired = acquireCanvasChannel(blobId, onStatus);
        const channel = acquired.channel;
        const deviceId = acquired.deviceId;
        channelRef.current = channel;

        // Inbound op handler: parse + apply via wrapped dispatch. We tag
        // the action with `__remote: true` so the outbound listener below
        // can skip it (preventing a re-broadcast loop). The reducer
        // ignores the tag — it's a passthrough marker only the listener
        // checks.
        channel.on('broadcast', { event: 'op' }, (msg: any) => {
            if (cancelled) return;
            const p = msg?.payload as OpPayload | undefined;
            if (!p || typeof p.device_id !== 'string') return;
            if (p.device_id === deviceId) return; // self-echo guard
            // Bump our lamport beyond what we've seen so subsequent local
            // sends carry a higher tick. Schedule a debounced save so the
            // 500ms persistence cadence applies here too — a crash inside
            // the window self-heals on the next remote op clamp anyway.
            if (typeof p.lamport === 'number' && p.lamport > lamportRef.current) {
                lamportRef.current = p.lamport;
                scheduleLamportSave();
            }
            const action = p.action as CanvasAction;
            if (!action || typeof action !== 'object' || !('type' in action)) return;
            // Conflict detection (Phase 9, refined 2026-05-28): only flag
            // a conflict when the remote op touches the SAME FIELD as our
            // recent local edit — not when both clients are editing the
            // same item from different angles (e.g. local moves it while
            // peer types in it). Previous "any touch = conflict" produced
            // dozens of false positives during normal concurrent work and
            // drowned out the rare real-conflict signal.
            const now = Date.now();
            const recent = recentLocalEditsRef.current;
            const checkConflict = (
                itemId: string,
                remoteKind: 'overwritten' | 'deleted',
                remotePatchKeys?: ReadonlyArray<string>,
            ) => {
                const entry = recent.get(itemId);
                if (!entry) return;
                if (now - entry.at > CONFLICT_WINDOW_MS) return;
                // Deletes are always-conflict (the whole item is gone, not
                // just a field). For UPDATE overwrites, require at least one
                // overlapping field between local + remote patches.
                if (remoteKind === 'overwritten' && entry.fields && remotePatchKeys) {
                    const overlap = remotePatchKeys.some(k => entry.fields!.has(k));
                    if (!overlap) return;
                }
                try { onConflictRef.current?.({ kind: remoteKind, itemId }); } catch { /* swallow */ }
            };
            if (action.type === 'UPDATE_ITEM') {
                const patch = (action as any).patch;
                const keys = patch && typeof patch === 'object' ? Object.keys(patch) : [];
                checkConflict(action.id, 'overwritten', keys);
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
            if (!authedRef.current) return; // skip REST reads when signed out
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

        // Note: channel.subscribe() is called ONCE inside acquireCanvasChannel;
        // we get state changes via the onStatus handler captured above.

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
                // Track which FIELDS we just touched, so conflict detection
                // can ignore peer ops that touch DIFFERENT fields on the
                // same item (e.g. peer types text while we move the item).
                const patch = (action as any).patch;
                const fields = patch && typeof patch === 'object'
                    ? new Set<string>(Object.keys(patch))
                    : undefined;
                recent.set(action.id, { at: now, type: 'update', fields });
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
            if (!authedRef.current) return; // skip REST writes when signed out
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
            cancelled = true;
            unsubscribe();
            window.removeEventListener('pagehide', beforeUnload);
            window.removeEventListener('beforeunload', beforeUnload);
            channelRef.current = null;
            connectedRef.current = false;
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
            // Phase 22.5: flush both debounced caches synchronously so a
            // blob switch or unmount doesn't strand lamport/queue progress
            // in the pending-write window.
            flushLamportNow();
            flushQueueNow();
            // Release our refCount on the shared channel — the registry
            // tears the channel down when refCount hits 0.
            acquired.release();
        };
    }, [blobId, active, dispatch, subscribeActions]);
}
