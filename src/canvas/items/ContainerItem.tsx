import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ChevronDown, ChevronRight, Lock, LogOut, LogIn, FolderTree, ZoomIn } from 'lucide-react';
import { t } from '../../i18n/strings';
import { getReadabilityReference, hasTextDescendant } from './containerMinTextSize';
import type { ContainerItem as ContainerItemType, CanvasItem } from './types';
import { useCanvasStore } from '../state/canvasStore';
import { ResizeHandle } from '../interaction/ResizeHandle';
import { useGridSettings, isDarkBackground } from '../gridSettings';

interface Props {
    item: ContainerItemType;
    childCount: number;
    selected: boolean;
}

export const ContainerItemView = React.memo(ContainerItemViewImpl, (prev, next) => {
    return prev.item === next.item && prev.childCount === next.childCount && prev.selected === next.selected;
});

export const ContainerHeaderView = React.memo(ContainerHeaderViewImpl, (prev, next) => {
    return prev.item === next.item && prev.childCount === next.childCount && prev.selected === next.selected;
});

export const TITLE_BAR_HEIGHT = 28;

// Authoring uses canonical world-px sizes. Items have a fixed world size
// regardless of the view zoom they're created at; zoom is just
// magnification. Previously a getAuthoringCounterZoom multiplier
// compensated for view zoom so newly authored content appeared the same
// screen-size at any zoom — removed 2026-04-22 (Reading 2 decision):
// items authored at 400% now appear large at 400%, normal at 100%,
// small at 25%. Downstream tier 3 "dot" mode handles the too-small end.

// Minimum world-px stored width for a collapsed tab. Absolute floor on
// state — applied on first collapse + on the resize handle so the
// state never goes below this even when the user drags very narrow.
// 150 world-px happens to match the screen-px floor at zoom=1.
export const MIN_COLLAPSED_W = 150;

// Minimum SCREEN-px rendered width for the collapsed tab. At normal zoom
// (≥ ZOOM_BREAKPOINT) this holds at 150 px so the tab and its title are
// comfortably readable. Below the breakpoint the floor linearly shrinks
// toward MIN_W_EXTREME so collapsed tabs don't visually dominate at 2-5%
// zoom where they'd otherwise swallow the whole overview. The lerp uses
// (0.01 … breakpoint) as its t-range so zoom=2% lands near the minimum
// without hitting an abrupt edge at exactly 0.01.
export const MIN_COLLAPSED_SCREEN_PX = 150;     // exported for legacy / reference
// Was 60; bumped to 100 so collapsed tabs stay findable at overview
// zoom levels (e.g. 2-5%). At 60 they were visually small enough to
// miss on a dense canvas — user reported not noticing a father-group
// tab after creation.
const MIN_COLLAPSED_SCREEN_PX_EXTREME = 100;
const MIN_COLLAPSED_SCREEN_PX_BREAKPOINT = 0.1;  // viewZoom below this starts shrinking

export function getCollapsedMinScreenWidth(viewZoom: number): number {
    const z = Math.max(0.01, viewZoom);
    if (z >= MIN_COLLAPSED_SCREEN_PX_BREAKPOINT) return MIN_COLLAPSED_SCREEN_PX;
    const t = (z - 0.01) / (MIN_COLLAPSED_SCREEN_PX_BREAKPOINT - 0.01);
    const clamped = Math.max(0, Math.min(1, t));
    return MIN_COLLAPSED_SCREEN_PX_EXTREME + (MIN_COLLAPSED_SCREEN_PX - MIN_COLLAPSED_SCREEN_PX_EXTREME) * clamped;
}

/**
 * World-px width to render a collapsed container's capsule at. The
 * capsule is AUTO-FIT: its width always equals natural content width
 * (chevron + title + count + icons) × capsuleScale. No user-stored
 * collapsedW drives width anymore — resizing the capsule adjusts the
 * group's uniform scale, not the width directly.
 *
 * The `items` argument is optional so legacy callers (that only
 * passed item + zoom) keep compiling; without it we fall back to a
 * natural estimate using no sub-group / focus info, which is fine
 * for rough bounding-box uses.
 */
export function getCollapsedRenderW(
    item: ContainerItemType,
    viewZoom: number,
    items?: Record<string, CanvasItem>,
): number {
    if (items) {
        return computeCapsuleRenderMetrics(item, viewZoom, items, false).renderW;
    }
    // Lightweight estimate without items map — used by legacy call sites
    // that don't have state handy. Natural × scale, where scale derives
    // from item geometry as above.
    const aw = item.authoredW || item.w || 1;
    const ah = item.authoredH || item.h || 1;
    const scale = Math.max(0.3, Math.min(item.w / aw, item.h / ah) || 1);
    const natural = computeNaturalTabScreenW(item, { hasSubGroups: false, isFocused: false });
    return natural * scale;
}

// Legacy export — was the render-time cap on capsuleScale but render
// is now uncapped so the user can drag the capsule aspect-locked to
// any size. Kept as a named constant because other files may still
// import it and because it's a useful reference value (scale where
// the capsule is "large but still normal-looking"). Prefer
// PATHOLOGICAL_CAPSULE_SCALE for decisions about legacy data.
export const CAPSULE_SCALE_MAX = 2.5;

// Generosity factor on natural content width when seeding collapsedW
// on first collapse. 1.0 would look cramped; 1.3 keeps the capsule
// feeling like a tab you can grab without fighting content width.
const COMPACT_SEED_GENEROSITY = 1.3;

// capsuleScale above which a persisted collapsedW is treated as the
// pre-fix bug (items seeded to item.w at high zoom), not authored
// intent. Used by the load-time migration in anyFormat.ts. Raised
// well above CAPSULE_SCALE_MAX so legitimate user drags to very wide
// capsules survive a reload — only truly runaway values get reset.
export const PATHOLOGICAL_CAPSULE_SCALE = 20;

// Schema version of the collapsedW seed on a container. Bump when
// the seed algorithm changes. Migration treats any persisted version
// STRICTLY LESS than CURRENT as stale — so a user who opens a
// future-versioned file under older code leaves the marker intact
// instead of silently downgrading it.
export const COLLAPSED_W_SEED_VERSION_CURRENT = 2;

// Pure estimate (screen-px) of the tab's content width at
// capsuleScale=1. Same NAT_* constants the render path uses below
// at the capsuleScale block — extracted so first-collapse seed and
// load-time migration agree on the same measure. No DOM / refs, so
// no first-paint race.
export function computeNaturalTabScreenW(
    item: ContainerItemType,
    inputs: { hasSubGroups: boolean; isFocused: boolean },
): number {
    const NAT_PAD_X_SUM = 24;
    const NAT_CHEVRON = 14;
    const NAT_TITLE_CHAR = 7;
    const NAT_COUNT = 55;
    const NAT_ICON = 12;
    const NAT_GAP = 6;
    const titleText = item.title || 'Group';
    let w = NAT_PAD_X_SUM + NAT_CHEVRON + NAT_GAP + titleText.length * NAT_TITLE_CHAR + NAT_GAP + NAT_COUNT;
    // Lock button is always rendered (toggle, not conditional on
    // scopeLocked — only its color differs). Reserve its slot too so
    // the auto-fit capsule wraps it cleanly.
    w += NAT_GAP + NAT_ICON;
    if (inputs.hasSubGroups) w += NAT_GAP + NAT_ICON;
    // Enter / Exit button is always visible — Enter when not focused,
    // Exit when focused. Same icon slot either way.
    w += NAT_GAP + NAT_ICON;
    return w;
}

// Target collapsedW (world-px) on first collapse. Fits natural content
// with a small generosity factor. ZOOM-INDEPENDENT: the seed is the
// natural screen width (treated directly as world-px at the baseline
// zoom=1) times COMPACT_SEED_GENEROSITY. Capsule content scale is
// driven by collapsedW alone (see computeCapsuleRenderMetrics), so
// the same seed yields consistent appearance at any view zoom. Old
// formula divided by zoom, which produced collapsedW values that
// varied by 200× between 0.02 and 4 zoom — a capsule authored at 2%
// then viewed at 100% was absurdly wide. Floored at MIN_COLLAPSED_W
// so degenerate content doesn't land below the per-state minimum.
// The `viewZoom` param is kept for callsite stability but no longer
// influences the result.
export function computeCompactCollapsedW(
    item: ContainerItemType,
    _viewZoom: number,
    inputs: { hasSubGroups: boolean; isFocused: boolean },
): number {
    const natScreen = computeNaturalTabScreenW(item, inputs) * COMPACT_SEED_GENEROSITY;
    return Math.max(MIN_COLLAPSED_W, natScreen);
}

