import React, { useEffect, useRef, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import { Search, ArrowDown, ArrowUp, CornerDownLeft, Eye, EyeOff } from 'lucide-react';
import { t, useLocale } from '../i18n/strings';
import {
    subscribe,
    getSnapshot,
    close,
    setQuery,
    moveSelection,
    jumpSelection,
    cycleSecondary,
    setClipFilter,
    showToast,
    toggleDetailPane,
} from './paletteStore';
import { intentFromKey } from './keyboardModel';
import { recordHit } from './frecency';
import type { RankedResult, PaletteAction } from './providers/types';

// Render the inline action icons for a row. Filters secondary actions to
// just those that opted in via `inlineIcon`, renders each as a small
// clickable button. Click stops propagation so it doesn't double-fire
// the row's primary action.
function InlineActions({
    actions,
    onRun,
    highlighted,
}: {
    actions: PaletteAction[];
    onRun: (action: PaletteAction) => void;
    highlighted: boolean;
}) {
    const inline = actions.filter(a => a.inlineIcon);
    if (inline.length === 0) return null;
    return (
        <div
            style={{
                display: 'flex',
                gap: 4,
                flexShrink: 0,
                // Icons always visible but dimmed when row isn't highlighted.
                // Keeps them discoverable without making the long list noisy.
                opacity: highlighted ? 1 : 0.35,
                transition: 'opacity 100ms',
            }}
            // Catch clicks here to avoid letting them bubble up to the row.
            onClick={(e) => e.stopPropagation()}
        >
            {inline.map((a, i) => (
                <button
                    key={i}
                    type="button"
                    onClick={() => onRun(a)}
                    title={a.label}
                    aria-label={a.label}
                    style={{
                        width: 28,
                        height: 28,
                        position: 'relative',          // for the click-sink overlay below
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        background: 'rgba(255,255,255,0.04)',
                        border: '1px solid rgba(255,255,255,0.08)',
                        borderRadius: 5,
                        color: a.inlineIconAccent ?? 'rgba(255,255,255,0.7)',
                        cursor: 'pointer',
                        padding: 0,
                        pointerEvents: 'auto',
                    }}
                    onMouseEnter={(e) => {
                        e.currentTarget.style.background = a.inlineIconAccent
                            ? `${a.inlineIconAccent}22`
                            : 'rgba(255,255,255,0.10)';
                        e.currentTarget.style.borderColor = a.inlineIconAccent
                            ? `${a.inlineIconAccent}55`
                            : 'rgba(255,255,255,0.18)';
                    }}
                    onMouseLeave={(e) => {
                        e.currentTarget.style.background = 'rgba(255,255,255,0.04)';
                        e.currentTarget.style.borderColor = 'rgba(255,255,255,0.08)';
                    }}
                >
                    {/* Visible icon — pointer-events:none on the span,
                        BUT lucide SVG paths can still override and steal
                        clicks. The transparent overlay below is the
                        guaranteed click sink. */}
                    <span style={{ pointerEvents: 'none', display: 'flex' }}>
                        {a.inlineIcon}
                    </span>
                    {/* Click-sink: absolutely positioned over the entire
                        button surface, ON TOP of the icon visually but
                        having no content. Clicks land here, bubble to
                        button.onClick. Defeats the SVG-hit-test issue
                        unconditionally (including for PinOff and any
                        future icons with their own pointer-events). */}
                    <span
                        style={{
                            position: 'absolute',
                            inset: 0,
                            // Background must be transparent — we just want
                            // the rectangle to exist for hit-testing.
                            background: 'transparent',
                        }}
                    />
                </button>
            ))}
        </div>
    );
}

// Phase 23 — Command Palette UI shell. Renders to a portal at body level so
// it floats above EVERYTHING (canvas chrome, chat, dialogs). The modal
// itself is purely a driver — it doesn't know about providers, only about
// the ranked result list the store hands it.
//
// Layout:
//   ┌──────────────────────────────────────────────────┐
//   │ 🔍  search input                                  │  ← header
//   ├──────────────────────────────────────────────────┤
//   │ ▸ Result row (highlighted)                        │
//   │   subtitle                                        │
//   │   Result row                                      │
//   │   ...                                             │  ← scrollable list
//   ├──────────────────────────────────────────────────┤
//   │ ↑↓ navigate · ↵ open · Tab actions · Esc close   │  ← footer hints
//   └──────────────────────────────────────────────────┘
//
// Sizing: 640px wide, max-height 60vh, centered top-third of viewport.
// Same proportions as Raycast / Linear / Cmd+K palettes for muscle memory.

export function CommandPalette() {
    useLocale();
    const snap = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
    const inputRef = useRef<HTMLInputElement>(null);
    const listRef = useRef<HTMLDivElement>(null);

    // Focus the input every time the palette opens. Skipping requestAnimationFrame
    // here because by the time React renders us, the DOM is ready — and any
    // delay creates a flash of "input not yet focused" the user can see.
    useEffect(() => {
        if (snap.open) {
            inputRef.current?.focus();
            inputRef.current?.select();
        }
    }, [snap.open]);

    // Scroll the highlighted row into view as selection changes.
    useEffect(() => {
        if (!snap.open) return;
        const el = listRef.current?.querySelector<HTMLElement>(`[data-palette-row="${snap.selectedIndex}"]`);
        if (el) el.scrollIntoView({ block: 'nearest' });
    }, [snap.selectedIndex, snap.open]);

    // Click-outside to close. Captures at the backdrop, NOT on the modal
    // body, so clicks inside still work.
    const onBackdropMouseDown = (e: React.MouseEvent) => {
        if (e.target === e.currentTarget) close();
    };

    const runAction = async (action: PaletteAction | undefined, resultId?: string) => {
        if (!action) return;
        let succeeded = false;
        try {
            await action.handler();
            if (resultId) recordHit(resultId);
            succeeded = true;
        } catch (err) {
            console.warn('[palette] action failed:', err);
        } finally {
            // Show the confirmation toast BEFORE closing — when the palette
            // closes there's no surface to render the toast on. For keepOpen
            // actions the toast stays visible inside the modal.
            if (succeeded && action.toast) showToast(action.toast);
            if (!action.keepOpen) close();
        }
    };

    const onKeyDown = (e: React.KeyboardEvent) => {
        const intent = intentFromKey(e);
        if (!intent) return;  // letters go to the input
        e.preventDefault();
        e.stopPropagation();
        const cur = snap.ranked[snap.selectedIndex];
        switch (intent.kind) {
            case 'close': close(); return;
            case 'move': moveSelection(intent.delta); return;
            case 'jump':
                jumpSelection(intent.to);
                return;
            case 'primary':
                if (cur) void runAction(cur.primaryAction, cur.id);
                return;
            case 'cycle-secondary':
                cycleSecondary(intent.delta);
                return;
            case 'secondary':
                if (cur?.secondaryActions?.[intent.index]) {
                    void runAction(cur.secondaryActions[intent.index], cur.id);
                }
                return;
            case 'send-to-chat':
                // Convention: secondary index 1 is "send to chat". If a
                // provider didn't declare it, silently no-op so the chord
                // doesn't accidentally trigger something unrelated.
                if (cur?.secondaryActions?.[1]) {
                    void runAction(cur.secondaryActions[1], cur.id);
                }
                return;
            case 'send-to-canvas':
                if (cur?.secondaryActions?.[2]) {
                    void runAction(cur.secondaryActions[2], cur.id);
                }
                return;
        }
    };

    // Toast portal renders even when the palette modal is closed — actions
    // that close-on-success (Copy, Open) need a confirmation surface that
    // outlives the modal. Auto-clears via the store's setTimeout.
    const toastPortal = snap.toast
        ? createPortal(
              <PaletteToast key={snap.toast.id} text={snap.toast.text} />,
              document.body,
          )
        : null;

    if (!snap.open) return toastPortal;

    return (<>{toastPortal}{createPortal(
        <div
            onMouseDown={onBackdropMouseDown}
            onKeyDown={onKeyDown}
            style={{
                position: 'fixed',
                inset: 0,
                zIndex: 9999,
                background: 'rgba(0,0,0,0.35)',
                backdropFilter: 'blur(2px)',
                display: 'flex',
                alignItems: 'flex-start',
                justifyContent: 'center',
                paddingTop: '15vh',
            }}
            data-palette-root="1"
        >
            <div
                role="dialog"
                aria-label={t('palette.title')}
                style={{
                    // Detail pane visibility is STICKY (paletteStore auto-
                    // flips detailPaneSticky=true on first row with detail
                    // + stays on for the session; eye button toggles).
                    // Modal width follows the sticky flag, NOT the current
                    // row — fixes "width jumps when arrowing".
                    width: snap.detailPaneSticky ? 880 : 640,
                    maxWidth: '92vw',
                    // Phase 23 polish: FIXED height instead of max-height so
                    // the modal doesn't visually jump as the result count
                    // changes. 60vh capped at 520px so on small screens we
                    // don't stretch awkwardly tall. Body content scrolls
                    // inside the fixed container.
                    height: 'min(60vh, 520px)',
                    display: 'flex',
                    flexDirection: 'column',
                    background: '#0e0e14',
                    border: '1px solid rgba(255,255,255,0.08)',
                    borderRadius: 12,
                    boxShadow: '0 24px 64px rgba(0,0,0,0.6)',
                    overflow: 'hidden',
                    // When detail panel is active, the layout widens smoothly
                    // from 640 → 880 instead of jumping. 120ms feels responsive
                    // without being distracting on every selection change.
                    transition: 'width 120ms ease-out',
                }}
            >
                {/* Header: search input */}
                <div
                    style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 10,
                        padding: '12px 14px',
                        borderBottom: '1px solid rgba(255,255,255,0.06)',
                    }}
                >
                    <Search size={16} style={{ color: 'rgba(255,255,255,0.45)', flexShrink: 0 }} />
                    <input
                        ref={inputRef}
                        value={snap.query}
                        onChange={(e) => setQuery(e.target.value)}
                        placeholder={t('palette.placeholder')}
                        style={{
                            flex: 1,
                            background: 'transparent',
                            border: 'none',
                            outline: 'none',
                            color: 'white',
                            fontSize: 14,
                            fontFamily: 'inherit',
                        }}
                        spellCheck={false}
                        autoComplete="off"
                    />
                    {/* Eye toggle: show/hide the detail preview pane.
                        Pinned visibility means arrowing between rows
                        with and without detail doesn't make the modal
                        jump width. Click to dismiss the pane when not
                        wanted. */}
                    <button
                        type="button"
                        onClick={toggleDetailPane}
                        title={snap.detailPaneSticky ? t('palette.hide_preview') : t('palette.show_preview')}
                        aria-label={snap.detailPaneSticky ? t('palette.hide_preview') : t('palette.show_preview')}
                        style={{
                            background: snap.detailPaneSticky ? 'rgba(16,185,129,0.12)' : 'rgba(255,255,255,0.04)',
                            border: '1px solid ' + (snap.detailPaneSticky ? 'rgba(16,185,129,0.3)' : 'rgba(255,255,255,0.08)'),
                            color: snap.detailPaneSticky ? '#10b981' : 'rgba(255,255,255,0.55)',
                            borderRadius: 6,
                            width: 28,
                            height: 28,
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                            cursor: 'pointer',
                            padding: 0,
                        }}
                    >
                        <span style={{ pointerEvents: 'none', display: 'flex' }}>
                            {snap.detailPaneSticky ? <Eye size={14} /> : <EyeOff size={14} />}
                        </span>
                    </button>
                    {snap.exclusiveProvider && (
                        <span
                            style={{
                                fontSize: 10,
                                padding: '2px 8px',
                                borderRadius: 4,
                                background: 'rgba(16,185,129,0.15)',
                                color: '#10b981',
                                fontWeight: 600,
                                textTransform: 'uppercase',
                                letterSpacing: 0.5,
                            }}
                        >
                            {snap.exclusiveProvider}
                        </span>
                    )}
                </div>

                {/* Best-in-class: filter chips when in clip: mode. Lets the
                    user narrow to a kind subset (text / images / files /
                    pinned) without typing. Rendered above the result list
                    so it's visually separate from input + results. */}
                {snap.exclusiveProvider === 'clip' && (
                    <div
                        style={{
                            display: 'flex',
                            alignItems: 'center',
                            gap: 6,
                            padding: '6px 10px',
                            borderBottom: '1px solid rgba(255,255,255,0.04)',
                        }}
                    >
                        {([
                            { id: null, label: t('palette.clip_filter.all') },
                            { id: 'pinned' as const, label: t('palette.clip_filter.pinned') },
                            { id: 'text' as const, label: t('palette.clip_filter.text') },
                            { id: 'image' as const, label: t('palette.clip_filter.images') },
                            { id: 'files' as const, label: t('palette.clip_filter.files') },
                        ]).map((chip) => {
                            const active = snap.clipFilter === chip.id;
                            return (
                                <button
                                    key={String(chip.id)}
                                    type="button"
                                    onClick={() => setClipFilter(chip.id)}
                                    style={{
                                        fontSize: 10,
                                        padding: '3px 8px',
                                        borderRadius: 999,
                                        border: '1px solid ' + (active ? 'rgba(16,185,129,0.4)' : 'rgba(255,255,255,0.08)'),
                                        background: active ? 'rgba(16,185,129,0.18)' : 'rgba(255,255,255,0.03)',
                                        color: active ? '#10b981' : 'rgba(255,255,255,0.55)',
                                        cursor: 'pointer',
                                        fontWeight: 500,
                                    }}
                                >
                                    {chip.label}
                                </button>
                            );
                        })}
                        <div style={{ flex: 1 }} />
                        {/* Bulk clear unpinned. Pinned items survive — the
                            main-process handler explicitly preserves them.
                            Native confirm gates the destructive action. */}
                        <button
                            type="button"
                            onClick={async () => {
                                if (!window.confirm(t('palette.clip_filter.clear_confirm'))) return;
                                const bridge: any = (window as any).electron?.clipboardHistory;
                                if (bridge?.clear) {
                                    await bridge.clear();
                                    setQuery(snap.query);
                                }
                            }}
                            style={{
                                fontSize: 10,
                                padding: '3px 8px',
                                borderRadius: 999,
                                border: '1px solid rgba(239, 68, 68, 0.25)',
                                background: 'rgba(239, 68, 68, 0.08)',
                                color: '#fca5a5',
                                cursor: 'pointer',
                                fontWeight: 500,
                            }}
                            title={t('palette.clip_filter.clear_hint')}
                        >
                            {t('palette.clip_filter.clear')}
                        </button>
                    </div>
                )}

                {/* Body: result list + optional detail pane. The detail pane
                    renders for the highlighted row only when its provider
                    supplied a detail() factory — image clipboard rows show
                    full preview, file rows show parent path tree, etc. */}
                <div style={{ display: 'flex', flex: 1, minHeight: 0 }}>
                    <div
                        ref={listRef}
                        style={{
                            flex: snap.detailPaneSticky ? '0 0 480px' : 1,
                            overflowY: 'auto',
                            padding: 4,
                            minHeight: 0,
                            borderRight: snap.detailPaneSticky ? '1px solid rgba(255,255,255,0.05)' : 'none',
                        }}
                    >
                        {snap.ranked.length === 0 ? (
                            <EmptyState query={snap.query} />
                        ) : (
                            snap.ranked.map((r, i) => (
                                <ResultRow
                                    key={r.id}
                                    result={r}
                                    index={i}
                                    highlighted={i === snap.selectedIndex}
                                    onHover={() => jumpSelection(i)}
                                    onClick={() => runAction(r.primaryAction, r.id)}
                                    onRunAction={(a) => runAction(a, r.id)}
                                />
                            ))
                        )}
                    </div>
                    {snap.detailPaneSticky && (
                        <DetailPane result={snap.ranked[snap.selectedIndex]} />
                    )}
                </div>

                {/* Footer hint strip */}
                <Footer
                    current={snap.ranked[snap.selectedIndex]}
                    secondaryCursor={snap.secondaryCursor}
                />
            </div>
        </div>,
        document.body,
    )}</>);
}

