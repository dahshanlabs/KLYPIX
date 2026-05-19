import React, { useEffect, useRef, useState } from 'react';
import type { CollabPeer } from './useCanvasCollab';
import { useCanvasStore } from '../state/canvasStore';

interface Props {
    peers: CollabPeer[];
    /** Current view zoom — cursor + label scale with the canvas so they
     *  stay readable across zoom levels. We render the actual SVG at
     *  fixed screen size by inverse-scaling here; the parent wrapper
     *  (CanvasRenderer's world layer) handles pan/zoom positioning. */
    viewZoom: number;
}

/** A single SVG cursor arrow at world (cursorX, cursorY) with a name label.
 *  Uses a smoothed-position ref so the cursor lerps between received
 *  positions instead of teleporting at the 30Hz broadcast rate — looks
 *  more alive without bumping the network rate. */
function PeerCursor({ peer, viewZoom }: { peer: CollabPeer; viewZoom: number }) {
    const targetX = peer.cursorX!;
    const targetY = peer.cursorY!;
    const [pos, setPos] = useState({ x: targetX, y: targetY });
    const targetRef = useRef({ x: targetX, y: targetY });
    targetRef.current = { x: targetX, y: targetY };
    const rafRef = useRef<number | null>(null);
    const posRef = useRef({ x: targetX, y: targetY });
    posRef.current = pos;

    useEffect(() => {
        // Lerp toward target every frame. Stop the rAF loop when we've
        // converged closely enough — saves battery when peers idle.
        const tick = () => {
            const cur = posRef.current;
            const tgt = targetRef.current;
            const dx = tgt.x - cur.x;
            const dy = tgt.y - cur.y;
            const dist2 = dx * dx + dy * dy;
            if (dist2 < 0.25) {
                // Snap close enough; idle until next render kick.
                rafRef.current = null;
                if (cur.x !== tgt.x || cur.y !== tgt.y) setPos({ x: tgt.x, y: tgt.y });
                return;
            }
            // 0.35 = ~half-life of ~2 frames at 60fps; feels snappy without overshooting.
            const next = { x: cur.x + dx * 0.35, y: cur.y + dy * 0.35 };
            setPos(next);
            rafRef.current = requestAnimationFrame(tick);
        };
        if (rafRef.current == null) rafRef.current = requestAnimationFrame(tick);
        return () => {
            if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
            rafRef.current = null;
        };
    }, [targetX, targetY]);

    // Inverse-scale by viewZoom so the cursor stays a constant size on
    // screen regardless of canvas zoom. Clamp to [0.5, 4] world-units
    // per screen-px so it stays usable at the extremes.
    const inv = 1 / Math.max(0.25, Math.min(4, viewZoom));
    const ARROW_SIZE = 16 * inv;
    const PADDING = 4 * inv;
    const LABEL_FONT = 11 * inv;

    return (
        <div
            style={{
                position: 'absolute',
                left: pos.x,
                top: pos.y,
                pointerEvents: 'none',
                // Don't transition — the lerp loop handles the smoothing.
                // CSS transitions on left/top would fight the rAF updates.
                zIndex: 1000,
                userSelect: 'none',
            }}
        >
            {/* Arrow — SVG inline so we can stroke + fill in the peer color
                without needing a per-color asset. Pointed top-left so the
                tip sits exactly at (pos.x, pos.y). */}
            <svg
                width={ARROW_SIZE}
                height={ARROW_SIZE}
                viewBox="0 0 16 16"
                style={{ display: 'block', filter: 'drop-shadow(0 1px 2px rgba(0,0,0,0.4))' }}
            >
                <path
                    d="M2 2 L2 13 L5.5 10 L8.5 14 L10.5 13 L7.5 9 L12 8.5 Z"
                    fill={peer.color}
                    stroke="white"
                    strokeWidth={1}
                    strokeLinejoin="round"
                />
            </svg>
            {/* Name label — offset so the arrow stays the focal point. */}
            <div
                style={{
                    position: 'absolute',
                    left: ARROW_SIZE * 0.7,
                    top: ARROW_SIZE * 0.7,
                    background: peer.color,
                    color: 'white',
                    fontSize: LABEL_FONT,
                    fontFamily: 'Thmanyah Sans, system-ui, sans-serif',
                    fontWeight: 500,
                    padding: `${PADDING * 0.6}px ${PADDING * 1.4}px`,
                    borderRadius: PADDING * 1.5,
                    whiteSpace: 'nowrap',
                    boxShadow: '0 2px 6px rgba(0,0,0,0.3)',
                }}
            >
                {peer.displayName}
            </div>
        </div>
    );
}

/** Render every peer's cursor that's currently fresh (has cursorX/Y +
 *  cursorAt within the stale window — the hook filters those out before
 *  exposing them to us, so any peer here with cursor coords is current). */
export function RemoteCursors({ peers, viewZoom }: Props) {
    const cursored = peers.filter(p => p.cursorX != null && p.cursorY != null);
    if (cursored.length === 0) return null;
    return (
        <>
            {cursored.map(p => (
                <PeerCursor key={`${p.userId}::${p.deviceId}`} peer={p} viewZoom={viewZoom} />
            ))}
        </>
    );
}

/** Per-peer selection halos — colored outlines drawn around items each
 *  peer has selected. Lives inside the world transform so the rectangles
 *  pan/zoom with the canvas. Renders nothing for peers with no selection
 *  or for selections that reference items no longer in the local state. */
export function RemoteSelectionHalos({ peers, viewZoom }: { peers: CollabPeer[]; viewZoom: number }) {
    const { state } = useCanvasStore();
    const haloed: { peer: CollabPeer; rects: { id: string; x: number; y: number; w: number; h: number }[] }[] = [];
    for (const peer of peers) {
        const ids = peer.selectionIds;
        if (!ids || ids.length === 0) continue;
        const rects: { id: string; x: number; y: number; w: number; h: number }[] = [];
        for (const id of ids) {
            const item = state.items[id] as any;
            if (!item) continue;
            rects.push({ id, x: item.x, y: item.y, w: item.w, h: item.h });
        }
        if (rects.length > 0) haloed.push({ peer, rects });
    }
    if (haloed.length === 0) return null;
    // Stroke + offset stay constant in screen pixels regardless of zoom.
    const strokePx = 2 / Math.max(0.25, Math.min(4, viewZoom));
    const inset = -strokePx;  // halo lives just OUTSIDE the item border
    return (
        <>
            {haloed.flatMap(({ peer, rects }) => rects.map(r => (
                <div
                    key={`halo-${peer.deviceId}-${r.id}`}
                    style={{
                        position: 'absolute',
                        left: r.x + inset,
                        top: r.y + inset,
                        width: r.w - 2 * inset,
                        height: r.h - 2 * inset,
                        border: `${strokePx}px solid ${peer.color}`,
                        borderRadius: 4 / Math.max(0.25, viewZoom),
                        pointerEvents: 'none',
                        boxShadow: `0 0 ${8 / viewZoom}px ${peer.color}55`,
                    }}
                />
            )))}
        </>
    );
}
