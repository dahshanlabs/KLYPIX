import React, { useState } from 'react';
import { createPortal } from 'react-dom';
import { FilePlus2, FolderOpen, Clock, X as XIcon, Users } from 'lucide-react';
import { useRecentCanvases } from '../../hooks/useRecentCanvases';
import { useSharedCanvases, type SharedCanvas } from '../../hooks/useSharedCanvases';
import { removeRecentCanvas } from './recentCanvasesStore';
import type { RecentCanvas } from './recentCanvasesStore';
import { openSharedCanvas } from '../sync/openSharedCanvas';

interface Props {
    /** Open a previously-touched canvas by its file path. */
    onOpenRecent: (filePath: string) => Promise<{ ok: boolean; error?: string } | void>;
    /** Show the file-picker dialog to open any canvas from disk. */
    onOpenFile: () => Promise<unknown>;
    /** Dismiss the dashboard and start a fresh blank canvas in this tab. */
    onNewCanvas: () => void;
    /** Optional close handler — when provided, shows an X button + handles
     *  Esc + click-outside-dimmer. Omit for the empty-canvas auto-show
     *  state (no way out except picking a canvas). */
    onDismiss?: () => void;
}

/**
 * Canvas dashboard — the "your canvases" home screen.
 *
 * Shown when the active tab has no canvas loaded AND the canvas surface is
 * truly empty. Lists recent canvases so users think in canvases, not files.
 * For v0 this is a list view (no thumbnails); thumbnails come in a follow-up
 * once the new format's per-canvas thumb generation lands.
 *
 * UX rules:
 *   - This is an OVERLAY, not a separate route. Dismisses naturally when the
 *     user starts working (typing, dropping a file, etc.) because the
 *     isEmpty check flips to false.
 *   - Pointer events ON the dashboard itself, but the area outside is
 *     pass-through so the canvas keyboard hint (T V B L P C…) is still
 *     usable for muscle-memory users who don't want the dashboard.
 *   - "New canvas" doesn't dispatch any action; it just hides the dashboard
 *     and lets the user click into the empty canvas underneath. That's
 *     less surprising than a state mutation for "I just want to start typing."
 */