function PaletteToast({ text }: { text: string }) {
    return (
        <div
            // Centered at top of viewport, well above any other UI. zIndex
            // 10000 sits above the palette backdrop (9999) so the toast
            // is visible during the closing animation too.
            style={{
                position: 'fixed',
                top: 24,
                left: '50%',
                transform: 'translateX(-50%)',
                zIndex: 10000,
                background: 'rgba(16,185,129,0.95)',
                color: 'white',
                padding: '8px 16px',
                borderRadius: 999,
                fontSize: 12,
                fontWeight: 500,
                boxShadow: '0 8px 24px rgba(0,0,0,0.4)',
                fontFamily: 'inherit',
                pointerEvents: 'none',
            }}
        >
            {text}
        </div>
    );
}

function DetailPane({ result }: { result: RankedResult | undefined }) {
    // Provider-supplied detail() — call it to render the preview content.
    // Wrapped in error boundary semantics via try/catch so a bad provider
    // doesn't break the whole palette.
    let content: React.ReactNode = null;
    try {
        content = result?.detail?.();
    } catch {
        content = null;
    }
    return (
        <div
            style={{
                flex: 1,
                minWidth: 0,
                overflow: 'auto',
                padding: 16,
                background: 'rgba(255,255,255,0.015)',
            }}
        >
            {content ?? (
                <div style={{ color: 'rgba(255,255,255,0.3)', fontSize: 11, textAlign: 'center', marginTop: 40 }}>
                    {result
                        ? 'No preview for this item'
                        : 'Select an item to preview'}
                </div>
            )}
        </div>
    );
}

