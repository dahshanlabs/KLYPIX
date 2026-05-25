import React, { useRef } from 'react';
import { RotateCw } from 'lucide-react';
import { useCanvasStore } from '../state/canvasStore';

// Rotation handle for items that support visual rotation (box / image / text
// for v1). Renders a small circle ~24 screen-px ABOVE the item's top edge,
// connected to the item's top-center by a thin line — same convention as
// Figma / Miro / Excalidraw. Drag → rotate around item center. Hold Shift
// while dragging → snaps to nearest 15° increment.
//
// v1 limitations (intentional, to keep scope tight):
//   - Handle sits above the UN-ROTATED top edge, not the rotated visual.
//     Means at large rotations the handle floats above where the item
//     "would have been" rather than above the visible top.
//   - Resize handles stay around the un-rotated AABB too — same reason.
//   - Hit-testing the rotated body still uses the un-rotated AABB.
//
// All three become "v2 polish" if you ever ask for it.

interface Props {
    itemId: string;
    /** Un-rotated item bounds in world coordinates. */
    x: number;
    y: number;
    w: number;
    h: number;
    /** Current rotation in degrees, used so the handle position follows
     *  the rotated item's top-center rather than always sitting above
     *  the AABB. Defaults to 0 for items without rotation. */
    rotation?: number;
}

// Snap a degree value to the nearest 15° (Figma default). Wraps cleanly
// at 360 so dragging round and round keeps producing the same snapped
// angles instead of accumulating.
function snap15(deg: number): number {
    const SNAP = 15;
    const normalized = ((deg % 360) + 360) % 360;
    const snapped = Math.round(normalized / SNAP) * SNAP;
    // Keep -180..180 representation so the value stays small in the store.
    return snapped > 180 ? snapped - 360 : snapped;
}