// Tab-mode render metrics for a collapsed container. Single source of
// truth so the frame (ContainerItemView) and the header (ContainerHeaderView)
// agree on capsule dimensions — before this helper existed, the frame used
// a chrome-based titleBarH (clamped [0.5, 3]) while the header used the
// capsule-scale one, producing a visible height mismatch: selection and
// header extended below the dashed frame border at higher zoom.
//
// Returns all the scaled capsule values the header needs for its internal
// layout (font / icon / pad / gap / headerH) plus the world-px titleBarH
// that both components use for their bounds.
export interface CapsuleRenderMetrics {
    /** Uniform scale factor driving the whole capsule (and, on expand,
     *  the whole group). Derived from the container's geometry:
     *  min(item.w / authoredW, item.h / authoredH). Clamp-floored at
     *  0.3 so extreme shrinks don't collapse to zero. */
    capsuleScale: number;
    /** Natural content width in WORLD-px at capsuleScale = 1. Baseline
     *  for capsule auto-fit. */
    naturalW: number;
    /** Rendered capsule width in WORLD-px = naturalW × capsuleScale.
     *  Pill is always snug to content; no more user-stored width. */
    renderW: number;
    /** All following are WORLD-px base × capsuleScale. At render time
     *  they get multiplied by viewZoom via the transform layer, so
     *  they scale with zoom like any world-space content — consistent
     *  with Reading-2 (canonical world sizes, zoom is magnification). */
    font: number;
    countFont: number;
    icon: number;
    gap: number;
    padX: number;
    headerH: number;
    titleBarH: number;
}
export function computeCapsuleRenderMetrics(
    item: ContainerItemType,
    viewZoom: number,
    items: Record<string, CanvasItem>,
    isFocused: boolean,
): CapsuleRenderMetrics {
    // viewZoom no longer influences the capsule's intrinsic metrics —
    // zoom is applied at render time via the transform layer. Kept in
    // signature for caller-site stability.
    void viewZoom;
    let hasSubGroups = false;
    for (const c of Object.values(items)) {
        if (c?.type === 'container' && c.parentId === item.id) { hasSubGroups = true; break; }
    }
    const naturalW = computeNaturalTabScreenW(item, { hasSubGroups, isFocused });
    // Scale is derived from the container's geometry (same math as the
    // existing child vector-scale cascade: min of axis ratios against
    // authored). That way a drag on the expanded frame AND a drag on
    // the capsule both update the same thing — item.w / item.h — and
    // every derived representation (capsule, expanded frame, children)
    // stays in sync.
    const aw = item.authoredW || item.w || 1;
    const ah = item.authoredH || item.h || 1;
    const geomScale = Math.min(item.w / aw, item.h / ah);
    const capsuleScale = Math.max(0.3, Number.isFinite(geomScale) && geomScale > 0 ? geomScale : 1);
    const renderW = naturalW * capsuleScale;
    const font = 13 * capsuleScale;
    const countFont = 11 * capsuleScale;
    const icon = 12 * capsuleScale;
    const gap = 6 * capsuleScale;
    const padX = 12 * capsuleScale;
    const headerH = 28 * capsuleScale;
    const titleBarH = headerH;
    return { capsuleScale, naturalW, renderW, font, countFont, icon, gap, padX, headerH, titleBarH };
}

// World-px rectangle describing where a container is ACTUALLY rendered
// at the current zoom. Respects render mode:
//   - expanded: the raw item.x/y/w/h frame
//   - tab (collapsed / collapsed-visual): the capsule's collapsedW ×
//     titleBarH at item.x / item.y
//   - dotted: a DOT_SCREEN_PX/zoom square centered on item center
// Used by overlays (connection anchors, panel anchors, ghost
// indicators) so they track the visible shape instead of the
// invisible expanded bounds that would otherwise dangle below a
// capsule or out past a dot.
export function resolveContainerRenderRect(
    item: ContainerItemType,
    viewZoom: number,
    items: Record<string, CanvasItem>,
    semantic?: SemanticZoomInputs,
): { x: number; y: number; w: number; h: number } {
    const mode = getContainerRenderMode(item, viewZoom, items, semantic);
    const zoom = Math.max(0.01, viewZoom);
    if (mode === 'dotted') {
        const dotWorld = DOT_SCREEN_PX / zoom;
        return {
            x: item.x + item.w / 2 - dotWorld / 2,
            y: item.y + item.h / 2 - dotWorld / 2,
            w: dotWorld,
            h: dotWorld,
        };
    }
    if (mode === 'collapsed' || mode === 'collapsed-visual') {
        const metrics = computeCapsuleRenderMetrics(item, viewZoom, items, false);
        return { x: item.x, y: item.y, w: metrics.renderW, h: metrics.titleBarH };
    }
    return { x: item.x, y: item.y, w: item.w, h: item.h };
}

// Below this many screen-px of body height, the container can't
// show anything meaningful — the expanded header floats over a tiny
// invisible body, children degrade to pixel noise, and the whole
// frame looks broken. At that point we render AS IF collapsed
// (tab only) without touching state.collapsed. Zooming back in
// naturally returns to the expanded visual as the body crosses
// the threshold again.
export const BODY_VISIBILITY_THRESHOLD = 40;

// Render mode is a pure function of state + zoom. State is never
// mutated by this computation — it's purely a rendering decision.
//
//   'expanded'         → full frame with children visible.
//   'collapsed'        → user collapsed it via chevron; render tab.
//   'collapsed-visual' → state is expanded, but zoom is so far out
//                         that the body is unusable. Render tab.
//                         State stays collapsed:false — as zoom
//                         returns past the threshold the container
//                         pops back to 'expanded' automatically.
//   'dotted'           → further zoomed out than 'collapsed-visual'.
//                         Render a single 12-screen-px dot at the
//                         container's center; click zooms to fit.
//                         Hysteresis-safe: only fires on top of an
//                         already-collapsed state (user or zoom), so
//                         the two independent transitions (expanded→
//                         capsule and capsule→dot) each have their
//                         own stable boundary.
export type ContainerRenderMode = 'expanded' | 'collapsed' | 'collapsed-visual' | 'dotted';

// Below this screen-px width the container is rendered as a dot
// instead of a capsule. Only applies when the container is ALREADY
// in capsule mode — so the transition to dotted inherits whatever
// hysteresis zoom-collapsed uses for its own threshold.
export const DOT_TRIGGER_SCREEN_PX = 30;

// Screen-px diameter of the dot rendered in 'dotted' mode.
export const DOT_SCREEN_PX = 12;

// True when a loose (non-container) top-level item should render as a
// dot because it's too small at the current zoom to be meaningful —
// same screen threshold as the container dotted trigger. A text
// authored at fontSize 16 world-px renders at 0.32 screen-px at 2%
// zoom — indistinguishable from a stray pixel. Rendering it as a dot
// (and clustering with nearby dots) gives the overview a useful
// "something's here" marker instead of invisible dust.
//
// Never dots:
//   - The item currently in edit mode. Otherwise a T-click at low
//     zoom creates an empty text item whose ResizeObserver shrinks
//     w to 0 → which trips the dot check → which hides the edit
//     surface. User loses the text they're about to type.
//   - Empty text items. A text with no content has 0 width after
//     the DOM measures it — same hazard as above, even for items
//     that just lost edit focus without typing.
//   - The item currently being drawn (in-flight box / line / pen).
//     At pointer-down the shape starts at 1×1 and grows with the
//     drag — intermediate small sizes would trip the dot check
//     every frame and make the live preview flicker as a dot.
export function isLooseItemDottedAtZoom(
    item: CanvasItem,
    viewZoom: number,
    isEditing?: boolean,
    isDrawing?: boolean,
): boolean {
    if (item.type === 'container') return false;
    if (item.parentId != null) return false;
    if (isEditing) return false;
    if (isDrawing) return false;
    if (item.type === 'text' && !item.content) return false;
    // Defense against a stuck-dotted trap: if the item's stored dims
    // are nearly zero, a transient measurement glitch probably set
    // them (TextItem's ResizeObserver can see offsetWidth=0 during
    // a remount paint). If we dot the item, CanvasRenderer stops
    // rendering it → ResizeObserver can't re-measure → item stays
    // dotted forever. Treating sub-5-world-px items as "not dotted"
    // gives them a chance to re-render and re-measure to their real
    // content-driven size.
    if (item.w < 5 && item.h < 5) return false;
    const zoom = Math.max(0.01, viewZoom);
    // Text-specific rule: a short-content text (say "sa") auto-sizes
    // to a very narrow box via max-content CSS, so its maxDim × zoom
    // can be tiny even when its fontSize renders clearly readable on
    // screen. Use fontSize as the readability criterion instead — if
    // the font would render above a minimum screen-px, keep it as
    // text. Everything else falls through to the generic max-dim rule.
    if (item.type === 'text') {
        const TEXT_DOT_FONT_MIN_SCREEN_PX = 6;
        const fontScreen = (item.fontSize ?? 16) * zoom;
        return fontScreen < TEXT_DOT_FONT_MIN_SCREEN_PX;
    }
    const maxDim = Math.max(item.w, item.h);
    return maxDim * zoom < DOT_TRIGGER_SCREEN_PX;
}

// Semantic-zoom inputs. Callers that want the full spec behavior pass
// the transient maps from state; callers that only need a quick mode
// check (e.g. the hit-test path inside useCanvasInteraction during a
// drag) can omit them and get the same treatment as before the
// semantic-zoom feature landed — legacy-correct for those call sites.
export interface SemanticZoomInputs {
    zoomCollapsedIds?: Record<string, boolean>;
    userOverrideExpandedIds?: Record<string, boolean>;
}

export function getContainerRenderMode(
    item: ContainerItemType,
    viewZoom: number,
    items?: Record<string, CanvasItem>,
    semantic?: SemanticZoomInputs,
): ContainerRenderMode {
    // Spec: isCollapsed = (userCollapsed || zoomCollapsed) && !userOverrideExpanded
    // Nested groups (parentId != null) never have user-collapse — spec
    // A1(c): chevron only at depth 0, so there's no UI path to set it.
    // We treat any legacy `userCollapsed`/`collapsed=true` on a nested
    // container as false at render time, so old files that had a
    // nested group collapsed simply show it expanded (zoom-collapse can
    // still auto-tab it, and the magnifier still works).
    const anyIt: any = item;
    const isTopLevel = !item.parentId;
    const userCollapsed: boolean = isTopLevel
        ? (anyIt.userCollapsed ?? anyIt.collapsed ?? false)
        : false;
    const zoomCollapsed = !!semantic?.zoomCollapsedIds?.[item.id];
    const override = !!semantic?.userOverrideExpandedIds?.[item.id];
    const isCollapsed = (userCollapsed || zoomCollapsed) && !override;
    if (isCollapsed) {
        // Dotted promotion: if the container is already in capsule
        // mode AND its natural frame would render below
        // DOT_TRIGGER_SCREEN_PX at current zoom, show a dot instead
        // of the capsule. Gating on existing collapsed state gives us
        // free hysteresis — the transition into capsule uses the
        // zoom-collapsed watcher's own threshold pair, and we never
        // flip straight from expanded to dotted and back.
        const frameScreenW = item.w * Math.max(0.01, viewZoom);
        if (frameScreenW < DOT_TRIGGER_SCREEN_PX) return 'dotted';
        // Distinguish user-collapsed (explicit, chevron icon) from
        // zoom-collapsed (automatic, magnifier icon) via the existing
        // 'collapsed' / 'collapsed-visual' split. User-collapsed wins
        // visually because the user's intent is explicit; only the
        // purely-zoom-triggered case uses the visual variant.
        return userCollapsed ? 'collapsed' : 'collapsed-visual';
    }
    // Below-5% skip historically lived here to guarantee groups stay
    // visible as frames in overview mode. The semantic-zoom feature
    // replaces that with the capsule floor + auto-collapse pair: at
    // extreme zoom, groups auto-zoom-collapse (above branch) into a
    // min-size capsule. No separate skip needed. The fallback below is
    // kept only for legacy callers that don't yet pass `semantic`.
    if (!semantic) {
        if (viewZoom < 0.05) return 'expanded';
    }
    // Legacy body-visibility floor (kept as a sanity fallback per the
    // standing rule — additive to the new content-aware triggers).
    const bodyScreenH = Math.max(0, item.h - TITLE_BAR_HEIGHT) * Math.max(0.01, viewZoom);
    if (bodyScreenH < BODY_VISIBILITY_THRESHOLD) return 'collapsed-visual';
    // Nested-container cramped-headers rule — retained as an additive
    // trigger alongside the new content-aware zoom-collapse path.
    if (items) {
        let directNestedContainers = 0;
        for (const child of Object.values(items)) {
            if (child.parentId === item.id && child.type === 'container') directNestedContainers++;
        }
        if (directNestedContainers > 0) {
            const MIN_HEADER = 28;
            const requiredBody = (directNestedContainers + 1) * MIN_HEADER;
            if (bodyScreenH < requiredBody) return 'collapsed-visual';
        }
    }
    return 'expanded';
}

