import React, { useEffect, useRef, useState } from 'react';
import { Type, MousePointer2, Square, Minus as LineIcon, Pencil, ArrowRight, Undo2, Redo2, Circle, Triangle, Diamond, Eraser, Scaling, Camera, Scissors, Loader2 } from 'lucide-react';
import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';
import { useCanvasStore } from '../state/canvasStore';
import type { CanvasTool } from '../items/types';
import { FillPanel } from './FillPanel';
import { StrokePanel } from './StrokePanel';
import { TextPanel } from './TextPanel';
import { ScalePanel } from './ScalePanel';
import { scaleSelection } from './scaleSelection';
import { base64JpegToImageItem } from '../file/captureToCanvas';
import type { TextAlignH, TextAlignV } from './AlignmentGrid';

const cn = (...inputs: ClassValue[]) => twMerge(clsx(inputs));

const RECENT_COLORS_CAP = 5;

type LineStyle = 'solid' | 'dashed' | 'dotted';

// Captures the per-item originals at the start of a preview session so
// a hover that doesn't commit can be fully reverted.
interface PreviewSession {
    itemFields: Record<string, Partial<any>>;       // id → { borderColor, borderWidth, lineStyle, opacity, fillColor }
    lineFields: Record<string, Partial<any>>;       // id → { color, width }
    strokeFields: Record<string, Partial<any>>;     // id → { color, width }
    connectionFields: Record<string, Partial<any>>; // id → { color, width, style }
    wasDirty: boolean;                               // file-dirty flag at session start
    snapshotPushed: boolean;
}

