import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Trash2, Copy, Square as BorderIcon, Sparkles, FolderOpen, FolderMinus, Tag, CircleDot, MessageSquarePlus, MessagesSquare, Link as LinkIcon, Type as TypeIcon, Stamp, Minimize2, AlignCenter, Bold, Italic, Underline, Strikethrough, Eraser, Scaling, ChevronDown, ScanText, AlignVerticalJustifyCenter, LogIn, LogOut, Layers, ChevronsUp, ChevronUp, ChevronsDown } from 'lucide-react';
import type { ItemStatus, StyleRun } from '../items/types';
import type { SelectionStyle } from '../items/styleRuns';
import { AlignmentGrid, type TextAlignH, type TextAlignV } from './AlignmentGrid';
import { ItemAlignPanel } from './ItemAlignPanel';
import type { AlignOp } from './alignItems';
import { PALETTE_COLORS, FONT_OPTIONS } from './TextPanel';

// Patch shape for the Format section — same fields a StyleRun can carry,
// minus offsets (the menu doesn't know them; the caller applies the patch
// to the captured selection range).
export type FormatPatch = Partial<Omit<StyleRun, 'start' | 'end'>>;

interface Props {
    x: number;               // screen coords
    y: number;
    hasSelection: boolean;   // some actions only make sense with a selection
    onClose: () => void;
    onDelete: () => void;
    onDuplicate: () => void;
    onAddBorder: () => void;
    // True when every selected text item already has a border. Drives the
    // label between "Add border" / "Remove border" so the action reads as
    // its outcome instead of the abstract "Toggle". Undefined / no text in
    // selection → falls back to "Add border".
    selectionAllHaveBorder?: boolean;
    onAskAgent: () => void;
    onGroup: () => void;
    onSetStatus?: (s: ItemStatus) => void;
    // Parent opens an inline prompt and dispatches the tag itself —
    // window.prompt is disabled in Electron's renderer, so the menu
    // just signals intent.
    onAddTag?: () => void;
    onAddComment?: () => void;
    onOpenThread?: () => void;
    // Enabled only when exactly one item is selected (thread attaches to a specific item).
    canOpenThread?: boolean;
    // Turn a text item containing a URL into a rich link preview.
    onConvertToLink?: () => void;
    canConvertToLink?: boolean;
    // Turn a link preview card back into a plain text item with the URL.
    onConvertToText?: () => void;
    canConvertToText?: boolean;
    // Enter a container's focus mode — only items inside it are interactive.
    onEnterGroup?: () => void;
    canEnterGroup?: boolean;
    // Exit the currently-focused container. Surfaced whenever the canvas
    // has a focused container, regardless of selection — exiting is a
    // canvas-level action, not item-level. Icon mirrors the group
    // header's exit affordance so the user learns one symbol.
    onExitGroup?: () => void;
    canExitGroup?: boolean;
    // Shrink a container's frame so it wraps tightly around its children.
    // Only shown when the selection is a single container.
    onFitContents?: () => void;
    canFitContents?: boolean;
    // Save current selection as a reusable template.
    onSaveAsTemplate?: () => void;
    // Ungroup the first selected container (per-layer, not recursive).
    // Shown only when the selection includes a container.
    onUngroup?: () => void;
    canUngroup?: boolean;
    // Text alignment — only surfaced when a single bordered text item is
    // selected. The grid picker commits both axes in one click.
    onSetTextAlignment?: (h: TextAlignH, v: TextAlignV) => void;
    canSetTextAlignment?: boolean;
    currentTextAlignH?: TextAlignH;
    currentTextAlignV?: TextAlignV;
    // Per-range formatting — only surfaced when the user right-clicks
    // with an active text selection inside an editing text item. Caller
    // captures the DOM textarea's selectionStart/End before opening the
    // menu and applies the patch to that range.
    onApplyFormat?: (patch: FormatPatch) => void;
    canApplyFormat?: boolean;
    // Summary of what the current selection already has so toggle
    // buttons can show an "active" state and the toggle rule matches
    // Word: if all chars are bold → click un-bolds; if any char is
    // not-bold → click bolds everything.
    formatState?: SelectionStyle;
    // Recent colors used on this canvas (first one is the most recent).
    // Shown as a small row above the palette so repeat colors are one
    // click away — matches TextPanel.
    formatRecentColors?: string[];
    // Multiply the current selection's size (and inner properties) by a
    // factor around its bounding-box center. Same operation surfaced in
    // the left toolbar's Scale panel.
    onScaleSelection?: (factor: number) => void;
    // Run Gemini OCR on the single selected image and drop the result as
    // a bordered TextItem to the right of it. Surfaced only when the
    // selection is exactly one ImageItem with an asset attached.
    onExtractText?: () => void;
    canExtractText?: boolean;
    // True while OCR is mid-flight — disables the menu entry and shows a
    // "Extracting…" label so a slow Gemini call doesn't get re-triggered.
    extractingText?: boolean;
    // Snap multiple selected items to a shared edge / center, or
    // distribute them with equal gaps on one axis. Surfaced only when
    // the selection has ≥2 items (distribute requires ≥3 — handled
    // inside the panel via the canDistribute flag).
    onAlignItems?: (op: AlignOp) => void;
    canAlignItems?: boolean;
    canDistributeItems?: boolean;
    // Z-order ops on the current selection. Reorders happen among siblings
    // within the same parent container, so a child can never escape its
    // group's visual frame. Disabled when nothing is selected.
    onArrange?: (mode: 'front' | 'back' | 'forward' | 'backward') => void;
    // Reports the menu's final on-screen rect after viewport-edge
    // clamping. Used by TextFormatCapsule to anchor itself directly
    // above the menu (or flip below when there's no room above) —
    // without this, the capsule would chase the click point even when
    // the menu flipped upward to escape the viewport bottom.
    onPositioned?: (rect: { left: number; top: number; width: number; height: number }) => void;
}

