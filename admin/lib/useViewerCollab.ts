'use client';

import { useEffect, useRef, useState } from 'react';
import type { RealtimeChannel } from '@supabase/supabase-js';
import { supabase } from './supabase';

// Viewer-side presence hook. Mirrors the desktop's useCanvasCollab but
// anonymous — no auth, no per-user color persistence. Joins the same
// 'klypix-canvas-<blobId>' channel so desktop users see this browser
// session in their presence chips, and vice versa.
//
// Identity for an anonymous viewer is a per-tab generated nickname +
// random user id. Closing the tab leaves the channel automatically.

const CHANNEL_PREFIX = 'klypix-canvas-';

const PEER_COLORS = [
    '#10b981', '#3b82f6', '#f59e0b', '#ec4899',
    '#8b5cf6', '#ef4444', '#06b6d4', '#84cc16',
    '#f97316', '#a855f7', '#14b8a6', '#eab308',
];

function colorForUser(userId: string): string {
    let h = 0;
    for (let i = 0; i < userId.length; i++) h = (h * 31 + userId.charCodeAt(i)) | 0;
    return PEER_COLORS[Math.abs(h) % PEER_COLORS.length];
}

/** Per-tab anonymous identity. Generated once, persists for the
 *  lifetime of the tab (sessionStorage so a refresh keeps you,
 *  but a fresh tab is a new "guest"). */
function getViewerIdentity(): { userId: string; deviceId: string; displayName: string } {
    const KEY = 'klypix:viewer:identity';
    try {
        const raw = sessionStorage.getItem(KEY);
        if (raw) return JSON.parse(raw);
    } catch { /* fresh session */ }
    const id = Math.random().toString(36).slice(2, 10);
    const name = `Guest ${id.slice(0, 4).toUpperCase()}`;
    const identity = {
        userId: `guest_${id}`,
        deviceId: `guest_dev_${id}`,
        displayName: name,
    };
    try { sessionStorage.setItem(KEY, JSON.stringify(identity)); } catch { /* no-op */ }
    return identity;
}

export interface ViewerCollabPeer {
    userId: string;
    deviceId: string;
    displayName: string;
    color: string;
}

interface PresenceRow {
    user_id: string;
    device_id: string;
    display_name: string;
    joined_at: number;
}

export interface UseViewerCollabResult {
    peers: ViewerCollabPeer[];
    connected: boolean;
    selfName: string;
}

/** Subscribe to the canvas's presence channel as an anonymous viewer.
 *  Blob id null/undefined → hook is inert. */
export function useViewerCollab(blobId: string | null | undefined): UseViewerCollabResult {
    const [peers, setPeers] = useState<ViewerCollabPeer[]>([]);
    const [connected, setConnected] = useState(false);
    const identityRef = useRef<{ userId: string; deviceId: string; displayName: string } | null>(null);
    const channelRef = useRef<RealtimeChannel | null>(null);

    // Resolve identity client-side only (sessionStorage is browser-only).
    if (identityRef.current === null && typeof window !== 'undefined') {
        identityRef.current = getViewerIdentity();
    }

    useEffect(() => {
        if (!blobId || !identityRef.current) return;
        const identity = identityRef.current;
        const channelName = `${CHANNEL_PREFIX}${blobId}`;

        const channel = supabase.channel(channelName, {
            config: {
                presence: { key: identity.deviceId },
                broadcast: { self: false, ack: false },
            },
        });
        channelRef.current = channel;

        const refresh = () => {
            const state = channel.presenceState() as Record<string, PresenceRow[]>;
            const flat: ViewerCollabPeer[] = [];
            for (const slot of Object.values(state)) {
                for (const row of slot) {
                    if (!row || typeof row !== 'object') continue;
                    if (row.device_id === identity.deviceId) continue;
                    flat.push({
                        userId: row.user_id,
                        deviceId: row.device_id,
                        displayName: row.display_name,
                        color: colorForUser(row.user_id),
                    });
                }
            }
            setPeers(flat);
        };

        channel
            .on('presence', { event: 'sync' }, refresh)
            .on('presence', { event: 'join' }, refresh)
            .on('presence', { event: 'leave' }, refresh)
            .subscribe(async status => {
                if (status === 'SUBSCRIBED') {
                    setConnected(true);
                    await channel.track({
                        user_id: identity.userId,
                        device_id: identity.deviceId,
                        display_name: identity.displayName,
                        joined_at: Date.now(),
                    } satisfies PresenceRow);
                } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
                    setConnected(false);
                }
            });

        return () => {
            channelRef.current = null;
            try { channel.untrack(); } catch { /* ignored */ }
            try { supabase.removeChannel(channel); } catch { /* ignored */ }
            setConnected(false);
            setPeers([]);
        };
    }, [blobId]);

    return {
        peers,
        connected,
        selfName: identityRef.current?.displayName || 'Guest',
    };
}
