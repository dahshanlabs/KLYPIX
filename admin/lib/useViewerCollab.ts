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
    cursorX?: number;
    cursorY?: number;
    cursorAt?: number;
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
    /** Broadcast this viewer's cursor (in canvas WORLD coords) so the desktop
     *  shows the viewer's pointer. Throttled internally; safe to call on
     *  every pointermove. Pass null when cursor leaves the canvas. */
    publishCursor: (world: { x: number; y: number } | null) => void;
}

const CURSOR_THROTTLE_MS = 33;
const CURSOR_STALE_MS = 5000;

/** Subscribe to the canvas's presence channel as an anonymous viewer.
 *  Blob id null/undefined → hook is inert. */
export function useViewerCollab(blobId: string | null | undefined): UseViewerCollabResult {
    const [peers, setPeers] = useState<ViewerCollabPeer[]>([]);
    const [connected, setConnected] = useState(false);
    const identityRef = useRef<{ userId: string; deviceId: string; displayName: string } | null>(null);
    const channelRef = useRef<RealtimeChannel | null>(null);
    const cursorLastPublishRef = useRef(0);
    const cursorQueuedRef = useRef<{ x: number; y: number } | null | undefined>(undefined);
    const cursorTimerRef = useRef<number | null>(null);

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

        // Ephemeral state per peer (cursor positions) — merged into peers
        // on every render schedule.
        const ephemeral = new Map<string, { cursorX?: number; cursorY?: number; cursorAt?: number }>();
        let raf = false;
        const scheduleRender = () => {
            if (raf) return;
            raf = true;
            requestAnimationFrame(() => { raf = false; refresh(); });
        };

        const refresh = () => {
            const state = channel.presenceState() as Record<string, PresenceRow[]>;
            const flat: ViewerCollabPeer[] = [];
            const now = Date.now();
            for (const slot of Object.values(state)) {
                for (const row of slot) {
                    if (!row || typeof row !== 'object') continue;
                    if (row.device_id === identity.deviceId) continue;
                    const eph = ephemeral.get(row.device_id);
                    const cursorFresh = eph?.cursorAt && (now - eph.cursorAt) < CURSOR_STALE_MS;
                    flat.push({
                        userId: row.user_id,
                        deviceId: row.device_id,
                        displayName: row.display_name,
                        color: colorForUser(row.user_id),
                        cursorX: cursorFresh ? eph?.cursorX : undefined,
                        cursorY: cursorFresh ? eph?.cursorY : undefined,
                        cursorAt: cursorFresh ? eph?.cursorAt : undefined,
                    });
                }
            }
            setPeers(flat);
        };

        channel
            .on('presence', { event: 'sync' }, refresh)
            .on('presence', { event: 'join' }, refresh)
            .on('presence', { event: 'leave' }, refresh)
            .on('broadcast', { event: 'cursor' }, (msg: any) => {
                const p = msg?.payload;
                if (!p || typeof p.device_id !== 'string') return;
                if (p.device_id === identity.deviceId) return;
                const prev = ephemeral.get(p.device_id) || {};
                if (p.x == null || p.y == null) {
                    ephemeral.set(p.device_id, { ...prev, cursorX: undefined, cursorY: undefined, cursorAt: undefined });
                } else {
                    ephemeral.set(p.device_id, { ...prev, cursorX: p.x, cursorY: p.y, cursorAt: Date.now() });
                }
                scheduleRender();
            })
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

        const staleSweep = window.setInterval(() => {
            const now = Date.now();
            let needs = false;
            for (const eph of ephemeral.values()) {
                if (eph.cursorAt && (now - eph.cursorAt) >= CURSOR_STALE_MS) { needs = true; break; }
            }
            if (needs) refresh();
        }, 2000);

        return () => {
            channelRef.current = null;
            window.clearInterval(staleSweep);
            try { channel.untrack(); } catch { /* ignored */ }
            try { supabase.removeChannel(channel); } catch { /* ignored */ }
            setConnected(false);
            setPeers([]);
        };
    }, [blobId]);

    const publishCursor = (world: { x: number; y: number } | null): void => {
        const channel = channelRef.current;
        const identity = identityRef.current;
        if (!channel || !identity) return;
        cursorQueuedRef.current = world;
        const now = Date.now();
        const sinceLast = now - cursorLastPublishRef.current;
        if (sinceLast >= CURSOR_THROTTLE_MS) {
            cursorLastPublishRef.current = now;
            const payload = cursorQueuedRef.current;
            cursorQueuedRef.current = undefined;
            channel.send({
                type: 'broadcast',
                event: 'cursor',
                payload: { device_id: identity.deviceId, x: payload?.x ?? null, y: payload?.y ?? null },
            });
            return;
        }
        if (cursorTimerRef.current != null) return;
        cursorTimerRef.current = window.setTimeout(() => {
            cursorTimerRef.current = null;
            const ch = channelRef.current;
            if (!ch) return;
            cursorLastPublishRef.current = Date.now();
            const payload = cursorQueuedRef.current;
            cursorQueuedRef.current = undefined;
            ch.send({
                type: 'broadcast',
                event: 'cursor',
                payload: { device_id: identity.deviceId, x: payload?.x ?? null, y: payload?.y ?? null },
            });
        }, CURSOR_THROTTLE_MS - sinceLast);
    };

    return {
        peers,
        connected,
        selfName: identityRef.current?.displayName || 'Guest',
        publishCursor,
    };
}