export const CanvasDashboard: React.FC<Props> = ({ onOpenRecent, onOpenFile, onNewCanvas, onDismiss }) => {
    const recents = useRecentCanvases();
    const { canvases: shared, loading: sharedLoading, leave: leaveShared } = useSharedCanvases();
    const [dismissed, setDismissed] = useState(false);
    const [openingPath, setOpeningPath] = useState<string | null>(null);

    // Esc closes when this is a manual Home-button open (onDismiss is set).
    // For the empty-canvas auto-show case, Esc is a no-op — there's nothing
    // to fall back to.
    React.useEffect(() => {
        if (!onDismiss) return;
        const onKey = (e: KeyboardEvent) => {
            if (e.key === 'Escape') {
                e.preventDefault();
                e.stopPropagation();
                onDismiss();
            }
        };
        window.addEventListener('keydown', onKey, true);
        return () => window.removeEventListener('keydown', onKey, true);
    }, [onDismiss]);

    if (dismissed) return null;

    const handleOpen = async (entry: RecentCanvas) => {
        setOpeningPath(entry.filePath);
        try {
            const res = await onOpenRecent(entry.filePath);
            // If the file no longer exists on disk, drop it from the list so the
            // user isn't haunted by ghost entries forever.
            if (res && 'ok' in res && !res.ok && /ENOENT|not found|no such file/i.test(res.error || '')) {
                removeRecentCanvas(entry.filePath);
            }
        } finally {
            setOpeningPath(null);
        }
    };

    const handleOpenShared = async (entry: SharedCanvas) => {
        if (!entry.key_b64) return; // disabled state — UI already prevents click, defensive
        setOpeningPath(entry.blob_id);
        try {
            const res = await openSharedCanvas({
                blobId: entry.blob_id,
                keyB64: entry.key_b64,
                titleHint: entry.canvas_blobs?.title_hint,
            });
            if (res.ok) {
                // The shared canvas is now on disk. Hand it off to the normal
                // open-by-path flow, same as a recent canvas click.
                await onOpenRecent(res.filePath);
            } else {
                // Surface failure as a window.alert for v1. A nicer toast can
                // come later — for now we just want the user to see WHY a
                // shared canvas didn't open.
                window.alert(`Couldn't open shared canvas: ${res.reason}${res.error ? ' — ' + res.error : ''}`);
            }
        } finally {
            setOpeningPath(null);
        }
    };

    const handleNew = () => {
        setDismissed(true);
        onNewCanvas();
    };

    // Render via portal so we escape any pointer-capture set by the canvas's
    // drawing tools (the pen tool absorbs pointerdown on the canvas surface).
    if (typeof document === 'undefined') return null;
    return createPortal((
        <div
            className="fixed inset-0 flex items-center justify-center"
            style={{
                zIndex: 9998,
                // Manual Home-button open gets a dimmed clickable backdrop so
                // recipient can click outside the modal to close. Empty-canvas
                // auto-show stays click-through so it doesn't feel modal.
                pointerEvents: onDismiss ? 'auto' : 'none',
                background: onDismiss ? 'rgba(0, 0, 0, 0.45)' : 'transparent',
            }}
            onPointerDown={onDismiss
                ? (e) => { if (e.target === e.currentTarget) { e.stopPropagation(); onDismiss(); } }
                : undefined}
        >
            <div
                onPointerDown={(e) => e.stopPropagation()}
                // Portals bubble React events through the React tree, not the
                // DOM tree — so wheel events here would otherwise reach the
                // canvas surface's onWheel and pan/zoom the workspace behind.
                onWheel={(e) => e.stopPropagation()}
                style={{
                    pointerEvents: 'auto',
                    width: 'min(560px, 92vw)',
                    maxHeight: '80vh',
                    background: 'rgba(15, 15, 24, 0.94)',
                    border: '1px solid rgba(255, 255, 255, 0.08)',
                    borderRadius: 16,
                    padding: '24px 24px 16px',
                    boxShadow: '0 24px 64px rgba(0, 0, 0, 0.5), 0 0 0 1px rgba(255,255,255,0.04)',
                    backdropFilter: 'blur(20px)',
                    display: 'flex',
                    flexDirection: 'column',
                    fontFamily: 'Outfit, system-ui, sans-serif',
                    color: '#e8e8ed',
                }}
            >
                <div style={{ marginBottom: 18, display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12 }}>
                    <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontSize: 20, fontWeight: 600, letterSpacing: '-0.01em' }}>Your canvases</div>
                        <div style={{ fontSize: 12, color: 'rgba(255,255,255,0.45)', marginTop: 2 }}>
                            {recents.length === 0
                                ? 'No canvases yet. Create one or open an existing .klypix file.'
                                : `${recents.length} canvas${recents.length === 1 ? '' : 'es'} you have worked on.`}
                        </div>
                    </div>
                    {onDismiss && (
                        <button
                            type="button"
                            onPointerDown={(e) => { e.preventDefault(); e.stopPropagation(); onDismiss(); }}
                            onClick={(e) => { e.preventDefault(); e.stopPropagation(); onDismiss(); }}
                            title="Close (Esc)"
                            aria-label="Close dashboard"
                            style={{
                                padding: 8,
                                borderRadius: 8,
                                background: 'rgba(255,255,255,0.04)',
                                border: '1px solid rgba(255,255,255,0.06)',
                                color: 'rgba(255,255,255,0.7)',
                                cursor: 'pointer',
                                display: 'flex',
                                alignItems: 'center',
                                justifyContent: 'center',
                                lineHeight: 0,
                                flexShrink: 0,
                            }}
                        >
                            <XIcon size={14} />
                        </button>
                    )}
                </div>

                <div style={{ display: 'flex', gap: 8, marginBottom: 18 }}>
                    <button
                        onClick={handleNew}
                        style={{
                            display: 'flex', alignItems: 'center', gap: 8,
                            padding: '10px 16px',
                            borderRadius: 10,
                            background: 'rgba(16, 185, 129, 0.15)',
                            border: '1px solid rgba(16, 185, 129, 0.4)',
                            color: '#10b981',
                            fontWeight: 500, fontSize: 13,
                            cursor: 'pointer',
                            transition: 'background 0.15s',
                        }}
                        onMouseEnter={(e) => (e.currentTarget.style.background = 'rgba(16, 185, 129, 0.25)')}
                        onMouseLeave={(e) => (e.currentTarget.style.background = 'rgba(16, 185, 129, 0.15)')}
                    >
                        <FilePlus2 size={15} />
                        New canvas
                    </button>
                    <button
                        onClick={() => onOpenFile()}
                        style={{
                            display: 'flex', alignItems: 'center', gap: 8,
                            padding: '10px 16px',
                            borderRadius: 10,
                            background: 'rgba(255,255,255,0.04)',
                            border: '1px solid rgba(255,255,255,0.1)',
                            color: '#e8e8ed',
                            fontWeight: 500, fontSize: 13,
                            cursor: 'pointer',
                            transition: 'background 0.15s',
                        }}
                        onMouseEnter={(e) => (e.currentTarget.style.background = 'rgba(255,255,255,0.08)')}
                        onMouseLeave={(e) => (e.currentTarget.style.background = 'rgba(255,255,255,0.04)')}
                    >
                        <FolderOpen size={15} />
                        Open file...
                    </button>
                </div>

                <div style={{
                    flex: 1,
                    overflow: 'auto',
                    margin: '0 -8px',
                    padding: '0 8px',
                }}>
                    {recents.length > 0 && (
                        <>
                            <div style={{
                                fontSize: 10, color: 'rgba(255,255,255,0.4)',
                                textTransform: 'uppercase', letterSpacing: '0.08em',
                                marginBottom: 8, paddingLeft: 4,
                            }}>
                                Recent
                            </div>
                            {recents.map(entry => (
                                <RecentRow
                                    key={entry.filePath}
                                    entry={entry}
                                    opening={openingPath === entry.filePath}
                                    onOpen={() => handleOpen(entry)}
                                    onRemove={() => removeRecentCanvas(entry.filePath)}
                                />
                            ))}
                        </>
                    )}
                    {(shared.length > 0 || sharedLoading) && (
                        <>
                            <div style={{
                                fontSize: 10, color: 'rgba(255,255,255,0.4)',
                                textTransform: 'uppercase', letterSpacing: '0.08em',
                                marginTop: recents.length > 0 ? 16 : 0,
                                marginBottom: 8, paddingLeft: 4,
                                display: 'flex', alignItems: 'center', gap: 6,
                            }}>
                                <Users size={10} />
                                Shared with you
                            </div>
                            {sharedLoading && (
                                <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.35)', padding: '8px 12px' }}>
                                    Loading…
                                </div>
                            )}
                            {!sharedLoading && shared.map(entry => (
                                <SharedRow
                                    key={entry.blob_id}
                                    entry={entry}
                                    opening={openingPath === entry.blob_id}
                                    onOpen={() => handleOpenShared(entry)}
                                    onLeave={() => {
                                        const title = entry.canvas_blobs?.title_hint || 'this canvas';
                                        const ok = window.confirm(
                                            `Remove "${title}" from your shared list?\n\n` +
                                            `You won't be able to open it again unless the owner re-invites you. ` +
                                            `Your local downloaded copy (if any) is not affected.`
                                        );
                                        if (ok) leaveShared(entry.blob_id);
                                    }}
                                />
                            ))}
                        </>
                    )}
                </div>
            </div>
        </div>
    ), document.body);
};

