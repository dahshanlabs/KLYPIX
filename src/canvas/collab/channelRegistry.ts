import type { RealtimeChannel } from '@supabase/supabase-js';
import { getRealtimeClient, isCollabPrivateChannels, primeRealtimeAuth } from './supabaseRealtimeClient';

// Phase 14: ONE Supabase Realtime channel per (blob_id), shared across all
// collab hooks (useCanvasCollab + useOpSync + useAssetSync).
//
// WHY THIS EXISTS
// Each of the 3 hooks used to call `supabase.channel('klypix-canvas-<id>')`
// independently, getting back 3 different channel objects on the same
// topic. Supabase Realtime v2 allows this but the message delivery to
// the right channel object isn't strictly guaranteed — broadcasts could
// land on one channel's listeners but not the others, manifesting as
// "items dropped on this user's screen don't appear on my screen" in
// real two-PC testing.
//
// HOW IT WORKS
// - acquireCanvasChannel(blobId, statusCb?) bumps a refCount. First call
//   creates + subscribes the channel; later calls share it.
// - release() decrements; channel is removed when refCount hits 0.
// - statusCb is per-acquire, so each hook hears subscribe/disconnect
//   events independently. New subscribers get an immediate callback with
//   the current status if the channel is already subscribed (no need to
//   wait for the next SUBSCRIBED event).
//
// LISTENERS
// Each consumer calls channel.on(...) to register its broadcast handlers.
// Those handlers must capture a `cancelled` flag in closure so they can
// no-op cleanly after teardown — there's no per-hook .off() pattern in
// supabase-js v2 (channel.unsubscribe() would tear down everyone's
// listeners since they all share this channel).

interface ChannelEntry {
    channel: RealtimeChannel;
    refCount: number;
    statusListeners: Set<(status: string) => void>;
    deviceId: string;
    currentStatus: string | null;
    /** Cancels any pending auto-reconnect (set up in acquireCanvasChannel,
     *  called on release so a deliberate teardown doesn't reconnect). */
    clearReconnect?: () => void;
}

const channels = new Map<string, ChannelEntry>();

/** Per-device id used as the presence key + self-echo guard. Generated
 *  lazily and persisted to localStorage so the same browser tab keeps
 *  the same id across reloads. Shared by all collab subsystems for
 *  consistent identity. */
export function getCollabDeviceId(): string {
    const KEY = 'klypix:collab:deviceId';
    let id = localStorage.getItem(KEY);
    if (!id) {
        id = 'cdev_' + Math.random().toString(36).slice(2) + Date.now().toString(36);
        localStorage.setItem(KEY, id);
    }
    return id;
}

export interface AcquiredChannel {
    channel: RealtimeChannel;
    deviceId: string;
    /** Call this when the consumer is done with the channel. Decrements the
     *  refCount; the channel is fully torn down (untrack + removeChannel)
     *  when the count hits zero. */
    release: () => void;
}

/**
 * Get-or-create the canonical channel for a canvas blob.
 *
 * @param blobId   The canvas's blob id (from cloudShare.blobId).
 * @param statusCb Optional callback that fires on subscribe state changes.
 *                 Receives 'SUBSCRIBED' | 'CHANNEL_ERROR' | 'TIMED_OUT'
 *                 | 'CLOSED'. Fired IMMEDIATELY with currentStatus if the
 *                 channel was already subscribed when this hook acquires.
 */
export function acquireCanvasChannel(blobId: string, statusCb?: (status: string) => void): AcquiredChannel {
    let entry = channels.get(blobId);
    if (!entry) {
        const supabase = getRealtimeClient();
        const channelName = `klypix-canvas-${blobId}`;
        const deviceId = getCollabDeviceId();
        // Private mode (Phase C) is OFF by default — `private: false` is
        // identical to the legacy public channel. When enabled, RLS on
        // realtime.messages gates join/broadcast to canvas members.
        const usePrivate = isCollabPrivateChannels();
        const channel = supabase.channel(channelName, {
            config: {
                private: usePrivate,
                presence: { key: deviceId },
                broadcast: { self: false, ack: false },
            },
        });
        entry = {
            channel,
            refCount: 0,
            statusListeners: new Set<(status: string) => void>(),
            deviceId,
            currentStatus: null,
        };
        channels.set(blobId, entry);
        // Subscribe ONCE — all consumers share this single subscription.
        const localEntry = entry;
        let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
        let attempt = 0;
        localEntry.clearReconnect = () => { if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; } };
        const onStatus = (status: string) => {
            localEntry.currentStatus = status;
            if (status === 'SUBSCRIBED') attempt = 0;
            // supabase-js does NOT auto-rejoin after a channel error/close. Without
            // this the channel stays dark forever: op-sync may limp on, but presence
            // /cursors vanish (observed: a peer with a stale realtime token hit
            // CHANNEL_ERROR → CLOSED and never came back). Re-subscribe the SAME
            // channel (its .on bindings persist) with capped backoff — but ONLY while
            // this entry is still the live, referenced one, so a deliberate release
            // (refCount 0 / entry replaced) never triggers a phantom reconnect.
            if ((status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED')
                && channels.get(blobId) === localEntry && localEntry.refCount > 0 && !reconnectTimer) {
                const delay = Math.min(1000 * 2 ** attempt, 15000);
                attempt++;
                reconnectTimer = setTimeout(() => {
                    reconnectTimer = null;
                    if (channels.get(blobId) !== localEntry || localEntry.refCount <= 0) return;
                    try { localEntry.channel.subscribe(onStatus); } catch { /* will retry on next status */ }
                }, delay);
            }
            for (const cb of localEntry.statusListeners) {
                try { cb(status); } catch { /* swallow per-listener errors */ }
            }
        };
        const doSubscribe = () => channel.subscribe(onStatus);
        if (usePrivate) {
            // Private channels need a valid JWT applied to the Realtime client
            // BEFORE subscribe so RLS resolves auth.uid(). Prime it first, then
            // subscribe (consumers attach their .on handlers to the returned
            // channel meanwhile — handlers registered pre-subscribe are fine).
            primeRealtimeAuth().finally(doSubscribe);
        } else {
            doSubscribe();
        }
    }
    entry.refCount++;
    if (statusCb) {
        entry.statusListeners.add(statusCb);
        // Fire immediately if the channel is already in a known state, so
        // a hook acquiring AFTER subscribe doesn't sit waiting forever for
        // an event that already happened.
        if (entry.currentStatus) {
            try { statusCb(entry.currentStatus); } catch { /* swallow */ }
        }
    }
    const release = () => {
        const e = channels.get(blobId);
        if (!e) return;
        if (statusCb) e.statusListeners.delete(statusCb);
        e.refCount--;
        if (e.refCount <= 0) {
            e.clearReconnect?.();   // stop any pending reconnect before teardown
            try { e.channel.untrack(); } catch { /* ignored */ }
            try { getRealtimeClient().removeChannel(e.channel); } catch { /* ignored */ }
            channels.delete(blobId);
        }
    };
    return {
        channel: entry.channel,
        deviceId: entry.deviceId,
        release,
    };
}
