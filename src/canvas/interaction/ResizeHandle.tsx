import React, { useRef } from 'react';
import { useCanvasStore } from '../state/canvasStore';

// 8-handle resize (4 corners + 4 edges) for boxes, images, containers, and
// text items. Each handle drags in its own direction; opposite edges stay
// pinned so the user feels like they're dragging THAT side.

export type HandlePos = 'nw' | 'n' | 'ne' | 'w' | 'e' | 'sw' | 's' | 'se';

interface Props {
    itemId: string;
    x: number;
    y: number;
    w: number;
    h: number;
    minW?: number;
    minH?: number;
    // When true, the aspect ratio is ALWAYS locked (e.g. images).
    preserveAspect?: boolean;
    // When true, aspect ratio is locked by default and Shift RELEASES it
    // (inverse of the usual Shift-to-lock gesture). Used for containers
    // where dragging a lone edge would otherwise squash the frame.
    aspectLockedByDefault?: boolean;
    handles?: HandlePos[];   // subset to render (default: all 8)
    // When true, ANY handle (edge or corner) only affects width — height
    // and y are restored to the item's current values before dispatch.
    // Used for collapsed containers where the tab is height-fixed: corner
    // handles should still work (user wants them visible for reach) but
    // they behave as horizontal-only drags.
    lockHeight?: boolean;
    // Target field for width dispatches. Default 'w'. Collapsed containers
    // pass 'collapsedW' so tab drags never touch the real expanded width.
    // Implies the caller also passes the current collapsedW value as the
    // `w` prop so handle positioning matches the tab's rendered width.
    widthField?: 'w' | 'collapsedW';
    // When set, dragging enters font-scaling mode used by plain text items
    // where width auto-fits content. GROW drags scale the font; SHRINK
    // drags (dragging an edge inward) DON'T touch the font — they set
    // `authoredWidth` on the item so the text wraps at a narrower width.
    scaleField?: {
        key: 'fontSize';
        base: number;           // current font value — starting point for grow scaling
        min: number;
        max: number;
        // Needed so shrink-drags can set authoredWidth.
        authoredWidth?: number;    // current authored width (undefined = auto)
    };
    // When set, drag input is interpreted as a change to the item's
    // uniform scale (rather than a direct width/height write). The
    // dispatched patch writes `w = authoredW × newScale` and
    // `h = authoredH × newScale`, keeping the container's scale
    // geometry in sync. Used by collapsed capsules: the handle's
    // visible w/h is the pill's rendered bounds (naturalW × scale ×
    // titleBarH), and dragging the handle wider/narrower updates
    // the group's scale — which affects both the capsule and the
    // eventual expanded-group size uniformly.
    scaleAnchor?: {
        naturalW: number;     // world-px content width at scale=1
        authoredW: number;    // baseline world-px width at scale=1
        authoredH: number;    // baseline world-px height at scale=1
        minScale?: number;    // default 0.3
        maxScale?: number;    // default unbounded
    };
}

const DEFAULT_ALL: HandlePos[] = ['nw', 'n', 'ne', 'w', 'e', 'sw', 's', 'se'];

export function ResizeHandle(props: Props) {
    const handles = props.handles || DEFAULT_ALL;
    return (
        <>
            {handles.map(pos => (
                <SingleHandle key={pos} pos={pos} {...props} />
            ))}
        </>
    );
}

function cursorFor(pos: HandlePos): string {
    switch (pos) {
        case 'nw': case 'se': return 'nwse-resize';
        case 'ne': case 'sw': return 'nesw-resize';
        case 'n': case 's': return 'ns-resize';
        case 'e': case 'w': return 'ew-resize';
    }
}

