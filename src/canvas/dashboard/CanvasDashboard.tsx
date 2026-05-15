import React, { useState } from 'react';
import { createPortal } from 'react-dom';
import { FilePlus2, FolderOpen, Clock, X as XIcon } from 'lucide-react';
import { useRecentCanvases } from '../../hooks/useRecentCanvases';
import { removeRecentCanvas } from './recentCanvasesStore';
import type { RecentCanvas } from './recentCanvasesStore';

interface Props {
    /** Open a previously-touched canvas by its file path. */
    onOpenRecent: (filePath: string) => Promise<{ ok: boolean; error?: string } | void>;
    /** Show the file-picker dialog to open any canvas from disk. */
    onOpenFile: () => Promise<unknown>;
    /** Dismiss the dashboard and start a fresh blank canvas in this tab. */
    onNewCanvas: () => void;
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
export const CanvasDashboard: React.FC<Props> = ({ onOpenRecent, onOpenFile, onNewCanvas }) => {
    const recents = useRecentCanvases();
    const [dismissed, setDismissed] = useState(false);
    const [openingPath, setOpeningPath] = useState<string | null>(null);

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
            style={{ zIndex: 9998, pointerEvents: 'none' }}
        >
            <div
                onPointerDown={(e) => e.stopPropagation()}
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
                <div style={{ marginBottom: 18 }}>
                    <div style={{ fontSize: 20, fontWeight: 600, letterSpacing: '-0.01em' }}>Your canvases</div>
                    <div style={{ fontSize: 12, color: 'rgba(255,255,255,0.45)', marginTop: 2 }}>
                        {recents.length === 0
                            ? 'No canvases yet. Create one or open an existing .klypix file.'
                            : `${recents.length} canvas${recents.length === 1 ? '' : 'es'} you have worked on.`}
                    </div>
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

                {recents.length > 0 && (
                    <div style={{
                        flex: 1,
                        overflow: 'auto',
                        margin: '0 -8px',
                        padding: '0 8px',
                    }}>
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
                    </div>
                )}
            </div>
        </div>
    ), document.body);
};

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