interface SharedRowProps {
    entry: SharedCanvas;
    opening: boolean;
    onOpen: () => void;
    /** Recipient-side "leave this shared canvas". The parent shows the confirm
     *  prompt — this just fires the RPC. */
    onLeave: () => void;
}

// Clickable entry in the "Shared with you" list. Click → openSharedCanvas
// downloads the encrypted blob, decrypts with the key copied from the
// invitation on accept, writes to userData/shared-canvases/, and opens via
// the normal openByPath path.
//
// If key_b64 is null (legacy invitation predating key sharing), the row is
// disabled — UI title explains why.
function SharedRow({ entry, opening, onOpen, onLeave }: SharedRowProps) {
    const title = entry.canvas_blobs?.title_hint || 'Untitled canvas';
    const updatedAt = entry.canvas_blobs?.updated_at;
    const canOpen = !!entry.key_b64;
    return (
        <div
            onPointerDown={(e) => { e.stopPropagation(); if (canOpen && !opening) onOpen(); }}
            style={{
                display: 'flex',
                alignItems: 'center',
                gap: 10,
                padding: '10px 12px',
                borderRadius: 8,
                cursor: !canOpen ? 'not-allowed' : opening ? 'wait' : 'pointer',
                opacity: !canOpen ? 0.55 : opening ? 0.5 : 1,
                transition: 'background 0.1s',
            }}
            onMouseEnter={(e) => { if (canOpen && !opening) e.currentTarget.style.background = 'rgba(255,255,255,0.05)'; }}
            onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
            title={!canOpen ? 'This invitation was sent before key-sharing landed. Ask the owner for a fresh invite.' : 'Open shared canvas'}
        >
            <div style={{
                width: 36, height: 36, borderRadius: 8,
                background: 'rgba(16, 185, 129, 0.12)',
                color: '#10b981',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                flexShrink: 0,
                fontSize: 10, fontWeight: 600, letterSpacing: '0.04em',
            }}>
                {title.slice(0, 2).toUpperCase()}
            </div>
            <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 13, fontWeight: 500, color: '#e8e8ed', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {title}
                </div>
                <div style={{ fontSize: 10, color: 'rgba(255,255,255,0.4)', display: 'flex', alignItems: 'center', gap: 6, marginTop: 2 }}>
                    <Clock size={9} />
                    {updatedAt ? new Date(updatedAt).toLocaleString() : 'unknown date'}
                    <span style={{ opacity: 0.4 }}>·</span>
                    <span style={{ color: 'rgba(16, 185, 129, 0.7)' }}>editor</span>
                </div>
            </div>
            {!canOpen && (
                <div style={{
                    fontSize: 9,
                    color: 'rgba(255,255,255,0.35)',
                    background: 'rgba(255,255,255,0.04)',
                    border: '1px solid rgba(255,255,255,0.06)',
                    padding: '3px 7px',
                    borderRadius: 5,
                    flexShrink: 0,
                }}>
                    no key
                </div>
            )}
            <button
                onPointerDown={(e) => { e.stopPropagation(); }}
                onClick={(e) => { e.preventDefault(); e.stopPropagation(); onLeave(); }}
                title="Remove from shared list (unlink yourself — owner is not notified)"
                aria-label="Leave shared canvas"
                style={{
                    padding: 4, borderRadius: 5,
                    background: 'transparent',
                    border: 'none',
                    color: 'rgba(255,255,255,0.3)',
                    cursor: 'pointer',
                    flexShrink: 0,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    lineHeight: 0,
                }}
                onMouseEnter={(e) => { e.currentTarget.style.color = '#ef4444'; e.currentTarget.style.background = 'rgba(239, 68, 68, 0.1)'; }}
                onMouseLeave={(e) => { e.currentTarget.style.color = 'rgba(255,255,255,0.3)'; e.currentTarget.style.background = 'transparent'; }}
            >
                <XIcon size={12} />
            </button>
        </div>
    );
}

