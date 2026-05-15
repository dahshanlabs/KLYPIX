import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Bold, Italic, Underline, Strikethrough, Type, ChevronDown, AlignLeft, AlignCenter, AlignRight, List, ListOrdered } from 'lucide-react';
import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';
import { useCanvasStore } from '../state/canvasStore';
import type { TextItem, StyleRun } from '../items/types';
import { STYLE_RUN_FIELDS } from '../items/styleRuns';
import { applyBulletPrefixes, applyNumberedPrefixes, stripListPrefixes } from '../items/listOps';
import { isLooseItemDottedAtZoom } from '../items/ContainerItem';
import { FONT_OPTIONS, PALETTE_COLORS } from './TextPanel';
import { AlignmentGrid, type TextAlignH, type TextAlignV } from './AlignmentGrid';

const cn = (...inputs: ClassValue[]) => twMerge(clsx(inputs));

// Floating formatting capsule that hovers above a right-clicked text item.
// Quick-access controls (Figma/Notion pattern): B / I / U, font size, color,
// font family, horizontal alignment. The full Text panel in the toolbar
// remains available for everything else (vertical alignment, recents,
// custom color picker). Hidden while editing the text inline so it doesn't
// fight the textarea for focus / pointer events.
//
// Visibility is gated on `state.textCapsuleAnchorId`, set ONLY by a
// right-click on a text item (KlypixCanvas onContextMenu). Selection alone
// never opens it — that was the prior behavior, which popped the capsule
// every time a text happened to be in the selection (e.g. as a descendant
// of a pasted group).
//
// Position math: anchored above the anchor item's screen rect, centered
// horizontally, flipped below if no room above. Re-runs whenever the
// anchor or view changes.

const CAPSULE_HEIGHT = 36;
const GAP_PX = 10;
const ALIGN_OPTIONS: Array<{ value: 'left' | 'center' | 'right'; Icon: React.ComponentType<{ size?: number }>; label: string }> = [
    { value: 'left', Icon: AlignLeft, label: 'Align left' },
    { value: 'center', Icon: AlignCenter, label: 'Align center' },
    { value: 'right', Icon: AlignRight, label: 'Align right' },
];

interface TextFormatCapsuleProps {
    // True while the right-click context menu is visible.
    ctxMenuOpen?: boolean;
    // The menu's final on-screen rect (viewport coordinates) AFTER it
    // applies its own viewport-edge clamp. Used directly so the
    // capsule tracks where the menu actually rendered — the menu
    // flips upward when clicked near the bottom of the viewport, and
    // anchoring to the click point in that case lands the capsule
    // inside / under the menu.
    ctxMenuRect?: { left: number; top: number; width: number; height: number } | null;
}

// Viewport top-pad: keep the capsule below the canvas's top toolbar
// (~64 px). 8 px clamp that came with the original code clipped the
// capsule behind the toolbar when the menu was anchored too high.
const TOP_SAFE_PAD = 72;

