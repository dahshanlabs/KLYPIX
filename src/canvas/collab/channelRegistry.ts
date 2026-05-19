import type { RealtimeChannel } from '@supabase/supabase-js';
import { getRealtimeClient } from './supabaseRealtimeClient';

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
        const channel = supabase.channel(channelName, {
            config: {
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
        channel.subscribe((status) => {
            localEntry.currentStatus = status;
            for (const cb of localEntry.statusListeners) {
                try { cb(status); } catch { /* swallow per-listener errors */ }
            }
        });
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
