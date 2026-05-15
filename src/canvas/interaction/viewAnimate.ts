// Smooth view animator for the "zoom-to-author" pattern.
//
// Pattern (spec'd by product): when the user starts authoring (click-create
// text, paste, drag to draw) while zoomed out below a comfortable level,
// we animate the view to a known-readable zoom centered on the point of
// interaction BEFORE creating content. Content itself stays at fixed world
// sizes (no counter-zoom on insert). The view moves to meet the user, not
// the other way around.
//
// Keep this small — the canvas store already has SET_VIEW; this is just a
// rAF-driven tween on top.

import type { ViewState } from '../items/types';

export const MIN_AUTHORING_ZOOM = 0.4;   // below this, auto-zoom kicks in
export const COMFORTABLE_AUTHORING_ZOOM = 0.7;  // target zoom after the tween
const DEFAULT_DURATION_MS = 300;

interface AnimateOpts {
    /** Current view state at animation start. */
    from: ViewState;
    /** World-space anchor — the point that should stay under the viewport center. */
    centerWorld: { x: number; y: number };
    /** Target zoom level. */
    zoom: number;
    /** Viewport size in CSS pixels (width, height). */
    viewport: { w: number; h: number };
    /** Called each frame with the interpolated view. */
    onFrame: (v: ViewState) => void;
    /** ms. Defaults to 300. */
    durationMs?: number;
    /** Called once when the animation completes (or is cancelled). */
    onDone?: (finalView: ViewState) => void;
}

// Cancel handle — call it to stop an in-flight animation.
export type AnimationHandle = { cancel: () => void };

// Module-level tracker for the CURRENT running animation. Any new
// animation cancels the previous one (no dog-piling). User input
// (pan / zoom / pointer-down) also cancels via cancelActiveAnimation()
// so there's a single source of truth for "what's moving the view" —
// the animation, until the user takes over, then the user.
let activeAnimation: AnimationHandle | null = null;

export function cancelActiveAnimation(): void {
    if (activeAnimation) {
        activeAnimation.cancel();
        activeAnimation = null;
    }
}

// Cubic ease-out — fast start, gentle settle. Matches the "pop into focus"
// feel you want for zoom-to-author.
function easeOutCubic(t: number): number {
    return 1 - Math.pow(1 - t, 3);
}

/**
 * Tween pan + zoom so `centerWorld` ends up at the viewport center at the
 * target zoom level. Returns a cancel handle; the caller can bail (e.g. if
 * the user pans/zooms during the animation). Also registers the handle
 * as the module's active animation so `cancelActiveAnimation()` can
 * stop it on user input.
 */
export function animateView(opts: AnimateOpts): AnimationHandle {
    // Kill any previous animation — we never want two tweens fighting
    // for the view.
    cancelActiveAnimation();

    const duration = opts.durationMs ?? DEFAULT_DURATION_MS;
    const startTime = (typeof performance !== 'undefined' ? performance.now() : Date.now());
    const { from, centerWorld, zoom: targetZoom, viewport, onFrame, onDone } = opts;

    const targetPanX = viewport.w / 2 - centerWorld.x * targetZoom;
    const targetPanY = viewport.h / 2 - centerWorld.y * targetZoom;

    let rafId = 0;
    let cancelled = false;

    const step = (now: number) => {
        if (cancelled) return;
        const t = Math.min(1, (now - startTime) / duration);
        const eased = easeOutCubic(t);
        const view: ViewState = {
            zoom: from.zoom + (targetZoom - from.zoom) * eased,
            panX: from.panX + (targetPanX - from.panX) * eased,
            panY: from.panY + (targetPanY - from.panY) * eased,
        };
        onFrame(view);
        if (t < 1) {
            rafId = requestAnimationFrame(step);
        } else {
            // Natural completion — clear the active slot only if it's
            // still us (a newer animation may have taken over).
            if (activeAnimation === handle) activeAnimation = null;
            onDone?.(view);
        }
    };

    const handle: AnimationHandle = {
        cancel: () => {
            if (cancelled) return;
            cancelled = true;
            cancelAnimationFrame(rafId);
            if (activeAnimation === handle) activeAnimation = null;
        },
    };
    activeAnimation = handle;

    rafId = requestAnimationFrame(step);

    return handle;
}

/**
 * Convenience: if the current zoom is below `MIN_AUTHORING_ZOOM`, animate
 * to `COMFORTABLE_AUTHORING_ZOOM` centered on the given world point.
 * Returns true if a zoom was initiated, false if the view was already
 * comfortable (caller can skip the pre-zoom step).
 */
export function autoZoomForAuthoring(args: {
    view: ViewState;
    centerWorld: { x: number; y: number };
    viewport: { w: number; h: number };
    onFrame: (v: ViewState) => void;
    onDone?: (v: ViewState) => void;
}): boolean {
    if (args.view.zoom >= MIN_AUTHORING_ZOOM) return false;
    animateView({
        from: args.view,
        centerWorld: args.centerWorld,
        zoom: COMFORTABLE_AUTHORING_ZOOM,
        viewport: args.viewport,
        onFrame: args.onFrame,
        onDone: args.onDone,
    });
    return true;
}