/** True for 'collapsed' and 'collapsed-visual' — capsule rendering.
 *  NOT true for 'dotted' (dot renders with its own dims). Call sites
 *  that want the broader "body-is-hidden" predicate should check
 *  `mode !== 'expanded'`. */
export function isTabMode(mode: ContainerRenderMode): boolean {
    return mode === 'collapsed' || mode === 'collapsed-visual';
}

/** True only for 'dotted'. No chrome, no resize handles. */
export function isDottedMode(mode: ContainerRenderMode): boolean {
    return mode === 'dotted';
}

// Module-level registry: container ids whose NEXT resize should NOT cascade
// to children. Used by "Fit to contents" where the container bounds are
// recomputed to match already-placed children — scaling children again in
// response would move them off-position. Entry is cleared after consumption.
const suppressNextResize = new Set<string>();
export function suppressContainerResizeScaling(id: string): void {
    suppressNextResize.add(id);
}

// Shared chrome-scale calculation.
//
// - `chromeScale` is the pure vector-scale of the group's chrome (current
//   h / authored h), clamped to [0.5, 3]. Used for the FRAME: its border
//   / background / radius scale with the group so the body is "part of
//   the picture" and proportional at any view zoom. Named `chromeScale`
//   (not `groupScale`) to leave the bare `scale` identifier free for
//   the stored uniform-scale field that Phase 2 Commit B will read from.
//
// - `titleScale` is what the HEADER uses. It floors `chromeScale` at a
//   minimum screen-px size so the title bar stays readable at extreme
//   zoom-out (16%, 5%, 2%, etc.). Header height / font / padding are
//   always at least the minimum — readability beats strict proportionality
//   per product decision. Same idea as resize handles' min-screen-px
//   floor.
export function computeContainerScales(item: ContainerItemType, viewZoom: number) {
    const authoredH = item.authoredH || item.h;
    const rawScale = item.h / Math.max(1, authoredH);
    const chromeScale = Math.max(0.5, Math.min(3, rawScale || 1));
    const z = Math.max(0.01, viewZoom);
    // Target: title bar renders at ≥ MIN_HEADER_SCREEN_PX on screen, at
    // any view zoom. title bar world height = TITLE_BAR_HEIGHT × titleScale,
    // rendered = title × z, so minimum titleScale = MIN_HEADER / (TB × z).
    const MIN_HEADER_SCREEN_PX = 28;
    // Also cap at MAX_HEADER_SCREEN_PX so a container viewed at 400%+
    // doesn't produce a 112-px-tall title bar (chromeScale=1 × 28 × 4).
    // Every scaled header value (titleBarH, font, icons, padding, gap,
    // separator) flows through titleScale, so capping here covers all
    // of them in one place.
    const MAX_HEADER_SCREEN_PX = 44;
    const minTitleScale = MIN_HEADER_SCREEN_PX / (TITLE_BAR_HEIGHT * z);
    const maxTitleScale = MAX_HEADER_SCREEN_PX / (TITLE_BAR_HEIGHT * z);
    const titleScale = Math.max(minTitleScale, Math.min(maxTitleScale, chromeScale));
    return { chromeScale, titleScale };
}

// Per-depth hue for nested group frames. First attempt cycled emerald
// → teal which was too close on a dark background at ~50% alpha — the
// hierarchy wasn't visible. v2 skips entirely outside the green
// spectrum for nested levels so every level reads as a clearly
// different frame even at low border alpha. Avoids amber (reserved for
// scope-locked) and plain emerald (reserved for focus / brand). RGB
// tuples so dashedBorderAlpha still modulates them. Loops at length 4.
const NESTED_FRAME_RGB: [number, number, number][] = [
    [16, 185, 129],   // emerald — depth 0 (brand default)
    [56, 189, 248],   // sky     — depth 1 (cool, distinct from emerald)
    [251, 113, 133],  // rose    — depth 2 (warm, distinct from sky)
    [192, 132, 252],  // violet  — depth 3 (between sky and rose)
];
function rgbForDepth(depth: number): [number, number, number] {
    return NESTED_FRAME_RGB[((depth % NESTED_FRAME_RGB.length) + NESTED_FRAME_RGB.length) % NESTED_FRAME_RGB.length];
}

/** Nesting depth — how many container ancestors this item has. 0 = top-
 *  level, 1 = inside one group, 2 = inside two, etc. Used to stack
 *  background opacity + border contrast so nested groups don't visually
 *  blend into their parents (spec Issue 2). */
function containerDepth(item: ContainerItemType, items: Record<string, CanvasItem>): number {
    let depth = 0;
    let cur: CanvasItem | undefined = item;
    const seen = new Set<string>();
    while (cur?.parentId && !seen.has(cur.parentId)) {
        seen.add(cur.parentId);
        const parent: CanvasItem | undefined = items[cur.parentId];
        if (!parent) break;
        if (parent.type === 'container') depth++;
        cur = parent;
    }
    return depth;
}