function offsetFor(pos: HandlePos, w: number, h: number): { x: number; y: number } {
    const mx = w / 2, my = h / 2;
    switch (pos) {
        case 'nw': return { x: 0, y: 0 };
        case 'n':  return { x: mx, y: 0 };
        case 'ne': return { x: w, y: 0 };
        case 'w':  return { x: 0, y: my };
        case 'e':  return { x: w, y: my };
        case 'sw': return { x: 0, y: h };
        case 's':  return { x: mx, y: h };
        case 'se': return { x: w, y: h };
    }
}

function SingleHandle({ itemId, x, y, w, h, minW = 20, minH = 20, preserveAspect, aspectLockedByDefault, scaleField, lockHeight, widthField, scaleAnchor, pos }: Props & { pos: HandlePos }) {
    const { state, dispatch, pushSnapshot } = useCanvasStore();
    const zoomRef = useRef(state.view.zoom);
    zoomRef.current = state.view.zoom;
    // Capture base values at drag start, not at each render. Otherwise
    // mid-drag re-renders feed the new (already-grown) values back in and
    // the math compounds.
    const dragRef = useRef<{
        x: number; y: number; w: number; h: number;
        startX: number; startY: number;
        baseFont: number; baseAuthoredWidth: number | undefined;
        // Captured at drag-start so the non-scaleField path can scale
        // proportionally on corner drags without re-reading stale state.
        baseItemFontSize: number | undefined;
        baseItemBorderWidth: number | undefined;
    } | null>(null);

    const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
        // When 2+ entities are selected, the outer MultiSelectionBox owns
        // the drag — per-item handles stay visible but become inert so
        // the user can't accidentally resize a single item out of a group.
        const totalSel =
            state.selectedIds.length
            + state.selectedLineIds.length
            + state.selectedStrokeIds.length;
        if (totalSel >= 2) return;
        e.stopPropagation();
        e.preventDefault();
        pushSnapshot();
        const cur: any = state.items[itemId];
        dragRef.current = {
            x, y, w, h,
            startX: e.clientX, startY: e.clientY,
            baseFont: scaleField?.base ?? 0,
            baseAuthoredWidth: scaleField?.authoredWidth,
            baseItemFontSize: cur?.type === 'text' ? cur.fontSize : undefined,
            baseItemBorderWidth: cur?.type === 'box' ? cur.borderWidth : undefined,
        };
        (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    };

    // Items that live inside a container have their geometry vector-derived
    // every render from authoredInParent × containerScale (see
    // ContainerItem.tsx vector-scale effect). If a resize dispatch updates
    // only x/y/w/h, that effect will REVERT it on the next pass — producing
    // the "fight" / "snap-back" the user sees as flicker or initial jump.
    // To make resize stick for child items, we must also update
    // authoredInParent in the same patch so the next vector-scale pass
    // produces the exact geometry the user just drew.
    const buildAuthoredInParentPatch = (
        nx: number,
        ny: number,
        nw: number,
        nh: number,
        opts: { fontSize?: number; authoredWidth?: number; borderWidth?: number } = {}
    ): any | null => {
        const it = state.items[itemId];
        if (!it || !it.parentId) return null;
        const parent = state.items[it.parentId];
        if (!parent || parent.type !== 'container') return null;
        const aw = (parent as any).authoredW || parent.w;
        const ah = (parent as any).authoredH || parent.h;
        if (!aw || !ah) return null;
        // Mirror the uniform-min scale the effect uses — otherwise our
        // anchor would get out of sync the moment the container's aspect
        // changes.
        const scale = Math.min(parent.w / aw, parent.h / ah);
        if (scale <= 0) return null;
        const inv = 1 / scale;
        const next: any = {
            relX: (nx - parent.x) * inv,
            relY: (ny - parent.y) * inv,
            w: nw * inv,
            h: nh * inv,
        };
        if (opts.fontSize != null) next.fontSize = opts.fontSize * inv;
        if (opts.authoredWidth != null) next.authoredWidth = opts.authoredWidth * inv;
        if (opts.borderWidth != null) next.borderWidth = opts.borderWidth * inv;
        return next;
    };

    const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
        const d = dragRef.current;
        if (!d) return;
        const z = zoomRef.current || 1;
        const dx = (e.clientX - d.startX) / z;
        const dy = (e.clientY - d.startY) / z;

        // Scale-field mode: crop-style handle semantics.
        //
        //   EDGE (N / S / E / W): single-axis only.
        //     E / W → set authoredWidth (text wraps at new width), font stays.
        //     N / S → no-op for plain text. Height follows wrapped content;
        //             we don't clip text.
        //
        //   CORNER (NW / NE / SW / SE): both axes → scale font uniformly.
        //     If authoredWidth was set, it scales by the same factor so the
        //     wrap structure is preserved while the text grows.
        if (scaleField && d.w > 0 && d.h > 0) {
            const dirX = pos.includes('e') ? 1 : pos.includes('w') ? -1 : 0;
            const dirY = pos.includes('s') ? 1 : pos.includes('n') ? -1 : 0;
            const isCorner = dirX !== 0 && dirY !== 0;
            const isEdge = !isCorner;

            if (isEdge) {
                const minAuthored = Math.max(24, d.baseFont * 3);

                if (dirX !== 0) {
                    // E / W edge: set authoredWidth directly, anchor opposite.
                    const targetW = Math.max(4, d.w + dirX * dx);
                    const newAuthored = Math.max(minAuthored, targetW);
                    let nx = d.x;
                    if (dirX === -1) nx = d.x + d.w - newAuthored;
                    const aip = buildAuthoredInParentPatch(nx, d.y, newAuthored, d.h, { authoredWidth: newAuthored });
                    dispatch({
                        type: 'UPDATE_ITEM',
                        id: itemId,
                        patch: {
                            authoredWidth: newAuthored,
                            x: nx,
                            w: newAuthored,
                            ...(aip ? { authoredInParent: aip } : {}),
                        } as any,
                    });
                    return;
                }

                // N / S edge: preserve text area. Shrinking height makes the
                // text reflow WIDER (fewer lines); growing height makes it
                // NARROWER. authoredWidth ≈ (baseW * baseH) / newH.
                const targetH = Math.max(Math.round(d.baseFont * 1.35), d.h + dirY * dy);
                const area = d.w * d.h;
                const newAuthored = Math.max(minAuthored, area / targetH);
                // Anchor the opposite horizontal edge at left by default; Y
                // anchor follows the edge NOT being dragged.
                let ny = d.y;
                if (dirY === -1) ny = d.y + d.h - targetH;  // N drag: bottom anchored
                const aip = buildAuthoredInParentPatch(d.x, ny, newAuthored, d.h, { authoredWidth: newAuthored });
                dispatch({
                    type: 'UPDATE_ITEM',
                    id: itemId,
                    patch: {
                        authoredWidth: newAuthored,
                        y: ny,
                        w: newAuthored,
                        ...(aip ? { authoredInParent: aip } : {}),
                    } as any,
                });
                return;
            }

            // Corner: scale font uniformly. Project the cursor delta onto the
            // box's diagonal so the corner tracks the cursor at the same rate
            // regardless of the box's aspect ratio.
            //
            // The previous "max relative change" rule (pick scaleX or scaleY,
            // whichever moved further from 1) blew up wide-but-short text
            // items: a 3px vertical wobble against a 20px-tall, 300px-wide
            // text gave scaleY=1.15 vs scaleX=1.017, so the algorithm picked
            // scaleY and the box jumped forward 45px while the cursor only
            // moved 3px sideways. User-visible as "scale runs faster than the
            // cursor". Projection-based scale weights each axis by its size,
            // so the dimension with more *travel room* dominates and small
            // perpendicular wobble has small effect.
            //
            //   s = 1 + (dirX·dx·w + dirY·dy·h) / (w² + h²)
            //
            // Pure horizontal drag on a wide box → scale ≈ 1 + dx/w.
            // Pure vertical drag on the same box → scale ≈ 1 + dy·h/(w² + h²)
            // — small, since a tall scale isn't what was asked for. Users who
            // actually want vertical-only resize use the N/S edge handle.
            const diag2 = d.w * d.w + d.h * d.h;
            const projectedDelta = diag2 > 0
                ? (dirX * dx * d.w + dirY * dy * d.h) / diag2
                : 0;
            const scale = Math.max(0.05, 1 + projectedDelta);

            const rawFont = d.baseFont * scale;
            const clampedFont = Math.max(scaleField.min, Math.min(scaleField.max, rawFont));
            const effectiveScale = clampedFont / d.baseFont;
            const finalW = d.w * effectiveScale;
            const finalH = d.h * effectiveScale;
            let nx = d.x;
            let ny = d.y;
            if (dirX === -1) nx = d.x + d.w - finalW;
            if (dirY === -1) ny = d.y + d.h - finalH;
            // Preserve the wrap ratio: if user had set authoredWidth, scale
            // it by the same factor — no snap back to the untrapped width.
            const nextAuthored = d.baseAuthoredWidth != null
                ? d.baseAuthoredWidth * effectiveScale
                : undefined;
            const aip = buildAuthoredInParentPatch(nx, ny, finalW, finalH, {
                fontSize: clampedFont,
                authoredWidth: nextAuthored,
            });
            dispatch({
                type: 'UPDATE_ITEM',
                id: itemId,
                patch: {
                    [scaleField.key]: Math.round(clampedFont),
                    x: nx,
                    y: ny,
                    authoredWidth: nextAuthored,
                    ...(aip ? { authoredInParent: aip } : {}),
                } as any,
            });
            return;
        }

        let nx = d.x, ny = d.y, nw = d.w, nh = d.h;
        if (pos.includes('w')) { nx = d.x + dx; nw = d.w - dx; }
        if (pos.includes('e')) { nw = d.w + dx; }
        if (pos.includes('n')) { ny = d.y + dy; nh = d.h - dy; }
        if (pos.includes('s')) { nh = d.h + dy; }

        // Scale-anchor mode — used by collapsed capsules. Drag input
        // is interpreted as a change to the item's uniform scale, not
        // a direct w/h write. newScale is derived from whichever drag
        // axis the user is on; item.w and item.h are set to
        // authored × newScale so the container's scale-geometry stays
        // consistent (the vector-scale cascade picks it up).
        if (scaleAnchor) {
            const { naturalW, authoredW, authoredH } = scaleAnchor;
            const minScale = scaleAnchor.minScale ?? 0.3;
            const maxScale = scaleAnchor.maxScale ?? Number.POSITIVE_INFINITY;
            // Prefer the horizontal axis for scale derivation because
            // capsule width IS the natural visible dimension. Vertical-
            // only edges (n/s) fall back to deriving scale from the
            // capsule's titleBarH ratio which maps to the same scale.
            let newScale: number;
            if (pos === 'n' || pos === 's') {
                // headerH at scale=1 is 28 (see computeCapsuleRenderMetrics).
                newScale = Math.max(1, nh) / 28;
            } else {
                newScale = Math.max(1, nw) / Math.max(1, naturalW);
            }
            newScale = Math.max(minScale, Math.min(maxScale, newScale));
            // Anchor the drag: west/north edges should move item.x/y so
            // the opposite edge stays put. We do this in terms of the
            // rendered capsule bounds (d.w/d.h), not item.w/h (which
            // may be much larger when the expanded frame is bigger
            // than the capsule it currently displays as).
            let anchoredX = d.x;
            let anchoredY = d.y;
            const newRenderW = naturalW * newScale;
            const newRenderH = 28 * newScale;
            if (pos.includes('w')) anchoredX = d.x + d.w - newRenderW;
            if (pos.includes('n')) anchoredY = d.y + d.h - newRenderH;
            dispatch({
                type: 'UPDATE_ITEM',
                id: itemId,
                patch: {
                    w: authoredW * newScale,
                    h: authoredH * newScale,
                    x: anchoredX,
                    y: anchoredY,
                } as any,
            });
            return;
        }

        // Screen-space floor. Item can't shrink below 20 screen-px —
        // at low zoom that corresponds to a much larger world-px value,
        // which prevents the tiny-item-runaway-sensitivity case where
        // a 5-screen-px item becomes 6× bigger from one cursor jump.
        // Caller-supplied minW/minH take precedence if they're larger.
        const MIN_SCREEN_PX = 20;
        const zMinW = Math.max(minW, MIN_SCREEN_PX / z);
        const zMinH = Math.max(minH, MIN_SCREEN_PX / z);
        if (nw < zMinW) { if (pos.includes('w')) nx -= (zMinW - nw); nw = zMinW; }
        if (nh < zMinH) { if (pos.includes('n')) ny -= (zMinH - nh); nh = zMinH; }

        // Aspect lock policy:
        //   preserveAspect        → always locked (images).
        //   aspectLockedByDefault → locked UNLESS Shift is held (containers).
        //   default               → locked WHEN Shift is held (everything else).
        const aspectLocked = (
            preserveAspect
            || (aspectLockedByDefault ? !e.shiftKey : e.shiftKey)
        ) && d.w > 0 && d.h > 0;
        if (aspectLocked) {
            const aspect = d.w / d.h;
            if (pos === 'e' || pos === 'w') nh = nw / aspect;
            else if (pos === 'n' || pos === 's') nw = nh * aspect;
            else {
                // Corners: use larger delta.
                if (Math.abs(dx) * d.h >= Math.abs(dy) * d.w) nh = nw / aspect;
                else nw = nh * aspect;
            }
        }

        // lockHeight (used by collapsed containers): dispatch only width/x
        // changes. y and h are pinned to whatever the store currently holds,
        // NOT the d.h captured at pointerdown — that's often the visual
        // titleBarH which would clobber the real expanded-state h.
        if (lockHeight) {
            const cur = state.items[itemId];
            if (cur) {
                ny = cur.y;
                nh = cur.h;
            }
        }

        // Proportional content scale on corner drags. When the user is
        // directly resizing a text or box item, scale its fontSize /
        // borderWidth by the same ratio as the frame — so "bigger box"
        // also means "bigger text" / "thicker border", tracking the
        // cursor and staying visually proportional. Edge-only drags
        // (N/S/E/W) don't scale content; only corners do, where aspect
        // is typically preserved.
        const isCorner = pos.length === 2;
        const contentPatch: any = {};
        if (isCorner && d.w > 0) {
            const scaleRatio = nw / d.w;
            if (d.baseItemFontSize != null) {
                // Authoring-style readability floor on corner-shrink. The
                // existing minW screen-floor only protects the FRAME; this
                // protects the FONT. Without it a corner-drag scales
                // fontSize by nw/d.w, can drop it below 6 screen-px, and
                // shouldRenderAsDot (ContainerItem.tsx) flips the whole
                // item to a 12-px dot — handles vanish, item is no longer
                // grabbable by mouse. World-px term (6) keeps the font
                // visible at 100% zoom regardless of where the drag ends;
                // screen-px term (7/z) keeps the item from crossing the
                // dot threshold mid-drag at the current zoom.
                const fontFloor = Math.max(6, 7 / z);
                contentPatch.fontSize = Math.max(fontFloor, d.baseItemFontSize * scaleRatio);
            }
            if (d.baseItemBorderWidth != null) {
                contentPatch.borderWidth = Math.max(0.5, d.baseItemBorderWidth * scaleRatio);
            }
        }

        // Route width changes to the requested field so collapsed-tab
        // drags update collapsedW (cosmetic) and leave w untouched.
        const aip = buildAuthoredInParentPatch(nx, ny, nw, nh, {
            fontSize: contentPatch.fontSize,
            borderWidth: contentPatch.borderWidth,
        });
        // For bordered text cards, an N/S/corner drag means the user is
        // explicitly choosing a height. Pin the flag so TextItem's auto-
        // grow observer stops snapping h back to the rendered content
        // height the moment we shrink below it. Width-only edges (E/W)
        // don't touch h, so we leave the flag alone — the observer can
        // still grow the card to wrap newly-narrower content.
        const cur = state.items[itemId];
        const heightChanged = pos.includes('n') || pos.includes('s');
        const userResizedPatch: any = (cur?.type === 'text' && (cur as any).border && heightChanged)
            ? { userResizedHeight: true }
            : {};
        if (widthField && widthField !== 'w') {
            dispatch({
                type: 'UPDATE_ITEM',
                id: itemId,
                patch: {
                    x: nx, y: ny, [widthField]: nw, h: nh, ...contentPatch,
                    ...(aip ? { authoredInParent: aip } : {}),
                    ...userResizedPatch,
                } as any,
            });
        } else {
            dispatch({
                type: 'UPDATE_ITEM',
                id: itemId,
                patch: {
                    x: nx, y: ny, w: nw, h: nh, ...contentPatch,
                    ...(aip ? { authoredInParent: aip } : {}),
                    ...userResizedPatch,
                } as any,
            });
        }
        // Child scaling is handled by ContainerItem's effect, which
        // derives children from their frozen authoredInParent × current
        // scale — drift-free by construction.
    };

    const onPointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
        dragRef.current = null;
        try { (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId); } catch {}
    };

    // Screen-constant handle chrome. Previously SIZE was in world-px
    // (10 × chromeScale), which meant a handle rendered 40 screen-px
    // at 400% zoom — dwarfed the items it was attached to. Now SIZE is
    // derived from a target screen-px directly, so the handle is the
    // same visual size at every zoom level. Matches Figma/Miro chrome
    // behavior: tools are screen-constant; content is world-scale.
    const viewZoom = Math.max(0.01, state.view.zoom);
    const TARGET_HANDLE_SCREEN_PX = 10;
    const SIZE = TARGET_HANDLE_SCREEN_PX / viewZoom;
    // Border + shadow in world-px to render at ~1 and ~2 screen-px.
    const BORDER_WORLD_PX = 1 / viewZoom;
    const SHADOW_WORLD_PX = 2 / viewZoom;

    const off = offsetFor(pos, w, h);
    return (
        <div
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerUp}
            className="no-drag"
            style={{
                position: 'absolute',
                left: x + off.x - SIZE / 2,
                top: y + off.y - SIZE / 2,
                width: SIZE,
                height: SIZE,
                // Full circle (radius = half the size) for every handle.
                // Prior versions used borderRadius:2 for corners and
                // borderRadius:8 for edges — both are CSS pixel values
                // that get multiplied by the pan/zoom transform, so at
                // 400% corners looked like pills and edges looked like
                // full circles (inconsistent), while at 100% corners
                // looked like slightly-rounded squares. Expressing the
                // radius in world-px proportional to SIZE (which itself
                // scales with zoom) makes every handle render as a
                // perfect emerald dot at every zoom. Matches Figma.
                borderRadius: SIZE / 2,
                background: '#10b981',
                border: `${BORDER_WORLD_PX}px solid rgba(10,10,15,0.85)`,
                boxShadow: `0 0 0 ${SHADOW_WORLD_PX}px rgba(16,185,129,0.22)`,
                cursor: cursorFor(pos),
                pointerEvents: 'auto',
                WebkitAppRegion: 'no-drag',
                zIndex: 10,
            } as React.CSSProperties & { WebkitAppRegion?: string }}
        />
    );
}