export function TextFormatCapsule({ ctxMenuOpen = false, ctxMenuRect = null }: TextFormatCapsuleProps) {
    const { state, dispatch, pushSnapshot } = useCanvasStore();
    const { items, selectedIds, editingId, view, textCapsuleAnchorId } = state;

    // The capsule is anchored ONLY by an explicit right-click on a text
    // item — never by selection alone. This keeps the capsule from popping
    // up whenever a text happens to land in the selection (e.g. as a
    // descendant of a pasted group). Commits still apply to every text in
    // the current selection that includes the anchor, so multi-selecting
    // → right-clicking one of them lets the user format the whole batch.
    const anchorItem = textCapsuleAnchorId ? items[textCapsuleAnchorId] : undefined;
    const anchor: TextItem | undefined = (anchorItem && anchorItem.type === 'text')
        ? (anchorItem as TextItem)
        : undefined;
    const selectedTexts = useMemo(() => {
        if (!anchor) return [] as TextItem[];
        const ids = selectedIds.includes(anchor.id) ? selectedIds : [anchor.id];
        const arr: TextItem[] = [];
        for (const id of ids) {
            const it = items[id];
            if (it && it.type === 'text') arr.push(it as TextItem);
        }
        return arr;
    }, [items, selectedIds, anchor]);

    const isEditingAnchor = anchor && editingId === anchor.id;

    // Suppress for ~150ms right after exiting edit mode. textarea.onBlur
    // dispatches SET_EDITING null one frame before the toolbar's tool
    // change clears selection, so without this gate the capsule pops in
    // for a single frame between those two updates and immediately hides.
    // 150ms is below the perceptual response threshold (~200ms) so the
    // legitimate Escape / blur-to-canvas paths still feel instant.
    const [postEditSuppressUntil, setPostEditSuppressUntil] = useState(0);
    const prevEditingIdRef = useRef<string | null>(editingId);
    useEffect(() => {
        const wasEditingText = prevEditingIdRef.current && items[prevEditingIdRef.current]?.type === 'text';
        if (wasEditingText && editingId === null) {
            setPostEditSuppressUntil(Date.now() + 150);
        }
        prevEditingIdRef.current = editingId;
    }, [editingId, items]);
    const suppressed = Date.now() < postEditSuppressUntil;
    useEffect(() => {
        if (!suppressed) return;
        const t = setTimeout(() => setPostEditSuppressUntil(0), Math.max(0, postEditSuppressUntil - Date.now()) + 10);
        return () => clearTimeout(t);
    }, [suppressed, postEditSuppressUntil]);

    // Re-position whenever selection / view / window changes. We measure the
    // capsule's own width post-render so we can horizontally center it on
    // the anchor regardless of which controls render at intrinsic widths.
    const ref = useRef<HTMLDivElement | null>(null);
    const [pos, setPos] = useState<{
        left: number;
        top: number;
        placement: 'above' | 'below';
        popoverDir: 'up' | 'down';
    } | null>(null);
    useLayoutEffect(() => {
        if (!anchor) { setPos(null); return; }
        const compute = () => {
            const el = ref.current;
            if (!el) return;
            // The capsule renders with `position: absolute` inside the
            // canvas root, so its top/left are CANVAS-LOCAL. The
            // context menu uses `position: fixed` (viewport coords).
            // Convert the menu rect into canvas-local space via the
            // offsetParent's screen rect — without this the capsule
            // lands one canvas-offset (header height etc.) off.
            const op = el.offsetParent as HTMLElement | null;
            const opRect = op ? op.getBoundingClientRect() : null;
            const opX = opRect ? opRect.left : 0;
            const opY = opRect ? opRect.top : 0;
            const z = view.zoom;
            const itemScreenLeft = view.panX + anchor.x * z;
            const itemScreenTop = view.panY + anchor.y * z;
            const itemScreenW = anchor.w * z;
            const itemScreenH = anchor.h * z;
            const capsuleW = el.offsetWidth || 280;
            const capsuleH = el.offsetHeight || CAPSULE_HEIGHT;
            // Top/bottom safe-bands in canvas-local coords. The window's
            // top-toolbar lives just above the canvas (~72 px viewport)
            // so when we'd otherwise clamp to top:0 we want to land
            // BELOW the toolbar. The bottom limit is the canvas's
            // visible height.
            const safeTopLocal = TOP_SAFE_PAD - opY;
            const safeBottomLocal = (opRect ? opRect.bottom : window.innerHeight) - opY - 8;

            let top: number;
            let placement: 'above' | 'below';
            let anchorCenterX: number;

            if (ctxMenuOpen && ctxMenuRect) {
                // Anchor to the menu's actual rendered rect (handles
                // its viewport flip, not the click point).
                const menuTopLocal = ctxMenuRect.top - opY;
                const menuBottomLocal = ctxMenuRect.top + ctxMenuRect.height - opY;
                const menuCenterXLocal = ctxMenuRect.left + ctxMenuRect.width / 2 - opX;
                const tryAbove = menuTopLocal - capsuleH - GAP_PX;
                if (tryAbove >= safeTopLocal) {
                    placement = 'above';
                    top = tryAbove;
                } else {
                    // No room above (would clip toolbar) — drop the
                    // capsule below the menu's bottom edge.
                    const tryBelow = menuBottomLocal + GAP_PX;
                    placement = 'below';
                    top = Math.min(tryBelow, safeBottomLocal - capsuleH);
                }
                anchorCenterX = menuCenterXLocal;
            } else {
                // Default: above the item, centered on it.
                const tryAbove = itemScreenTop - capsuleH - GAP_PX;
                if (tryAbove >= safeTopLocal) {
                    placement = 'above';
                    top = tryAbove;
                } else {
                    placement = 'below';
                    top = itemScreenTop + itemScreenH + GAP_PX;
                }
                anchorCenterX = itemScreenLeft + itemScreenW / 2;
            }

            let left = anchorCenterX - capsuleW / 2;
            const opWidth = opRect ? opRect.width : window.innerWidth;
            const maxLeft = opWidth - capsuleW - 8;
            if (left < 8) left = 8;
            else if (left > maxLeft) left = maxLeft;

            // Popover open direction. The font dropdown is the tall one,
            // capped by max-h-64 (256 px) but its NATURAL height with the
            // current 7 fonts is ~200 px (≈ 28 px per row + 8 px padding).
            // Color/align popovers are smaller and fit either way. Prefer
            // to open AWAY from the right-click menu (away from where
            // the capsule's `placement` sits next to it), but only if
            // there's enough room — otherwise fall back to the other
            // direction so the dropdown isn't clipped off-screen. Using
            // 200 (natural) instead of 256 (cap) so a capsule near the
            // top of the viewport with ~250 px above still flips up
            // rather than getting forced down into the menu region.
            const POPOVER_H = 200;
            const roomAbove = top - safeTopLocal;
            const roomBelow = safeBottomLocal - (top + capsuleH);
            let popoverDir: 'up' | 'down';
            if (placement === 'above') {
                popoverDir = roomAbove >= POPOVER_H ? 'up' : 'down';
            } else {
                popoverDir = roomBelow >= POPOVER_H ? 'down' : 'up';
            }
            setPos({ left, top, placement, popoverDir });
        };
        compute();
        const ro = new ResizeObserver(compute);
        if (ref.current) ro.observe(ref.current);
        window.addEventListener('resize', compute);
        return () => { ro.disconnect(); window.removeEventListener('resize', compute); };
    }, [anchor, view.panX, view.panY, view.zoom, ctxMenuOpen, ctxMenuRect]);

    // Click-outside + Escape dismissal for the capsule itself. The
    // anchor only clears when the click lands on the canvas surface
    // or a canvas item — clicks on ANY data-canvas-ui surface (the
    // right-click context menu, popovers, toolbar, etc.) are ignored
    // so the capsule survives the lifetime of an overlapping menu and
    // reappears once that menu closes. Without this, the right-click
    // context menu's first click would clear our anchor before the
    // user ever got a chance to use the capsule. The setTimeout(0)
    // defer skips the same-tick contextmenu that opened us.
    useEffect(() => {
        if (!anchor) return;
        const onDown = (e: PointerEvent) => {
            const target = e.target as HTMLElement | null;
            if (target?.closest?.('[data-canvas-ui="1"]')) return;
            dispatch({ type: 'SET_TEXT_CAPSULE_ANCHOR', id: null });
        };
        const onKey = (e: KeyboardEvent) => {
            if (e.key === 'Escape') dispatch({ type: 'SET_TEXT_CAPSULE_ANCHOR', id: null });
        };
        const t = setTimeout(() => {
            window.addEventListener('pointerdown', onDown);
            window.addEventListener('keydown', onKey);
        }, 0);
        return () => {
            clearTimeout(t);
            window.removeEventListener('pointerdown', onDown);
            window.removeEventListener('keydown', onKey);
        };
    }, [anchor, dispatch]);

    // Popover state — single popover slot at a time so opening one closes
    // the others. Tracked by a discriminator string rather than three bools
    // so click-outside collapse logic is simpler.
    const [openMenu, setOpenMenu] = useState<null | 'font' | 'color' | 'align'>(null);
    const popoverHostRef = useRef<HTMLDivElement | null>(null);
    useEffect(() => {
        if (!openMenu) return;
        const handler = (e: PointerEvent) => {
            const host = popoverHostRef.current;
            if (host && host.contains(e.target as Node)) return;
            setOpenMenu(null);
        };
        // Defer to skip the same-tick click that opened the menu.
        const t = setTimeout(() => window.addEventListener('pointerdown', handler), 0);
        return () => { clearTimeout(t); window.removeEventListener('pointerdown', handler); };
    }, [openMenu]);

    // --- Commits: snapshot once per gesture, then patch every selected text ---
    // The capsule represents "global formatting" — a click here means
    // "I want the whole item this way," so any per-range styleRun
    // override on the SAME field gets stripped (Word's rule: global
    // formatting overrides per-range formatting for the same property).
    // Other run fields survive — applying a global color doesn't undo
    // a bold range, and vice versa.
    const itemFieldToRunField: Partial<Record<keyof TextItem, keyof StyleRun>> = {
        color: 'color',
        fontSize: 'fontSize',
        fontWeight: 'bold',
        fontStyle: 'italic',
        textDecoration: 'underline',
        strikethrough: 'strikethrough',
        fontFamily: 'fontFamily',
    };
    const stripFieldsFromRuns = (
        runs: StyleRun[] | undefined,
        fields: (keyof StyleRun)[],
    ): StyleRun[] | undefined => {
        if (!runs || runs.length === 0 || fields.length === 0) return runs;
        const stripped = runs.map((r) => {
            const out: any = { ...r };
            for (const f of fields) delete out[f];
            return out as StyleRun;
        }).filter((r) => {
            // Drop runs that no longer carry any override.
            for (const f of STYLE_RUN_FIELDS) {
                if ((r as any)[f] !== undefined) return true;
            }
            return false;
        });
        return stripped;
    };
    // List toggle bakes prefixes ('• ' / '1. ') into content so the
    // textarea sees them while editing — matches Word's "press Enter,
    // get next bullet" behavior. Plain dispatch through applyToAllTexts
    // wouldn't migrate content, so list state would render only in
    // display mode. This handler does the migration per item: strip
    // any existing list prefix (including the OTHER list type so a
    // bullet→numbered switch reflows cleanly), apply the new one, and
    // shift styleRuns to track. Passing `undefined` clears.
    const setListType = (newType: 'bullet' | 'numbered' | undefined) => {
        if (selectedTexts.length === 0) return;
        pushSnapshot();
        for (const it of selectedTexts) {
            const result =
                newType === 'bullet'
                    ? applyBulletPrefixes(it.content, it.styleRuns)
                    : newType === 'numbered'
                        ? applyNumberedPrefixes(it.content, it.styleRuns)
                        : stripListPrefixes(it.content, it.styleRuns);
            const patch: any = {
                content: result.content,
                listType: newType,
            };
            if (result.runs !== it.styleRuns) {
                patch.styleRuns = result.runs ?? [];
            }
            dispatch({ type: 'UPDATE_ITEM', id: it.id, patch });
        }
    };

    const applyToAllTexts = (patch: Partial<TextItem>) => {
        if (selectedTexts.length === 0) return;
        pushSnapshot();
        const runFieldsTouched: (keyof StyleRun)[] = [];
        for (const k of Object.keys(patch) as (keyof TextItem)[]) {
            const rf = itemFieldToRunField[k];
            if (rf) runFieldsTouched.push(rf);
        }
        for (const it of selectedTexts) {
            const finalPatch: any = { ...patch };
            if (runFieldsTouched.length > 0) {
                const newRuns = stripFieldsFromRuns(it.styleRuns, runFieldsTouched);
                // Only attach styleRuns to the patch if it actually
                // changed — avoids dirtying items that had no runs to
                // begin with (would still write [] otherwise).
                if (newRuns !== it.styleRuns) {
                    finalPatch.styleRuns = newRuns ?? [];
                }
            }
            dispatch({ type: 'UPDATE_ITEM', id: it.id, patch: finalPatch });
        }
    };

    // Don't render at all when there's no anchor or it's being edited —
    // the capsule has no purpose in those states. When `anchor` exists but
    // `pos` hasn't been measured yet (first paint after selection), still
    // render so the ref attaches and useLayoutEffect can measure on the
    // very next frame; just keep it visually hidden until placed.
    if (!anchor || isEditingAnchor || suppressed) return null;
    const anchorItemNarrowed: TextItem = anchor;
    // Also hide when the anchor is currently being rendered as a DOT
    // (low-zoom tier — text item below the legibility threshold,
    // CanvasRenderer skips its actual glyph rendering and DotClusterLayer
    // draws a single dot instead). Anchoring a formatting toolbar to a
    // dot the user can't even see the text inside is just visual noise —
    // and the toolbar would float over empty canvas space because the
    // dot's own footprint is much smaller than the item's world rect.
    if (isLooseItemDottedAtZoom(anchor, view.zoom, isEditingAnchor, false)) return null;

    // "Mixed" = either (a) any selected text item carries a per-range
    // override that disagrees with its own item-level value, OR (b) the
    // item-level values disagree across the selection. Previously only
    // (a) was checked, so multi-selecting items with different colors /
    // sizes / styles still showed a definite value on the capsule.
    function isFieldMixed<V>(
        runField: 'color' | 'bold' | 'italic' | 'underline' | 'strikethrough' | 'fontSize' | 'fontFamily',
        getter: (it: TextItem) => V,
    ): boolean {
        // Within-item: any run on any selected item disagreeing with
        // that item's own value.
        for (const it of selectedTexts) {
            const runs = it.styleRuns;
            if (!runs || runs.length === 0) continue;
            const itemVal = getter(it);
            for (const r of runs) {
                const v = (r as any)[runField];
                if (v === undefined) continue;
                if (v !== itemVal) return true;
            }
        }
        // Across-item: item-level values differ between selected items.
        if (selectedTexts.length > 1) {
            const first = getter(selectedTexts[0]);
            for (let i = 1; i < selectedTexts.length; i++) {
                if (getter(selectedTexts[i]) !== first) return true;
            }
        }
        return false;
    }

    // Item-level fields without a per-range run override (textAlign,
    // verticalAlign, listType) only need across-item comparison.
    function isAcrossMixed<V>(getter: (it: TextItem) => V): boolean {
        if (selectedTexts.length <= 1) return false;
        const first = getter(selectedTexts[0]);
        for (let i = 1; i < selectedTexts.length; i++) {
            if (getter(selectedTexts[i]) !== first) return true;
        }
        return false;
    }

    // Default fallback must match TextItem's actual render default (Virgil),
    // otherwise the capsule label lies — items with no fontFamily set would
    // render in Virgil but the dropdown would say "Outfit". Pre-Virgil-default
    // canvases that were saved with explicit fontFamily='Outfit' keep their
    // Outfit label because anchor.fontFamily is set; only the unset-fallback
    // changed.
    const fontFamily = anchor.fontFamily ?? 'Virgil';
    const fontFamilyMixed = isFieldMixed('fontFamily', it => it.fontFamily ?? 'Virgil');
    const fontSizeValue = anchor.fontSize;
    const fontSizeMixed = isFieldMixed('fontSize', it => it.fontSize as number);
    const isBold = anchor.fontWeight === 'bold' || anchor.heading === true;
    const boldMixed = isFieldMixed('bold', it => it.fontWeight === 'bold' || it.heading === true);
    const isItalic = anchor.fontStyle === 'italic';
    const italicMixed = isFieldMixed('italic', it => it.fontStyle === 'italic');
    const isUnderline = anchor.textDecoration === 'underline';
    const underlineMixed = isFieldMixed('underline', it => it.textDecoration === 'underline');
    const isStrikethrough = anchor.strikethrough === true;
    const strikeMixed = isFieldMixed('strikethrough', it => it.strikethrough === true);
    const color = anchor.color;
    const colorMixed = isFieldMixed('color', it => it.color);
    const textAlign: TextAlignH = (anchor.textAlign ?? 'left') as TextAlignH;
    const verticalAlign: TextAlignV = (anchor.verticalAlign ?? 'top') as TextAlignV;
    const alignMixed = isAcrossMixed(it => `${it.textAlign ?? 'left'}|${it.verticalAlign ?? 'top'}`);
    const ActiveAlignIcon = (ALIGN_OPTIONS.find(a => a.value === textAlign) ?? ALIGN_OPTIONS[0]).Icon;
    // popoverDir is computed in the layout effect — it considers BOTH
    // capsule placement (open away from the right-click menu) AND
    // available room (so a capsule near the viewport edge doesn't open
    // a dropdown that runs off-screen). Default 'down' when pos hasn't
    // measured yet.
    const popoverPos = pos?.popoverDir === 'up' ? 'bottom-full mb-1' : 'top-full mt-1';
    // List state — item-level (bullets / numbering apply to whole lines,
    // not character ranges). Toggle commits 'bullet' / 'numbered' /
    // undefined to every text in the selection. Mixed across selection
    // shows the neutral ring on the corresponding button.
    const listType = anchor.listType;
    const listMixed = isAcrossMixed(it => it.listType ?? 'none');

    return (
        <div
            ref={ref}
            data-canvas-ui="1"
            // Specific marker so the right-click ContextMenu's outside-click
            // handler can skip clicks landing here. The capsule and the
            // menu are two sibling DOM trees that intentionally co-present
            // (capsule floats above the menu); without this, clicking the
            // capsule's font dropdown counted as "outside the menu" and
            // dismissed the menu mid-flow — at which point the capsule
            // re-anchored from the menu rect to the bare item rect and
            // visually jumped to a new position.
            data-canvas-text-capsule="1"
            // Stop pointer events from leaking through to the canvas surface
            // beneath — clicks/wheels here must not start a drag or pan.
            onPointerDown={(e) => e.stopPropagation()}
            onWheel={(e) => e.stopPropagation()}
            onContextMenu={(e) => e.stopPropagation()}
            style={{
                position: 'absolute',
                left: pos ? pos.left : -9999,
                top: pos ? pos.top : -9999,
                // Bump above the right-click ContextMenu (z-[80]) while
                // a popover is open so the dropdown renders IN FRONT of
                // the menu instead of being capped below it. The capsule
                // creates its own stacking context via its own zIndex,
                // so no inner z-index can escape — only raising the
                // capsule's root z works. Idle z stays at 20 so the
                // capsule doesn't dominate the canvas chrome unnecessarily.
                zIndex: openMenu ? 90 : 20,
                pointerEvents: 'auto',
                visibility: pos ? 'visible' : 'hidden',
            }}
            className="flex items-center gap-1 px-1.5 py-1 rounded-lg bg-[#12121a] border border-white/10 shadow-[0_10px_30px_rgba(0,0,0,0.55)]"
        >
            {/* Font family — compact pill that shows the current font in its */}
            {/* own typeface, tap to expand a vertical list. */}
            <div className="relative" ref={openMenu === 'font' ? popoverHostRef : undefined}>
                <button
                    onClick={() => setOpenMenu(openMenu === 'font' ? null : 'font')}
                    title={fontFamilyMixed ? 'Font (mixed)' : 'Font'}
                    className={cn(
                        'flex items-center gap-1 px-2 h-7 rounded-md hover:bg-white/10 text-[11px] transition-colors max-w-[120px]',
                        fontFamilyMixed ? 'text-white/55 italic' : 'text-white/85',
                    )}
                    style={fontFamilyMixed ? undefined : { fontFamily: `"${fontFamily}", sans-serif` }}
                >
                    <span className="truncate">{fontFamilyMixed ? 'Mixed' : fontFamily}</span>
                    <ChevronDown size={11} className="text-white/45 shrink-0" />
                </button>
                {openMenu === 'font' && (
                    <div
                        onWheel={(e) => e.stopPropagation()}
                        className={cn(
                            'absolute left-0 z-40 min-w-[160px] max-h-64 overflow-y-auto rounded-md bg-[#0d0d14] border border-white/10 shadow-lg py-1',
                            popoverPos,
                        )}
                    >
                        {FONT_OPTIONS.map(f => (
                            <button
                                key={f.value}
                                onClick={() => { applyToAllTexts({ fontFamily: f.value }); setOpenMenu(null); }}
                                className={cn(
                                    'w-full text-left px-3 py-1.5 text-[12px] transition-colors',
                                    !fontFamilyMixed && f.value === fontFamily
                                        ? 'bg-emerald-500/20 text-emerald-300'
                                        : 'text-white/75 hover:bg-white/10',
                                )}
                                style={{ fontFamily: `"${f.value}", sans-serif` }}
                            >
                                {f.label}
                            </button>
                        ))}
                    </div>
                )}
            </div>

            <Divider />

            {/* Font size — number input with up/down stepper baked in.
                When runs disagree on font size, the input is blank and
                the Type icon dims; typing a value still commits to every
                char in the selection (including run-overridden ones). */}
            <div className={cn('flex items-center h-7 px-1 rounded-md hover:bg-white/5', fontSizeMixed && 'ring-1 ring-white/15')}>
                <Type size={11} className={fontSizeMixed ? 'text-white/25 mr-1' : 'text-white/40 mr-1'} />
                <input
                    type="number"
                    min={8}
                    max={400}
                    step={1}
                    value={fontSizeMixed ? '' : fontSizeValue}
                    placeholder={fontSizeMixed ? '—' : undefined}
                    onChange={(e) => {
                        const v = Number(e.target.value);
                        if (!Number.isFinite(v) || v <= 0) return;
                        applyToAllTexts({ fontSize: v });
                    }}
                    onKeyDown={(e) => { e.stopPropagation(); }}
                    className="w-12 bg-transparent text-[11px] text-white/85 text-center outline-none [appearance:textfield] [&::-webkit-outer-spin-button]:m-0 [&::-webkit-inner-spin-button]:m-0 placeholder:text-white/35"
                />
            </div>

            <Divider />

            {/* B / I / U / S — toggles. `mixed` draws a middle-ground
                ring so the user knows the selection contains both
                on- and off- runs. Clicking a mixed toggle commits the
                matching ON state to every char (including any run
                override) — same rule as Word. */}
            <CapsuleToggle
                active={isBold}
                mixed={boldMixed}
                onClick={() => applyToAllTexts({ fontWeight: isBold ? 'normal' : 'bold' })}
                title={boldMixed ? 'Bold (mixed)' : 'Bold (Ctrl+B)'}
            >
                <Bold size={12} />
            </CapsuleToggle>
            <CapsuleToggle
                active={isItalic}
                mixed={italicMixed}
                onClick={() => applyToAllTexts({ fontStyle: isItalic ? 'normal' : 'italic' })}
                title={italicMixed ? 'Italic (mixed)' : 'Italic (Ctrl+I)'}
            >
                <Italic size={12} />
            </CapsuleToggle>
            <CapsuleToggle
                active={isUnderline}
                mixed={underlineMixed}
                onClick={() => applyToAllTexts({ textDecoration: isUnderline ? 'none' : 'underline' })}
                title={underlineMixed ? 'Underline (mixed)' : 'Underline (Ctrl+U)'}
            >
                <Underline size={12} />
            </CapsuleToggle>
            <CapsuleToggle
                active={isStrikethrough}
                mixed={strikeMixed}
                onClick={() => applyToAllTexts({ strikethrough: !isStrikethrough })}
                title={strikeMixed ? 'Strikethrough (mixed)' : 'Strikethrough'}
            >
                <Strikethrough size={12} />
            </CapsuleToggle>

            <Divider />

            {/* Color — swatch button → palette popover. When styleRuns
                disagree with the item-level color, the swatch renders
                as a rainbow conic gradient instead of a solid fill,
                and no palette chip is ringed as "active" in the popover
                (matches the right-click Format panel's mixed-color UI). */}
            <div className="relative" ref={openMenu === 'color' ? popoverHostRef : undefined}>
                <button
                    onClick={() => setOpenMenu(openMenu === 'color' ? null : 'color')}
                    title={colorMixed ? 'Text color (mixed)' : 'Text color'}
                    className="flex items-center justify-center w-7 h-7 rounded-md hover:bg-white/10 transition-colors"
                >
                    <span
                        className="w-3.5 h-3.5 rounded-full ring-1 ring-white/30"
                        style={colorMixed
                            ? { background: 'conic-gradient(from 0deg, #ef4444, #f5a623, #10b981, #3b82f6, #a855f7, #ef4444)' }
                            : { background: color }}
                    />
                </button>
                {openMenu === 'color' && (
                    <div className={cn(
                        'absolute left-1/2 -translate-x-1/2 z-40 rounded-md bg-[#0d0d14] border border-white/10 shadow-lg p-2 flex items-center gap-1.5',
                        popoverPos,
                    )}>
                        {PALETTE_COLORS.map(c => (
                            <button
                                key={c}
                                onClick={() => { applyToAllTexts({ color: c }); setOpenMenu(null); }}
                                title={c}
                                className={cn(
                                    'w-5 h-5 rounded-full transition-all',
                                    !colorMixed && color === c
                                        ? 'ring-2 ring-white scale-110'
                                        : 'ring-1 ring-white/20 hover:ring-white/60',
                                )}
                                style={{ background: c }}
                            />
                        ))}
                    </div>
                )}
            </div>

            <Divider />

            {/* Alignment — 3×3 grid popover matching the right-click menu. */}
            {/* Single click commits both horizontal + vertical alignment. */}
            {/* Button icon reflects the current horizontal alignment for a */}
            {/* quick visual cue of the state. */}
            <div className="relative" ref={openMenu === 'align' ? popoverHostRef : undefined}>
                <button
                    onClick={() => setOpenMenu(openMenu === 'align' ? null : 'align')}
                    title={alignMixed ? 'Alignment (mixed)' : `Alignment: ${verticalAlign} ${textAlign}`}
                    className={cn(
                        'flex items-center justify-center w-7 h-7 rounded-md hover:bg-white/10 transition-colors',
                        alignMixed ? 'text-white/40' : 'text-white/70',
                    )}
                >
                    <ActiveAlignIcon size={13} />
                </button>
                {openMenu === 'align' && (
                    <div className={cn(
                        'absolute left-1/2 -translate-x-1/2 z-40 rounded-md bg-[#0d0d14] border border-white/10 shadow-lg',
                        popoverPos,
                    )}>
                        <AlignmentGrid
                            currentH={textAlign}
                            currentV={verticalAlign}
                            onChange={(h, v) => { applyToAllTexts({ textAlign: h, verticalAlign: v } as any); setOpenMenu(null); }}
                        />
                    </div>
                )}
            </div>

            <Divider />

            {/* Bullets / numbering — item-level toggles. Clicking the
                active list type clears it; clicking the inactive one
                switches over (mutually exclusive). Bullets render only
                in display mode; entering inline edit hides them so the
                textarea/overlay character alignment stays exact. */}
            <CapsuleToggle
                active={listType === 'bullet'}
                mixed={listMixed && listType !== 'bullet'}
                onClick={() => setListType(listType === 'bullet' ? undefined : 'bullet')}
                title={listMixed ? 'Bulleted list (mixed)' : 'Bulleted list'}
            >
                <List size={12} />
            </CapsuleToggle>
            <CapsuleToggle
                active={listType === 'numbered'}
                mixed={listMixed && listType !== 'numbered'}
                onClick={() => setListType(listType === 'numbered' ? undefined : 'numbered')}
                title={listMixed ? 'Numbered list (mixed)' : 'Numbered list'}
            >
                <ListOrdered size={12} />
            </CapsuleToggle>
        </div>
    );
}

function Divider() {
    return <div className="w-px h-5 bg-white/10 mx-0.5" />;
}

function CapsuleToggle({ active, mixed, onClick, title, children }: { active: boolean; mixed?: boolean; onClick: () => void; title: string; children: React.ReactNode }) {
    // Three-state visual: off (default), on (emerald), mixed (neutral
    // ring — tells the user "part of the selection has this on, part
    // doesn't" without implying a committed value). Clicking from the
    // mixed state applies ON to everything (Word's toggle rule).
    return (
        <button
            onClick={onClick}
            title={title}
            className={cn(
                'flex items-center justify-center w-7 h-7 rounded-md transition-colors cursor-pointer',
                active
                    ? 'bg-emerald-500/25 text-emerald-300'
                    : mixed
                        ? 'bg-white/5 text-white/75 ring-1 ring-white/25'
                        : 'text-white/65 hover:bg-white/10 hover:text-white',
            )}
        >
            {children}
        </button>
    );
}