interface RecentRowProps {
    entry: RecentCanvas;
    opening: boolean;
    onOpen: () => void;
    onRemove: () => void;
}

function RecentRow({ entry, opening, onOpen, onRemove }: RecentRowProps) {
    const fileName = entry.filePath.split(/[\\/]/).pop() || entry.filePath;
    return (
        <div
            // onPointerDown fires BEFORE any canvas pen tool can call
            // setPointerCapture and swallow the click.
            onPointerDown={(e) => { e.stopPropagation(); if (!opening) onOpen(); }}
            style={{
                display: 'flex',
                alignItems: 'center',
                gap: 10,
                padding: '10px 12px',
                borderRadius: 8,
                cursor: opening ? 'wait' : 'pointer',
                transition: 'background 0.1s',
                opacity: opening ? 0.5 : 1,
            }}
            onMouseEnter={(e) => (e.currentTarget.style.background = 'rgba(255,255,255,0.05)')}
            onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
        >
            <div style={{
                width: 36, height: 36, borderRadius: 8,
                background: 'rgba(16, 185, 129, 0.12)',
                color: '#10b981',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                flexShrink: 0,
                fontSize: 10, fontWeight: 600, letterSpacing: '0.04em',
            }}>
                {entry.title.slice(0, 2).toUpperCase()}
            </div>
            <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 13, fontWeight: 500, color: '#e8e8ed', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {entry.title}
                </div>
                <div style={{ fontSize: 10, color: 'rgba(255,255,255,0.4)', display: 'flex', alignItems: 'center', gap: 6, marginTop: 2 }}>
                    <Clock size={9} />
                    {formatRelativeTime(entry.lastOpened)}
                    <span style={{ opacity: 0.4 }}>·</span>
                    <span style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: 280 }} title={entry.filePath}>
                        {fileName}
                    </span>
                </div>
            </div>
            <button
                onPointerDown={(e) => { e.stopPropagation(); }}
                onClick={(e) => { e.stopPropagation(); onRemove(); }}
                title="Remove from recent (file on disk is untouched)"
                style={{
                    padding: 4, borderRadius: 5,
                    background: 'transparent',
                    color: 'rgba(255,255,255,0.3)',
                    cursor: 'pointer',
                    flexShrink: 0,
                }}
                onMouseEnter={(e) => { e.currentTarget.style.color = '#ef4444'; e.currentTarget.style.background = 'rgba(239, 68, 68, 0.1)'; }}
                onMouseLeave={(e) => { e.currentTarget.style.color = 'rgba(255,255,255,0.3)'; e.currentTarget.style.background = 'transparent'; }}
            >
                <XIcon size={12} />
            </button>
        </div>
    );
}

function formatRelativeTime(ms: number): string {
    const diff = Date.now() - ms;
    const minute = 60_000;
    const hour = 60 * minute;
    const day = 24 * hour;
    const week = 7 * day;

    if (diff < minute) return 'just now';
    if (diff < hour) return `${Math.floor(diff / minute)}m ago`;
    if (diff < day) return `${Math.floor(diff / hour)}h ago`;
    if (diff < week) return `${Math.floor(diff / day)}d ago`;
    if (diff < 4 * week) return `${Math.floor(diff / week)}w ago`;
    return new Date(ms).toLocaleDateString();
}
