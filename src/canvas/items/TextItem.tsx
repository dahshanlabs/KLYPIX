import React, { useEffect, useRef } from 'react';
import type { TextItem as TextItemType, StyleRun } from './types';
import { useCanvasStore } from '../state/canvasStore';
import { ResizeHandle } from '../interaction/ResizeHandle';
import { useGridSettings, luminance, isDarkBackground } from '../gridSettings';
import { getStyleAt, shiftRuns, diffSingleEdit } from './styleRuns';
import { renumberNumberedLines, stripListPrefixes, LIST_PREFIX_RE } from './listOps';

// Contrast-gated legibility halo for plain text sitting directly on the
// canvas surface (no border, no parent container). When the text color
// is close in luminance to the canvas background, the text disappears —
// so we paint a faint halo in the opposite luminance. Above-threshold
// contrast gets no halo (otherwise every text item looks glowy).
//
// Threshold was 0.3, but that flagged perfectly-readable saturated hues
// (orange on cream: luminance delta ≈ 0.29) and painted a halo nobody
// asked for. Dropped to 0.15 — only fires for genuinely-invisible
// cases (yellow on white, light-grey on cream, white on white), where
// the text would actually disappear without the glow.
const HALO_LUM_THRESHOLD = 0.15;
function haloShadowFor(textColor: string, bgColor: string): string | undefined {
    const delta = Math.abs(luminance(textColor) - luminance(bgColor));
    if (delta >= HALO_LUM_THRESHOLD) return undefined;
    const haloRgba = isDarkBackground(bgColor) ? 'rgba(255,255,255,0.55)' : 'rgba(0,0,0,0.55)';
    return `0 0 3px ${haloRgba}, 0 0 6px ${haloRgba}`;
}