function ContainerItemViewImpl({ item, selected }: Props) {
    const { state, dispatch } = useCanvasStore();
    const isFocused = state.focusedContainerId === item.id;
    const depth = containerDepth(item, state.items);

    // Seed authoredW/H once per container. Baseline for vector-scale
    // children derivation + the container's own chromeScale calculations.
    useEffect(() => {
        if (item.authoredW && item.authoredH) return;
        dispatch({
            type: 'UPDATE_ITEM',
            id: item.id,
            patch: { authoredW: item.w, authoredH: item.h } as any,
        });
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // Frame must be at least as wide as its header's natural content
    // (chevron + title + count badge + icons). Otherwise a small group
    // (e.g. "Group 3" with a single-letter child) ends up with the
    // header content visually overflowing past the narrower dashed
    // frame — looks like the header and the body are different items.
    // Auto-grow item.w only. authoredW stays frozen at what the user
    // originally created — inflating it to preserve the w/authoredW
    // ratio would push authoredWMin (0.3 × authoredW) above the post-
    // grow item.w, causing the expanded resize handle to snap-jump on
    // first drag. Derived scale is min(w/authoredW, h/authoredH); since
    // h is unchanged, h/authoredH dominates and the capsule-chosen
    // scale survives the expand without authoredW manipulation.
    useEffect(() => {
        if (!item.authoredW || !item.authoredH) return;
        if (item.collapsed) return;
        let hasSubGroups = false;
        for (const c of Object.values(state.items)) {
            if (c?.type === 'container' && c.parentId === item.id) { hasSubGroups = true; break; }
        }
        const naturalHeaderW = computeNaturalTabScreenW(item, { hasSubGroups, isFocused });
        // Leave a 1-px tolerance so a tiny float mismatch doesn't loop.
        if (item.w >= naturalHeaderW - 1) return;
        dispatch({
            type: 'UPDATE_ITEM',
            id: item.id,
            patch: {
                w: naturalHeaderW,
            } as any,
        });
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [item.w, item.authoredW, item.title, item.scopeLocked, item.collapsed, state.items, isFocused]);

    // Semantic-zoom watcher. Evaluates content-aware thresholds against
    // the current zoom + items + this container's own geometry, and
    // dispatches zoomCollapsed/userOverrideExpanded transitions. Core
    // rules (all additive — ANY triggers collapse, ALL clear to expand):
    //   (a) Content readability: minTextSize × zoom < 6 → collapse;
    //       > 9 → re-expand. Hysteresis prevents boundary flicker.
    //       Fallback to smallest child dimension × zoom (20/30) for
    //       text-free groups; fallback to header font baseline for
    //       empty groups.
    //   (b) Body visibility floor (legacy, kept as sanity guard):
    //       body screen-h < BODY_VISIBILITY_THRESHOLD → collapse.
    //   (c) Nested-cramped-headers (legacy, kept): body too small to
    //       fit direct-nested group headers → collapse.
    //
    // Debounced to one animation frame via requestAnimationFrame —
    // during smooth zoom gestures (pinch/wheel) the effect re-runs many
    // times per frame but only the last scheduled rAF actually fires,
    // producing at most one dispatch per frame.
    //
    // Collapsing a user-collapsed group (userCollapsed=true) isn't
    // meaningful here — that state dominates the render-mode formula
    // already. Still compute zoomCollapsed for the "user uncollapsed
    // at low zoom" case so the correct icon appears on next render.
    useEffect(() => {
        const rafId = requestAnimationFrame(() => {
            const zoom = Math.max(0.01, state.view.zoom);
            const bodyScreenH = Math.max(0, item.h - TITLE_BAR_HEIGHT) * zoom;
            const hasText = hasTextDescendant(item.id, state.items);
            const reference = getReadabilityReference(
                item.id,
                state.items,
                state.lines,
                state.strokes,
            );
            const effective = reference * zoom;
            const collapseThreshold = hasText ? 6 : 20;
            const reexpandThreshold = hasText ? 9 : 30;
            const currentlyCollapsed = !!state.zoomCollapsedIds[item.id];
            // Text/dimension readability with hysteresis: stay collapsed
            // until crossing the re-expand threshold; stay expanded
            // until crossing the collapse threshold.
            const readabilityCollapse = currentlyCollapsed
                ? effective < reexpandThreshold
                : effective < collapseThreshold;
            // Legacy body-visibility floor (additive).
            const bodyCollapse = bodyScreenH < BODY_VISIBILITY_THRESHOLD;
            // Legacy nested-cramped-headers rule (additive).
            let directNestedContainers = 0;
            for (const child of Object.values(state.items)) {
                if (child.parentId === item.id && child.type === 'container') directNestedContainers++;
            }
            const crampedCollapse = directNestedContainers > 0
                && bodyScreenH < (directNestedContainers + 1) * 28;
            const shouldCollapse = readabilityCollapse || bodyCollapse || crampedCollapse;
            if (shouldCollapse !== currentlyCollapsed) {
                dispatch({ type: 'SET_ZOOM_COLLAPSED', id: item.id, collapsed: shouldCollapse });
                // When we're crossing back out of zoom-collapsed (going
                // to expanded) and an override was set, clear it — the
                // natural expansion takes over and override is no
                // longer needed (spec A5).
                if (!shouldCollapse && state.userOverrideExpandedIds[item.id]) {
                    dispatch({ type: 'SET_OVERRIDE_EXPANDED', id: item.id, overridden: false });
                }
            }
        });
        return () => cancelAnimationFrame(rafId);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [
        item.id, item.w, item.h, state.view.zoom, state.items,
        state.lines, state.strokes,
        state.zoomCollapsedIds, state.userOverrideExpandedIds,
    ]);

    // Vector-style group scaling, drift-free.
    //
    // Each child stores its authoredInParent { relX, relY, w, h, fontSize,
    // authoredWidth } — the geometry at the moment it was placed inside
    // this container. On every container resize, we compute a single
    // scale = container.currentW / container.authoredW and DERIVE every
    // child's x/y/w/h/fontSize/authoredWidth from authoredInParent × scale.
    //
    // Because the baseline never changes (authoredInParent is frozen),
    // a stretch-then-shrink cycle returns children to EXACTLY their
    // authored pixel layout. No floating-point drift, no baked wrap
    // widths, no orphan handles. True vector scaling.
    useEffect(() => {
        if (item.collapsed) return;
        // Fit-to-contents reset: consume the flag, skip one scale pass.
        if (suppressNextResize.has(item.id)) {
            suppressNextResize.delete(item.id);
            return;
        }
        if (!item.authoredW || !item.authoredH) return;
        // Uniform scale = min(scaleW, scaleH). Using w-only was leaving
        // children at a different scale from the container's height, so
        // if the container ever accumulated a non-uniform aspect (possible
        // across several collapse/expand/resize cycles, or a pre-lockHeight
        // state from an older build), children could overflow the
        // vertical bounds and appear outside the frame. Uniform min-scale
        // guarantees anchor.relX × scale ≤ authoredW × scaleW = item.w
        // AND anchor.relY × scale ≤ authoredH × scaleH = item.h — so a
        // child placed within authored bounds stays inside at any aspect.
        const scaleW = item.w / item.authoredW;
        const scaleH = item.h / item.authoredH;
        const scale = Math.min(scaleW, scaleH);
        // Track the rightmost / bottommost point any clamped child will
        // occupy. If a child TRULY exceeds parent bounds, grow to fit —
        // matches the drag-end auto-expand but running at render-time
        // for all overflow sources (header clamp, child resize, zoom
        // change). Initial values = parent's own right/bottom so we
        // only grow when a child pushes past them. Earlier version
        // added PAD unconditionally, which made `requiredW = item.w +
        // PAD > item.w` every render → unbounded grow feedback loop.
        const parentRight = item.x + item.w;
        const parentBottom = item.y + item.h;
        let overflowRight = parentRight;
        let overflowBottom = parentBottom;
        for (const child of Object.values(state.items)) {
            if (!child || child.parentId !== item.id) continue;
            let anchor = child.authoredInParent;
            if (!anchor) {
                const invScale = scale > 0 ? 1 / scale : 1;
                const seeded: NonNullable<CanvasItem['authoredInParent']> = {
                    relX: (child.x - item.x) * invScale,
                    relY: (child.y - item.y) * invScale,
                    w: child.w * invScale,
                    h: child.h * invScale,
                };
                if (child.type === 'text') {
                    seeded.fontSize = child.fontSize * invScale;
                    seeded.authoredWidth = (child.authoredWidth ?? child.w) * invScale;
                }
                if (child.type === 'box') {
                    seeded.borderWidth = child.borderWidth * invScale;
                }
                dispatch({ type: 'UPDATE_ITEM', id: child.id, patch: { authoredInParent: seeded } as any });
                anchor = seeded;
            } else if (child.type === 'box' && anchor.borderWidth == null) {
                // Legacy anchor from before borderWidth was tracked in
                // authoredInParent. Backfill using current borderWidth /
                // current scale so the first scale pass preserves the
                // visible thickness, then subsequent scales will grow /
                // shrink it proportionally.
                const invScale = scale > 0 ? 1 / scale : 1;
                const migrated = {
                    ...anchor,
                    borderWidth: child.borderWidth * invScale,
                };
                dispatch({ type: 'UPDATE_ITEM', id: child.id, patch: { authoredInParent: migrated } as any });
                anchor = migrated;
            } else if (child.type === 'text' && anchor.authoredWidth == null) {
                const invScale = scale > 0 ? 1 / scale : 1;
                const migrated = {
                    ...anchor,
                    authoredWidth: (child.authoredWidth ?? child.w) * invScale,
                };
                dispatch({ type: 'UPDATE_ITEM', id: child.id, patch: { authoredInParent: migrated } as any });
                anchor = migrated;
            }
            const nextX = item.x + anchor.relX * scale;
            // Reserve the header's world-px zone at the top of the
            // container so children never visually slip under the title
            // bar. Previously used chromeScale only — which at low view
            // zoom left the rendered header (screen-floored at 28 px =
            // up to 1400 world-px at 2%) covering its first children.
            // User reported nested group's header landed under the
            // parent's header at 2% zoom. Now headerWorldH also honors
            // the screen-px floor: max(world-scale-derived, screen-floor
            // / zoom). At normal zoom the world-scale path wins
            // (unchanged behavior); at low zoom the screen-floor path
            // wins and pushes children below the rendered header.
            const MIN_HEADER_SCREEN_PX = 28;
            const viewZoomSafe = Math.max(0.01, state.view.zoom);
            const headerWorldH = Math.max(
                TITLE_BAR_HEIGHT * scale,
                MIN_HEADER_SCREEN_PX / viewZoomSafe,
            );
            const rawNextY = item.y + anchor.relY * scale;
            const nextY = Math.max(rawNextY, item.y + headerWorldH);
            const nextW = anchor.w * scale;
            const nextH = anchor.h * scale;
            // Track this child's AUTHORED (un-clamped) extent for the
            // parent auto-grow check. Using the post-header-clamp nextY
            // here would let a transient zoom-dependent clamp
            // (headerWorldH = 28 screen-px / viewZoom, which at 2% zoom
            // becomes ~1400 world-px) grow the parent permanently — the
            // parent then stayed bloated after zooming back in because
            // the SHRINK path doesn't exist. rawNextY reflects the
            // child's stable authored position and doesn't include the
            // render-time header adjustment.
            const childRight = nextX + nextW;
            const childBottom = rawNextY + nextH;
            if (childRight > overflowRight) overflowRight = childRight;
            if (childBottom > overflowBottom) overflowBottom = childBottom;
            const patch: any = {};
            if (Math.abs(nextX - child.x) > 0.01) patch.x = nextX;
            if (Math.abs(nextY - child.y) > 0.01) patch.y = nextY;
            if (Math.abs(nextW - child.w) > 0.01) patch.w = nextW;
            if (Math.abs(nextH - child.h) > 0.01) patch.h = nextH;
            if (child.type === 'text') {
                if (anchor.fontSize != null) {
                    const nextFs = anchor.fontSize * scale;
                    if (Math.abs(nextFs - child.fontSize) > 0.01) patch.fontSize = nextFs;
                }
                if (anchor.authoredWidth != null) {
                    // Subpixel cushion: glyph widths don't scale perfectly
                    // linearly with fontSize (hinting / kerning / rounding),
                    // so an authoredWidth that exactly matches the text's
                    // natural width at scale=1 can become 0.5-1 px too narrow
                    // at smaller scales — which tips a single-line string into
                    // wrap mid-resize. +2 world-px is below visible threshold
                    // at any realistic zoom but large enough to absorb the
                    // worst-case rounding error.
                    const nextAw = anchor.authoredWidth * scale + 2;
                    if (child.authoredWidth == null || Math.abs(nextAw - child.authoredWidth) > 0.01) {
                        patch.authoredWidth = nextAw;
                    }
                }
            }
            if (child.type === 'box' && anchor.borderWidth != null) {
                // Vector-scale the border: stays at the same proportional
                // thickness relative to the box at any container scale.
                // Minimum of 0.5 world-px so the border doesn't vanish
                // during extreme down-scaling (browsers floor to 1 device
                // pixel on render anyway; we keep state sane).
                const nextBW = Math.max(0.5, anchor.borderWidth * scale);
                if (Math.abs(nextBW - child.borderWidth) > 0.01) patch.borderWidth = nextBW;
            }
            if (Object.keys(patch).length) {
                dispatch({ type: 'UPDATE_ITEM', id: child.id, patch });
            }
        }

        // Drawings (straight lines + pen strokes) participate in the same
        // vector-scale system. authoredInParent stores endpoints / points
        // RELATIVE to container (x, y) so a resize re-derives absolute
        // world coords. First-pass seed uses the current geometry × invScale.
        const invScale = scale > 0 ? 1 / scale : 1;
        for (const [lid, ln] of Object.entries(state.lines)) {
            if (ln.parentId !== item.id) continue;
            let anchor = ln.authoredInParent;
            if (!anchor) {
                anchor = {
                    x1: (ln.x1 - item.x) * invScale,
                    y1: (ln.y1 - item.y) * invScale,
                    x2: (ln.x2 - item.x) * invScale,
                    y2: (ln.y2 - item.y) * invScale,
                    width: ln.width * invScale,
                };
                dispatch({ type: 'UPDATE_LINE', id: lid, patch: { authoredInParent: anchor } });
            }
            const nextX1 = item.x + anchor.x1 * scale;
            const nextY1 = item.y + anchor.y1 * scale;
            const nextX2 = item.x + anchor.x2 * scale;
            const nextY2 = item.y + anchor.y2 * scale;
            const nextWidth = Math.max(0.5, anchor.width * scale);
            const patch: any = {};
            if (Math.abs(nextX1 - ln.x1) > 0.01) patch.x1 = nextX1;
            if (Math.abs(nextY1 - ln.y1) > 0.01) patch.y1 = nextY1;
            if (Math.abs(nextX2 - ln.x2) > 0.01) patch.x2 = nextX2;
            if (Math.abs(nextY2 - ln.y2) > 0.01) patch.y2 = nextY2;
            if (Math.abs(nextWidth - ln.width) > 0.01) patch.width = nextWidth;
            if (Object.keys(patch).length) {
                dispatch({ type: 'UPDATE_LINE', id: lid, patch });
            }
        }
        for (const [sid, st] of Object.entries(state.strokes)) {
            if (st.parentId !== item.id) continue;
            let anchor = st.authoredInParent;
            if (!anchor) {
                anchor = {
                    points: st.points.map(p => ({ ...p, x: (p.x - item.x) * invScale, y: (p.y - item.y) * invScale })),
                    width: st.width * invScale,
                };
                dispatch({ type: 'UPDATE_STROKE', id: sid, patch: { authoredInParent: anchor } });
            }
            const nextPoints = anchor.points.map(p => ({
                ...p,
                x: item.x + p.x * scale,
                y: item.y + p.y * scale,
            }));
            const nextWidth = Math.max(0.5, anchor.width * scale);
            // Cheap equality check — compare first/last + length; full point
            // compare is quadratic and almost always redundant after first
            // settle. If they differ, dispatch. (False positives are benign:
            // UPDATE_STROKE with identical points is a no-op render-wise.)
            const prev = st.points;
            const differs =
                prev.length !== nextPoints.length
                || (prev.length > 0 && (
                    Math.abs(prev[0].x - nextPoints[0].x) > 0.01
                    || Math.abs(prev[0].y - nextPoints[0].y) > 0.01
                    || Math.abs(prev[prev.length - 1].x - nextPoints[nextPoints.length - 1].x) > 0.01
                    || Math.abs(prev[prev.length - 1].y - nextPoints[nextPoints.length - 1].y) > 0.01
                ));
            const patch: any = {};
            if (differs) patch.points = nextPoints;
            if (Math.abs(nextWidth - st.width) > 0.01) patch.width = nextWidth;
            if (Object.keys(patch).length) {
                dispatch({ type: 'UPDATE_STROKE', id: sid, patch });
            }
        }
        // Grow parent ONLY when a child actually overflowed, and only
        // on the axes where it overflowed. PAD applied once, on the
        // axis being grown, so the frame shows margin around the
        // furthest child. authoredW/H grow alongside w/h so scale
        // stays at 1 and the next render doesn't loop.
        const OVERFLOW_PAD = 16;
        const growPatch: any = {};
        if (overflowRight > parentRight + 0.5) {
            const newW = overflowRight + OVERFLOW_PAD - item.x;
            growPatch.w = newW;
            growPatch.authoredW = newW;
        }
        if (overflowBottom > parentBottom + 0.5) {
            const newH = overflowBottom + OVERFLOW_PAD - item.y;
            growPatch.h = newH;
            growPatch.authoredH = newH;
        }
        if (Object.keys(growPatch).length) {
            dispatch({ type: 'UPDATE_ITEM', id: item.id, patch: growPatch });
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [item.w, item.h, item.authoredW, item.authoredH, item.id, item.collapsed]);
    // NOTE: state.view.zoom intentionally NOT a dep. The header-height
    // floor below uses view zoom for rendering decisions, but if it also
    // wrote different child positions on every zoom change, child geometry
    // would drift between view zooms — visible as text wrap shifting and
    // items re-positioning at extreme zoom levels. The float in headerWorldH
    // only matters at very low zoom (<10%) to keep nested headers from
    // stacking; at normal zooms TITLE_BAR_HEIGHT * scale wins anyway, so
    // dropping the dep doesn't change normal-zoom behavior.

    const { chromeScale } = computeContainerScales(item, state.view.zoom);
    const borderW = Math.max(0.5, (isFocused ? 2 : 1) * chromeScale);
    const shadowW = Math.max(1, 3 * chromeScale);

    // Render mode drives the visible layout — may be 'collapsed-visual'
    // (state.collapsed=false but zoom is too low for the body to be
    // useful). State is never mutated here; the mode is a pure fn of
    // state + zoom. As the user zooms back in, mode flips to 'expanded'
    // automatically and the frame grows back.
    const mode = getContainerRenderMode(item, state.view.zoom, state.items, {
        zoomCollapsedIds: state.zoomCollapsedIds,
        userOverrideExpandedIds: state.userOverrideExpandedIds,
    });
    const tabMode = isTabMode(mode);
    const renderW = tabMode ? getCollapsedRenderW(item, state.view.zoom) : item.w;
    // Tab-mode height: use the SAME capsule-aware titleBarH the header uses.
    // Previously this computed a chrome-based titleBarH (clamped [0.5, 3])
    // which diverged from the header's capsule-scale-based titleBarH at
    // higher zoom — the frame's dashed border ended short of the visible
    // header, and the selection + header extended below it.
    const renderH = tabMode
        ? computeCapsuleRenderMetrics(item, state.view.zoom, state.items, isFocused).titleBarH
        : item.h;

    // Smooth expand / collapse animation. CSS transition on width+height
    // is enabled ONLY during the short window right after the user
    // toggles `collapsed`, then removed — so a regular resize drag
    // (which changes w/h every frame) isn't interpolated and doesn't
    // flicker. Mode flips driven by ZOOM (collapsed-visual) are NOT
    // animated on purpose: zooming is a continuous gesture and users
    // want the tab to appear the instant the body drops below the
    // threshold, not lag 250ms behind.
    const prevCollapsedRef = useRef(item.collapsed);
    const [animatingCollapse, setAnimatingCollapse] = React.useState(false);
    useEffect(() => {
        if (prevCollapsedRef.current === item.collapsed) return;
        prevCollapsedRef.current = item.collapsed;
        setAnimatingCollapse(true);
        const t = window.setTimeout(() => setAnimatingCollapse(false), 260);
        return () => window.clearTimeout(t);
    }, [item.collapsed]);

    // Nested-group visual contrast (spec Issue 2). Each level of nesting
    // increases the frame's background opacity so deeper groups visually
    // "recede" into their parents. Border color gains opacity with depth
    // for the same reason — an inner group's border reads clearly against
    // the outer group's body. Floors / ceilings prevent runaway styling
    // at absurdly deep nesting. Enforce a 2-world-px minimum border so
    // the frame never fades to invisibility at low zoom.
    const bgOpacity = Math.min(0.4, 0.12 + depth * 0.06);
    // Theme-aware frame fills. Prior hardcoded `rgba(18,18,26,...)` only
    // worked on dark canvases — on a light canvas the frame read as a
    // heavy black well; on matching-dark canvases it disappeared into
    // the background with only the dashed border visible. Derive the
    // tint direction from the canvas luminance: dark canvas gets a
    // slightly-lighter overlay, light canvas gets a slightly-darker one.
    // Alpha accumulates with nesting depth so inner groups stay
    // distinguishable against their parent.
    const canvasBg = useGridSettings().background;
    const canvasIsDark = isDarkBackground(canvasBg);
    const frameTintRgb = canvasIsDark ? '255,255,255' : '0,0,0';
    const bodyTintAlpha = Math.min(0.14, 0.05 + depth * 0.03);
    const titleBarTintAlpha = Math.min(0.22, 0.10 + depth * 0.03);
    // Nested frames now start at a much higher alpha (0.75) than the
    // top-level default (0.4) so the inner group reads louder than the
    // outer. User reported that teal + 0.5 alpha on a dark background
    // was nearly invisible against an emerald parent. At depth 0 we
    // keep the subtle default; everything deeper jumps straight to
    // high-contrast and keeps climbing.
    const dashedBorderAlpha = depth === 0
        ? 0.4
        : Math.min(0.95, 0.75 + (depth - 1) * 0.08);
    const [dr, dg, db] = rgbForDepth(depth);
    const defaultDashedBorder = `rgba(${dr},${dg},${db},${dashedBorderAlpha})`;
    // Historical group creation paths (groupSelection, agent canvas
    // tools) bake a fixed emerald borderColor onto every new container.
    // That value used to equal "the default," but the depth-based
    // palette now owns defaulting — so a hardcoded emerald borderColor
    // was preventing nested groups from getting their sky/rose/violet
    // hue. Treat those known-default strings as "no override" and fall
    // through to the depth default. Any genuinely custom color set by
    // the user still wins. Extend DEFAULT_BORDER_COLORS if future
    // creation paths bake new literals.
    const DEFAULT_BORDER_COLORS = new Set<string>([
        'rgba(16,185,129,0.35)',
        'rgba(16,185,129,0.5)',
        'rgba(16,185,129,0.4)',
    ]);
    const hasCustomBorder = item.borderColor
        && !DEFAULT_BORDER_COLORS.has(item.borderColor);
    const effectiveBorderColor = isFocused
        ? '#10b981'
        : (item.scopeLocked ? '#f5a623' : (hasCustomBorder ? item.borderColor : defaultDashedBorder));
    // Nested frames: bump the floor by 1 world-px per depth so the
    // child's outline reads thicker than the parent's. Caps at 4 so
    // deeply-nested groups don't get absurdly heavy borders. Then
    // screen-clamp both directions: min 1.5 screen-px so the frame
    // never disappears at extreme zoom-out (at 2% view zoom, a
    // 2 world-px border was 0.04 screen-px = invisible, which is the
    // "no borders at all" bug the user reported); max 6 screen-px so
    // 400%+ views don't produce a chunky 16-px-thick frame.
    const z = Math.max(0.01, state.view.zoom);
    const nominalBorderW = Math.max(borderW, 2 + Math.min(2, depth));
    const MIN_BORDER_SCREEN_PX = 1.5;
    const MAX_BORDER_SCREEN_PX = 6;
    const effectiveBorderW = Math.min(
        MAX_BORDER_SCREEN_PX / z,
        Math.max(MIN_BORDER_SCREEN_PX / z, nominalBorderW),
    );
    // Dotted mode: DotClusterLayer handles rendering (so nearby dots
    // cluster into a single count-badged dot instead of stacking
    // individually). This component just steps aside.
    if (isDottedMode(mode)) return null;

    const style: React.CSSProperties = {
        position: 'absolute',
        left: item.x,
        top: item.y,
        width: renderW,
        height: renderH,
        transition: animatingCollapse
            ? 'width 250ms cubic-bezier(0.22, 1, 0.36, 1), height 250ms cubic-bezier(0.22, 1, 0.36, 1)'
            : undefined,
        border: `${effectiveBorderW}px ${isFocused ? 'solid' : 'dashed'} ${effectiveBorderColor}`,
        borderRadius: Math.round(10 * Math.min(1.5, chromeScale)),
        background: isFocused
            ? 'rgba(16,185,129,0.08)'
            : `rgba(${frameTintRgb},${bodyTintAlpha})`,
        boxShadow: isFocused
            ? `0 0 0 ${shadowW}px rgba(16,185,129,0.3)`
            : selected ? `0 0 0 ${shadowW}px rgba(16,185,129,0.22)` : undefined,
        pointerEvents: 'auto',
        overflow: 'hidden',
    };

    return (
        <div
            data-canvas-item={item.id}
            style={style}
            className="no-drag"
            onDoubleClick={(e) => {
                if (isFocused) return;
                e.stopPropagation();
                dispatch({ type: 'SET_FOCUSED_CONTAINER', id: item.id });
            }}
        />
    );
}

// The title bar + resize handles, rendered as a SEPARATE top-layer overlay
// by CanvasRenderer so it always sits above child items. Also positions
// the interactive controls so they're reachable regardless of child
// stacking order.
function ContainerHeaderViewImpl({ item, childCount, selected }: Props) {
    const { state, dispatch } = useCanvasStore();
    const inputRef = useRef<HTMLInputElement>(null);
    // Mirror the body's theme-aware tint logic so the title-bar strip
    // reads correctly on both light and dark canvases. Prior hardcoded
    // dark navy looked wrong on a light canvas and disappeared on a
    // matching-dark canvas. Title bar uses a slightly heavier alpha than
    // the body so it still reads as a distinct strip (the "header" vs
    // "content" boundary) at any theme.
    const canvasBgForHeader = useGridSettings().background;
    const headerCanvasIsDark = isDarkBackground(canvasBgForHeader);
    const headerTintRgb = headerCanvasIsDark ? '255,255,255' : '0,0,0';
    // Header text + icon colors tied to the SAME tonal direction as the
    // strip fill. On a light canvas the strip is a subtle darker tint,
    // so text should be dark; on a dark canvas, text should be light.
    // Using the shared tint color with per-element alpha — one source
    // of truth, no hardcoded #e8e8ed / text-white classes that would
    // disappear on the wrong theme.
    const headerInkPrimary = `rgba(${headerTintRgb},0.9)`;   // title
    const headerInkMeta = `rgba(${headerTintRgb},0.45)`;     // "2 ITEMS"
    const headerInkIcon = `rgba(${headerTintRgb},0.55)`;     // chevron / magnifier / lock (unlocked)
    // Manual double-click tracker on the title span. Tracks the time of
    // the previous pointerdown so the second rapid click can fire the
    // rename trigger directly, bypassing any pointer-capture quirks that
    // would otherwise swallow the native dblclick event.
    const titleDblRef = useRef<number>(0);
    const isFocused = state.focusedContainerId === item.id;
    const renaming = state.renamingContainerId === item.id;
    // Depth-aware header accent so the title bar's bottom separator
    // matches the frame color + thickness. Previously a flat 1px white
    // 6%-alpha line, which looked disconnected from a 3-4px colored
    // dashed frame. Now the separator is the same hue, same alpha, and
    // scales its thickness with depth (capped) just like the frame.
    const headerDepth = containerDepth(item, state.items);
    const [hdr, hdg, hdb] = rgbForDepth(headerDepth);
    const headerSeparatorAlpha = headerDepth === 0
        ? 0.4
        : Math.min(0.95, 0.75 + (headerDepth - 1) * 0.08);
    // Same screen-px clamp as the frame border so the header separator
    // stays visible at extreme zoom-out (was invisible at 2% view) and
    // doesn't balloon at 400%+.
    const nominalSeparatorW = 2 + Math.min(2, headerDepth);
    const headerZ = Math.max(0.01, state.view.zoom);
    const headerSeparatorW = Math.min(
        6 / headerZ,
        Math.max(1.5 / headerZ, nominalSeparatorW),
    );
    const headerSeparatorColor = `rgba(${hdr},${hdg},${hdb},${headerSeparatorAlpha})`;
    const setRenaming = (on: boolean) => {
        dispatch({ type: 'SET_RENAMING_CONTAINER', id: on ? item.id : null });
    };
    useEffect(() => {
        if (renaming && inputRef.current) {
            inputRef.current.focus();
            inputRef.current.select();
        }
    }, [renaming]);

    const { titleScale } = computeContainerScales(item, state.view.zoom);

    const toggleCollapse = (e: React.MouseEvent) => {
        e.stopPropagation();
        const mode = getContainerRenderMode(
            item,
            state.view.zoom,
            state.items,
            { zoomCollapsedIds: state.zoomCollapsedIds, userOverrideExpandedIds: state.userOverrideExpandedIds },
        );
        // Spec transitions for the chevron (top-level only):
        //   expanded → user-collapse (userCollapsed=true, override=false)
        //   collapsed (user) → uncollapse (userCollapsed=false, override=false)
        //   collapsed-visual (zoom) → handled by the magnifier button,
        //     not chevron. This path shouldn't be reachable now because
        //     the chevron renders only in 'expanded' or 'collapsed' modes.
        if (mode === 'collapsed') {
            dispatch({
                type: 'UPDATE_ITEM',
                id: item.id,
                patch: { collapsed: false, userCollapsed: false } as any,
            });
            dispatch({ type: 'SET_OVERRIDE_EXPANDED', id: item.id, overridden: false });
        } else if (mode === 'expanded') {
            // Expanded → user-collapse. Capsule width is now auto-fit
            // to natural content × the group's uniform scale (derived
            // from item.w / authoredW). No collapsedW seeding needed —
            // that field is legacy/unused by the render path. Toggle
            // just flips the user-collapse bit and clears any active
            // override so fresh intent wins.
            dispatch({
                type: 'UPDATE_ITEM',
                id: item.id,
                patch: {
                    collapsed: true,
                    userCollapsed: true,
                } as any,
            });
            dispatch({ type: 'SET_OVERRIDE_EXPANDED', id: item.id, overridden: false });
        }
    };

    // Magnifier click — available only when the group is zoom-collapsed
    // (mode === 'collapsed-visual'). Sets the override flag so the
    // group expands in place at the current zoom. Spec: "Clicking the
    // magnifier on a zoom-collapsed group expands it in place at the
    // current zoom level." No view animation.
    const activateOverride = (e: React.MouseEvent) => {
        e.stopPropagation();
        dispatch({ type: 'SET_OVERRIDE_EXPANDED', id: item.id, overridden: true });
        // Clear selection on expand — same reasoning as the dot-cluster
        // click-to-zoom path. Once the user opens a group to look inside,
        // any prior selection (often the group itself or stale nested
        // items from before the collapse) is no longer the thing they
        // want to act on; leaving it set keeps stray formatting toolbars
        // floating over the fresh contents.
        dispatch({ type: 'SELECT', ids: [] });
    };

    const toggleLock = (e: React.MouseEvent) => {
        e.stopPropagation();
        dispatch({ type: 'UPDATE_ITEM', id: item.id, patch: { scopeLocked: !item.scopeLocked } });
    };

    // Header width follows the rendered frame width. tabMode covers
    // both real collapse and the zoom-driven collapsed-visual mode —
    // in either case we render the cosmetic tab (width = collapsedW
    // floored at MIN_COLLAPSED_SCREEN_PX). When genuinely expanded,
    // width = real w.
    const mode = getContainerRenderMode(item, state.view.zoom, state.items, {
        zoomCollapsedIds: state.zoomCollapsedIds,
        userOverrideExpandedIds: state.userOverrideExpandedIds,
    });
    const tabMode = isTabMode(mode);
    const renderW = tabMode ? getCollapsedRenderW(item, state.view.zoom) : item.w;

    // Capsule metrics for tab mode — shared helper ensures frame (in
    // ContainerItemView) and header agree on dimensions. Expanded mode
    // keeps the legacy titleScale-based sizing for its chrome package.
    // Capsule scale floors at 0.3 (below that the content floors kick
    // in — 7-px font etc.); no upper cap so drag is true aspect-lock
    // and the whole capsule enlarges/shrinks proportionally. Width /
    // font / icons / pad / gap / height all derive from capsuleScale
    // — one slider (width drag) drives the whole tab uniformly.
    const zoom = Math.max(0.01, state.view.zoom);
    const capsuleMetrics = tabMode
        ? computeCapsuleRenderMetrics(item, state.view.zoom, state.items, isFocused)
        : null;
    // Sub-group menu visibility gate, used in the render below. The
    // capsule helper computes this internally but doesn't return it —
    // cheap to re-derive here rather than widening the return type.
    let hasSubGroups = false;
    for (const c of Object.values(state.items)) {
        if (c?.type === 'container' && c.parentId === item.id) { hasSubGroups = true; break; }
    }

    // Convert to WORLD px for CSS in the transform layer.
    const titleBarH = capsuleMetrics
        ? capsuleMetrics.titleBarH
        : Math.round(TITLE_BAR_HEIGHT * titleScale);
    // Capsule metrics are already in WORLD-px — no /zoom division needed.
    // At render time the transform layer multiplies by zoom, so text
    // and icons scale with zoom like any other canvas content.
    // Expanded headers keep the legacy titleScale-based sizing.
    const titleFontSize = capsuleMetrics ? capsuleMetrics.font : 11 * titleScale;
    const titleMetaFontSize = capsuleMetrics ? capsuleMetrics.countFont : 10 * titleScale;
    const lockIconSize = capsuleMetrics ? capsuleMetrics.icon : 10 * titleScale;
    const chevronIconSize = capsuleMetrics ? capsuleMetrics.icon : 12 * titleScale;
    const exitIconSize = capsuleMetrics ? capsuleMetrics.icon : 10 * titleScale;
    const subMenuIconSize = capsuleMetrics ? capsuleMetrics.icon : 10 * titleScale;
    const headerGap = capsuleMetrics ? capsuleMetrics.gap : 6 * titleScale;
    const headerPadX = capsuleMetrics ? capsuleMetrics.padX : 8 * titleScale;
    // Animate header in sync with the frame during collapse/expand.
    const prevCollapsedRef = useRef(item.collapsed);
    const [animatingCollapse, setAnimatingCollapse] = React.useState(false);
    useEffect(() => {
        if (prevCollapsedRef.current === item.collapsed) return;
        prevCollapsedRef.current = item.collapsed;
        setAnimatingCollapse(true);
        const t = window.setTimeout(() => setAnimatingCollapse(false), 260);
        return () => window.clearTimeout(t);
    }, [item.collapsed]);

    // Dot mode: no header rendered — the dot itself is the entire visible
    // representation. Returned AFTER all hooks above so the hook order
    // stays consistent on every render regardless of mode. React crashes
    // with "rendered fewer hooks than expected" if an early return
    // upstream of a hook causes a mode-flip mid-gesture (which was the
    // crash in the first tier-3 attempt).
    if (isDottedMode(mode)) return null;

    // Title-bar div. Positioned absolutely at the container's top-left at
    // world coords — rendered inside the world-transform layer alongside
    // items, but AFTER them in DOM order so it always visually stacks on
    // top of children (and its own container frame).
    const headerStyle: React.CSSProperties = {
        position: 'absolute',
        left: item.x,
        top: item.y,
        width: renderW,
        height: titleBarH,
        transition: animatingCollapse
            ? 'width 250ms cubic-bezier(0.22, 1, 0.36, 1)'
            : undefined,
        padding: `0 ${headerPadX}px`,
        background: item.scopeLocked
            // Scope-locked keeps an amber-tinted strip in both themes —
            // the warm hue is the "locked" signal, independent of canvas.
            ? `rgba(245,158,11,${Math.min(0.30, 0.18 + headerDepth * 0.03)})`
            : `rgba(${headerTintRgb},${Math.min(0.22, 0.10 + headerDepth * 0.03)})`,
        borderBottom: tabMode ? 'none' : `${headerSeparatorW}px dashed ${headerSeparatorColor}`,
        borderTopLeftRadius: Math.round(10 * Math.min(1.5, titleScale)),
        borderTopRightRadius: Math.round(10 * Math.min(1.5, titleScale)),
        borderBottomLeftRadius: tabMode ? Math.round(10 * Math.min(1.5, titleScale)) : 0,
        borderBottomRightRadius: tabMode ? Math.round(10 * Math.min(1.5, titleScale)) : 0,
        display: 'flex',
        alignItems: 'center',
        gap: headerGap,
        color: headerInkPrimary,
        fontSize: titleFontSize,
        fontFamily: 'Outfit, system-ui, sans-serif',
        fontWeight: 500,
        letterSpacing: '0.02em',
        pointerEvents: 'auto',
        // Title must always be legible regardless of container width — a
        // narrow group was showing "G…" instead of "Group 2". Header
        // keeps its renderW-sized background but content (long title,
        // badge, icons) is allowed to visibly extend past the right
        // edge when the container is too narrow to fit the chrome.
        overflow: 'visible',
        whiteSpace: 'nowrap',
    };

    return (
        <>
            <div
                data-canvas-item={item.id}
                style={headerStyle}
                className="no-drag"
            >
                {/* Collapse / expand control.
                    - Chevron (top-level only): user-initiated collapse
                      for the user-collapsed (→expand) and expanded
                      (→collapse) states. Nested groups keep no chevron
                      by design (spec A1c) — user-initiated collapse
                      doesn't exist at depth > 0.
                    - Magnifier (any depth): rendered only when the group
                      is zoom-collapsed (mode === 'collapsed-visual').
                      Clicking sets the override flag so the group
                      expands in place. Nested groups get this too so
                      auto-collapsed descendants remain inspectable
                      without zooming the whole canvas.
                    Both icons share this slot — never shown together. */}
                {mode === 'collapsed-visual' ? (
                    <button
                        onPointerDown={(e) => e.stopPropagation()}
                        onClick={activateOverride}
                        className="flex items-center justify-center transition-colors"
                        style={{ color: headerInkIcon }}
                        title={t('zoom.expand.tooltip')}
                    >
                        <ZoomIn size={Math.round(chevronIconSize)} />
                    </button>
                ) : headerDepth === 0 ? (
                    <button
                        onPointerDown={(e) => e.stopPropagation()}
                        onClick={toggleCollapse}
                        className="flex items-center justify-center transition-colors"
                        style={{ color: headerInkIcon }}
                        title={mode === 'collapsed' ? 'Expand' : 'Collapse'}
                    >
                        {tabMode
                            ? <ChevronRight size={Math.round(chevronIconSize)} />
                            : <ChevronDown size={Math.round(chevronIconSize)} />}
                    </button>
                ) : null}
                {renaming ? (
                    <input
                        ref={inputRef}
                        type="text"
                        defaultValue={item.title}
                        onPointerDown={(e) => e.stopPropagation()}
                        onBlur={(e) => {
                            const v = e.currentTarget.value.trim() || 'Group';
                            dispatch({ type: 'UPDATE_ITEM', id: item.id, patch: { title: v } as any });
                            setRenaming(false);
                        }}
                        onKeyDown={(e) => {
                            if (e.key === 'Enter') {
                                (e.currentTarget as HTMLInputElement).blur();
                            } else if (e.key === 'Escape') {
                                e.preventDefault();
                                setRenaming(false);
                            }
                            e.stopPropagation();
                        }}
                        className="flex-1 bg-transparent border border-emerald-400/40 rounded px-1 outline-none"
                        style={{ color: headerInkPrimary, fontSize: titleFontSize }}
                    />
                ) : (
                    <span
                        // No truncate: titles always render in full even
                        // when the container is narrower than the chrome
                        // needs. Together with the header's overflow:
                        // visible this lets the title extend past the
                        // right edge instead of collapsing to "G…". Badge
                        // / sub-group menu / collapse button still flex
                        // to the right of the title and overflow visibly
                        // alongside it.
                        className="flex-shrink-0 cursor-text whitespace-nowrap"
                        // Manual dblclick detector that runs BEFORE the
                        // surface's pointerdown handler gets a chance to
                        // hit-test the container. stopPropagation on both
                        // events so the parent frame's onDoubleClick
                        // (which triggers focus mode) and the surface's
                        // manual-dblclick path don't fire as a fallback
                        // and compete for the event. Native onDoubleClick
                        // stays as a belt-and-braces trigger in case
                        // pointer-event capture somewhere upstream eats
                        // the pointerdown sequence.
                        onPointerDown={(e) => {
                            const now = Date.now();
                            const prev = titleDblRef.current;
                            titleDblRef.current = now;
                            if (prev && now - prev < 450) {
                                e.stopPropagation();
                                e.preventDefault();
                                setRenaming(true);
                                titleDblRef.current = 0;
                            }
                        }}
                        onDoubleClick={(e) => { e.stopPropagation(); setRenaming(true); }}
                        title="Double-click to rename"
                    >{item.title}</span>
                )}
                <span
                    className="flex-shrink-0 tracking-widest uppercase whitespace-nowrap"
                    style={{ fontSize: titleMetaFontSize, color: headerInkMeta }}
                >
                    {childCount} {childCount === 1 ? 'item' : 'items'}
                </span>
                {hasSubGroups && <SubGroupMenu container={item} iconSize={subMenuIconSize} inkColor={headerInkIcon} />}
                <button
                    onPointerDown={(e) => e.stopPropagation()}
                    onClick={toggleLock}
                    className={`flex items-center justify-center transition-colors flex-shrink-0 ${item.scopeLocked ? 'text-amber-400' : ''}`}
                    style={item.scopeLocked ? undefined : { color: headerInkIcon }}
                    title={item.scopeLocked ? 'Scope locked — agent outside cannot see inside' : 'Lock scope'}
                >
                    <Lock size={Math.round(lockIconSize)} />
                </button>
                {!isFocused && (
                    <button
                        // Quick "enter group" affordance — mirrors the Exit
                        // button shown when focused. Lets users open a
                        // group's focus mode in one click instead of
                        // right-click → Enter group.
                        onPointerDown={(e) => e.stopPropagation()}
                        onClick={(e) => {
                            e.stopPropagation();
                            dispatch({ type: 'SET_FOCUSED_CONTAINER', id: item.id });
                        }}
                        className="flex items-center justify-center transition-colors flex-shrink-0 hover:text-emerald-300"
                        style={{ color: headerInkIcon }}
                        title="Enter group"
                    >
                        <LogIn size={Math.round(exitIconSize)} />
                    </button>
                )}
                {isFocused && (
                    <button
                        // onPointerDown stopPropagation matches chevron/lock —
                        // without it the canvas surface's onPointerDown fires
                        // first, starts a container-move drag, and calls
                        // setPointerCapture which swallows the subsequent
                        // click. Result: the exit button did nothing, only
                        // Escape worked. See spec Issue 1.
                        onPointerDown={(e) => e.stopPropagation()}
                        onClick={(e) => {
                            e.stopPropagation();
                            dispatch({ type: 'SET_FOCUSED_CONTAINER', id: null });
                        }}
                        className="flex items-center justify-center transition-colors flex-shrink-0 hover:text-emerald-300"
                        style={{ color: headerInkIcon }}
                        title="Exit group (Esc)"
                    >
                        <LogOut size={Math.round(exitIconSize)} />
                    </button>
                )}
            </div>
            {selected && (() => {
                // Minimum size scales with the authored size so a large
                // group can't be shrunk to a pinhead where its children
                // become unrecognizable. At 30% of authored, the group
                // still reads as "the same thing" — below that, the
                // internal vector scale makes content too small to
                // identify. Absolute floors (120/80) kick in for small
                // authored groups so they aren't clamped to their full size.
                const authoredWMin = Math.max(120, (item.authoredW || item.w) * 0.3);
                const authoredHMin = Math.max(80, (item.authoredH || item.h) * 0.3);
                // tabMode covers both 'collapsed' and 'collapsed-visual'.
                // Capsule resize is now scale-anchored: drag adjusts the
                // group's uniform scale (which writes item.w / item.h in
                // proportion to authored). The handle visually sits on
                // the rendered capsule bounds — natural × scale wide,
                // headerH × scale tall — and the dispatch keeps scale
                // in sync across the collapsed and expanded views.
                if (tabMode && capsuleMetrics) {
                    const authoredWBase = item.authoredW || item.w;
                    const authoredHBase = item.authoredH || item.h;
                    // minScale that keeps the expanded body visible at the
                    // current view zoom. Without this, a user could shrink
                    // the capsule to scale=0.3 at 400% zoom, expand it,
                    // and immediately see the container flip back to
                    // collapsed-visual because body screen-h dropped
                    // below BODY_VISIBILITY_THRESHOLD. They'd feel stuck
                    // with a magnifier prompt telling them to zoom more.
                    // Formula: body screen-px = (authoredH × scale -
                    // TITLE_BAR_HEIGHT) × viewZoom ≥ BODY_VISIBILITY_THRESHOLD.
                    // Solving for scale gives the minimum that keeps
                    // the group meaningfully expandable at current zoom.
                    const zoomSafe = Math.max(0.01, state.view.zoom);
                    const bodyReadableMinScale =
                        (TITLE_BAR_HEIGHT + BODY_VISIBILITY_THRESHOLD / zoomSafe) / Math.max(1, authoredHBase);
                    const minScale = Math.max(0.3, bodyReadableMinScale);
                    return (
                        <ResizeHandle
                            itemId={item.id}
                            x={item.x}
                            y={item.y}
                            w={capsuleMetrics.renderW}
                            h={capsuleMetrics.titleBarH}
                            minW={capsuleMetrics.naturalW * minScale}
                            minH={28 * minScale}
                            scaleAnchor={{
                                naturalW: capsuleMetrics.naturalW,
                                authoredW: authoredWBase,
                                authoredH: authoredHBase,
                                minScale,
                            }}
                        />
                    );
                }
                // Minimum expanded-frame width respects the header's
                // natural content width. Without this, a shrink-drag
                // would push item.w below what the header row needs,
                // the auto-grow effect would dispatch it back to
                // naturalHeaderW, and the drag visibly fought with the
                // correction every frame. Clamping at the handle prevents
                // the tug-of-war entirely.
                let hdrHasSubGroups = false;
                for (const c of Object.values(state.items)) {
                    if (c?.type === 'container' && c.parentId === item.id) { hdrHasSubGroups = true; break; }
                }
                const naturalHeaderW = computeNaturalTabScreenW(item, { hasSubGroups: hdrHasSubGroups, isFocused });
                // Floor-clamp: the effective min can never exceed the
                // item's current size. If the user shrunk the capsule
                // below authoredWMin/authoredHMin and then expanded,
                // the expanded handle would otherwise snap w/h up to
                // the min on first drag. This lets them hold their
                // current small size; they just can't shrink further.
                const effMinW = Math.min(item.w, Math.max(authoredWMin, naturalHeaderW));
                const effMinH = Math.min(item.h, authoredHMin);
                return (
                    <ResizeHandle
                        itemId={item.id}
                        x={item.x}
                        y={item.y}
                        w={item.w}
                        h={item.h}
                        minW={effMinW}
                        minH={effMinH}
                        aspectLockedByDefault={true}
                    />
                );
            })()}
        </>
    );
}

/** Count direct children for a given container id — items + drawings.
 *  The header badge uses this, so it must match user expectation
 *  (a stroke drawn inside a group should count toward "N items"). */
export function countChildren(
    containerId: string,
    items: Record<string, CanvasItem>,
    lines?: Record<string, import('./types').DrawnLine>,
    strokes?: Record<string, import('./types').FreehandStroke>,
): number {
    let n = 0;
    for (const it of Object.values(items)) if (it.parentId === containerId) n++;
    if (lines) {
        for (const ln of Object.values(lines)) if (ln.parentId === containerId) n++;
    }
    if (strokes) {
        for (const st of Object.values(strokes)) if (st.parentId === containerId) n++;
    }
    return n;
}

/** Sub-group dropdown in the container header. Visible only when the
 *  container has at least one direct child of type 'container'. Clicking
 *  a sub-group in the list enters its focus mode — a faster path than
 *  double-clicking through nested layers. Spec C4 in docs/KLYPIX-
 *  GROUPS-SHAPES-UX.md. Breadcrumbs remain the primary navigation for
 *  exiting back up; this menu is just "jump straight into a nested
 *  group I can see". */
function SubGroupMenu({ container, iconSize, inkColor }: { container: ContainerItemType; iconSize: number; inkColor: string }) {
    const { state, dispatch } = useCanvasStore();
    const [open, setOpen] = useState(false);
    const [anchorRect, setAnchorRect] = useState<DOMRect | null>(null);
    const wrapperRef = useRef<HTMLDivElement>(null);
    const buttonRef = useRef<HTMLButtonElement>(null);
    const panelRef = useRef<HTMLDivElement>(null);

    const subGroups = Object.values(state.items).filter(
        (it): it is ContainerItemType => it.type === 'container' && it.parentId === container.id,
    );

    // Refresh the anchor rect whenever the menu opens so the panel
    // starts at the current screen position of the button. The world
    // transform zoomed the button's on-screen coords; by positioning
    // the panel via getBoundingClientRect we break out of that transform
    // and render screen-constant.
    useEffect(() => {
        if (!open) { setAnchorRect(null); return; }
        if (buttonRef.current) setAnchorRect(buttonRef.current.getBoundingClientRect());
    }, [open]);

    // Close on outside click (check BOTH the wrapper and the portaled
    // panel — the panel is outside the wrapper in the DOM now) or Esc.
    useEffect(() => {
        if (!open) return;
        const handler = (e: MouseEvent) => {
            const target = e.target as Node;
            const inWrapper = wrapperRef.current?.contains(target);
            const inPanel = panelRef.current?.contains(target);
            if (!inWrapper && !inPanel) setOpen(false);
        };
        const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
        window.addEventListener('mousedown', handler);
        window.addEventListener('keydown', esc);
        return () => {
            window.removeEventListener('mousedown', handler);
            window.removeEventListener('keydown', esc);
        };
    }, [open]);

    if (subGroups.length === 0) return null;

    // Panel is portaled to document.body so it escapes the world-
    // transform layer (and thus is screen-constant, on top of every
    // canvas element regardless of zoom / stacking context).
    const panel = open && anchorRect ? createPortal(
        <div
            ref={panelRef}
            data-canvas-ui="1"
            style={{
                position: 'fixed',
                top: anchorRect.bottom + 4,
                // Right-align the panel to the button so it opens to the
                // left of its anchor like a typical menu.
                right: Math.max(4, window.innerWidth - anchorRect.right),
                minWidth: 180,
                zIndex: 10000,
            }}
            className="bg-[#12121a] border border-white/10 rounded-xl shadow-[0_12px_40px_rgba(0,0,0,0.6)] py-1.5 text-white/85 text-[12px] font-medium"
        >
            <div className="px-3 py-1 text-[9px] tracking-[0.18em] uppercase text-white/30">Enter sub-group</div>
            {subGroups.map(sub => {
                const count = countChildren(sub.id, state.items, state.lines, state.strokes);
                return (
                    <button
                        key={sub.id}
                        onPointerDown={(e) => e.stopPropagation()}
                        onClick={(e) => {
                            e.stopPropagation();
                            dispatch({ type: 'SET_FOCUSED_CONTAINER', id: sub.id });
                            setOpen(false);
                        }}
                        className="w-full px-3 py-1.5 flex items-center justify-between gap-2 hover:bg-emerald-500/15 hover:text-emerald-200 text-left cursor-pointer"
                    >
                        <span className="truncate">{sub.title || 'Untitled group'}</span>
                        <span className="text-[10px] text-white/40 shrink-0">{count}</span>
                    </button>
                );
            })}
        </div>,
        document.body,
    ) : null;

    return (
        <div ref={wrapperRef} style={{ position: 'relative', flexShrink: 0 }} data-canvas-ui="1">
            <button
                ref={buttonRef}
                onPointerDown={(e) => e.stopPropagation()}
                onClick={(e) => { e.stopPropagation(); setOpen(v => !v); }}
                className="flex items-center justify-center hover:text-emerald-300 transition-colors"
                style={{ color: inkColor }}
                title={`Enter sub-group (${subGroups.length})`}
            >
                <FolderTree size={Math.round(iconSize)} />
            </button>
            {panel}
        </div>
    );
}