const STATUSES: { v: ItemStatus; label: string; color: string }[] = [
    { v: 'none', label: 'None', color: '#555' },
    { v: 'todo', label: 'To do', color: '#6b6b80' },
    { v: 'in_progress', label: 'In progress', color: '#f5a623' },
    { v: 'in_review', label: 'In review', color: '#3b82f6' },
    { v: 'done', label: 'Done', color: '#2dd4a0' },
    { v: 'blocked', label: 'Blocked', color: '#ef4444' },
    { v: 'waiting', label: 'Waiting', color: '#a855f7' },
];

// Simple right-click menu. Closes on any outside click or Escape. Kept local
// to the surface; no store state, no ref-counting.

export function ContextMenu({
    x, y, hasSelection,
    onClose, onDelete, onDuplicate, onAddBorder, selectionAllHaveBorder, onAskAgent, onGroup,
    onSetStatus, onAddTag, onAddComment, onOpenThread, canOpenThread,
    onConvertToLink, canConvertToLink, onConvertToText, canConvertToText,
    onEnterGroup, canEnterGroup,
    onExitGroup, canExitGroup,
    onFitContents, canFitContents,
    onSaveAsTemplate,
    onUngroup, canUngroup,
    onSetTextAlignment, canSetTextAlignment,
    currentTextAlignH, currentTextAlignV,
    onApplyFormat, canApplyFormat, formatState, formatRecentColors,
    onScaleSelection,
    onExtractText, canExtractText, extractingText,
    onAlignItems, canAlignItems, canDistributeItems,
    onArrange,
    onPositioned,
}: Props) {
    const ref = useRef<HTMLDivElement>(null);
    const [statusOpen, setStatusOpen] = useState(false);
    const [alignOpen, setAlignOpen] = useState(false);
    const [scaleOpen, setScaleOpen] = useState(false);
    const [itemAlignOpen, setItemAlignOpen] = useState(false);
    const [arrangeOpen, setArrangeOpen] = useState(false);
    const [scaleCustom, setScaleCustom] = useState('');
    // Render at an off-screen position on first paint, then reposition in
    // useLayoutEffect once we can measure the real menu size. Without this
    // the menu gets clipped when right-click lands near the bottom or right
    // edge — the Win32 viewport is only 980px tall by default and our menu
    // with status/align sub-entries runs ~360px, so clicks in the bottom
    // third were dropping half the options off-screen.
    const [pos, setPos] = useState<{ left: number; top: number; ready: boolean }>({
        left: x,
        top: y,
        ready: false,
    });
    useLayoutEffect(() => {
        const el = ref.current;
        if (!el) return;
        const rect = el.getBoundingClientRect();
        const PAD = 8;
        const vw = window.innerWidth;
        const vh = window.innerHeight;
        let left = x;
        let top = y;
        if (left + rect.width + PAD > vw) left = Math.max(PAD, vw - rect.width - PAD);
        if (top + rect.height + PAD > vh) top = Math.max(PAD, vh - rect.height - PAD);
        setPos({ left, top, ready: true });
        onPositioned?.({ left, top, width: rect.width, height: rect.height });
    }, [x, y, onPositioned]);

    // Stable ref so the effect below can run ONCE on mount. Previously
    // onClose was passed as an inline arrow `() => setCtxMenu(null)` and
    // changed identity every parent render, which kept tearing down and
    // re-attaching the listeners (through a setTimeout(0) delay) — if the
    // user clicked during the gap, nothing dismissed the menu.
    const onCloseRef = useRef(onClose);
    onCloseRef.current = onClose;

    useEffect(() => {
        const handler = (e: Event) => {
            if (!ref.current) return;
            const target = e.target as HTMLElement | null;
            // Skip clicks landing inside the floating TextFormatCapsule —
            // that toolbar is a sibling DOM tree designed to co-present
            // with this menu, and one of its controls (the font dropdown)
            // requires two clicks to use. Without this guard, opening the
            // dropdown closed the menu and the capsule re-anchored to the
            // text item, visibly jumping to a new position mid-interaction.
            if (target?.closest?.('[data-canvas-text-capsule="1"]')) return;
            if (!ref.current.contains(target as Node)) onCloseRef.current();
        };
        const esc = (e: KeyboardEvent) => {
            if (e.key === 'Escape') onCloseRef.current();
        };
        // Both pointerdown and mousedown: pointer-captured elements can
        // suppress one or the other in Chromium, but at least one will bubble
        // to window so the menu always dismisses.
        window.addEventListener('pointerdown', handler);
        window.addEventListener('mousedown', handler);
        window.addEventListener('keydown', esc);
        return () => {
            window.removeEventListener('pointerdown', handler);
            window.removeEventListener('mousedown', handler);
            window.removeEventListener('keydown', esc);
        };
        // Empty deps: run once for the menu's lifetime, read onClose via ref.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    const run = (fn: () => void) => () => { fn(); onClose(); };

    return (
        <div
            ref={ref}
            data-canvas-ui="1"
            className="fixed z-[80] no-drag min-w-[190px] bg-[#12121a] border border-white/10 rounded-xl shadow-[0_12px_40px_rgba(0,0,0,0.6)] py-1.5 text-white/80 text-[12px] font-medium animate-in fade-in zoom-in-95 duration-100"
            style={{ left: pos.left, top: pos.top, visibility: pos.ready ? 'visible' : 'hidden' }}
        >
            {canApplyFormat && onApplyFormat && (
                <>
                    <FormatSection
                        state={formatState}
                        recentColors={formatRecentColors}
                        onApply={(p) => { onApplyFormat(p); onClose(); }}
                    />
                    <Separator />
                </>
            )}
            {onExtractText && canExtractText && (
                <MenuItem
                    icon={<ScanText size={13} />}
                    label={extractingText ? 'Extracting text…' : 'Extract text (OCR)'}
                    disabled={!!extractingText}
                    onClick={extractingText ? () => {} : run(onExtractText)}
                />
            )}
            <MenuItem icon={<Sparkles size={13} />} label="Ask agent" disabled={!hasSelection} onClick={run(onAskAgent)} />
            {onOpenThread && (
                <MenuItem icon={<MessagesSquare size={13} />} label="Open chat thread" disabled={!canOpenThread} onClick={run(onOpenThread)} />
            )}
            {onEnterGroup && canEnterGroup && (
                <MenuItem icon={<LogIn size={13} />} label="Enter group" onClick={run(onEnterGroup)} />
            )}
            {onExitGroup && canExitGroup && (
                <MenuItem icon={<LogOut size={13} />} label="Exit group" onClick={run(onExitGroup)} />
            )}
            {onFitContents && canFitContents && (
                <MenuItem icon={<Minimize2 size={13} />} label="Fit to contents" onClick={run(onFitContents)} />
            )}
            {onSaveAsTemplate && (
                <MenuItem icon={<Stamp size={13} />} label="Save as template…" disabled={!hasSelection} onClick={run(onSaveAsTemplate)} />
            )}
            {onConvertToLink && canConvertToLink && (
                <MenuItem icon={<LinkIcon size={13} />} label="Convert to link preview" onClick={run(onConvertToLink)} />
            )}
            {onConvertToText && canConvertToText && (
                <MenuItem icon={<TypeIcon size={13} />} label="Convert to text" onClick={run(onConvertToText)} />
            )}
            <Separator />
            <MenuItem icon={<Copy size={13} />} label="Duplicate" shortcut="Ctrl+D" disabled={!hasSelection} onClick={run(onDuplicate)} />
            <MenuItem icon={<BorderIcon size={13} />} label={selectionAllHaveBorder ? 'Remove border' : 'Add border'} disabled={!hasSelection} onClick={run(onAddBorder)} />
            <MenuItem icon={<FolderOpen size={13} />} label="Group" shortcut="Ctrl+G" disabled={!hasSelection} onClick={run(onGroup)} />
            {onUngroup && canUngroup && (
                <MenuItem icon={<FolderMinus size={13} />} label="Ungroup" shortcut="Ctrl+Shift+G" onClick={run(onUngroup)} />
            )}
            {onArrange && (
                <div className="relative">
                    <MenuItem
                        icon={<Layers size={13} />}
                        label="Arrange ▸"
                        disabled={!hasSelection}
                        onClick={() => setArrangeOpen(v => !v)}
                    />
                    {arrangeOpen && hasSelection && (
                        <Submenu className="py-1 min-w-[200px]">
                            <ArrangeRow
                                icon={<ChevronsUp size={13} />}
                                label="Bring to Front"
                                shortcut="Ctrl+Shift+]"
                                onClick={() => { onArrange('front'); setArrangeOpen(false); onClose(); }}
                            />
                            <ArrangeRow
                                icon={<ChevronUp size={13} />}
                                label="Bring Forward"
                                shortcut="Ctrl+]"
                                onClick={() => { onArrange('forward'); setArrangeOpen(false); onClose(); }}
                            />
                            <ArrangeRow
                                icon={<ChevronDown size={13} />}
                                label="Send Backward"
                                shortcut="Ctrl+["
                                onClick={() => { onArrange('backward'); setArrangeOpen(false); onClose(); }}
                            />
                            <ArrangeRow
                                icon={<ChevronsDown size={13} />}
                                label="Send to Back"
                                shortcut="Ctrl+Shift+["
                                onClick={() => { onArrange('back'); setArrangeOpen(false); onClose(); }}
                            />
                        </Submenu>
                    )}
                </div>
            )}
            {onAlignItems && canAlignItems && (
                <div className="relative">
                    <MenuItem
                        icon={<AlignVerticalJustifyCenter size={13} />}
                        label="Align items ▸"
                        onClick={() => setItemAlignOpen(v => !v)}
                    />
                    {itemAlignOpen && (
                        <Submenu>
                            <ItemAlignPanel
                                canDistribute={!!canDistributeItems}
                                onPick={(op) => {
                                    onAlignItems(op);
                                    setItemAlignOpen(false);
                                    onClose();
                                }}
                            />
                        </Submenu>
                    )}
                </div>
            )}
            {onScaleSelection && hasSelection && (
                <div className="relative">
                    <MenuItem icon={<Scaling size={13} />} label="Scale ▸" onClick={() => setScaleOpen(v => !v)} />
                    {scaleOpen && (
                        <Submenu className="p-2 w-[176px]">
                            <div className="grid grid-cols-3 gap-1 mb-2">
                                {[
                                    { label: '0.25×', f: 0.25 },
                                    { label: '0.5×',  f: 0.5  },
                                    { label: '0.75×', f: 0.75 },
                                    { label: '1.5×',  f: 1.5  },
                                    { label: '2×',    f: 2    },
                                    { label: '3×',    f: 3    },
                                ].map(p => (
                                    <button
                                        key={p.label}
                                        onClick={() => { onScaleSelection(p.f); setScaleOpen(false); onClose(); }}
                                        className="text-[11px] font-medium py-1 rounded-md bg-white/5 text-white/65 hover:bg-emerald-500/20 hover:text-emerald-300 transition-all"
                                    >
                                        {p.label}
                                    </button>
                                ))}
                            </div>
                            <div className="flex items-center gap-1">
                                <input
                                    type="text"
                                    inputMode="decimal"
                                    placeholder="custom"
                                    value={scaleCustom}
                                    onChange={(e) => setScaleCustom(e.target.value)}
                                    onKeyDown={(e) => {
                                        if (e.key === 'Enter') {
                                            const n = parseFloat(scaleCustom);
                                            if (isFinite(n) && n > 0) {
                                                onScaleSelection(n);
                                                setScaleOpen(false);
                                                onClose();
                                            }
                                        }
                                    }}
                                    className="flex-1 bg-black/40 border border-white/10 rounded-md px-2 py-1 text-[11px] text-white/85 placeholder-white/25 focus:outline-none focus:border-emerald-500/40"
                                />
                                <span className="text-[10px] text-white/40">×</span>
                                <button
                                    onClick={() => {
                                        const n = parseFloat(scaleCustom);
                                        if (isFinite(n) && n > 0) {
                                            onScaleSelection(n);
                                            setScaleOpen(false);
                                            onClose();
                                        }
                                    }}
                                    className="text-[10px] font-medium px-2 py-1 rounded-md bg-emerald-500/25 text-emerald-300 hover:bg-emerald-500/35 transition-all"
                                >
                                    Go
                                </button>
                            </div>
                        </Submenu>
                    )}
                </div>
            )}
            {onSetTextAlignment && canSetTextAlignment && (
                <div className="relative">
                    <MenuItem icon={<AlignCenter size={13} />} label="Align ▸" onClick={() => setAlignOpen(v => !v)} />
                    {alignOpen && (
                        <Submenu>
                            <AlignmentGrid
                                currentH={currentTextAlignH ?? 'left'}
                                currentV={currentTextAlignV ?? 'top'}
                                onChange={(h, v) => {
                                    onSetTextAlignment(h, v);
                                    setAlignOpen(false);
                                    onClose();
                                }}
                            />
                        </Submenu>
                    )}
                </div>
            )}
            {onAddTag && (
                <MenuItem icon={<Tag size={13} />} label="Add tag…" disabled={!hasSelection} onClick={run(onAddTag)} />
            )}
            {onSetStatus && (
                <div className="relative">
                    <MenuItem icon={<CircleDot size={13} />} label="Set status ▸" disabled={!hasSelection} onClick={() => setStatusOpen(v => !v)} />
                    {statusOpen && (
                        <Submenu className="py-1 min-w-[140px]">
                            {STATUSES.map(s => (
                                <button
                                    key={s.v}
                                    onClick={() => { onSetStatus(s.v); setStatusOpen(false); onClose(); }}
                                    className="w-full px-3 py-1.5 flex items-center gap-2 text-[12px] text-white/75 hover:bg-emerald-500/15 hover:text-emerald-200 text-left"
                                >
                                    {/* Diamond status indicator: 45°-rotated square. Wrapper
                                        reserves the same column width a circle would have, so
                                        the label column stays aligned across rows. */}
                                    <span style={{ width: 10, height: 10, display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}>
                                        <span style={{ width: 7, height: 7, borderRadius: 1, background: s.color, transform: 'rotate(45deg)' }} />
                                    </span>
                                    {s.label}
                                </button>
                            ))}
                        </Submenu>
                    )}
                </div>
            )}
            {onAddComment && (
                <MenuItem icon={<MessageSquarePlus size={13} />} label="Add comment…" disabled={!hasSelection} onClick={run(onAddComment)} />
            )}
            <Separator />
            <MenuItem
                icon={<Trash2 size={13} />}
                label="Delete"
                shortcut="Del"
                danger
                disabled={!hasSelection}
                onClick={run(onDelete)}
            />
        </div>
    );
}

interface MenuItemProps {
    icon: React.ReactNode;
    label: string;
    shortcut?: string;
    disabled?: boolean;
    danger?: boolean;
    onClick: () => void;
}

function MenuItem({ icon, label, shortcut, disabled, danger, onClick }: MenuItemProps) {
    return (
        <button
            disabled={disabled}
            onClick={onClick}
            className={`w-full px-3 py-1.5 flex items-center gap-2.5 transition-colors text-left cursor-pointer disabled:opacity-35 disabled:cursor-not-allowed ${
                danger
                    ? 'hover:bg-red-500/20 hover:text-red-300 text-red-400/80'
                    : 'hover:bg-emerald-500/15 hover:text-emerald-200'
            }`}
        >
            <span className="shrink-0 w-4 flex items-center justify-center">{icon}</span>
            <span className="flex-1">{label}</span>
            {shortcut && <span className="text-[10px] text-white/30">{shortcut}</span>}
        </button>
    );
}

function Separator() {
    return <div className="h-px bg-white/5 my-1 mx-2" />;
}

interface ArrangeRowProps {
    icon: React.ReactNode;
    label: string;
    shortcut?: string;
    onClick: () => void;
}
function ArrangeRow({ icon, label, shortcut, onClick }: ArrangeRowProps) {
    return (
        <button
            onClick={onClick}
            className="w-full px-3 py-1.5 flex items-center gap-2.5 text-left text-[12px] text-white/75 hover:bg-emerald-500/15 hover:text-emerald-200 cursor-pointer"
        >
            <span className="shrink-0 w-4 flex items-center justify-center">{icon}</span>
            <span className="flex-1">{label}</span>
            {shortcut && <span className="text-[10px] text-white/30">{shortcut}</span>}
        </button>
    );
}

// Side-flyout for Scale/Align/Status. Default opens to the right of the
// parent menu, top-aligned. If the submenu would clip the bottom of the
// viewport, shifts up by the overflow amount so every option stays
// reachable. Flips to the left side if right-overflow looms. Hidden on
// the first paint until measured to avoid a flicker at the wrong spot.
interface SubmenuProps {
    children: React.ReactNode;
    className?: string;
}
function Submenu({ children, className }: SubmenuProps) {
    const ref = useRef<HTMLDivElement>(null);
    const [pos, setPos] = useState<{ top: number; flipLeft: boolean; ready: boolean }>({
        top: 0, flipLeft: false, ready: false,
    });
    useLayoutEffect(() => {
        const el = ref.current;
        if (!el) return;
        const rect = el.getBoundingClientRect();
        const PAD = 8;
        const vh = window.innerHeight;
        const vw = window.innerWidth;
        let top = 0;
        if (rect.bottom > vh - PAD) {
            // Negative offset shifts the submenu up. Don't go above the
            // viewport top — clamp so first row stays visible.
            top = (vh - PAD) - rect.bottom;
            if (rect.top + top < PAD) top = PAD - rect.top;
        }
        const flipLeft = rect.right > vw - PAD;
        setPos({ top, flipLeft, ready: true });
    }, []);
    return (
        <div
            ref={ref}
            className={`absolute ${pos.flipLeft ? 'right-full mr-1' : 'left-full ml-1'} rounded-lg bg-[#12121a] border border-white/10 shadow-lg z-[90] ${className || ''}`}
            style={{ top: pos.top, visibility: pos.ready ? 'visible' : 'hidden' }}
            onPointerDown={(e) => e.stopPropagation()}
            onMouseDown={(e) => e.stopPropagation()}
        >
            {children}
        </div>
    );
}

// Word-style format toolbar shown above the menu when the user right-
// clicks with a live text selection. Picks a color / toggles B/I/U/S —
// each click commits the patch and closes the menu; re-opening carries
// no preserved selection so there's no multi-op flow to preserve.
interface FormatSectionProps {
    state?: SelectionStyle;
    recentColors?: string[];
    onApply: (patch: FormatPatch) => void;
}
function FormatSection({ state, recentColors, onApply }: FormatSectionProps) {
    const colorInputRef = useRef<HTMLInputElement>(null);
    const [fontMenuOpen, setFontMenuOpen] = useState(false);
    const fontMenuRef = useRef<HTMLDivElement>(null);
    useEffect(() => {
        if (!fontMenuOpen) return;
        const handler = (e: PointerEvent) => {
            if (fontMenuRef.current && fontMenuRef.current.contains(e.target as Node)) return;
            setFontMenuOpen(false);
        };
        const t = setTimeout(() => window.addEventListener('pointerdown', handler), 0);
        return () => { clearTimeout(t); window.removeEventListener('pointerdown', handler); };
    }, [fontMenuOpen]);
    const fontFamilyValue = state?.fontFamily;
    const fontFamilyMixed = fontFamilyValue === 'mixed';
    const fontFamilyLabel = fontFamilyMixed
        ? 'Mixed'
        : (typeof fontFamilyValue === 'string' ? fontFamilyValue : 'Font');
    // Toggle rule: Word-style. If the selection is uniformly ON, click
    // clears the override (undefined). Otherwise (off or mixed), click
    // turns everything ON. Explicit undefined in the patch signals
    // "drop this field from any covering run" — applyStyleToRange /
    // normalizeRuns handle promotion back to item default.
    const togglePatch = (field: 'bold' | 'italic' | 'underline' | 'strikethrough'): FormatPatch => {
        const cur = state?.[field];
        return { [field]: cur === true ? undefined : true } as FormatPatch;
    };
    const isActive = (field: 'bold' | 'italic' | 'underline' | 'strikethrough'): boolean => {
        return state?.[field] === true;
    };
    const isMixed = (field: 'bold' | 'italic' | 'underline' | 'strikethrough'): boolean => {
        return state?.[field] === 'mixed';
    };
    // Dedup recents that collide with the palette — keeps the row short
    // and stops the palette from looking like two copies of red.
    const uniqRecents = (recentColors || []).filter(c => !PALETTE_COLORS.includes(c)).slice(0, 5);
    return (
        <div
            className="px-2.5 py-1.5 flex flex-col gap-1.5"
            onPointerDown={(e) => e.stopPropagation()}
            // preventDefault on mousedown stops the click target (font
            // dropdown trigger, B/I/U/S, swatches, …) from grabbing focus
            // away from the editing textarea. Without it, opening the
            // font dropdown blurs the textarea — edit mode exits, the
            // selected range visualization disappears, and the user
            // sees a whole-item selection ring while the dropdown is
            // still open. The format apply still hits the captured
            // pendingTextSelection range, but the in-between visual is
            // confusing. Keeping focus on the textarea preserves the
            // range highlight for the duration of the dropdown
            // interaction; click events still fire normally.
            onMouseDown={(e) => { e.stopPropagation(); e.preventDefault(); }}
        >
            {/* Font family — dropdown matching the Text panel + capsule. */}
            {/* Applies to just the captured selection range via the same */}
            {/* applyStyleToRange path B/I/U/S/color use. */}
            <div className="relative" ref={fontMenuRef}>
                <button
                    onClick={() => setFontMenuOpen(v => !v)}
                    title={fontFamilyMixed ? 'Font (mixed)' : 'Font'}
                    className={`w-full flex items-center justify-between gap-2 bg-white/5 hover:bg-white/10 rounded px-2 py-1 text-[11px] transition-colors ${
                        fontFamilyMixed ? 'text-white/55 italic' : 'text-white/85'
                    }`}
                    style={fontFamilyMixed || typeof fontFamilyValue !== 'string'
                        ? undefined
                        : { fontFamily: `"${fontFamilyValue}", sans-serif` }}
                >
                    <span className="truncate">{fontFamilyLabel}</span>
                    <ChevronDown size={11} className="text-white/45 shrink-0" />
                </button>
                {fontMenuOpen && (
                    <div
                        onWheel={(e) => e.stopPropagation()}
                        className="absolute left-0 right-0 top-full mt-1 z-50 max-h-64 overflow-y-auto rounded-md bg-[#0d0d14] border border-white/10 shadow-lg py-1"
                    >
                        {FONT_OPTIONS.map(f => (
                            <button
                                key={f.value}
                                onClick={() => { onApply({ fontFamily: f.value }); setFontMenuOpen(false); }}
                                className={`w-full text-left px-3 py-1.5 text-[12px] transition-colors ${
                                    !fontFamilyMixed && fontFamilyValue === f.value
                                        ? 'bg-emerald-500/20 text-emerald-300'
                                        : 'text-white/75 hover:bg-white/10'
                                }`}
                                style={{ fontFamily: `"${f.value}", sans-serif` }}
                            >
                                {f.label}
                            </button>
                        ))}
                    </div>
                )}
            </div>
            <div className="flex items-center gap-1.5">
                <FormatToggle
                    active={isActive('bold')}
                    mixed={isMixed('bold')}
                    label="Bold"
                    onClick={() => onApply(togglePatch('bold'))}
                >
                    <Bold size={12} strokeWidth={2.5} />
                </FormatToggle>
                <FormatToggle
                    active={isActive('italic')}
                    mixed={isMixed('italic')}
                    label="Italic"
                    onClick={() => onApply(togglePatch('italic'))}
                >
                    <Italic size={12} strokeWidth={2.5} />
                </FormatToggle>
                <FormatToggle
                    active={isActive('underline')}
                    mixed={isMixed('underline')}
                    label="Underline"
                    onClick={() => onApply(togglePatch('underline'))}
                >
                    <Underline size={12} strokeWidth={2.5} />
                </FormatToggle>
                <FormatToggle
                    active={isActive('strikethrough')}
                    mixed={isMixed('strikethrough')}
                    label="Strikethrough"
                    onClick={() => onApply(togglePatch('strikethrough'))}
                >
                    <Strikethrough size={12} strokeWidth={2.5} />
                </FormatToggle>
                <div className="w-px h-4 bg-white/10 mx-0.5" />
                <button
                    title="Clear formatting"
                    onClick={() => onApply({
                        color: undefined, bold: undefined, italic: undefined,
                        underline: undefined, strikethrough: undefined, fontSize: undefined,
                        fontFamily: undefined,
                    })}
                    className="w-6 h-6 rounded-md flex items-center justify-center text-white/55 hover:text-white hover:bg-white/10"
                >
                    <Eraser size={12} />
                </button>
            </div>
            <div className="flex items-center gap-1 flex-wrap">
                {uniqRecents.map((c) => (
                    <ColorSwatch key={`r-${c}`} color={c} active={state?.color === c} onClick={() => onApply({ color: c })} />
                ))}
                {uniqRecents.length > 0 && <div className="w-px h-4 bg-white/10 mx-0.5" />}
                {PALETTE_COLORS.map((c) => (
                    <ColorSwatch key={c} color={c} active={state?.color === c} onClick={() => onApply({ color: c })} />
                ))}
                <button
                    title="Custom color"
                    onClick={() => colorInputRef.current?.click()}
                    className="w-5 h-5 rounded-full flex items-center justify-center border border-white/20 text-[10px] text-white/60 hover:text-white hover:border-white/50 relative overflow-hidden"
                    style={{
                        background: 'conic-gradient(from 0deg, #ef4444, #f5a623, #10b981, #3b82f6, #a855f7, #ef4444)',
                    }}
                >
                    <span className="absolute inset-[2px] rounded-full bg-[#12121a] flex items-center justify-center">+</span>
                </button>
                <input
                    ref={colorInputRef}
                    type="color"
                    className="sr-only"
                    // No default value — otherwise Chromium uses the last
                    // picker state, and "pick the same color twice in a
                    // row" would skip the change event entirely.
                    onChange={(e) => onApply({ color: e.target.value })}
                />
            </div>
        </div>
    );
}

interface FormatToggleProps {
    active: boolean;
    mixed: boolean;
    label: string;
    onClick: () => void;
    children: React.ReactNode;
}
function FormatToggle({ active, mixed, label, onClick, children }: FormatToggleProps) {
    return (
        <button
            title={label}
            onClick={onClick}
            className={`w-6 h-6 rounded-md flex items-center justify-center transition-colors ${
                active
                    ? 'bg-emerald-500/25 text-emerald-200'
                    : mixed
                        ? 'bg-white/10 text-white/70 ring-1 ring-white/20'
                        : 'text-white/55 hover:text-white hover:bg-white/10'
            }`}
        >
            {children}
        </button>
    );
}

interface ColorSwatchProps {
    color: string;
    active: boolean;
    onClick: () => void;
}
function ColorSwatch({ color, active, onClick }: ColorSwatchProps) {
    return (
        <button
            title={color}
            onClick={onClick}
            className={`w-5 h-5 rounded-full border transition-all ${
                active ? 'border-white ring-1 ring-white/50' : 'border-white/15 hover:border-white/50'
            }`}
            style={{ background: color }}
        />
    );
}