function EmptyState({ query }: { query: string }) {
    return (
        <div
            style={{
                padding: '40px 20px',
                textAlign: 'center',
                color: 'rgba(255,255,255,0.35)',
                fontSize: 13,
            }}
        >
            {query
                ? t('palette.empty_with_query').replace('{q}', query)
                : t('palette.empty_no_query')}
        </div>
    );
}

function ResultRow({
    result,
    index,
    highlighted,
    onHover,
    onClick,
    onRunAction,
}: {
    result: RankedResult;
    index: number;
    highlighted: boolean;
    onHover: () => void;
    onClick: () => void;
    onRunAction: (action: PaletteAction) => void;
}) {
    // Section header rendering — non-interactive, visually distinct.
    // Used by clipboard provider's withSectionHeaders to split pinned
    // from recent rows. Skipped by keyboard navigation in paletteStore.
    if (result.sectionHeader) {
        return (
            <div
                data-palette-row={index}
                data-palette-section-header="1"
                style={{
                    fontSize: 10,
                    fontWeight: 700,
                    letterSpacing: 1.2,
                    color: result.accent ?? 'rgba(255,255,255,0.4)',
                    padding: '10px 12px 4px 12px',
                    textTransform: 'uppercase',
                    pointerEvents: 'none',
                    userSelect: 'none',
                }}
            >
                {result.title}
            </div>
        );
    }
    // Best-in-class: native title-attribute tooltip shows the FULL title
    // + subtitle on hover. Lets users see truncated content (long URLs,
    // long clipboard text) without a custom hover-preview component.
    const tooltip = result.subtitle && result.title !== result.subtitle
        ? `${result.title}\n\n${result.subtitle}`
        : result.title;
    return (
        <div
            data-palette-row={index}
            onMouseEnter={onHover}
            onClick={onClick}
            title={tooltip}
            style={{
                display: 'flex',
                alignItems: 'center',
                gap: 10,
                padding: '8px 10px',
                borderRadius: 6,
                cursor: 'pointer',
                background: highlighted ? 'rgba(16,185,129,0.12)' : 'transparent',
                border: highlighted
                    ? '1px solid rgba(16,185,129,0.25)'
                    : '1px solid transparent',
                transition: 'background 60ms, border-color 60ms',
            }}
        >
            <div
                style={{
                    width: 28,
                    height: 28,
                    flexShrink: 0,
                    borderRadius: 6,
                    background: result.accent
                        ? `${result.accent}22`
                        : 'rgba(255,255,255,0.05)',
                    color: result.accent ?? 'rgba(255,255,255,0.6)',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                }}
            >
                {result.icon ?? <DotIcon />}
            </div>
            <div style={{ flex: 1, minWidth: 0 }}>
                <div
                    style={{
                        fontSize: 13,
                        color: 'rgba(255,255,255,0.92)',
                        whiteSpace: 'nowrap',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                    }}
                >
                    {result.title}
                </div>
                {result.subtitle && (
                    <div
                        style={{
                            fontSize: 11,
                            color: 'rgba(255,255,255,0.4)',
                            whiteSpace: 'nowrap',
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                            marginTop: 1,
                        }}
                    >
                        {result.subtitle}
                    </div>
                )}
            </div>
            {/* Inline action icons (Pin, Remove, etc.) — clickable shortcuts
                that mirror the keyboard chords. Filtered to actions with
                inlineIcon set so providers control which actions surface
                here (vs the keyboard-only ones). */}
            {result.secondaryActions && (
                <InlineActions
                    actions={result.secondaryActions}
                    onRun={onRunAction}
                    highlighted={highlighted}
                />
            )}
            <span
                style={{
                    fontSize: 9,
                    color: 'rgba(255,255,255,0.3)',
                    textTransform: 'uppercase',
                    letterSpacing: 0.5,
                    flexShrink: 0,
                }}
            >
                {result.source}
            </span>
        </div>
    );
}

