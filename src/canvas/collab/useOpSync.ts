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

/**
 * Connects the canvas store's action stream to a Supabase Realtime
 * channel. Sends syncable actions outbound; applies inbound ops via the
 * normal dispatch path so the reducer is a single source of truth for
 * how state changes (no parallel "apply remote" code path that could
 * drift from the local one).
 */
export function useOpSync({ blobId, active }: UseOpSyncArgs): void {
    const { dispatch, subscribeActions } = useCanvasStore();
    const channelRef = useRef<RealtimeChannel | null>(null);
    // Lamport clock — bumped on every send AND on every received op so it
    // tracks the highest tick we've seen. Carried in OpPayload.lamport for
    // future per-item LWW; not used for ordering decisions yet.
    const lamportRef = useRef(0);

    useEffect(() => {
        if (!blobId) return;
        const supabase = getRealtimeClient();
        const channelName = `${CHANNEL_PREFIX}${blobId}`;
        const deviceId = getDeviceId();

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
            // sends carry a higher tick.
            if (typeof p.lamport === 'number' && p.lamport > lamportRef.current) {
                lamportRef.current = p.lamport;
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

        channel.subscribe();

        // Outbound: every local action that's syncable + not flagged remote.
        const unsubscribe = subscribeActions((action) => {
            if ((action as any).__remote) return;
            if (!SYNCABLE_ACTIONS.has(action.type)) return;
            if (!active) return; // background tab — don't broadcast
            lamportRef.current += 1;
            const payload: OpPayload = {
                device_id: deviceId,
                lamport: lamportRef.current,
                action,
            };
            channel.send({
                type: 'broadcast',
                event: 'op',
                payload,
            }).catch((err: unknown) => {
                console.warn('[opSync] send failed:', err);
            });
        });

        return () => {
            unsubscribe();
            channelRef.current = null;
            try { supabase.removeChannel(channel); } catch { /* ignored */ }
        };
    }, [blobId, active, dispatch, subscribeActions]);
}