export function RotateHandle({ itemId, x, y, w, h, rotation = 0 }: Props) {
    const { state, dispatch, pushSnapshot } = useCanvasStore();
    // Phase 22.5: hide per-item rotation when 2+ entities are selected —
    // MultiSelectionBox now provides a group rotation handle that rotates
    // the whole selection around the bbox centroid. Mirrors the same gate
    // in ResizeHandle.
    const totalSel =
        state.selectedIds.length
        + state.selectedLineIds.length
        + state.selectedStrokeIds.length;
    if (totalSel >= 2) return null;
    const surfaceZoom = Math.max(0.01, state.view.zoom);

    // Visual constants — all in screen-px, divided by zoom so they render
    // at the same size regardless of canvas zoom (matches the resize-handle
    // chrome strategy).
    const HANDLE_DIAMETER_SCREEN = 14;
    const HANDLE_OFFSET_SCREEN = 22;     // gap between item's top edge and handle
    const ICON_SCREEN = 9;

    const handleDiameter = HANDLE_DIAMETER_SCREEN / surfaceZoom;
    const handleOffset = HANDLE_OFFSET_SCREEN / surfaceZoom;
    const iconSize = ICON_SCREEN / surfaceZoom;
    const borderWidthWorld = 1 / surfaceZoom;
    const shadowWorld = 2 / surfaceZoom;

    // Item center in world coords — used as the rotation pivot AND as the
    // angle origin for drag math.
    const cx = x + w / 2;
    const cy = y + h / 2;

    // Handle anchor in item-local coords (before applying rotation):
    // directly above the top edge, on the vertical centerline, offset by
    // the handle gap + half the handle so the bottom of the circle aligns
    // with the gap end.
    const localAnchorX = 0;
    const localAnchorY = -(h / 2) - handleOffset - handleDiameter / 2;

    // Rotate the anchor around (0,0) by the item's current rotation, then
    // translate to world coords. This keeps the handle visually "above" the
    // rotated item — drag a rotated item by its handle and it still feels
    // attached to the right place.
    const rad = (rotation * Math.PI) / 180;
    const cos = Math.cos(rad);
    const sin = Math.sin(rad);
    const worldDx = localAnchorX * cos - localAnchorY * sin;
    const worldDy = localAnchorX * sin + localAnchorY * cos;
    const handleCenterX = cx + worldDx;
    const handleCenterY = cy + worldDy;

    // Line from the rotated top-center of the item to the handle center.
    // Goes through the same local-to-world transform as the handle anchor
    // so it stays straight under any rotation.
    const topLocalX = 0;
    const topLocalY = -h / 2;
    const topWorldX = cx + (topLocalX * cos - topLocalY * sin);
    const topWorldY = cy + (topLocalX * sin + topLocalY * cos);

    // Drag state captured at pointerdown — initial cursor angle relative
    // to item center, and the rotation the item had at that moment. The
    // delta between current cursor angle and initial cursor angle is
    // applied to the initial rotation each frame.
    const dragRef = useRef<{
        startAngle: number;
        startRotation: number;
    } | null>(null);

    const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
        e.stopPropagation();
        e.preventDefault();
        (e.target as HTMLElement).setPointerCapture(e.pointerId);
        pushSnapshot();
        // Compute initial cursor angle in world coords. Screen → world via
        // (screen - pan) / zoom; angle from item center to cursor.
        const cursorWorldX = (e.clientX - state.view.panX) / surfaceZoom;
        const cursorWorldY = (e.clientY - state.view.panY) / surfaceZoom;
        const startAngle = (Math.atan2(cursorWorldY - cy, cursorWorldX - cx) * 180) / Math.PI;
        dragRef.current = {
            startAngle,
            startRotation: rotation,
        };
    };

    const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
        const d = dragRef.current;
        if (!d) return;
        const cursorWorldX = (e.clientX - state.view.panX) / surfaceZoom;
        const cursorWorldY = (e.clientY - state.view.panY) / surfaceZoom;
        const currentAngle = (Math.atan2(cursorWorldY - cy, cursorWorldX - cx) * 180) / Math.PI;
        // Atan2 measures from +X axis. Our "neutral" handle is straight up
        // (along -Y), which is -90° in atan2 terms. We want rotation=0 to
        // correspond to the handle being straight up, so add 90 so the
        // delta from the start angle directly maps to rotation degrees.
        // (Equivalent to just using delta between current and start since
        // both atan2 values share the same offset; the +90 isn't needed
        // when working with deltas. Kept as a comment to explain why no
        // offset is required.)
        const delta = currentAngle - d.startAngle;
        let next = d.startRotation + delta;
        if (e.shiftKey) next = snap15(next);
        dispatch({
            type: 'UPDATE_ITEM',
            id: itemId,
            patch: { rotation: next } as any,
        });
    };

    const onPointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
        dragRef.current = null;
        try { (e.target as HTMLElement).releasePointerCapture(e.pointerId); } catch { /* noop */ }
    };

    return (
        <>
            {/* Connector line from item top-center to handle. SVG so it
                renders cleanly at any zoom; sits BEHIND the handle. */}
            <svg
                style={{
                    position: 'absolute',
                    left: Math.min(topWorldX, handleCenterX) - 2,
                    top: Math.min(topWorldY, handleCenterY) - 2,
                    width: Math.abs(handleCenterX - topWorldX) + 4,
                    height: Math.abs(handleCenterY - topWorldY) + 4,
                    pointerEvents: 'none',
                    overflow: 'visible',
                }}
            >
                <line
                    x1={topWorldX - (Math.min(topWorldX, handleCenterX) - 2)}
                    y1={topWorldY - (Math.min(topWorldY, handleCenterY) - 2)}
                    x2={handleCenterX - (Math.min(topWorldX, handleCenterX) - 2)}
                    y2={handleCenterY - (Math.min(topWorldY, handleCenterY) - 2)}
                    stroke="rgba(16,185,129,0.6)"
                    strokeWidth={borderWidthWorld}
                    strokeDasharray={`${2 / surfaceZoom} ${2 / surfaceZoom}`}
                />
            </svg>
            {/* The handle itself. cursor-grab so users know to drag. */}
            <div
                data-canvas-ui="1"
                className="no-drag"
                onPointerDown={onPointerDown}
                onPointerMove={onPointerMove}
                onPointerUp={onPointerUp}
                onPointerCancel={onPointerUp}
                title="Drag to rotate · Shift snaps to 15°"
                style={{
                    position: 'absolute',
                    left: handleCenterX - handleDiameter / 2,
                    top: handleCenterY - handleDiameter / 2,
                    width: handleDiameter,
                    height: handleDiameter,
                    borderRadius: handleDiameter / 2,
                    background: '#10b981',
                    border: `${borderWidthWorld}px solid rgba(10,10,15,0.85)`,
                    boxShadow: `0 0 0 ${shadowWorld}px rgba(16,185,129,0.22)`,
                    cursor: 'grab',
                    pointerEvents: 'auto',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    color: 'white',
                    zIndex: 11,
                }}
            >
                <RotateCw size={iconSize} />
            </div>
        </>
    );
}