function DotIcon() {
    return (
        <span
            style={{
                width: 6,
                height: 6,
                borderRadius: '50%',
                background: 'currentColor',
                display: 'block',
            }}
        />
    );
}

function Footer({
    current,
    secondaryCursor,
}: {
    current: RankedResult | undefined;
    secondaryCursor: number;
}) {
    const cur = current?.secondaryActions?.[secondaryCursor];
    return (
        <div
            style={{
                display: 'flex',
                alignItems: 'center',
                gap: 14,
                padding: '8px 14px',
                fontSize: 10,
                color: 'rgba(255,255,255,0.4)',
                borderTop: '1px solid rgba(255,255,255,0.06)',
                background: 'rgba(255,255,255,0.02)',
            }}
        >
            <Hint icon={<><ArrowUp size={10} /><ArrowDown size={10} /></>} label={t('palette.hint.navigate')} />
            <Hint icon={<CornerDownLeft size={10} />} label={current?.primaryAction.label ?? t('palette.hint.open')} />
            {cur && (
                <Hint
                    icon={<span style={{ fontSize: 9, fontWeight: 700 }}>Tab</span>}
                    label={cur.label + (cur.chord ? ` (${cur.chord})` : '')}
                />
            )}
            <div style={{ flex: 1 }} />
            <Hint icon={<span style={{ fontSize: 9, fontWeight: 700 }}>Esc</span>} label={t('palette.hint.close')} />
        </div>
    );
}

function Hint({ icon, label }: { icon: React.ReactNode; label: string }) {
    return (
        <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            <span
                style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 2,
                    padding: '1px 4px',
                    borderRadius: 3,
                    background: 'rgba(255,255,255,0.08)',
                    color: 'rgba(255,255,255,0.7)',
                    minWidth: 18,
                    justifyContent: 'center',
                }}
            >
                {icon}
            </span>
            <span>{label}</span>
        </div>
    );
}