export function Toolbar() {
    const { state, dispatch, commit, pushSnapshot, popLastSnapshot, undo, redo, canUndo, canRedo } = useCanvasStore();
    const setTool = (tool: CanvasTool) => dispatch({ type: 'SET_TOOL', tool });
    const [shapesOpen, setShapesOpen] = useState(false);
    const [fillOpen, setFillOpen] = useState(false);
    const [strokeOpen, setStrokeOpen] = useState(false);
    const [textOpen, setTextOpen] = useState(false);
    const [scaleOpen, setScaleOpen] = useState(false);
    // Local "capture in progress" lights up the relevant tray button so the
    // user gets feedback while the OS dialog is up — the main process hides
    // KLYPIX during capture, but the snipping tool can take many seconds
    // while the user draws their selection. Stored as the source ('screen'
    // or 'snip') so we can spin only the active button.
    const [capturing, setCapturing] = useState<null | 'screen' | 'snip'>(null);
    const shapesPopoverRef = useRef<HTMLDivElement>(null);
    const fillPopoverRef = useRef<HTMLDivElement>(null);
    const strokePopoverRef = useRef<HTMLDivElement>(null);
    const textPopoverRef = useRef<HTMLDivElement>(null);
    const scalePopoverRef = useRef<HTMLDivElement>(null);

    // Shared recent colors queue — one list across Fill and Stroke so
    // colors picked for fill appear in stroke recents and vice versa.
    // Session-scoped; not persisted.
    const [recentColors, setRecentColors] = useState<string[]>([]);
    const addRecent = (c: string) => {
        setRecentColors(prev => {
            const next = [c, ...prev.filter(x => x !== c)];
            return next.slice(0, RECENT_COLORS_CAP);
        });
    };

    // Panel "active chip" tracking — deliberately NOT derived from the
    // live effective state because that would include hover-preview
    // values. User expectation: click locks the ring on the chosen chip
    // and subsequent hovers move the canvas preview only. These refs
    // hold the last committed color per surface and get seeded on panel
    // open + updated on commit. `undefined` means "no chip highlighted"
    // (mixed selection or not yet initialized).
    const [panelFillColor, setPanelFillColor] = useState<string | undefined>(undefined);
    const [panelStrokeColor, setPanelStrokeColor] = useState<string | undefined>(undefined);
    const [panelTextColor, setPanelTextColor] = useState<string | undefined>(undefined);

    const hasSelection =
        state.selectedIds.length > 0
        || state.selectedLineIds.length > 0
        || state.selectedStrokeIds.length > 0
        || state.selectedConnectionIds.length > 0;

    // Fill is meaningless for anything except boxes + bordered text. Disable
    // the button when (a) the active tool can't create a fillable thing —
    // pen / line / connect make strokes, type makes text, eraser removes —
    // AND (b) the current selection contains no fillable item. Fill stays
    // enabled whenever there's something on-canvas it could actually paint:
    // a box or bordered text selected with Select, or Box tool active so a
    // fresh box will inherit the current fill default.
    const fillToolApplicable = state.tool === 'box';
    const selectionHasFillable = state.selectedIds.some(id => {
        const it = state.items[id] as any;
        if (!it) return false;
        if (it.type === 'box') return true;
        if (it.type === 'text' && it.border) return true;
        return false;
    });
    const fillDisabled = !fillToolApplicable && !selectionHasFillable;

    // --- Preview session plumbing ----------------------------------------
    const previewRef = useRef<PreviewSession | null>(null);

    const ensurePreviewSession = () => {
        if (previewRef.current) return;
        const session: PreviewSession = {
            itemFields: {},
            lineFields: {},
            strokeFields: {},
            connectionFields: {},
            wasDirty: state.isDirty,
            snapshotPushed: false,
        };
        for (const id of state.selectedIds) {
            const it = state.items[id] as any;
            if (!it) continue;
            // Geometry snapshot: stroke-width changes on box / bordered-text
            // items adjust x/y/w/h so the inner content area stays put as
            // the stroke grows outward (Illustrator's "Align Stroke to
            // Outside"). Hover-revert needs to restore the original
            // bounds, not just the borderWidth — otherwise a quick hover
            // off the slider leaves the box wider than it started.
            if (it.type === 'text') {
                // Text items have a different field surface — snapshot
                // everything the TextPanel can touch so previews revert
                // cleanly when the user hovers away. Bordered text now
                // participates in Fill + Stroke panels too, so we also
                // capture border/fill fields for revert.
                session.itemFields[id] = {
                    color: it.color,
                    fontSize: it.fontSize,
                    fontWeight: it.fontWeight,
                    fontStyle: it.fontStyle,
                    fontFamily: it.fontFamily,
                    textDecoration: it.textDecoration,
                    strikethrough: it.strikethrough,
                    textAlign: it.textAlign,
                    verticalAlign: it.verticalAlign,
                    opacity: it.opacity,
                    borderColor: it.borderColor,
                    borderWidth: it.borderWidth,
                    lineStyle: it.lineStyle,
                    fillColor: it.fillColor,
                    x: it.x,
                    y: it.y,
                    w: it.w,
                    h: it.h,
                };
            } else {
                session.itemFields[id] = {
                    borderColor: it.borderColor,
                    borderWidth: it.borderWidth,
                    lineStyle: it.lineStyle,
                    opacity: it.opacity,
                    fillColor: it.fillColor,
                    x: it.x,
                    y: it.y,
                    w: it.w,
                    h: it.h,
                };
            }
        }
        for (const id of state.selectedLineIds) {
            const ln = state.lines[id];
            if (!ln) continue;
            session.lineFields[id] = { color: ln.color, width: ln.width };
        }
        for (const id of state.selectedStrokeIds) {
            const st = state.strokes[id];
            if (!st) continue;
            session.strokeFields[id] = { color: st.color, width: st.width };
        }
        for (const id of state.selectedConnectionIds) {
            const cn = state.connections[id];
            if (!cn) continue;
            session.connectionFields[id] = { color: cn.color, width: cn.width, style: cn.style };
        }
        if (hasSelection) {
            pushSnapshot();
            session.snapshotPushed = true;
        }
        previewRef.current = session;
    };

    const revertPreview = () => {
        const session = previewRef.current;
        if (!session) return;
        for (const id of Object.keys(session.itemFields)) {
            dispatch({ type: 'UPDATE_ITEM', id, patch: session.itemFields[id] });
        }
        for (const id of Object.keys(session.lineFields)) {
            dispatch({ type: 'UPDATE_LINE', id, patch: session.lineFields[id] });
        }
        for (const id of Object.keys(session.strokeFields)) {
            dispatch({ type: 'UPDATE_STROKE', id, patch: session.strokeFields[id] });
        }
        for (const id of Object.keys(session.connectionFields)) {
            dispatch({ type: 'UPDATE_CONNECTION', id, patch: session.connectionFields[id] });
        }
        if (session.snapshotPushed) popLastSnapshot();
        if (!session.wasDirty) dispatch({ type: 'SET_DIRTY', dirty: false });
        previewRef.current = null;
    };

    const endPreviewAsCommitted = () => {
        previewRef.current = null;
    };

    // --- Apply-to-selection dispatches -----------------------------------
    interface StylePatch {
        strokeColor?: string;                    // maps to borderColor / color
        strokeWidthUnit?: number;                // pre-counter-zoom
        lineStyle?: LineStyle;
        opacity?: number;
        fillColor?: string;                       // direct fillColor write
        fillEnabled?: boolean;                    // maps to fillColor transparent/state.fillColor
        strokeEnabled?: boolean;                  // maps to borderColor transparent/state.color
        // Text-only fields. Applied only to text items; shape items ignore
        // them. Keeps one helper covering both panels.
        textFontFamily?: string;
        textFontSize?: number;
        textBold?: boolean;
        textItalic?: boolean;
        textUnderline?: boolean;
        textStrikethrough?: boolean;
        textColor?: string;
        textAlignH?: TextAlignH;
        textAlignV?: TextAlignV;
    }

    const applyToSelection = (patch: StylePatch) => {
        for (const id of state.selectedIds) {
            const item = state.items[id] as any;
            if (!item) continue;
            const p: any = {};
            // "Stroke to outside" geometry compensation: when the user
            // bumps borderWidth, we want the inner content area to stay
            // the same size — the stroke grows outward, the box's outer
            // perimeter expands. Without this, CSS border-box eats the
            // extra width inward and the text reflows. Computed once per
            // item against its CURRENT borderWidth, so a slider drag
            // that fires many ticks stays consistent (delta is always
            // last-tick → next-tick).
            const applyStrokeOutsideTo = (prevBw: number) => {
                if (patch.strokeWidthUnit == null) return;
                const nextBw = patch.strokeWidthUnit;
                const d = nextBw - prevBw;
                if (d === 0) return;
                p.x = item.x - d;
                p.y = item.y - d;
                p.w = Math.max(20, item.w + 2 * d);
                p.h = Math.max(16, item.h + 2 * d);
            };
            if (item.type === 'text') {
                if (patch.textFontFamily !== undefined) p.fontFamily = patch.textFontFamily;
                if (patch.textFontSize != null) p.fontSize = patch.textFontSize;
                if (patch.textBold != null) p.fontWeight = patch.textBold ? 'bold' : 'normal';
                if (patch.textItalic != null) p.fontStyle = patch.textItalic ? 'italic' : 'normal';
                if (patch.textUnderline != null) p.textDecoration = patch.textUnderline ? 'underline' : 'none';
                if (patch.textStrikethrough != null) p.strikethrough = patch.textStrikethrough;
                if (patch.textColor) p.color = patch.textColor;
                if (patch.textAlignH) p.textAlign = patch.textAlignH;
                if (patch.textAlignV) p.verticalAlign = patch.textAlignV;
                if (patch.opacity != null) p.opacity = patch.opacity;
                // Bordered text participates in Fill + Stroke panels the
                // same way boxes do. Plain text silently ignores these
                // patches — no border/fill surface to paint on.
                if (item.border) {
                    if (patch.strokeColor) p.borderColor = patch.strokeColor;
                    if (patch.strokeWidthUnit != null) {
                        p.borderWidth = patch.strokeWidthUnit;
                        applyStrokeOutsideTo(item.borderWidth ?? 1);
                    }
                    if (patch.lineStyle) p.lineStyle = patch.lineStyle;
                    if (patch.fillEnabled != null) {
                        p.fillColor = patch.fillEnabled ? state.fillColor : 'transparent';
                    }
                    if (patch.fillColor) p.fillColor = patch.fillColor;
                    if (patch.strokeEnabled != null) {
                        p.borderColor = patch.strokeEnabled ? state.color : 'transparent';
                    }
                }
            } else if (item.type === 'box') {
                if (patch.strokeColor) p.borderColor = patch.strokeColor;
                if (patch.strokeWidthUnit != null) {
                    p.borderWidth = patch.strokeWidthUnit;
                    applyStrokeOutsideTo(item.borderWidth ?? 1);
                }
                if (patch.lineStyle) p.lineStyle = patch.lineStyle;
                if (patch.opacity != null) p.opacity = patch.opacity;
                if (patch.fillEnabled != null) {
                    p.fillColor = patch.fillEnabled ? state.fillColor : 'transparent';
                }
                if (patch.fillColor) p.fillColor = patch.fillColor;
                if (patch.strokeEnabled != null) {
                    p.borderColor = patch.strokeEnabled ? state.color : 'transparent';
                }
            } else {
                // Other item types (image / file / container / ...): only
                // opacity is a universal field.
                if (patch.opacity != null) p.opacity = patch.opacity;
            }
            if (Object.keys(p).length > 0) dispatch({ type: 'UPDATE_ITEM', id, patch: p });
        }
        for (const id of state.selectedLineIds) {
            const p: any = {};
            if (patch.strokeColor) p.color = patch.strokeColor;
            if (patch.strokeWidthUnit != null) p.width = patch.strokeWidthUnit;
            if (Object.keys(p).length > 0) dispatch({ type: 'UPDATE_LINE', id, patch: p });
        }
        for (const id of state.selectedStrokeIds) {
            const p: any = {};
            if (patch.strokeColor) p.color = patch.strokeColor;
            if (patch.strokeWidthUnit != null) p.width = patch.strokeWidthUnit;
            if (Object.keys(p).length > 0) dispatch({ type: 'UPDATE_STROKE', id, patch: p });
        }
        for (const id of state.selectedConnectionIds) {
            const p: any = {};
            if (patch.strokeColor) p.color = patch.strokeColor;
            if (patch.strokeWidthUnit != null) p.width = patch.strokeWidthUnit;
            // Connection.style is 'solid' | 'dashed' only — no dotted. Map
            // a 'dotted' choice to 'dashed' so the user sees a visible
            // change rather than a silent no-op.
            if (patch.lineStyle) p.style = patch.lineStyle === 'solid' ? 'solid' : 'dashed';
            if (Object.keys(p).length > 0) dispatch({ type: 'UPDATE_CONNECTION', id, patch: p });
        }
    };

    const previewApply = (patch: StylePatch) => {
        ensurePreviewSession();
        applyToSelection(patch);
    };

    const commitApply = (patch: StylePatch, setDefault: () => void) => {
        if (hasSelection && !previewRef.current) {
            pushSnapshot();
        }
        applyToSelection(patch);
        setDefault();
        endPreviewAsCommitted();
    };

    // --- Fill handlers ---------------------------------------------------
    const onPreviewFillColor = (c: string) => previewApply({ fillColor: c, fillEnabled: true });
    const onCommitFillColor = (c: string) => {
        commitApply({ fillColor: c, fillEnabled: true }, () => {
            dispatch({ type: 'SET_FILL_COLOR', color: c });
            if (!state.fillEnabled) dispatch({ type: 'SET_FILL_ENABLED', enabled: true });
        });
        addRecent(c);
        setPanelFillColor(c);
    };
    const onPreviewFillOff = () => previewApply({ fillEnabled: false });
    const onCommitFillOff = () => {
        commitApply({ fillEnabled: false }, () => dispatch({ type: 'SET_FILL_ENABLED', enabled: false }));
        setPanelFillColor(undefined);
    };
    const onCommitFillOn = () => {
        commitApply({ fillEnabled: true }, () => dispatch({ type: 'SET_FILL_ENABLED', enabled: true }));
        setPanelFillColor(state.fillColor);
    };
    const onPreviewOpacity = (o: number) => previewApply({ opacity: o });
    const onCommitOpacity = (o: number) => {
        commitApply({ opacity: o }, () => dispatch({ type: 'SET_OPACITY', opacity: o }));
    };

    // --- Stroke handlers -------------------------------------------------
    const onPreviewStrokeColor = (c: string) => previewApply({ strokeColor: c, strokeEnabled: true });
    const onCommitStrokeColor = (c: string) => {
        commitApply({ strokeColor: c, strokeEnabled: true }, () => {
            dispatch({ type: 'SET_COLOR', color: c });
            if (!state.strokeEnabled) dispatch({ type: 'SET_STROKE_ENABLED', enabled: true });
        });
        addRecent(c);
        setPanelStrokeColor(c);
    };
    const onPreviewStrokeOff = () => previewApply({ strokeEnabled: false });
    const onCommitStrokeOff = () => {
        commitApply({ strokeEnabled: false }, () => dispatch({ type: 'SET_STROKE_ENABLED', enabled: false }));
        setPanelStrokeColor(undefined);
    };
    const onCommitStrokeOn = () => {
        commitApply({ strokeEnabled: true }, () => dispatch({ type: 'SET_STROKE_ENABLED', enabled: true }));
        setPanelStrokeColor(state.color);
    };
    const onPreviewWidth = (w: number) => {
        previewApply({ strokeWidthUnit: w });
        // With NO selection, previewApply is a no-op (nothing to paint
        // onto), which leaves state.strokeWidth unchanged during drag.
        // The slider's value prop is derived from state.strokeWidth, so
        // the thumb snaps back to the stored value each frame — and on
        // release the commit reads back the OLD value. Net effect: the
        // user can't change stroke width before drawing a shape.
        // Keep the default in sync live when there's no selection so
        // the slider stays responsive AND the next drawn shape picks
        // up the right width.
        if (!hasSelection) dispatch({ type: 'SET_STROKE_WIDTH', width: w });
    };
    const onCommitWidth = (w: number) => {
        commitApply({ strokeWidthUnit: w }, () => dispatch({ type: 'SET_STROKE_WIDTH', width: w }));
    };
    const onPreviewLineStyle = (s: LineStyle) => previewApply({ lineStyle: s });
    const onCommitLineStyle = (s: LineStyle) => {
        commitApply({ lineStyle: s }, () => dispatch({ type: 'SET_LINE_STYLE', style: s }));
    };

    // --- Text handlers ---------------------------------------------------
    // Commits apply to the text selection (if any) AND persist to
    // state.textDefaults so the next T-tool creation inherits the same
    // look. Lets the user configure font/color before typing.
    const onPreviewFont = (f: string) => previewApply({ textFontFamily: f });
    const onCommitFont = (f: string) => commitApply({ textFontFamily: f }, () => {
        dispatch({ type: 'SET_TEXT_DEFAULTS', patch: { fontFamily: f } });
    });
    const onPreviewSize = (s: number) => {
        previewApply({ textFontSize: s });
        // No-selection drag: previewApply is a no-op, so the slider's
        // value prop stays pinned to state.textDefaults.fontSize and
        // React reverts the thumb every onChange. Keep the default in
        // sync live so the slider stays responsive AND the next-typed
        // text picks up the chosen size. Same pattern as onPreviewWidth.
        if (!hasTextSelection) dispatch({ type: 'SET_TEXT_DEFAULTS', patch: { fontSize: s } });
    };
    const onCommitSize = (s: number) => commitApply({ textFontSize: s }, () => {
        dispatch({ type: 'SET_TEXT_DEFAULTS', patch: { fontSize: s } });
    });
    const onCommitBold = (on: boolean) => commitApply({ textBold: on }, () => {
        dispatch({ type: 'SET_TEXT_DEFAULTS', patch: { bold: on } });
    });
    const onCommitItalic = (on: boolean) => commitApply({ textItalic: on }, () => {
        dispatch({ type: 'SET_TEXT_DEFAULTS', patch: { italic: on } });
    });
    const onCommitUnderline = (on: boolean) => commitApply({ textUnderline: on }, () => {
        dispatch({ type: 'SET_TEXT_DEFAULTS', patch: { underline: on } });
    });
    const onCommitStrikethrough = (on: boolean) => commitApply({ textStrikethrough: on }, () => {
        dispatch({ type: 'SET_TEXT_DEFAULTS', patch: { strikethrough: on } });
    });
    const onPreviewTextColor = (c: string) => previewApply({ textColor: c });
    const onCommitTextColor = (c: string) => {
        commitApply({ textColor: c }, () => {
            dispatch({ type: 'SET_TEXT_DEFAULTS', patch: { color: c } });
        });
        addRecent(c);
        setPanelTextColor(c);
    };
    const onCommitAlignment = (h: TextAlignH, v: TextAlignV) => {
        commitApply({ textAlignH: h, textAlignV: v }, () => {
            dispatch({ type: 'SET_TEXT_DEFAULTS', patch: { alignH: h, alignV: v } });
        });
    };

    // --- Effective (mixed-aware) value derivations -----------------------
    const computeEffective = <T,>(values: T[], fallback: T | undefined): T | undefined => {
        if (values.length === 0) return fallback;
        const first = values[0];
        for (let i = 1; i < values.length; i++) if (values[i] !== first) return undefined;
        return first;
    };

    const effectiveFill = (() => {
        if (!hasSelection) {
            return { color: state.fillColor, enabled: state.fillEnabled };
        }
        // Fillable items = boxes + bordered text (both carry fillColor).
        const fillables: any[] = [];
        for (const id of state.selectedIds) {
            const it = state.items[id] as any;
            if (it?.type === 'box') fillables.push(it);
            else if (it?.type === 'text' && it.border) fillables.push(it);
        }
        if (fillables.length === 0) {
            return { color: state.fillColor, enabled: state.fillEnabled };
        }
        const enabledVals = fillables.map(b => !!(b.fillColor && b.fillColor !== 'transparent'));
        const colorVals = fillables.map(b => b.fillColor && b.fillColor !== 'transparent' ? b.fillColor : undefined).filter(Boolean) as string[];
        const enabled = computeEffective(enabledVals, state.fillEnabled);
        const color = colorVals.length === fillables.length ? computeEffective(colorVals, state.fillColor) : undefined;
        return { color, enabled };
    })();

    const effectiveStroke = (() => {
        if (!hasSelection) {
            return { color: state.color, enabled: state.strokeEnabled };
        }
        const colorVals: string[] = [];
        const enabledVals: boolean[] = [];
        let touched = false;
        for (const id of state.selectedIds) {
            const it = state.items[id] as any;
            if (it?.type === 'box' || (it?.type === 'text' && it.border)) {
                touched = true;
                const on = !!(it.borderColor && it.borderColor !== 'transparent');
                enabledVals.push(on);
                if (on) colorVals.push(it.borderColor);
            }
        }
        for (const id of state.selectedLineIds) {
            const ln = state.lines[id];
            if (!ln) continue;
            touched = true;
            enabledVals.push(true);
            colorVals.push(ln.color);
        }
        for (const id of state.selectedStrokeIds) {
            const st = state.strokes[id];
            if (!st) continue;
            touched = true;
            enabledVals.push(true);
            colorVals.push(st.color);
        }
        for (const id of state.selectedConnectionIds) {
            const cn = state.connections[id];
            if (!cn) continue;
            touched = true;
            enabledVals.push(true);
            colorVals.push(cn.color);
        }
        if (!touched) return { color: state.color, enabled: state.strokeEnabled };
        const enabled = computeEffective(enabledVals, state.strokeEnabled);
        const allEnabled = enabledVals.every(Boolean);
        const color = allEnabled && colorVals.length > 0 ? computeEffective(colorVals, state.color) : undefined;
        return { color, enabled };
    })();

    const effectiveStrokeWidth = (() => {
        if (!hasSelection) return state.strokeWidth;
        // Stored stroke widths are now canonical world-px (no
        // counter-zoom compensation) — display raw.
        const vals: number[] = [];
        for (const id of state.selectedIds) {
            const it = state.items[id] as any;
            if ((it?.type === 'box' || (it?.type === 'text' && it.border)) && typeof it.borderWidth === 'number') {
                vals.push(Math.round(it.borderWidth));
            }
        }
        for (const id of state.selectedLineIds) {
            const ln = state.lines[id];
            if (ln) vals.push(Math.round(ln.width));
        }
        for (const id of state.selectedStrokeIds) {
            const st = state.strokes[id];
            if (st) vals.push(Math.round(st.width));
        }
        for (const id of state.selectedConnectionIds) {
            const cn = state.connections[id];
            if (cn && typeof cn.width === 'number') vals.push(Math.round(cn.width));
        }
        return computeEffective(vals, state.strokeWidth);
    })();

    const effectiveLineStyle = (() => {
        if (!hasSelection) return state.lineStyle;
        const vals: LineStyle[] = [];
        for (const id of state.selectedIds) {
            const it = state.items[id] as any;
            if (it?.type === 'box' || (it?.type === 'text' && it.border)) {
                vals.push((it.lineStyle || 'solid') as LineStyle);
            }
        }
        for (const id of state.selectedConnectionIds) {
            const cn = state.connections[id];
            if (cn) vals.push((cn.style || 'solid') as LineStyle);
        }
        if (vals.length === 0) return state.lineStyle;
        return computeEffective(vals, state.lineStyle);
    })();

    // Text button shows when at least one text item is selected OR the
    // T-tool is active (so the user can set defaults before typing).
    const selectedTextItems = state.selectedIds
        .map(id => state.items[id])
        .filter((it): it is any => !!it && it.type === 'text');
    const hasTextSelection = selectedTextItems.length > 0;
    const textButtonVisible = hasTextSelection || state.tool === 'type';

    const effectiveText = (() => {
        const td = state.textDefaults;
        if (!hasTextSelection) {
            // T-tool active with nothing selected — panel shows the
            // next-create defaults from state so the user can dial in
            // font / size / weight / color / alignment BEFORE clicking
            // to drop a fresh text item. Size falls back to 16 (the
            // canonical authoring size) so the slider is always live
            // and pre-settable; without a fallback `undefined` made
            // the panel render "Mixed" and dim the slider, even though
            // there's nothing to be mixed about — there's no selection.
            // First slider drag dispatches SET_TEXT_DEFAULTS so the
            // chosen size is what the next-typed text picks up.
            return {
                // Virgil is the actual render default in TextItem; keep this
                // fallback in sync so the panel doesn't lie about the font.
                fontFamily: td.fontFamily ?? 'Virgil',
                fontSize: td.fontSize ?? 16,
                bold: td.bold,
                italic: td.italic,
                underline: td.underline,
                strikethrough: td.strikethrough,
                textColor: td.color,
                textAlign: td.alignH as TextAlignH,
                verticalAlign: td.alignV as TextAlignV,
            };
        }
        // Per-item field reader: returns the item-level value, OR a
        // sentinel string 'mixed' when any styleRun on that item carries
        // an override value that disagrees with the item-level value.
        // computeEffective then collapses the per-item array; if the
        // result is the 'mixed' sentinel (or differs across items) the
        // panel sees `undefined` and shows its existing "Mixed" badge.
        // Without this, an item with one orange run and item.color=black
        // reported `black` to the panel — the swatch never showed mixed
        // for intra-item variation.
        const MIXED = '__mixed__';
        function readField<V>(
            it: any,
            itemValue: V,
            runField: 'color' | 'bold' | 'italic' | 'underline' | 'strikethrough' | 'fontSize' | 'fontFamily',
        ): V | typeof MIXED {
            const runs = it.styleRuns as { [k: string]: any }[] | undefined;
            if (!runs || runs.length === 0) return itemValue;
            for (const r of runs) {
                const v = r[runField];
                if (v === undefined) continue;
                // Boolean-ish fields: only `true` is recorded as an
                // override; absence implies "use item default". So a
                // run with the field present but matching itemValue is
                // not mixing — only a different value counts.
                if (v !== itemValue) return MIXED;
            }
            return itemValue;
        }
        const collapse = <V,>(v: V | typeof MIXED | undefined): V | undefined =>
            v === MIXED ? undefined : (v as V | undefined);

        const fontFamily = collapse(computeEffective(
            selectedTextItems.map(it => readField(it, it.fontFamily ?? 'Virgil', 'fontFamily')),
            undefined,
        ));
        const fontSize = collapse(computeEffective(
            selectedTextItems.map(it => readField(it, it.fontSize as number, 'fontSize')),
            undefined,
        ));
        const bold = collapse(computeEffective(
            selectedTextItems.map(it => readField(it, it.fontWeight === 'bold' || it.heading === true, 'bold')),
            undefined,
        ));
        const italic = collapse(computeEffective(
            selectedTextItems.map(it => readField(it, it.fontStyle === 'italic', 'italic')),
            undefined,
        ));
        const underline = collapse(computeEffective(
            selectedTextItems.map(it => readField(it, it.textDecoration === 'underline', 'underline')),
            undefined,
        ));
        const strikethrough = collapse(computeEffective(
            selectedTextItems.map(it => readField(it, it.strikethrough === true, 'strikethrough')),
            undefined,
        ));
        const textColor = collapse(computeEffective(
            selectedTextItems.map(it => readField(it, it.color as string, 'color')),
            undefined,
        ));
        const textAlign = computeEffective(
            selectedTextItems.map(it => (it.textAlign ?? 'left') as TextAlignH),
            undefined,
        );
        const verticalAlign = computeEffective(
            selectedTextItems.map(it => (it.verticalAlign ?? 'top') as TextAlignV),
            undefined,
        );
        return { fontFamily, fontSize, bold, italic, underline, strikethrough, textColor, textAlign, verticalAlign };
    })();

    const effectiveOpacity = (() => {
        if (!hasSelection) return state.opacity;
        const vals: number[] = [];
        for (const id of state.selectedIds) {
            const it = state.items[id] as any;
            if (it && typeof it.opacity === 'number') vals.push(it.opacity);
        }
        if (vals.length === 0) return state.opacity;
        return computeEffective(vals, state.opacity);
    })();

    // --- Screen capture --------------------------------------------------
    // Two modes share the same drop pipeline: the main-process IPC hides
    // KLYPIX before the capture so the toolbar / canvas isn't in the shot,
    // returns a base64 JPEG, and we land it as an ImageItem at viewport
    // center. Same path produces the same ImageItem shape as a dropped or
    // pasted screenshot — assets registered, thumbnail generated, zoom
    // compensated — so it serializes into .any normally.
    const captureToCanvas = async (source: 'screen' | 'snip') => {
        if (capturing) return;
        const api: any = (window as any).electron;
        if (!api) return;
        setCapturing(source);
        try {
            const base64: string | null = source === 'snip'
                ? await api.launchNativeSnipping?.()
                : await api.captureScreen?.();
            if (!base64) return;
            const vw = window.innerWidth;
            const vh = window.innerHeight;
            const worldX = (vw / 2 - state.view.panX) / state.view.zoom;
            const worldY = (vh / 2 - state.view.panY) / state.view.zoom;
            const item = await base64JpegToImageItem(base64, {
                worldX, worldY,
                zIndexStart: state.order.length,
                viewZoom: state.view.zoom,
            }, source);
            if (!item) return;
            commit({ type: 'ADD_ITEM', item });
            dispatch({ type: 'SELECT', ids: [item.id] });
        } catch (err) {
            console.warn('[canvas capture]', err);
        } finally {
            setCapturing(null);
        }
    };

    // --- Popover dismiss effects -----------------------------------------
    // Any outside click / Escape also reverts uncommitted previews so the
    // canvas never gets stuck in a half-hovered state.
    useEffect(() => {
        if (!fillOpen) return;
        const close = (e: PointerEvent) => {
            const el = fillPopoverRef.current;
            if (el && el.contains(e.target as Node)) return;
            revertPreview();
            setFillOpen(false);
        };
        const esc = (e: KeyboardEvent) => {
            if (e.key === 'Escape') { revertPreview(); setFillOpen(false); }
        };
        const t = setTimeout(() => {
            window.addEventListener('pointerdown', close);
            window.addEventListener('keydown', esc);
        }, 0);
        return () => {
            clearTimeout(t);
            window.removeEventListener('pointerdown', close);
            window.removeEventListener('keydown', esc);
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [fillOpen]);

    useEffect(() => {
        if (!strokeOpen) return;
        const close = (e: PointerEvent) => {
            const el = strokePopoverRef.current;
            if (el && el.contains(e.target as Node)) return;
            revertPreview();
            setStrokeOpen(false);
        };
        const esc = (e: KeyboardEvent) => {
            if (e.key === 'Escape') { revertPreview(); setStrokeOpen(false); }
        };
        const t = setTimeout(() => {
            window.addEventListener('pointerdown', close);
            window.addEventListener('keydown', esc);
        }, 0);
        return () => {
            clearTimeout(t);
            window.removeEventListener('pointerdown', close);
            window.removeEventListener('keydown', esc);
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [strokeOpen]);

    useEffect(() => {
        if (!shapesOpen) return;
        const close = (e: PointerEvent) => {
            const el = shapesPopoverRef.current;
            if (el && el.contains(e.target as Node)) return;
            setShapesOpen(false);
        };
        const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setShapesOpen(false); };
        const t = setTimeout(() => {
            window.addEventListener('pointerdown', close);
            window.addEventListener('keydown', esc);
        }, 0);
        return () => {
            clearTimeout(t);
            window.removeEventListener('pointerdown', close);
            window.removeEventListener('keydown', esc);
        };
    }, [shapesOpen]);

    useEffect(() => {
        if (!textOpen) return;
        const close = (e: PointerEvent) => {
            const el = textPopoverRef.current;
            if (el && el.contains(e.target as Node)) return;
            revertPreview();
            setTextOpen(false);
        };
        const esc = (e: KeyboardEvent) => {
            if (e.key === 'Escape') { revertPreview(); setTextOpen(false); }
        };
        const t = setTimeout(() => {
            window.addEventListener('pointerdown', close);
            window.addEventListener('keydown', esc);
        }, 0);
        return () => {
            clearTimeout(t);
            window.removeEventListener('pointerdown', close);
            window.removeEventListener('keydown', esc);
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [textOpen]);

    useEffect(() => {
        if (!scaleOpen) return;
        const close = (e: PointerEvent) => {
            const el = scalePopoverRef.current;
            if (el && el.contains(e.target as Node)) return;
            setScaleOpen(false);
        };
        const esc = (e: KeyboardEvent) => {
            if (e.key === 'Escape') setScaleOpen(false);
        };
        const t = setTimeout(() => {
            window.addEventListener('pointerdown', close);
            window.addEventListener('keydown', esc);
        }, 0);
        return () => {
            clearTimeout(t);
            window.removeEventListener('pointerdown', close);
            window.removeEventListener('keydown', esc);
        };
    }, [scaleOpen]);

    // Close the Text panel if it loses both triggers (no text selected
    // AND tool isn't T). Otherwise the panel would linger after the
    // user switches away to, say, the box tool with nothing selected.
    useEffect(() => {
        if (textOpen && !textButtonVisible) {
            revertPreview();
            setTextOpen(false);
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [textButtonVisible]);

    // Auto-close Fill if the user switches to a stroke-only tool while
    // it's open — matches the button's new disabled state.
    useEffect(() => {
        if (fillOpen && fillDisabled) {
            revertPreview();
            setFillOpen(false);
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [fillDisabled]);

    // When opening one style panel, close the other (can't be open at once).
    const openFill = () => {
        if (fillDisabled) return;
        revertPreview();
        setStrokeOpen(false);
        setTextOpen(false);
        // Seed the panel active color from the current effective fill
        // so the highlight starts on the right chip. Subsequent updates
        // happen only on commit — hover previews won't move the ring.
        setPanelFillColor(effectiveFill.enabled === true ? effectiveFill.color : undefined);
        setFillOpen(v => !v);
    };
    const openStroke = () => {
        revertPreview();
        setFillOpen(false);
        setTextOpen(false);
        setPanelStrokeColor(effectiveStroke.enabled === true ? effectiveStroke.color : undefined);
        setStrokeOpen(v => !v);
    };
    const openText = () => {
        revertPreview();
        setFillOpen(false);
        setStrokeOpen(false);
        // Seed the ring on the current effective text color (selection's
        // color if selected, state.textDefaults.color otherwise).
        setPanelTextColor(effectiveText.textColor);
        setTextOpen(v => !v);
    };
    const openScale = () => {
        revertPreview();
        setFillOpen(false);
        setStrokeOpen(false);
        setTextOpen(false);
        setScaleOpen(v => !v);
    };
    const onApplyScale = (factor: number) => {
        scaleSelection({ state, dispatch, pushSnapshot }, factor);
    };

    const shapesButtonIcon = state.tool === 'line'
        ? <LineIcon size={14} />
        : state.shape === 'circle' ? <Circle size={14} />
        : state.shape === 'triangle' ? <Triangle size={14} />
        : state.shape === 'diamond' ? <Diamond size={14} />
        : <Square size={14} />;
    const shapesButtonActive = state.tool === 'box' || state.tool === 'line';

    return (
        <div
            data-canvas-ui="1"
            onWheel={(e) => e.stopPropagation()}
            className="absolute left-3 top-1/2 -translate-y-1/2 z-20 no-drag flex flex-col items-center gap-1 p-1.5 rounded-2xl bg-black/60 border border-white/10 backdrop-blur-xl shadow-[0_6px_28px_rgba(0,0,0,0.5)]"
        >
            {/* T has an inline right-hand slot for the Text ("A") button —
                visible when a text item is selected OR the T-tool is active.
                Rendered as an absolute child of the T wrapper so it floats
                to the right of T rather than growing the vertical toolbar
                stack. Smooth fade/slide-in on appearance. */}
            <div className="relative">
                <ToolButton label="Type (T)" active={state.tool === 'type'} onClick={() => setTool('type')}><Type size={14} /></ToolButton>
                <div
                    className={cn(
                        'absolute left-full top-0 ml-2 p-1.5 rounded-2xl bg-black/60 border border-white/10 backdrop-blur-xl shadow-[0_6px_28px_rgba(0,0,0,0.5)] transition-all duration-150 ease-out',
                        textButtonVisible
                            ? 'opacity-100 translate-x-0'
                            : 'opacity-0 -translate-x-1 pointer-events-none',
                    )}
                >
                    <div className="relative">
                        <ToolButton label="Text" active={textOpen} onClick={openText}>
                            <TextIcon color={effectiveText.textColor} />
                        </ToolButton>
                        {textButtonVisible && textOpen && (
                            <TextPanel
                                ref={textPopoverRef}
                                fontFamily={effectiveText.fontFamily}
                                fontSize={effectiveText.fontSize}
                                bold={effectiveText.bold}
                                italic={effectiveText.italic}
                                underline={effectiveText.underline}
                                strikethrough={effectiveText.strikethrough}
                                color={effectiveText.textColor}
                                textAlign={effectiveText.textAlign}
                                verticalAlign={effectiveText.verticalAlign}
                                recentColors={recentColors}
                                onPreviewFont={onPreviewFont}
                                onCommitFont={onCommitFont}
                                onPreviewSize={onPreviewSize}
                                onCommitSize={onCommitSize}
                                onCommitBold={onCommitBold}
                                onCommitItalic={onCommitItalic}
                                onCommitUnderline={onCommitUnderline}
                                onCommitStrikethrough={onCommitStrikethrough}
                                onPreviewColor={onPreviewTextColor}
                                onCommitColor={onCommitTextColor}
                                onCommitAlignment={onCommitAlignment}
                                onRevertPreview={revertPreview}
                            />
                        )}
                    </div>
                </div>
            </div>
            <ToolButton label="Select (V)" active={state.tool === 'select'} onClick={() => setTool('select')}><MousePointer2 size={14} /></ToolButton>
            <div className="relative">
                <ToolButton
                    label="Shapes & line"
                    active={shapesButtonActive}
                    onClick={() => setShapesOpen(v => !v)}
                >
                    {shapesButtonIcon}
                </ToolButton>
                {shapesOpen && (
                    <div
                        ref={shapesPopoverRef}
                        className="absolute left-full ml-2 top-0 z-30 p-1.5 rounded-xl bg-[#12121a] border border-white/10 shadow-[0_10px_40px_rgba(0,0,0,0.5)] flex flex-col gap-0.5"
                    >
                        <ShapePopoverItem
                            label="Rectangle"
                            active={state.tool === 'box' && state.shape === 'rect'}
                            onClick={() => { dispatch({ type: 'SET_SHAPE', shape: 'rect' }); setTool('box'); setShapesOpen(false); }}
                        ><Square size={13} /></ShapePopoverItem>
                        <ShapePopoverItem
                            label="Circle"
                            active={state.tool === 'box' && state.shape === 'circle'}
                            onClick={() => { dispatch({ type: 'SET_SHAPE', shape: 'circle' }); setTool('box'); setShapesOpen(false); }}
                        ><Circle size={13} /></ShapePopoverItem>
                        <ShapePopoverItem
                            label="Triangle"
                            active={state.tool === 'box' && state.shape === 'triangle'}
                            onClick={() => { dispatch({ type: 'SET_SHAPE', shape: 'triangle' }); setTool('box'); setShapesOpen(false); }}
                        ><Triangle size={13} /></ShapePopoverItem>
                        <ShapePopoverItem
                            label="Diamond"
                            active={state.tool === 'box' && state.shape === 'diamond'}
                            onClick={() => { dispatch({ type: 'SET_SHAPE', shape: 'diamond' }); setTool('box'); setShapesOpen(false); }}
                        ><Diamond size={13} /></ShapePopoverItem>
                        <div className="h-px bg-white/10 my-0.5" />
                        <ShapePopoverItem
                            label="Line"
                            active={state.tool === 'line'}
                            onClick={() => { setTool('line'); setShapesOpen(false); }}
                        ><LineIcon size={13} /></ShapePopoverItem>
                    </div>
                )}
            </div>
            <ToolButton label="Pen (P)" active={state.tool === 'pen'} onClick={() => setTool('pen')}><Pencil size={14} /></ToolButton>
            <ToolButton label="Connect (C)" active={state.tool === 'connect'} onClick={() => setTool('connect')}><ArrowRight size={14} /></ToolButton>
            <ToolButton label="Eraser (E)" active={state.tool === 'eraser'} onClick={() => setTool('eraser')}><Eraser size={14} /></ToolButton>

            <div className="w-6 h-px bg-white/10 my-1" />

            {/* Capture full screen — KLYPIX hides briefly, screenshots the
                desktop, and drops the JPEG as an ImageItem at viewport
                center. The whole window flickers off-and-on (~150ms) which
                is the standard hide-show cycle the main app already uses. */}
            <ToolButton
                label={capturing === 'screen' ? 'Capturing…' : 'Capture full screen'}
                disabled={!!capturing}
                onClick={() => { void captureToCanvas('screen'); }}
            >
                {capturing === 'screen' ? <Loader2 size={14} className="animate-spin" /> : <Camera size={14} />}
            </ToolButton>

            {/* Snip area — launches the Windows Snipping Tool (ms-screenclip:).
                The main process polls the clipboard for the resulting image,
                so we sit in "Capturing…" until the user finishes drawing or
                cancels. */}
            <ToolButton
                label={capturing === 'snip' ? 'Snipping…' : 'Snip area'}
                disabled={!!capturing}
                onClick={() => { void captureToCanvas('snip'); }}
            >
                {capturing === 'snip' ? <Loader2 size={14} className="animate-spin" /> : <Scissors size={14} />}
            </ToolButton>

            <div className="w-6 h-px bg-white/10 my-1" />

            {/* Fill button — live-preview icon reflects current fill state:
                solid colored swatch when enabled, red-slashed swatch when
                off, greyed `~` when the selection is mixed. */}
            <div className="relative">
                <ToolButton
                    label={fillDisabled ? "Fill (disabled for stroke-only tools)" : "Fill"}
                    active={fillOpen}
                    disabled={fillDisabled}
                    onClick={openFill}
                >
                    <FillIcon color={effectiveFill.color} enabled={effectiveFill.enabled} />
                </ToolButton>
                {fillOpen && (
                    <FillPanel
                        ref={fillPopoverRef}
                        fillColor={panelFillColor}
                        fillEnabled={effectiveFill.enabled}
                        opacity={effectiveOpacity}
                        recentColors={recentColors}
                        onPreviewColor={onPreviewFillColor}
                        onCommitColor={onCommitFillColor}
                        onPreviewFillOff={onPreviewFillOff}
                        onCommitFillOff={onCommitFillOff}
                        onCommitFillOn={onCommitFillOn}
                        onPreviewOpacity={onPreviewOpacity}
                        onCommitOpacity={onCommitOpacity}
                        onRevertPreview={revertPreview}
                    />
                )}
            </div>

            {/* Stroke button — live-preview icon: hollow ring in the current
                stroke color, dashed grey ring when "no stroke", greyed
                ring with `~` for mixed selections. */}
            <div className="relative">
                <ToolButton label="Stroke" active={strokeOpen} onClick={openStroke}>
                    <StrokeIcon color={effectiveStroke.color} enabled={effectiveStroke.enabled} />
                </ToolButton>
                {strokeOpen && (
                    <StrokePanel
                        ref={strokePopoverRef}
                        strokeColor={panelStrokeColor}
                        strokeEnabled={effectiveStroke.enabled}
                        strokeWidth={effectiveStrokeWidth}
                        lineStyle={effectiveLineStyle}
                        recentColors={recentColors}
                        onPreviewColor={onPreviewStrokeColor}
                        onCommitColor={onCommitStrokeColor}
                        onPreviewStrokeOff={onPreviewStrokeOff}
                        onCommitStrokeOff={onCommitStrokeOff}
                        onCommitStrokeOn={onCommitStrokeOn}
                        onPreviewWidth={onPreviewWidth}
                        onCommitWidth={onCommitWidth}
                        onPreviewLineStyle={onPreviewLineStyle}
                        onCommitLineStyle={onCommitLineStyle}
                        onRevertPreview={revertPreview}
                    />
                )}
            </div>

            <div className="w-6 h-px bg-white/10 my-1" />

            {/* Scale — multiply selection size by a chosen factor around
                its bounding-box center. Disabled when nothing is selected. */}
            <div className="relative">
                <ToolButton
                    label={hasSelection ? "Scale" : "Scale (select something first)"}
                    active={scaleOpen}
                    disabled={!hasSelection}
                    onClick={openScale}
                >
                    <Scaling size={14} />
                </ToolButton>
                {scaleOpen && (
                    <ScalePanel
                        ref={scalePopoverRef}
                        hasSelection={hasSelection}
                        onApply={onApplyScale}
                    />
                )}
            </div>

            <div className="w-6 h-px bg-white/10 my-1" />

            <ToolButton label="Undo (Ctrl+Z)" onClick={() => { revertPreview(); undo(); }} disabled={!canUndo}><Undo2 size={13} /></ToolButton>
            <ToolButton label="Redo (Ctrl+Shift+Z)" onClick={() => { revertPreview(); redo(); }} disabled={!canRedo}><Redo2 size={13} /></ToolButton>
        </div>
    );
}

function ShapePopoverItem({ active, onClick, label, children }: { active: boolean; onClick: () => void; label: string; children: React.ReactNode }) {
    return (
        <button
            onClick={onClick}
            title={label}
            className={cn(
                'flex items-center gap-2 px-2 py-1.5 rounded-md transition-all cursor-pointer text-[11px] font-medium text-left min-w-[108px]',
                active
                    ? 'bg-emerald-500/25 text-emerald-300'
                    : 'text-white/60 hover:bg-white/10 hover:text-white',
            )}
        >
            <span className="shrink-0 w-4 flex items-center justify-center">{children}</span>
            <span>{label}</span>
        </button>
    );
}

interface ToolButtonProps {
    active?: boolean;
    disabled?: boolean;
    onClick: () => void;
    label: string;
    children: React.ReactNode;
}

// Live-preview Fill icon: filled disc in the current color, slashed
// transparent disc for "no fill", greyed `~` disc for mixed selection.
// Sized to match the 13-14px footprint of the lucide-react icons it
// replaces so the toolbar's rhythm stays the same.
function FillIcon({ color, enabled }: { color: string | undefined; enabled: boolean | undefined }) {
    // Mixed — color is undefined OR enabled is undefined but at least
    // one selected item contributed. Fall back to the greyed `~` state.
    const isMixed = enabled === undefined || (enabled === true && color === undefined);
    const isOff = enabled === false;
    if (isMixed) {
        return (
            <span
                className="w-[14px] h-[14px] rounded-full flex items-center justify-center text-[9px] leading-none font-semibold text-white/60 ring-1 ring-white/25"
                style={{ background: 'rgba(255,255,255,0.08)' }}
            >~</span>
        );
    }
    if (isOff) {
        return (
            <span className="w-[14px] h-[14px] rounded-full relative overflow-hidden ring-1 ring-white/30">
                <span
                    className="absolute inset-0"
                    style={{
                        background: 'linear-gradient(45deg, transparent calc(50% - 1px), #ef4444 calc(50% - 1px), #ef4444 calc(50% + 1px), transparent calc(50% + 1px))',
                    }}
                />
            </span>
        );
    }
    return (
        <span
            className="w-[14px] h-[14px] rounded-full ring-1 ring-white/30"
            style={{ background: color }}
        />
    );
}

// Live-preview Stroke icon: hollow ring in the current stroke color,
// dashed grey ring for "no stroke", greyed `~` ring for mixed. Border
// thickness is fixed (not proportional to actual stroke width) — the
// Width slider inside StrokePanel is the source of truth for that.
function StrokeIcon({ color, enabled }: { color: string | undefined; enabled: boolean | undefined }) {
    const isMixed = enabled === undefined || (enabled === true && color === undefined);
    const isOff = enabled === false;
    if (isMixed) {
        return (
            <span
                className="w-[14px] h-[14px] rounded-full flex items-center justify-center text-[9px] leading-none font-semibold text-white/60"
                style={{ border: '2px solid rgba(255,255,255,0.3)' }}
            >~</span>
        );
    }
    if (isOff) {
        return (
            <span
                className="w-[14px] h-[14px] rounded-full"
                style={{ border: '2px dashed rgba(255,255,255,0.35)' }}
            />
        );
    }
    return (
        <span
            className="w-[14px] h-[14px] rounded-full"
            style={{ border: `2px solid ${color}` }}
        />
    );
}

// Live-preview Text icon: a bold letter "A" rendered in the current
// text color. Greyed when the selection is mixed. Shown only for the
// Text button, which itself only appears when a text item is selected.
function TextIcon({ color }: { color: string | undefined }) {
    const isMixed = color === undefined;
    return (
        <span
            className="w-[14px] h-[14px] flex items-center justify-center text-[12px] leading-none font-bold"
            style={{ color: isMixed ? 'rgba(255,255,255,0.45)' : color }}
        >
            A
        </span>
    );
}

function ToolButton({ active, disabled, onClick, label, children }: ToolButtonProps) {
    return (
        <button
            onClick={onClick}
            disabled={disabled}
            title={label}
            className={cn(
                'w-8 h-8 flex items-center justify-center rounded-lg transition-all cursor-pointer',
                active
                    ? 'bg-emerald-500/25 text-emerald-300 shadow-[0_0_12px_rgba(16,185,129,0.25)]'
                    : 'text-white/50 hover:bg-white/10 hover:text-white',
                disabled && 'opacity-30 cursor-not-allowed hover:bg-transparent'
            )}
        >
            {children}
        </button>
    );
}
