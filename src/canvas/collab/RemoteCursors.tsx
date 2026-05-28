import React, { useEffect, useRef, useState } from 'react';
import type { CollabPeer } from './useCanvasCollab';
import { useCanvasStore } from '../state/canvasStore';
import { worldToScreen } from '../CanvasEngine';
import type { ViewState } from '../items/types';

interface Props {
    peers: CollabPeer[];
    /** Full viewport state — used to project each peer's world-space cursor
     *  to screen coords every render via worldToScreen(). Single source of
     *  truth for {zoom, panX, panY}; no separately-stored screen offset. */
    view: ViewState;
}

/** A single SVG cursor arrow whose ANCHOR is stored in world coords and
 *  projected to screen space on every render via worldToScreen(view).
 *  Lives in the screen-space overlay layer (sibling of the selection-ring
 *  overlay), so it does NOT inherit the canvas's CSS transform — zoom
 *  reprojection happens through the projection helper, not via a parent
 *  transform.
 *
 *  Uses a smoothed-position ref so the cursor lerps between received
 *  positions instead of teleporting at the 30Hz broadcast rate. */
function PeerCursor({ peer, view }: { peer: CollabPeer; view: ViewState }) {
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

    // Project world → screen via the shared helper. Single source of truth
    // for {zoom, panX, panY} — same projection the per-item selection rings
    // use, so the cursor and ring layers can't disagree on where world
    // coords land on screen.
    const screen = worldToScreen(pos, view);

    // Screen-space chrome — fixed pixels, no inverse-scale clamp. Living
    // outside the world transform means we don't have to counter-scale to
    // stay readable.
    const ARROW_SIZE = 16;
    const PADDING = 4;
    const LABEL_FONT = 11;

    // Phase 15: dev-only debug badge — flip on with
    // localStorage['klypix:debugCursor'] = '1' to see the raw world coord
    // the peer is broadcasting. Pair with the [cursor.in]/[cursor.out]
    // console logs to verify the two PCs agree on coordinates.
    const debugCursor = typeof window !== 'undefined' && localStorage.getItem('klypix:debugCursor') === '1';

    return (
        <div
            style={{
                position: 'absolute',
                left: screen.x,
                top: screen.y,
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
                {debugCursor && (
                    <span style={{ marginLeft: PADDING, opacity: 0.85, fontFamily: 'monospace', fontWeight: 400 }}>
                        {Math.round(pos.x)},{Math.round(pos.y)}
                    </span>
                )}
            </div>
        </div>
    );
}

/** Render every peer's cursor that's currently fresh (has cursorX/Y +
 *  cursorAt within the stale window — the hook filters those out before
 *  exposing them to us, so any peer here with cursor coords is current). */
export function RemoteCursors({ peers, view }: Props) {
    const cursored = peers.filter(p => p.cursorX != null && p.cursorY != null);
    if (cursored.length === 0) return null;
    return (
        <>
            {cursored.map(p => (
                <PeerCursor key={`${p.userId}::${p.deviceId}`} peer={p} view={view} />
            ))}
        </>
    );
}

/** Per-peer selection halos — colored outlines drawn around items each
 *  peer has selected. Lives inside the world transform so the rectangles
 *  pan/zoom with the canvas. Renders nothing for peers with no selection
 *  or for selections that reference items no longer in the local state. */
/**
 * Phase 23.x: soft-lock visual indicator. Each item in canvasState.peerLocks
 * gets a small "🔒 Peer Name" pill anchored at its top-right corner, in the
 * peer's color. Rendered in the SCREEN-space overlay layer so the pill stays
 * a fixed-pixel size regardless of zoom — that's why it lives here next to
 * RemoteCursors rather than inside the world-transform tree.
 *
 * Driven by canvasState.peerLocks (the soft-lock map maintained by the
 * KlypixCanvas-level effect that watches collab.peers). Locked items also
 * refuse SET_EDITING at the reducer level — this UI just communicates the
 * lock so the user understands WHY their double-click did nothing.
 */
export function RemoteLockBadges({ view }: { view: ViewState }) {
    const { state } = useCanvasStore();
    const lockEntries = Object.entries(state.peerLocks);
    if (lockEntries.length === 0) return null;
    return (
        <>
            {lockEntries.map(([itemId, lock]) => {
                const item = state.items[itemId] as any;
                if (!item) return null;
                // Anchor at top-right corner of the item. world → screen
                // projection uses the same helper everything else does, so
                // the badge never drifts from the item under zoom/pan.
                const corner = worldToScreen({ x: item.x + (item.w ?? 0), y: item.y }, view);
                return (
                    <div
                        key={`lock-${itemId}`}
                        style={{
                            position: 'absolute',
                            left: corner.x,
                            top: corner.y - 22,
                            transform: 'translate(-100%, 0)',
                            display: 'flex',
                            alignItems: 'center',
                            gap: 4,
                            padding: '2px 6px 2px 5px',
                            borderRadius: 999,
                            background: lock.color,
                            color: 'white',
                            fontSize: 10,
                            fontWeight: 600,
                            letterSpacing: 0.2,
                            whiteSpace: 'nowrap',
                            boxShadow: '0 2px 6px rgba(0,0,0,0.35)',
                            pointerEvents: 'none',
                        }}
                    >
                        <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                            <rect x="3" y="11" width="18" height="11" rx="2" />
                            <path d="M7 11V7a5 5 0 0 1 10 0v4" />
                        </svg>
                        <span>{lock.name}</span>
                    </div>
                );
            })}
        </>
    );
}

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