// Pretty-liberal URL matcher — good enough for "I pasted a link" detection.
// Requires a protocol so we don't underline every "word.thing".
const URL_REGEX = /\b(https?:\/\/[^\s<>"]+)/gi;

export function containsUrl(text: string): boolean {
    URL_REGEX.lastIndex = 0;
    return URL_REGEX.test(text);
}

export function firstUrl(text: string): string | null {
    URL_REGEX.lastIndex = 0;
    const m = URL_REGEX.exec(text);
    return m ? m[1] : null;
}

// Split content into alternating text / URL chunks so we can wrap URLs in
// clickable spans without affecting the rest of the rendering. A plain
// click falls through to the surface (so the item can be selected / dragged
// / resized); Ctrl+click (or Cmd+click on Mac) opens the URL in the
// browser. This mirrors how editors like VS Code handle inline links —
// otherwise every click on a pasted link would open the browser and the
// user could never select the text item to resize it.
function renderWithLinks(content: string, open: (url: string) => void): React.ReactNode[] {
    const out: React.ReactNode[] = [];
    URL_REGEX.lastIndex = 0;
    let i = 0;
    let m: RegExpExecArray | null;
    let key = 0;
    while ((m = URL_REGEX.exec(content)) !== null) {
        if (m.index > i) out.push(content.slice(i, m.index));
        const href = m[1];
        out.push(
            <span
                key={key++}
                onClick={(e) => {
                    if (!(e.ctrlKey || e.metaKey)) return;
                    e.stopPropagation();
                    e.preventDefault();
                    open(href);
                }}
                style={{
                    color: '#10b981',
                    textDecoration: 'underline',
                    textUnderlineOffset: 2,
                    cursor: 'pointer',
                }}
                title="Ctrl+click to open in browser"
            >
                {href}
            </span>,
        );
        i = m.index + href.length;
    }
    if (i < content.length) out.push(content.slice(i));
    return out;
}

// Render content with per-range styling from `runs`, falling back to
// the plain link renderer when there are no runs (keeping the hot path
// cheap for the common case of uniformly-styled text). Runs supply
// overrides — every span inherits item-level color/weight/etc., and a
// span only sets CSS for the override fields actually present on the
// run covering it. URL detection runs per-chunk; a URL that happens to
// straddle a run boundary won't be linkified as a single anchor (rare
// in practice — users don't manually style halves of URLs).
function renderStyledContent(
    content: string,
    runs: StyleRun[] | undefined,
    open: (url: string) => void,
): React.ReactNode[] {
    if (!runs || runs.length === 0) {
        return renderWithLinks(content, open);
    }
    const breaks = new Set<number>([0, content.length]);
    for (const r of runs) {
        if (r.start > 0 && r.start < content.length) breaks.add(r.start);
        if (r.end > 0 && r.end < content.length) breaks.add(r.end);
    }
    const sorted = Array.from(breaks).sort((a, b) => a - b);
    const nodes: React.ReactNode[] = [];
    for (let i = 0; i < sorted.length - 1; i++) {
        const s = sorted[i];
        const e = sorted[i + 1];
        if (s === e) continue;
        const chunk = content.slice(s, e);
        const style = getStyleAt(runs, s);
        const spanStyle: React.CSSProperties = {};
        if (style.color !== undefined) spanStyle.color = style.color;
        if (style.bold) spanStyle.fontWeight = 700;
        if (style.italic) spanStyle.fontStyle = 'italic';
        const decos: string[] = [];
        if (style.underline) decos.push('underline');
        if (style.strikethrough) decos.push('line-through');
        if (decos.length) spanStyle.textDecoration = decos.join(' ');
        if (style.fontSize !== undefined) spanStyle.fontSize = style.fontSize;
        if (style.fontFamily !== undefined) {
            spanStyle.fontFamily = `"${style.fontFamily}", Virgil, Outfit, system-ui, sans-serif`;
        }
        const hasOverride =
            style.color !== undefined || !!style.bold || !!style.italic ||
            !!style.underline || !!style.strikethrough || style.fontSize !== undefined ||
            style.fontFamily !== undefined;
        if (hasOverride) {
            nodes.push(
                <span key={`s${s}`} style={spanStyle}>
                    {renderWithLinks(chunk, open)}
                </span>,
            );
        } else {
            nodes.push(<React.Fragment key={`s${s}`}>{renderWithLinks(chunk, open)}</React.Fragment>);
        }
    }
    return nodes;
}

// Line-level list rendering. Splits content on '\n' and emits a block
// per line with hanging-indent CSS so a long bullet that wraps to two
// visual rows aligns the wrapped tail under the text, not under the
// bullet glyph. Prefixes ('• ' / '1. ') are baked into `content` by
// the toggle handler in TextFormatCapsule and by the in-editor Enter
// key, so renderStyledContent paints them naturally — and the textarea
// shows them too while editing (matching Word's UX).
//
// Legacy fallback: items created before content-baking shipped have
// `listType` set without prefixes in content. For those, prepend a
// render-only prefix span so the visible list isn't blank. Editing
// such an item bakes prefixes in (toggle off → on, or any content
// edit through the Enter handler), at which point the fallback no
// longer fires for that line.
function renderStyledLines(
    content: string,
    runs: StyleRun[] | undefined,
    listType: 'bullet' | 'numbered' | undefined,
    bordered: boolean,
    open: (url: string) => void,
): React.ReactNode {
    if (!listType) return renderStyledContent(content, runs, open);
    const lines = content.split('\n');
    // Legacy items (created before content-baking shipped) carry
    // listType but no baked prefixes anywhere. Detect that case so
    // we know to fall back to render-only prefixes for ALL lines.
    // For modern items (any baked prefix in any line), un-prefixed
    // lines are treated as Shift+Enter soft continuations and render
    // without a number — Word-style.
    const isLegacy = !lines.some(l => LIST_PREFIX_RE.test(l));
    let offset = 0;
    let legacyNonEmptyIdx = 0;
    return lines.map((line, idx) => {
        const lineStart = offset;
        offset += line.length + 1;
        if (line.length === 0) {
            return <div key={idx}>{'​'}</div>;
        }
        const hasBaked = LIST_PREFIX_RE.test(line);
        if (isLegacy) legacyNonEmptyIdx++;
        const fallbackPrefix = !hasBaked && isLegacy
            ? (listType === 'bullet' ? '• ' : `${legacyNonEmptyIdx}. `)
            : null;
        const isContinuation = !hasBaked && !isLegacy;
        const lineRuns: StyleRun[] | undefined = runs && runs.length > 0
            ? runs
                .map(r => ({
                    ...r,
                    start: Math.max(0, r.start - lineStart),
                    end: Math.min(line.length, r.end - lineStart),
                }))
                .filter(r => r.start < r.end)
            : undefined;
        // Hanging indent for prefixed lines (bullet sits at left edge,
        // wrapped tail aligns under the body). Continuation lines drop
        // the negative text-indent so their first character starts at
        // body position — visually nested under the previous bullet.
        //
        // Whitespace policy depends on whether the item has a border:
        //   - Bordered card → fixed width, lines wrap inside the box
        //     using the parent's pre-wrap + break-word; the NBSP after
        //     the bullet keeps the prefix glued to the body so wrap
        //     happens mid-body, never between bullet and first char.
        //   - Plain text  → max-content width, lines stay on one
        //     visual row (whiteSpace: pre) so the box auto-grows to
        //     match what the user typed in edit mode. wordBreak:
        //     normal prevents the parent's break-word from collapsing
        //     max-content to a single character when the body is long
        //     and unbreakable.
        const blockStyle: React.CSSProperties = bordered
            ? (isContinuation
                ? { paddingLeft: '1.5em' }
                : { paddingLeft: '1.5em', textIndent: '-1.5em' })
            : {
                paddingLeft: '1.5em',
                whiteSpace: 'pre',
                wordBreak: 'normal',
                ...(isContinuation ? {} : { textIndent: '-1.5em' }),
            };
        return (
            <div key={idx} style={blockStyle}>
                {fallbackPrefix && (
                    <span style={{ opacity: 0.85, whiteSpace: 'pre' }}>{fallbackPrefix}</span>
                )}
                {renderStyledContent(line, lineRuns, open)}
            </div>
        );
    });
}

interface Props {
    item: TextItemType;
    selected: boolean;
    editing: boolean;
}

export const TextItemView = React.memo(TextItemViewImpl, (prev, next) => {
    // Bail out unless this item or its selection/edit flags actually changed.
    return (
        prev.item === next.item &&
        prev.selected === next.selected &&
        prev.editing === next.editing
    );
});

function openExternalFromText(url: string) {
    try {
        const fn = (window as any).electron?.openExternal;
        if (typeof fn === 'function') { fn(url); return; }
    } catch { /* noop */ }
    window.open(url, '_blank');
}

function TextItemViewImpl({ item, selected, editing }: Props) {
    const { dispatch } = useCanvasStore();
    const textareaRef = useRef<HTMLTextAreaElement>(null);
    const displayRef = useRef<HTMLDivElement>(null);
    // Inner div inside the bordered-edit overlay. Translated up by the
    // textarea's scrollTop so per-range styleRun colors stay aligned with
    // characters when the user scrolls a long card. Only used in bordered
    // edit mode; null elsewhere.
    const overlayInnerRef = useRef<HTMLDivElement | null>(null);

    useEffect(() => {
        if (!editing) return;
        let cancelled = false;
        let rafHandle = 0;
        let retryHandle = 0;
        // Windows won't grant keyboard focus to an alwaysOnTop+transparent
        // overlay when it's merely clicked — DOM focus works but keystrokes
        // go to the previously foreground app. We AWAIT an OS-level focus
        // request so the render widget is ready before we call
        // textarea.focus(). Then we also fire textarea.click() — that's
        // Chromium's "real" focus path, triggering IME attachment too. On
        // a cold-cache first-interaction, .focus() alone sometimes sets
        // activeElement without wiring keystrokes; .click() reliably does.
        const focusTextarea = () => {
            if (cancelled) return;
            const el = textareaRef.current;
            if (!el) return;
            el.focus({ preventScroll: true });
            try { el.click(); } catch { /* no-op */ }
            try { el.setSelectionRange(el.value.length, el.value.length); } catch {}
        };
        (async () => {
            try { await (window as any).electron?.focusWindow?.(); } catch { /* no-op */ }
            if (cancelled) return;
            rafHandle = requestAnimationFrame(focusTextarea);
            // Retry once after 80ms as a safety net for first-launch races
            // where the first focus call happens before Chromium's render
            // widget is listening for keyboard events yet.
            retryHandle = window.setTimeout(() => {
                const el = textareaRef.current;
                if (!el) return;
                if (document.activeElement !== el) focusTextarea();
            }, 80);
        })();
        return () => {
            cancelled = true;
            if (rafHandle) cancelAnimationFrame(rafHandle);
            if (retryHandle) clearTimeout(retryHandle);
        };
    }, [editing]);

    // Plain (borderless) text items auto-size to their content via CSS
    // (width: max-content) unless the user has explicitly shrunk the box —
    // then `authoredWidth` locks width and the text wraps. Keep item.w/h in
    // state synced so resize handles sit on the real edges.
    //
    // Depend on `editing` because the display div is only mounted when NOT
    // editing; without this dep, the first measure runs while displayRef is
    // still null (editing=true) and never re-fires, leaving item.w at the
    // stale 260 default and the selection handles way wider than the text.
    const isPlain = !item.border;
    const authored = item.authoredWidth;
    const textAlignH = item.textAlign ?? 'left';
    const textAlignV = item.verticalAlign ?? 'top';
    const flexJustify = textAlignV === 'top' ? 'flex-start' : textAlignV === 'middle' ? 'center' : 'flex-end';

    // Halo (textShadow) was a legacy workaround for the case where the
    // hardcoded default text color (#e8e8ed) ended up close in luminance
    // to the canvas background — the text would otherwise be invisible.
    // New items now pick a default color from `defaultTextColorFor` at
    // creation time so the contrast is built in, and any user-picked
    // color is treated as intentional. Keeping the canvasBg read here
    // because some downstream comments still reference it; this side of
    // the file is otherwise unchanged.
    const canvasBg = useGridSettings().background;
    void canvasBg;
    const textShadow: string | undefined = undefined;

    // Clear the user-resized-height pin the moment the user enters edit
    // mode. Typing more text expects auto-grow to resume; without this
    // the card would clip new lines because the height is locked from
    // a prior manual resize.
    useEffect(() => {
        if (!editing) return;
        if (!item.userResizedHeight) return;
        dispatch({ type: 'UPDATE_ITEM', id: item.id, patch: { userResizedHeight: false } as any });
    }, [editing, item.id, item.userResizedHeight, dispatch]);

    // During editing: observe the textarea's own size (fieldSizing:content
    // grows it with content) and sync item.w/h on every change. This is
    // the "grow with typing" behavior for plain text. Bordered text
    // (box-to-text conversion, agent cards) was explicitly sized by the
    // user at creation; letting the textarea's content-sized footprint
    // collapse item.w/h at edit-mode entry was blowing big boxes down to
    // a ~200×17 slab (invisible at low zoom). Bordered items now preserve
    // their authored dimensions in edit mode; the textarea wraps inside.
    useEffect(() => {
        if (!editing) return;
        if (item.border) return;
        const el = textareaRef.current;
        if (!el) return;
        const measure = () => {
            const nw = el.offsetWidth + 1;
            const nh = el.offsetHeight + 1;
            // Skip suspiciously-zero measurements — can happen on the
            // first paint after remount (e.g. when returning from
            // dot-mode at low zoom). Patching item.w = 1 would trap
            // the item in dot-mode permanently because dotted items
            // don't render, so ResizeObserver never fires again to
            // correct the measurement.
            if (nw < 2 && nh < 2) return;
            const patch: any = {};
            if (Math.abs(nw - item.w) > 1) patch.w = nw;
            if (Math.abs(nh - item.h) > 1) patch.h = nh;
            if (Object.keys(patch).length) {
                dispatch({ type: 'UPDATE_ITEM', id: item.id, patch });
            }
        };
        measure();
        const ro = new ResizeObserver(measure);
        ro.observe(el);
        return () => ro.disconnect();
    }, [editing, item.border, item.id, item.w, item.h, dispatch]);

    useEffect(() => {
        if (!isPlain) return;
        if (editing) return;
        const el = displayRef.current;
        if (!el) return;
        const measure = () => {
            // CRITICAL: use offsetWidth/Height (pre-transform layout dims)
            // not getBoundingClientRect (post-transform, multiplied by the
            // canvas zoom). getBoundingClientRect would patch item.w with
            // SCREEN pixels at the current zoom — then at a different zoom
            // the stored world width is wrong and text layouts appear to
            // change with the zoom. offsetWidth is the layout dimension,
            // zoom-independent. We add 1 to cover the sub-pixel content
            // the display div's max-content sizing can include; otherwise
            // a freshly-opened textarea wraps a line the display didn't.
            const nw = el.offsetWidth + 1;
            const nh = el.offsetHeight + 1;
            // Always sync item.w/h to the rendered size. When authoredWidth
            // is set, nw equals authoredWidth (same CSS source). The handles
            // position off item.w, so if we let it stay stale they'd span
            // the pre-shrink box while the visible text sits inside it.
            const patch: any = {};
            if (Math.abs(nw - item.w) > 1) patch.w = nw;
            if (Math.abs(nh - item.h) > 1) patch.h = nh;
            if (Object.keys(patch).length) {
                dispatch({ type: 'UPDATE_ITEM', id: item.id, patch });
            }
        };
        measure();
        const ro = new ResizeObserver(measure);
        ro.observe(el);
        return () => ro.disconnect();
    }, [isPlain, editing, authored, item.id, item.w, item.h, dispatch]);

    // Bordered, non-editing: width is authored (see note above on edit-
    // mode behavior), but the display div uses minHeight: item.h, so the
    // rendered box grows past item.h whenever content wraps taller than
    // the authored height (common for agent-generated cards). Without
    // this sync, selection handles and connection edge-anchors stay
    // pinned to the smaller item.h while the visible card extends below.
    // Height only — never patch w, or we'd undo the authored width.
    //
    // Suppressed once the user has explicitly resized the card's height
    // (userResizedHeight flag set by ResizeHandle). The observer would
    // otherwise snap h back to the rendered content height the next
    // render — which is exactly the "drag inward → bounce taller on
    // release" bug. The flag clears on entering edit mode so typing more
    // text re-enables auto-grow.
    useEffect(() => {
        if (isPlain) return;
        if (editing) return;
        if (item.userResizedHeight) return;
        const el = displayRef.current;
        if (!el) return;
        const measure = () => {
            const nh = el.offsetHeight + 1;
            if (nh < 2) return;
            if (Math.abs(nh - item.h) > 1) {
                dispatch({ type: 'UPDATE_ITEM', id: item.id, patch: { h: nh } });
            }
        };
        measure();
        const ro = new ResizeObserver(measure);
        ro.observe(el);
        return () => ro.disconnect();
    }, [isPlain, editing, item.id, item.h, item.userResizedHeight, dispatch]);

    // Agent-authored bordered cards get a neutral look-and-feel with a
    // subtle violet left-bar accent + a tiny "AI" chip in the corner, so
    // they read as "agent wrote this" without inverting the theme. The
    // pre-existing dark fallback fill stranded these cards as dark slabs
    // on the light canvas — that was the source of the visual mismatch.
    const isAgentCard = item.createdBy === 'agent' && item.border;

    const style: React.CSSProperties = {
        position: 'absolute',
        left: item.x,
        top: item.y,
        // Plain text: max-content by default, or authoredWidth if the user
        // shrunk the box (wraps at that width, font stays put). Bordered
        // cards keep a user-sized box. No maxWidth cap — a freshly-typed
        // single line should display exactly as typed, never wrapped.
        // Wrapping only happens when the user explicitly resizes the text
        // (which sets authoredWidth for plain / item.w for bordered).
        width: isPlain
            ? (authored != null ? authored : 'max-content')
            : item.w,
        // Bordered card: minHeight by default so content is allowed to grow
        // the visible box (auto-grow observer keeps item.h in sync). Once
        // the user has explicitly resized, lock to a hard height + clip so
        // selection handles always hug the visible box — without this the
        // content overflow would render taller than item.h and the handles
        // would sit inside the visible card.
        ...(isPlain
            ? {}
            : item.userResizedHeight
                ? { height: item.h, overflow: 'hidden' as const }
                : { minHeight: item.h }),
        boxSizing: 'border-box',
        fontSize: item.fontSize,
        color: item.color,
        textShadow,
        fontWeight: item.heading || item.fontWeight === 'bold' ? 700 : 400,
        fontStyle: item.fontStyle === 'italic' ? 'italic' : 'normal',
        fontFamily: item.fontFamily ? `"${item.fontFamily}", Virgil, Outfit, system-ui, sans-serif` : 'Virgil, Outfit, system-ui, sans-serif',
        textDecoration: [item.textDecoration === 'underline' && 'underline', item.strikethrough && 'line-through'].filter(Boolean).join(' ') || 'none',
        lineHeight: 1.35,
        padding: item.border ? '8px 10px' : '2px',
        // Text item's own border — bordered cards use item.borderWidth
        // (counter-zoomed at creation time, inherited from the source
        // box on double-click conversion) so the border stays visually
        // consistent with the box it replaced at any zoom. Plain text
        // has a transparent 1-px border to avoid layout shift on toggle.
        // Selection feedback is drawn by the screen-space overlay ring
        // in CanvasRenderer so we don't paint a second outline here.
        border: item.border
            ? (isAgentCard
                ? `${item.borderWidth ?? 1}px ${item.lineStyle || 'solid'} rgba(139,92,246,0.22)`
                : `${item.borderWidth ?? 1}px ${item.lineStyle || 'solid'} ${item.borderColor}`)
            : '1px solid transparent',
        borderRadius: item.border ? 8 : 4,
        // Background: bordered cards inherit the source box's fill color
        // when the user double-clicks a filled box to enter text. Agent
        // cards without an explicit fill get a barely-tinted violet chip
        // so they blend with the canvas (user or light) instead of
        // slamming down a dark slab. Non-agent bordered items with no
        // fill still get the legacy dark fallback.
        background: item.border
            ? (item.fillColor && item.fillColor !== 'transparent'
                ? item.fillColor
                : (isAgentCard ? 'rgba(139,92,246,0.05)' : 'rgba(18,18,26,0.8)'))
            : 'transparent',
        // Violet inset left-bar on agent cards — the authorship signal.
        // Drawn via inset box-shadow so it layers on top of whatever
        // border color the card already has, with no layout cost.
        ...(isAgentCard ? { boxShadow: 'inset 3px 0 0 rgba(139,92,246,0.9)' } : null),
        opacity: item.opacity ?? 1,
        userSelect: editing ? 'text' : 'none',
        // Electron's drag region is set on the window's glass wrapper; children
        // inside a `no-drag` region need no-drag too when they want keyboard
        // focus. Spell it out explicitly so typing is never swallowed.
        WebkitAppRegion: 'no-drag',
        pointerEvents: 'auto',
        cursor: editing ? 'text' : 'default',
        whiteSpace: 'pre-wrap',
        wordBreak: 'break-word',
        // Alignment — only applied to bordered cards (plain text has no box
        // to align within, so defaults stay no-op). textAlign affects the
        // text itself; the flex column with justifyContent positions the
        // content vertically inside the fixed box.
        ...(item.border ? {
            display: 'flex',
            flexDirection: 'column',
            justifyContent: flexJustify,
            textAlign: textAlignH,
        } : null),
    } as React.CSSProperties & { WebkitAppRegion?: string };

    if (editing) {
        // Shared type-setting props between the transparent textarea
        // (owns input + caret) and the styled overlay behind it (paints
        // the styleRuns so colored ranges show while editing). Any drift
        // between these two layers = chars misalign → overlay ghosts
        // slide around as you type. Keep identical: font family / size /
        // weight / style, line-height, padding, border, white-space,
        // word-break, letter-spacing.
        const typeset: React.CSSProperties = {
            fontSize: item.fontSize,
            fontFamily: item.fontFamily ? `"${item.fontFamily}", Virgil, Outfit, system-ui, sans-serif` : 'Virgil, Outfit, system-ui, sans-serif',
            fontWeight: item.heading || item.fontWeight === 'bold' ? 700 : 400,
            fontStyle: item.fontStyle === 'italic' ? 'italic' : 'normal',
            textDecoration: [item.textDecoration === 'underline' && 'underline', item.strikethrough && 'line-through'].filter(Boolean).join(' ') || 'none',
            lineHeight: 1.35,
        };

        // Shared onChange behavior for typing: shift styleRun offsets
        // so runs keep covering the same characters after the
        // insert/delete. The overlay re-renders automatically from the
        // dispatched content/runs, so per-run coloring tracks the caret.
        const applyContentChange = (newContent: string) => {
            const patch: Partial<TextItemType> = { content: newContent };
            if (item.styleRuns && item.styleRuns.length > 0 && item.content !== newContent) {
                const { pos, delta } = diffSingleEdit(item.content, newContent);
                if (delta !== 0) {
                    patch.styleRuns = shiftRuns(item.styleRuns, pos, delta, newContent.length);
                }
            }
            dispatch({ type: 'UPDATE_ITEM', id: item.id, patch: patch as any });
        };

        // Enter key inside a bulleted/numbered list. Returns true when
        // handled (consumes the keystroke), false to fall through. Two
        // behaviors, mirroring Word:
        //   1. Pressing Enter on a line that is JUST an empty prefix
        //      ("• " or "5. ") → exit list mode for the whole item:
        //      strip every prefix and clear listType. The keystroke
        //      is consumed, so no extra newline is added.
        //   2. Otherwise → insert "\n• " (bullet) or "\n{N}. " (numbered)
        //      at the caret. For numbered lists, re-run applyNumberedPrefixes
        //      on the resulting content so subsequent lines renumber
        //      cleanly (handles mid-list inserts: typing Enter after
        //      "2. b" in "1. a / 2. b / 3. c" produces 1/2/new/3 → 1/2/3/4).
        const handleListEnter = (e: React.KeyboardEvent<HTMLTextAreaElement>): boolean => {
            if (e.key !== 'Enter' || !item.listType) return false;
            if (e.shiftKey) return false; // shift+enter = literal newline, no prefix
            const ta = e.currentTarget;
            const sel = ta.selectionStart;
            const value = ta.value;
            const lineStart = value.lastIndexOf('\n', sel - 1) + 1;
            const lineEndN = value.indexOf('\n', sel);
            const lineEnd = lineEndN === -1 ? value.length : lineEndN;
            const currentLine = value.slice(lineStart, lineEnd);

            const isEmptyPrefix = item.listType === 'bullet'
                ? /^•\s$/.test(currentLine)
                : /^\d+\.\s$/.test(currentLine);
            if (isEmptyPrefix && sel === lineEnd) {
                e.preventDefault();
                const stripped = stripListPrefixes(item.content, item.styleRuns);
                dispatch({
                    type: 'UPDATE_ITEM',
                    id: item.id,
                    patch: {
                        content: stripped.content,
                        styleRuns: stripped.runs ?? [],
                        listType: undefined,
                    } as any,
                });
                return true;
            }

            e.preventDefault();
            const before = value.slice(0, sel);
            const after = value.slice(sel);
            // Provisional number = (number of '\n' before caret) + 2.
            // The renumber pass below corrects this if it's wrong; the
            // provisional value just gives us a non-empty prefix to
            // insert and shift styleRuns against.
            const provisionalNum = (before.match(/\n/g)?.length ?? 0) + 2;
            // NBSP ( ) instead of regular space so a long body
            // doesn't wrap the bullet/number onto its own row in narrow
            // containers — see PREFIX_SEP in listOps.ts.
            const prefix = item.listType === 'bullet' ? '• ' : `${provisionalNum}. `;
            const insertion = '\n' + prefix;
            let newContent = before + insertion + after;
            let newRuns: StyleRun[] | undefined = item.styleRuns;
            if (item.styleRuns && item.styleRuns.length > 0) {
                newRuns = shiftRuns(item.styleRuns, sel, insertion.length, newContent.length);
            }
            if (item.listType === 'numbered') {
                // Re-sequence existing numbered prefixes only — leave
                // any Shift+Enter continuation lines without prefixes
                // alone (Word's soft-break behavior).
                const renumbered = renumberNumberedLines(newContent, newRuns);
                newContent = renumbered.content;
                newRuns = renumbered.runs;
            }
            const patch: any = { content: newContent };
            if (newRuns !== item.styleRuns) patch.styleRuns = newRuns ?? [];
            dispatch({ type: 'UPDATE_ITEM', id: item.id, patch });

            // Caret lands at start-of-body of the freshly-inserted line.
            // Numbered renumber may have changed the new line's prefix
            // length (e.g. "10. " vs the provisional "5. "), so we look
            // up the actual prefix length post-renumber by splitting
            // newContent and skipping past the matching prefix.
            requestAnimationFrame(() => {
                const newLines = newContent.split('\n');
                const newLineIdx = (before.match(/\n/g)?.length ?? 0) + 1;
                let pos = 0;
                for (let i = 0; i < newLineIdx && i < newLines.length; i++) {
                    pos += newLines[i].length + 1;
                }
                const targetLine = newLines[newLineIdx] ?? '';
                const m = LIST_PREFIX_RE.exec(targetLine);
                const caretPos = pos + (m ? m[0].length : 0);
                try { ta.setSelectionRange(caretPos, caretPos); } catch { /* no-op */ }
            });
            return true;
        };

        // Plain text (no border) — "text-editor feel": textarea auto-
        // fits its content via field-sizing:content (Chromium 123+), grows
        // horizontally with typing, no wrap. The edit-mode ResizeObserver
        // above syncs item.w/h to the typed dimensions. No alignment
        // because there's no box to align within.
        if (isPlain) {
            // Two siblings, both absolutely positioned at item.x/y.
            // The original (pre-overlay) code returned a single
            // textarea positioned this way and click-to-place-caret
            // worked perfectly because the textarea sized itself via
            // field-sizing:content. Wrapping both in a shrink-to-fit
            // div broke that — the wrapper's width-auto didn't
            // actually inherit the textarea's intrinsic width, so the
            // textarea ballooned and clicks landed in empty space.
            // Keeping them as siblings preserves the original sizing
            // behavior for the textarea while letting the overlay
            // anchor to the same coords independently.
            const editingStyle: React.CSSProperties = {
                ...style,
                width: 'auto',
                maxWidth: undefined,
                minWidth: 200,
                minHeight: undefined,
                fieldSizing: 'content',
                boxSizing: 'border-box',
                resize: 'none',
                outline: 'none',
                whiteSpace: 'pre',
                wordBreak: 'normal',
                background: 'transparent',
                // Hide textarea's own text — the overlay paints the
                // styled glyphs. Caret stays visible via caret-color;
                // selection highlight (browser blue) draws on top of
                // the textarea, showing the overlay text through it.
                color: 'transparent',
                caretColor: item.color,
            } as React.CSSProperties;
            // Overlay sits at the same item.x/y, sized to its own
            // content (max-content). Same padding/border/font as the
            // textarea so per-character positions align. pointer-
            // events:none lets clicks fall through to the textarea
            // sibling beneath it in DOM order — but the textarea is
            // listed AFTER the overlay so it stacks ON TOP and gets
            // the click natively. The overlay only paints; the
            // textarea owns input.
            const overlayStyle: React.CSSProperties = {
                ...style,
                width: 'max-content',
                maxWidth: undefined,
                minWidth: 200,
                minHeight: undefined,
                boxSizing: 'border-box',
                whiteSpace: 'pre',
                wordBreak: 'normal',
                pointerEvents: 'none',
                userSelect: 'none',
                overflow: 'hidden',
            } as React.CSSProperties;
            return (
                <>
                    {/* dir="auto" so the overlay's direction matches the
                        textarea's auto-detected direction. Without it, an
                        Arabic/Hebrew first-strong char flipped the textarea
                        to RTL (caret on the right edge of the min-200 box)
                        while the overlay stayed LTR (glyphs on the left)
                        — caret and visible text drifted apart. */}
                    <div aria-hidden dir="auto" style={overlayStyle}>
                        {item.content
                            ? renderStyledContent(item.content, item.styleRuns, openExternalFromText)
                            : null}
                    </div>
                    <textarea
                        ref={textareaRef}
                        data-canvas-item={item.id}
                        data-canvas-text-edit-id={item.id}
                        dir="auto"
                        className="no-drag"
                        rows={1}
                        spellCheck={false}
                        style={editingStyle}
                        value={item.content}
                        onChange={(e) => applyContentChange(e.target.value)}
                        onBlur={() => dispatch({ type: 'SET_EDITING', id: null })}
                        onKeyDown={(e) => {
                            if (e.key === 'Escape') {
                                e.preventDefault();
                                (e.target as HTMLTextAreaElement).blur();
                                return;
                            }
                            if (handleListEnter(e)) return;
                            e.stopPropagation();
                        }}
                        onPointerDown={(e) => e.stopPropagation()}
                    />
                </>
            );
        }
        // Bordered text — box was explicitly sized by the user; edit mode
        // preserves item.w/h and wraps text inside. Wrapped in a flex
        // column so vertical alignment matches display mode (textarea
        // itself can't vertically center its content natively). The
        // inner position-relative div stacks the overlay + textarea so
        // both share the same layout cell inside the flex column.
        //
        // Height lock: the wrapper uses `height: item.h` (not minHeight)
        // in edit mode. Without this, the textarea's `field-sizing:
        // content` reports a slightly different intrinsic height than
        // the display div would for the same string — browsers reserve
        // a few pixels around a textarea for cursor visibility — and
        // the wrapper would visibly grow on double-click and shrink on
        // blur. Locking height + flexing the textarea to fill (see
        // taStyle) keeps the card's outer shape identical between
        // display and edit modes. Internal scroll handles overflow when
        // the user types past the bottom.
        const wrapperStyle: React.CSSProperties = {
            ...style,
            display: 'flex',
            flexDirection: 'column',
            justifyContent: flexJustify,
            overflow: 'hidden',
            cursor: 'text',
            height: item.h,
            minHeight: undefined,
        };
        const innerStackStyle: React.CSSProperties = {
            position: 'relative',
            width: '100%',
            flex: '1 1 0',
            minHeight: 0,
            display: 'flex',
            flexDirection: 'column',
        };
        const overlayStyle: React.CSSProperties = {
            position: 'absolute',
            inset: 0,
            boxSizing: 'border-box',
            color: item.color,
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
            textAlign: textAlignH,
            pointerEvents: 'none',
            userSelect: 'none',
            overflow: 'hidden',
            padding: 0,
            margin: 0,
            border: 'none',
            ...typeset,
        };
        // Textarea fills the wrapper via `flex: 1` instead of sizing to
        // its content. Combined with the height-locked wrapper, this
        // pins the bordered card's outer shape across the display ↔
        // edit transition. `overflow: auto` gives the user an internal
        // scrollbar if they type past the visible area — the absolute
        // overlay's transform (see onScroll) keeps styleRun colors in
        // sync with the scroll position.
        const taStyle: React.CSSProperties = {
            position: 'relative',
            width: '100%',
            maxWidth: '100%',
            flex: '1 1 0',
            minHeight: 0,
            boxSizing: 'border-box',
            background: 'transparent',
            color: 'transparent',
            caretColor: item.color,
            border: 'none',
            outline: 'none',
            resize: 'none',
            padding: 0,
            margin: 0,
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
            textAlign: textAlignH,
            overflow: 'auto',
            ...typeset,
            WebkitAppRegion: 'no-drag',
        } as React.CSSProperties & { WebkitAppRegion?: string };
        return (
            <div
                data-canvas-item={item.id}
                style={wrapperStyle}
                onPointerDown={(e) => e.stopPropagation()}
            >
                <div style={innerStackStyle}>
                    {/* dir="auto" matches the textarea's auto-detected
                        direction so RTL content (Arabic/Hebrew) lays out
                        identically in the overlay and the input layer.
                        The overlay box is clipped to the visible card; an
                        inner div renders content at full natural height
                        and is translated by the textarea's scrollTop on
                        scroll so styleRun colors stay aligned with the
                        characters under the caret. */}
                    <div aria-hidden dir="auto" style={overlayStyle}>
                        <div ref={overlayInnerRef} style={{ willChange: 'transform' }}>
                            {item.content
                                ? renderStyledContent(item.content, item.styleRuns, openExternalFromText)
                                : null}
                        </div>
                    </div>
                    <textarea
                        ref={textareaRef}
                        data-canvas-text-edit-id={item.id}
                        dir="auto"
                        className="no-drag"
                        rows={1}
                        spellCheck={false}
                        style={taStyle}
                        value={item.content}
                        onChange={(e) => applyContentChange(e.target.value)}
                        onBlur={() => dispatch({ type: 'SET_EDITING', id: null })}
                        onScroll={(e) => {
                            const inner = overlayInnerRef.current;
                            if (inner) inner.style.transform = `translateY(-${e.currentTarget.scrollTop}px)`;
                        }}
                        onKeyDown={(e) => {
                            if (e.key === 'Escape') {
                                e.preventDefault();
                                (e.target as HTMLTextAreaElement).blur();
                                return;
                            }
                            if (handleListEnter(e)) return;
                            e.stopPropagation();
                        }}
                        onPointerDown={(e) => e.stopPropagation()}
                    />
                </div>
            </div>
        );
    }

    return (
        <>
            <div
                ref={displayRef}
                data-canvas-item={item.id}
                dir="auto"
                style={style}
                onDoubleClick={(e) => {
                    // Universal "double-click to edit" regardless of active
                    // tool — matches the mental model of every design tool.
                    e.stopPropagation();
                    dispatch({ type: 'SELECT', ids: [item.id] });
                    dispatch({ type: 'SET_EDITING', id: item.id });
                }}
            >
                {/* AI authorship chip — top-right of agent-authored cards.
                    Hidden while editing so it doesn't compete with the caret.
                    Pointer-events-none so clicks pass through to the card. */}
                {isAgentCard && !editing && (
                    <div
                        style={{
                            position: 'absolute',
                            top: 6,
                            right: 6,
                            padding: '1px 6px',
                            borderRadius: 4,
                            background: 'rgba(139,92,246,0.14)',
                            color: 'rgba(139,92,246,0.95)',
                            fontSize: 9,
                            fontWeight: 700,
                            letterSpacing: 0.5,
                            lineHeight: 1.4,
                            pointerEvents: 'none',
                            userSelect: 'none',
                        }}
                    >
                        AI
                    </div>
                )}
                {item.content && (
                    // Wrap the styled chunks in an inner block when the
                    // outer div is `display: flex` (bordered cards). The
                    // outer flex would otherwise treat every text node /
                    // span produced by renderStyledContent as a separate
                    // flex item and stack them vertically — so a single
                    // line "ddddd<span>dd</span>ddddd" rendered as three
                    // stacked rows. The inner div makes them inline
                    // siblings of one block child. For plain text (no
                    // border, no flex) the inner div is harmless; we
                    // emit the chunks bare to preserve the existing
                    // shrink-to-fit behavior of the outer max-content
                    // wrapper.
                    item.border ? (
                        <div style={{ textAlign: textAlignH }}>
                            {renderStyledLines(item.content, item.styleRuns, item.listType, true, openExternalFromText)}
                        </div>
                    ) : (
                        renderStyledLines(item.content, item.styleRuns, item.listType, false, openExternalFromText)
                    )
                )}
                {/* Follow-up thread — rendered inline inside bordered cards
                    (agent output or any text card the user chose to thread on).
                    Plain notes keep the clean content look; threads live only
                    on cards so the "nesting" isn't ambient on every random
                    text item. */}
                {item.border && item.thread && item.thread.length > 0 && (
                    <div
                        style={{
                            marginTop: 10,
                            paddingTop: 8,
                            borderTop: '1px dashed rgba(255,255,255,0.08)',
                            display: 'flex',
                            flexDirection: 'column',
                            gap: 6,
                            fontSize: Math.max(11, item.fontSize * 0.72),
                        }}
                    >
                        {item.thread.map((m) => (
                            <div
                                key={m.id}
                                style={{
                                    paddingLeft: 10,
                                    borderLeft: `2px solid ${m.role === 'user' ? 'rgba(16,185,129,0.45)' : 'rgba(255,255,255,0.12)'}`,
                                    color: m.role === 'user' ? 'rgba(16,185,129,0.9)' : 'rgba(255,255,255,0.75)',
                                    whiteSpace: 'pre-wrap',
                                    wordBreak: 'break-word',
                                }}
                            >
                                <div style={{ fontSize: 9, textTransform: 'uppercase', letterSpacing: '0.08em', color: 'rgba(255,255,255,0.35)', marginBottom: 2 }}>
                                    {m.role === 'user' ? 'You' : 'Agent'}
                                </div>
                                {m.content || (m.status === 'streaming' ? '…' : '')}
                            </div>
                        ))}
                    </div>
                )}
            </div>
            {selected && !editing && (
                <ResizeHandle
                    itemId={item.id}
                    x={item.x} y={item.y} w={item.w} h={item.h}
                    minW={80} minH={20}
                    // Plain text: GROW drags scale font; SHRINK drags set
                    // authoredWidth so the text wraps at a narrower width
                    // with font held constant. Bordered text (cards) keeps
                    // normal box-resize with all 8 handles.
                    scaleField={isPlain ? {
                        key: 'fontSize',
                        base: item.fontSize,
                        // Floor only (8 px — below that text is
                        // unreadable at normal zoom). No ceiling:
                        // banners, headings, slide titles can all grow
                        // freely. Browsers handle large font rendering
                        // fine; canvas zoom handles the screen-size
                        // trade-off. Effectively uncapped.
                        min: 8,
                        max: 100000,
                        authoredWidth: item.authoredWidth,
                    } : undefined}
                />
            )}
        </>
    );
}
