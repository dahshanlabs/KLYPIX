import React, { useState } from 'react';
import { createPortal } from 'react-dom';
import { FilePlus2, FolderOpen, Clock, X as XIcon, Users, Undo2, Check, Star } from 'lucide-react';
import { useRecentCanvases } from '../../hooks/useRecentCanvases';
import { useStarredCanvases } from '../../hooks/useStarredCanvases';
import { toggleStarred } from './starredCanvasesStore';
import { useVaultTags } from '../../hooks/useVaultTags';
import { t, useLocale } from '../../i18n/strings';
import { useSharedCanvases, type SharedCanvas } from '../../hooks/useSharedCanvases';
import { usePendingInvitations, type PendingInvitation } from '../../hooks/usePendingInvitations';
import { listCloudShares } from '../cloud/cloudShareStore';
import { removeRecentCanvas } from './recentCanvasesStore';
import type { RecentCanvas } from './recentCanvasesStore';
import { openSharedCanvas } from '../sync/openSharedCanvas';
import { useRecentlyClosed } from '../../hooks/useRecentlyClosed';
import { consumeClosedCanvas, type ClosedCanvas } from './recentlyClosedStore';

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
    /** Restore a session-scoped recently-closed canvas into the active tab.
     *  Receives the full ClosedCanvas record so the parent can deserialize
     *  + apply via the canvas store (and clear the entry from the queue).
     *  Omit if the host can't honor it (no current canvas state available). */
    onRestoreClosed?: (entry: ClosedCanvas) => void;
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
export const CanvasDashboard: React.FC<Props> = ({ onOpenRecent, onOpenFile, onNewCanvas, onDismiss, onRestoreClosed }) => {
    useLocale();
    const recents = useRecentCanvases();
    const recentlyClosed = useRecentlyClosed();
    const { canvases: shared, loading: sharedLoading, leave: leaveShared } = useSharedCanvases();
    const { invitations: pendingInvites, accept: acceptInvite, decline: declineInvite } = usePendingInvitations();
    const [dismissed, setDismissed] = useState(false);
    const [openingPath, setOpeningPath] = useState<string | null>(null);
    // Track which invitation rows are mid-accept/decline so we can show a
    // spinner + disable the buttons (prevents double-fire).
    const [busyInvite, setBusyInvite] = useState<string | null>(null);

    // "Shared by you" — canvases the user OWNS that have been pushed to the
    // cloud (i.e. they have a cloudShareStore entry without `invitedBy`).
    // Cross-referenced with recents to surface a friendly title; entries
    // without a matching recent row are still listed (basename of path).
    const sharedByYou = React.useMemo(() => {
        const allShares = listCloudShares();
        const recentByPath = new Map(recents.map(r => [r.filePath, r]));
        return allShares
            .filter(s => !s.invitedBy) // exclude canvases received from peers
            .map(s => {
                const rec = recentByPath.get(s.filePath);
                const basename = s.filePath.split(/[\\/]/).pop() || s.filePath;
                return {
                    filePath: s.filePath,
                    blobId: s.blobId,
                    title: rec?.title || basename.replace(/\.(any|klypix)$/i, ''),
                    lastPushedAt: s.lastPushedAt,
                    shareUrl: s.shareUrl,
                };
            })
            // Newest push first — same recency sort the recents list uses.
            .sort((a, b) => b.lastPushedAt - a.lastPushedAt);
    }, [recents]);

    // Starred — the user's pins, joined to recent metadata. A pin that fell
    // off the 50-entry recents cap still renders (synthetic basename row) and
    // opens via the same handleOpen path, so a star never silently vanishes.
    const starredPaths = useStarredCanvases();
    const starredSet = React.useMemo(() => new Set(starredPaths), [starredPaths]);
    const starredRows = React.useMemo(() => {
        const byPath = new Map(recents.map(r => [r.filePath, r]));
        return starredPaths.map(p => byPath.get(p) ?? ({
            filePath: p,
            title: (p.split(/[\\/]/).pop() || p).replace(/\.(any|klypix)$/i, ''),
            lastOpened: 0,
        } as RecentCanvas));
    }, [starredPaths, recents]);

    // Vault tag filter. The index builds lazily once per dashboard open (the
    // component only mounts while shown, so active:true is correct). Selecting
    // chips filters the canvas lists client-side via an O(1) Set membership
    // check — never a file read on toggle.
    const { tags, tagToPaths } = useVaultTags({ active: true });
    const [selectedTags, setSelectedTags] = useState<Set<string>>(new Set());
    const matchingPaths = React.useMemo(() => {
        if (selectedTags.size === 0) return null; // null = no filter (show all)
        const s = new Set<string>();
        for (const t of selectedTags) for (const p of (tagToPaths.get(t) || [])) s.add(p);
        return s;
    }, [selectedTags, tagToPaths]);
    const visible = <T extends { filePath: string }>(rows: T[]): T[] =>
        matchingPaths ? rows.filter(r => matchingPaths.has(r.filePath)) : rows;
    const toggleTag = (key: string) => setSelectedTags(prev => {
        const next = new Set(prev);
        next.has(key) ? next.delete(key) : next.add(key);
        return next;
    });

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
        // Phase 18: pull inviter identity off the entry (either the rich
        // RPC shape or the legacy bare-uuid string). If we only have a uuid,
        // there's nothing display-worthy to persist, so pass null.
        const invitedBy = (() => {
            const ib = entry.invited_by;
            if (!ib || typeof ib === 'string') return null;
            if (!ib.email && !ib.display_name) return null;
            return { name: ib.display_name ?? null, email: ib.email ?? null };
        })();
        try {
            const res = await openSharedCanvas({
                blobId: entry.blob_id,
                keyB64: entry.key_b64,
                titleHint: entry.canvas_blobs?.title_hint,
                invitedBy,
            });
            if (res.ok) {
                // The shared canvas is now on disk. Hand it off to the normal
                // open-by-path flow, same as a recent canvas click.
                await onOpenRecent(res.filePath);
            } else {
                // Surface failure as a window.alert for v1. A nicer toast can
                // come later — for now we just want the user to see WHY a
                // shared canvas didn't open.
                window.alert(t('canvas.open_shared_failed').replace('{r}', `${res.reason}${res.error ? ' — ' + res.error : ''}`));
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
                // Manual / launcher open: a SUBTLE backdrop — canvas chrome
                // (toolbar, file-ops cluster, grid) stays visible behind the
                // card, just lightly dimmed + blurred so it's clearly inert.
                // Backdrop captures pointer events so clicking the chrome
                // dismisses the launcher (and then the second click lands
                // on the chrome button normally). Empty-canvas auto-show
                // stays fully click-through (no backdrop) so it doesn't
                // feel modal at all.
                pointerEvents: onDismiss ? 'auto' : 'none',
                background: onDismiss ? 'rgba(0, 0, 0, 0.18)' : 'transparent',
                backdropFilter: onDismiss ? 'blur(2px)' : undefined,
                WebkitBackdropFilter: onDismiss ? 'blur(2px)' : undefined,
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
                    fontFamily: 'Thmanyah Sans, system-ui, sans-serif',
                    color: '#e8e8ed',
                }}
            >
                <div style={{ marginBottom: 18, display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12 }}>
                    <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontSize: 20, fontWeight: 600, letterSpacing: '-0.01em' }}>{t('canvas.your_canvases')}</div>
                        <div style={{ fontSize: 12, color: 'rgba(255,255,255,0.45)', marginTop: 2 }}>
                            {recents.length === 0
                                ? t('canvas.empty')
                                : recents.length === 1
                                    ? t('canvas.worked_on_count_one')
                                    : t('canvas.worked_on_count').replace('{n}', String(recents.length))}
                        </div>
                    </div>
                    {onDismiss && (
                        <button
                            type="button"
                            onPointerDown={(e) => { e.preventDefault(); e.stopPropagation(); onDismiss(); }}
                            onClick={(e) => { e.preventDefault(); e.stopPropagation(); onDismiss(); }}
                            title={t('canvas.close_esc')}
                            aria-label={t('canvas.close_dashboard')}
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
                        {t('canvas.new')}
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
                        {t('canvas.open_file')}
                    </button>
                </div>

                {/* Tag filter chips (Obsidian-comfort). Click to filter the lists
                    below to canvases carrying that #tag. O(1) Set check per row
                    on toggle — no file reads. Hidden when the vault has no tags. */}
                {tags.length > 0 && (
                    <div style={{ marginBottom: 14, flexShrink: 0 }}>
                        <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: '0.08em', color: 'rgba(255,255,255,0.4)', marginBottom: 7 }}>
                            FILTER BY TAG
                        </div>
                        <div
                            onPointerDown={(e) => e.stopPropagation()}
                            onWheel={(e) => e.stopPropagation()}
                            style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'flex-start', maxHeight: 120, overflowY: 'auto' }}
                        >
                            {tags.map(({ tag, count }) => {
                                const key = tag.toLowerCase();
                                const on = selectedTags.has(key);
                                return (
                                    <button
                                        key={key}
                                        onPointerDown={(e) => { e.stopPropagation(); toggleTag(key); }}
                                        title={`${count} canvas${count === 1 ? '' : 'es'} tagged #${tag}`}
                                        style={{
                                            display: 'inline-flex', alignItems: 'center', gap: 5, flexShrink: 0,
                                            fontSize: 11.5, fontWeight: 600, padding: '4px 10px', borderRadius: 999,
                                            cursor: 'pointer', whiteSpace: 'nowrap', lineHeight: 1.4,
                                            background: on ? '#10b981' : 'rgba(16,185,129,0.12)',
                                            color: on ? '#06281f' : '#10b981',
                                            border: '1px solid rgba(16,185,129,0.3)',
                                        }}
                                    >
                                        #{tag}
                                        <span style={{ opacity: 0.6, fontWeight: 500 }}>{count}</span>
                                    </button>
                                );
                            })}
                            {selectedTags.size > 0 && (
                                <button
                                    onPointerDown={(e) => { e.stopPropagation(); setSelectedTags(new Set()); }}
                                    style={{ fontSize: 11, padding: '4px 10px', borderRadius: 999, cursor: 'pointer', background: 'transparent', color: 'rgba(255,255,255,0.5)', border: '1px solid rgba(255,255,255,0.12)', flexShrink: 0, lineHeight: 1.4 }}
                                >
                                    {t('canvas.clear_filter')} · {matchingPaths?.size ?? 0}
                                </button>
                            )}
                        </div>
                    </div>
                )}

                <div style={{
                    flex: 1,
                    overflow: 'auto',
                    margin: '0 -8px',
                    padding: '0 8px',
                }}>
                    {/* Starred — the user's pins, pinned to the top so favorite
                        canvases are always one click away. Renders in BOTH
                        manual-open and empty-canvas auto-show modes. */}
                    {visible(starredRows).length > 0 && (
                        <>
                            <div style={{
                                fontSize: 10, color: '#f59e0b',
                                textTransform: 'uppercase', letterSpacing: '0.08em',
                                marginBottom: 8, paddingLeft: 4,
                                display: 'flex', alignItems: 'center', gap: 6,
                            }}>
                                <Star size={10} />
                                {t('canvas.starred')}
                            </div>
                            {visible(starredRows).map(entry => (
                                <RecentRow
                                    key={'star:' + entry.filePath}
                                    entry={entry}
                                    opening={openingPath === entry.filePath}
                                    onOpen={() => handleOpen(entry)}
                                    onRemove={() => removeRecentCanvas(entry.filePath)}
                                    isStarred={true}
                                    onToggleStar={() => toggleStarred(entry.filePath)}
                                />
                            ))}
                        </>
                    )}
                    {/* Pending invitations inbox (2026-05-30) — sits at the very
                        top because it's the most actionable thing: someone is
                        waiting on you. Accept → becomes a collaborator + the
                        canvas drops into "Shared with you"; Decline → gone. */}
                    {pendingInvites.length > 0 && (
                        <>
                            <div style={{
                                fontSize: 10, color: '#10b981',
                                textTransform: 'uppercase', letterSpacing: '0.08em',
                                marginBottom: 8, paddingLeft: 4,
                                display: 'flex', alignItems: 'center', gap: 6,
                            }}>
                                <Users size={10} />
                                {t('canvas.pending_invitations')} · {pendingInvites.length}
                            </div>
                            {pendingInvites.map(inv => (
                                <PendingInviteRow
                                    key={inv.invitation_id}
                                    invite={inv}
                                    busy={busyInvite === inv.invitation_id}
                                    onAccept={async () => {
                                        setBusyInvite(inv.invitation_id);
                                        try { await acceptInvite(inv.invitation_id); }
                                        finally { setBusyInvite(null); }
                                    }}
                                    onDecline={async () => {
                                        setBusyInvite(inv.invitation_id);
                                        try { await declineInvite(inv.invitation_id); }
                                        finally { setBusyInvite(null); }
                                    }}
                                />
                            ))}
                        </>
                    )}
                    {/* Recently closed — session-scoped. Sits above Recent because
                        it's the most likely thing the user wants right after an
                        accidental close. Each entry consumes itself on restore
                        so there's no duplicate-restore footgun. */}
                    {recentlyClosed.length > 0 && onRestoreClosed && (
                        <>
                            <div style={{
                                fontSize: 10, color: 'rgba(255,255,255,0.4)',
                                textTransform: 'uppercase', letterSpacing: '0.08em',
                                marginBottom: 8, paddingLeft: 4,
                                display: 'flex', alignItems: 'center', gap: 6,
                            }}>
                                <Undo2 size={10} />
                                {t('canvas.recently_closed')}
                            </div>
                            {recentlyClosed.map(entry => (
                                <RecentlyClosedRow
                                    key={entry.id}
                                    entry={entry}
                                    onRestore={() => {
                                        const consumed = consumeClosedCanvas(entry.id);
                                        if (consumed) onRestoreClosed(consumed);
                                    }}
                                />
                            ))}
                        </>
                    )}
                    {visible(recents).length > 0 && (
                        <>
                            <div style={{
                                fontSize: 10, color: 'rgba(255,255,255,0.4)',
                                textTransform: 'uppercase', letterSpacing: '0.08em',
                                marginTop: recentlyClosed.length > 0 && onRestoreClosed ? 16 : 0,
                                marginBottom: 8, paddingLeft: 4,
                            }}>
                                {t('canvas.recent')}
                            </div>
                            {visible(recents).map(entry => (
                                <RecentRow
                                    key={entry.filePath}
                                    entry={entry}
                                    opening={openingPath === entry.filePath}
                                    onOpen={() => handleOpen(entry)}
                                    onRemove={() => removeRecentCanvas(entry.filePath)}
                                    isStarred={starredSet.has(entry.filePath)}
                                    onToggleStar={() => toggleStarred(entry.filePath)}
                                />
                            ))}
                        </>
                    )}
                    {visible(sharedByYou).length > 0 && (
                        <>
                            <div style={{
                                fontSize: 10, color: 'rgba(255,255,255,0.4)',
                                textTransform: 'uppercase', letterSpacing: '0.08em',
                                marginTop: recents.length > 0 ? 16 : 0,
                                marginBottom: 8, paddingLeft: 4,
                                display: 'flex', alignItems: 'center', gap: 6,
                            }}>
                                <Users size={10} />
                                {t('canvas.shared_by_you')}
                            </div>
                            {visible(sharedByYou).map(entry => (
                                <SharedByYouRow
                                    key={entry.blobId}
                                    entry={entry}
                                    opening={openingPath === entry.filePath}
                                    onOpen={() => {
                                        setOpeningPath(entry.filePath);
                                        onOpenRecent(entry.filePath);
                                    }}
                                />
                            ))}
                        </>
                    )}
                    {(shared.length > 0 || sharedLoading) && (
                        <>
                            <div style={{
                                fontSize: 10, color: 'rgba(255,255,255,0.4)',
                                textTransform: 'uppercase', letterSpacing: '0.08em',
                                marginTop: (recents.length > 0 || sharedByYou.length > 0) ? 16 : 0,
                                marginBottom: 8, paddingLeft: 4,
                                display: 'flex', alignItems: 'center', gap: 6,
                            }}>
                                <Users size={10} />
                                {t('canvas.shared_with_you')}
                            </div>
                            {sharedLoading && (
                                <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.35)', padding: '8px 12px' }}>
                                    {t('canvas.loading')}
                                </div>
                            )}
                            {!sharedLoading && shared.map(entry => (
                                <SharedRow
                                    key={entry.blob_id}
                                    entry={entry}
                                    opening={openingPath === entry.blob_id}
                                    onOpen={() => handleOpenShared(entry)}
                                    onLeave={() => {
                                        const title = entry.canvas_blobs?.title_hint || t('canvas.this_canvas');
                                        const ok = window.confirm(
                                            `${t('canvas.leave_shared_q')} "${title}"\n\n${t('canvas.leave_shared_warn')}`
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

// ── Pending-invitation inbox row (2026-05-30) ───────────────────────────
function PendingInviteRow({ invite, busy, onAccept, onDecline }: {
    invite: PendingInvitation;
    busy: boolean;
    onAccept: () => void;
    onDecline: () => void;
}) {
    const title = invite.title_hint || t('canvas.untitled_canvas');
    const inviter = invite.invited_by?.display_name || invite.invited_by?.masked_email || t('canvas.someone');
    // Relative expiry ("expires in 2h"). expires_at is ISO from the server.
    let expiresLabel = '';
    try {
        const ms = new Date(invite.expires_at).getTime() - Date.now();
        if (ms > 0) {
            const hr = Math.floor(ms / 3600000);
            const day = Math.floor(hr / 24);
            expiresLabel = day >= 1
                ? t('canvas.expires_in_days').replace('{n}', String(day))
                : hr >= 1
                    ? t('canvas.expires_in_hours').replace('{n}', String(hr))
                    : t('canvas.expires_soon');
        } else {
            expiresLabel = t('canvas.expired');
        }
    } catch { /* leave blank */ }
    return (
        <div
            style={{
                display: 'flex', alignItems: 'center', gap: 10,
                padding: '10px 12px', borderRadius: 8, marginBottom: 4,
                background: 'rgba(16, 185, 129, 0.06)',
                border: '1px solid rgba(16, 185, 129, 0.18)',
            }}
        >
            <div style={{
                width: 36, height: 36, borderRadius: 8,
                background: 'rgba(16, 185, 129, 0.14)', color: '#10b981',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                flexShrink: 0, fontSize: 10, fontWeight: 600, letterSpacing: '0.04em',
            }}>
                {/* bdi keeps a non-Latin title/inviter from flipping the box in RTL */}
                <bdi>{title.slice(0, 2).toUpperCase()}</bdi>
            </div>
            <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{
                    fontSize: 13, fontWeight: 500, color: '#e8e8ed',
                    whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                }}>
                    <bdi>{title}</bdi>
                </div>
                <div style={{ fontSize: 10, color: 'rgba(255,255,255,0.45)', marginTop: 2 }}>
                    <bdi>{inviter}</bdi> {t('canvas.invited_you_to')}{expiresLabel ? ` · ${expiresLabel}` : ''}
                </div>
            </div>
            {/* Decline (subtle) */}
            <button
                onPointerDown={(e) => { e.stopPropagation(); if (!busy) onDecline(); }}
                disabled={busy}
                title={t('canvas.decline')}
                style={{
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    width: 30, height: 30, borderRadius: 7, flexShrink: 0,
                    background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.08)',
                    color: 'rgba(255,255,255,0.55)', cursor: busy ? 'wait' : 'pointer',
                }}
            >
                <XIcon size={14} />
            </button>
            {/* Accept (emerald, primary) */}
            <button
                onPointerDown={(e) => { e.stopPropagation(); if (!busy) onAccept(); }}
                disabled={busy}
                title={t('canvas.accept')}
                style={{
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    gap: 5, height: 30, padding: '0 12px', borderRadius: 7, flexShrink: 0,
                    background: 'rgba(16, 185, 129, 0.2)', border: '1px solid rgba(16, 185, 129, 0.4)',
                    color: '#10b981', fontSize: 12, fontWeight: 600,
                    cursor: busy ? 'wait' : 'pointer', opacity: busy ? 0.6 : 1,
                }}
            >
                {busy
                    ? <span style={{ width: 12, height: 12, border: '2px solid rgba(16,185,129,0.3)', borderTopColor: '#10b981', borderRadius: '50%', display: 'inline-block', animation: 'spin 0.6s linear infinite' }} />
                    : <Check size={14} />}
                {t('canvas.accept')}
            </button>
        </div>
    );
}

interface SharedByYouEntry {
    filePath: string;
    blobId: string;
    title: string;
    lastPushedAt: number;
    shareUrl: string;
}

interface SharedByYouRowProps {
    entry: SharedByYouEntry;
    opening: boolean;
    onOpen: () => void;
}

/**
 * Row in the "Shared by you" launcher section — canvases the user OWNS and
 * has pushed to the cloud. Visually distinct from the "Shared with you"
 * (recipient) rows by using an emerald accent (mirrors the owner-side
 * "you are owner" badge inside an open canvas). Click → opens the local
 * .klypix file via the existing onOpenRecent path.
 */
function SharedByYouRow({ entry, opening, onOpen }: SharedByYouRowProps) {
    const pushedAgo = formatRelativeTime(entry.lastPushedAt);
    return (
        <div
            onPointerDown={(e) => { e.stopPropagation(); if (!opening) onOpen(); }}
            style={{
                display: 'flex',
                alignItems: 'center',
                gap: 10,
                padding: '10px 12px',
                borderRadius: 8,
                cursor: opening ? 'wait' : 'pointer',
                opacity: opening ? 0.5 : 1,
                transition: 'background 0.1s',
            }}
            onMouseEnter={(e) => {
                if (!opening) e.currentTarget.style.background = 'rgba(255,255,255,0.05)';
            }}
            onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
            title={`${entry.filePath}\n${t('canvas.shared_by_you')} · ${t('canvas.last_shared').replace('{t}', pushedAgo)}`}
        >
            <div style={{
                width: 36, height: 36, borderRadius: 8,
                background: 'rgba(16, 185, 129, 0.12)',
                color: '#10b981',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                flexShrink: 0, fontSize: 10, fontWeight: 600, letterSpacing: '0.04em',
            }}>
                {entry.title.slice(0, 2).toUpperCase()}
            </div>
            <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{
                    fontSize: 13, fontWeight: 500, color: '#e8e8ed',
                    whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                }}>{entry.title}</div>
                <div style={{
                    fontSize: 10, color: 'rgba(255,255,255,0.4)',
                    display: 'flex', alignItems: 'center', gap: 6, marginTop: 2,
                }}>
                    <bdi>{t('canvas.last_shared').replace('{t}', pushedAgo)}</bdi>
                    <span style={{ opacity: 0.4 }}>·</span>
                    <span style={{ color: 'rgba(16, 185, 129, 0.7)' }}>{t('canvas.role_owner')}</span>
                </div>
            </div>
        </div>
    );
}

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
    const title = entry.canvas_blobs?.title_hint || t('canvas.untitled_canvas');
    const updatedAt = entry.canvas_blobs?.updated_at;
    // When the current user accepted the invite (i.e. joined this canvas).
    // Already fetched by useSharedCanvases — surface it as a friendly relative
    // time so the user can see how long they've been a collaborator. Falls
    // back to nothing for legacy rows without an accepted_at.
    const joinedMs = entry.accepted_at ? new Date(entry.accepted_at).getTime() : NaN;
    const joinedLabel = Number.isFinite(joinedMs) ? formatRelativeTime(joinedMs) : null;
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
            title={!canOpen
                ? t('canvas.invitation_too_old')
                : updatedAt
                    ? t('canvas.open_shared_updated').replace('{t}', new Date(updatedAt).toLocaleString())
                    : t('canvas.open_shared')}
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
                    <bdi>{joinedLabel
                        ? t('canvas.joined').replace('{t}', joinedLabel)
                        : updatedAt ? new Date(updatedAt).toLocaleString() : t('canvas.unknown_date')}</bdi>
                    <span style={{ opacity: 0.4 }}>·</span>
                    <span style={{ color: 'rgba(16, 185, 129, 0.7)' }}>{t('canvas.role_editor')}</span>
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
                    {t('canvas.no_key')}
                </div>
            )}
            <button
                onPointerDown={(e) => { e.stopPropagation(); }}
                onClick={(e) => { e.preventDefault(); e.stopPropagation(); onLeave(); }}
                title={t('canvas.remove_shared')}
                aria-label={t('canvas.leave_shared')}
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
    isStarred?: boolean;
    onToggleStar?: () => void;
}

function RecentRow({ entry, opening, onOpen, onRemove, isStarred, onToggleStar }: RecentRowProps) {
    const fileName = entry.filePath.split(/[\\/]/).pop() || entry.filePath;
    // "Untitled" / "Untitled canvas" is the SENTINEL value canvases get
    // when the user hasn't named them. We don't want to mutate the saved
    // title in the .klypix file (that would change the file's identity
    // across locales), so localize at display time only. User-chosen
    // titles render verbatim.
    const isUntitledSentinel = entry.title === 'Untitled' || entry.title === 'Untitled canvas';
    const displayTitle = isUntitledSentinel ? t('canvas.untitled_canvas') : entry.title;
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
                {displayTitle.slice(0, 2).toUpperCase()}
            </div>
            <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 13, fontWeight: 500, color: '#e8e8ed', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {displayTitle}
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
            {onToggleStar && (
                <button
                    // onPointerDown (not onClick) so the canvas pen tool can't
                    // swallow the first click via setPointerCapture.
                    onPointerDown={(e) => { e.stopPropagation(); onToggleStar(); }}
                    title={isStarred ? t('canvas.unstar') : t('canvas.star')}
                    style={{
                        padding: 4, borderRadius: 5,
                        background: 'transparent',
                        color: isStarred ? '#f59e0b' : 'rgba(255,255,255,0.3)',
                        cursor: 'pointer',
                        flexShrink: 0,
                        display: 'flex',
                    }}
                    onMouseEnter={(e) => { e.currentTarget.style.color = '#f59e0b'; e.currentTarget.style.background = 'rgba(245,158,11,0.1)'; }}
                    onMouseLeave={(e) => { e.currentTarget.style.color = isStarred ? '#f59e0b' : 'rgba(255,255,255,0.3)'; e.currentTarget.style.background = 'transparent'; }}
                >
                    <Star size={12} fill={isStarred ? '#f59e0b' : 'none'} />
                </button>
            )}
            <button
                onPointerDown={(e) => { e.stopPropagation(); }}
                onClick={(e) => { e.stopPropagation(); onRemove(); }}
                title={t('canvas.remove_recent')}
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

/** A row in the "Recently closed" section. Clicking restores the snapshot
 *  into the active canvas tab. No hover preview yet; just title + meta. */
function RecentlyClosedRow({ entry, onRestore }: { entry: ClosedCanvas; onRestore: () => void }) {
    return (
        <div
            onPointerDown={(e) => { e.stopPropagation(); onRestore(); }}
            title={entry.filePath || entry.title}
            style={{
                display: 'flex',
                alignItems: 'center',
                gap: 10,
                padding: '10px 12px',
                borderRadius: 10,
                background: 'rgba(255,255,255,0.03)',
                cursor: 'pointer',
                transition: 'background 0.15s',
                marginBottom: 4,
            }}
            onMouseEnter={(e) => (e.currentTarget.style.background = 'rgba(16,185,129,0.10)')}
            onMouseLeave={(e) => (e.currentTarget.style.background = 'rgba(255,255,255,0.03)')}
        >
            <div style={{
                width: 32, height: 32, borderRadius: 8,
                background: 'rgba(16,185,129,0.12)',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                color: '#10b981', flexShrink: 0,
            }}>
                <Undo2 size={14} />
            </div>
            <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 13, fontWeight: 500, color: '#e8e8ed', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {entry.title}
                </div>
                <div style={{ fontSize: 10, color: 'rgba(255,255,255,0.4)', display: 'flex', alignItems: 'center', gap: 6, marginTop: 2 }}>
                    <Clock size={9} />
                    <span>{formatRelativeTime(entry.closedAt)}</span>
                    <span>·</span>
                    <span>{entry.itemCount === 1 ? t('canvas.group_item_one') : `${entry.itemCount} ${t('canvas.group_items')}`}</span>
                </div>
            </div>
        </div>
    );
}

function formatRelativeTime(ms: number): string {
    const diff = Date.now() - ms;
    const minute = 60_000;
    const hour = 60 * minute;
    const day = 24 * hour;
    const week = 7 * day;

    const fill = (key: 'time.minutes_ago' | 'time.hours_ago' | 'time.days_ago' | 'time.weeks_ago', n: number) =>
        t(key).replace('{n}', String(n));

    if (diff < minute) return t('time.just_now');
    if (diff < hour) return fill('time.minutes_ago', Math.floor(diff / minute));
    if (diff < day) return fill('time.hours_ago', Math.floor(diff / hour));
    if (diff < week) return fill('time.days_ago', Math.floor(diff / day));
    if (diff < 4 * week) return fill('time.weeks_ago', Math.floor(diff / week));
    // Beyond 4 weeks: fall through to the user's locale-formatted date.
    // This naturally renders Arabic numerals + month names in Arabic mode
    // (Intl uses navigator/electron locale, not our app-level toggle —
    // close enough for now; if drift is reported, pipe the active locale
    // in explicitly via toLocaleDateString(locale)).
    return new Date(ms).toLocaleDateString();
}
