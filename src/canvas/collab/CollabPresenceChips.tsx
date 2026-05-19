import React, { useEffect, useRef, useState } from 'react';
import { Trash2 } from 'lucide-react';
import { t } from '../../i18n/strings';
import type { CollabPeer } from './useCanvasCollab';

interface Props {
    peers: CollabPeer[];
    connected: boolean;
    /** True when the local user owns this canvas — gates the "Remove from
     *  canvas" action inside the popover. Non-owners just see read-only
     *  details (server-side RLS would deny the action anyway, but we avoid
     *  showing buttons that can't work). */
    selfIsOwner?: boolean;
    /** Fired when the owner clicks Remove inside a peer popover. The parent
     *  is responsible for the confirm dialog + IPC call + any follow-up
     *  refresh (e.g. nudging the collaborators list). Optional — when
     *  omitted, the Remove button doesn't render even for owners. */
    onRemovePeer?: (peer: CollabPeer) => void | Promise<void>;
}

/** Compact avatar strip showing other users in the same canvas. Renders
 *  nothing when no peers — a saved canvas with no collaborators stays
 *  visually identical to before. Up to 4 chips inline; overflow becomes
 *  a "+N" pill. Phase 16: click a chip to open a popover with name +
 *  details (replaces the tooltip-only mode from v1). */
export function CollabPresenceChips({ peers, connected, selfIsOwner, onRemovePeer }: Props) {
    const [openId, setOpenId] = useState<string | null>(null);
    // Close-on-outside-click ref. Lives at the strip level so clicking a
    // different chip within the strip still works (we want it to switch
    // popovers, not close them).
    const stripRef = useRef<HTMLDivElement | null>(null);
    useEffect(() => {
        if (!openId) return;
        const onDown = (e: MouseEvent) => {
            const el = stripRef.current;
            if (!el) return;
            if (!el.contains(e.target as Node)) setOpenId(null);
        };
        const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpenId(null); };
        document.addEventListener('mousedown', onDown);
        document.addEventListener('keydown', onKey);
        return () => {
            document.removeEventListener('mousedown', onDown);
            document.removeEventListener('keydown', onKey);
        };
    }, [openId]);

    if (peers.length === 0) return null;

    const VISIBLE = 4;
    const visible = peers.slice(0, VISIBLE);
    const overflow = peers.length - visible.length;

    return (
        <div
            ref={stripRef}
            data-canvas-ui="1"
            className="flex items-center -space-x-1.5 relative"
            title={connected
                ? t('canvas.collab_n_here').replace('{n}', String(peers.length))
                : t('canvas.collab_disconnected')}
        >
            {visible.map((p) => {
                const id = `${p.userId}::${p.deviceId}`;
                return (
                    <PeerChip
                        key={id}
                        peer={p}
                        dim={!connected}
                        open={openId === id}
                        onToggle={() => setOpenId(openId === id ? null : id)}
                        onClose={() => setOpenId(null)}
                        selfIsOwner={!!selfIsOwner}
                        onRemovePeer={onRemovePeer}
                    />
                );
            })}
            {overflow > 0 && (
                <div
                    className="flex items-center justify-center w-6 h-6 rounded-full text-[10px] font-bold bg-white/10 text-white/70 border-2 border-[#08080c] no-drag"
                    title={t('canvas.collab_more_count').replace('{n}', String(overflow))}
                >
                    +{overflow}
                </div>
            )}
        </div>
    );
}

interface PeerChipProps {
    peer: CollabPeer;
    dim: boolean;
    open: boolean;
    onToggle: () => void;
    onClose: () => void;
    selfIsOwner: boolean;
    onRemovePeer?: (peer: CollabPeer) => void | Promise<void>;
}

function PeerChip({ peer, dim, open, onToggle, onClose, selfIsOwner, onRemovePeer }: PeerChipProps) {
    const initials = (peer.displayName || '?')
        .split(/\s+/)
        .map(s => s[0])
        .filter(Boolean)
        .slice(0, 2)
        .join('')
        .toUpperCase();
    return (
        <div className="relative no-drag">
            <button
                type="button"
                onClick={onToggle}
                className="flex items-center justify-center w-6 h-6 rounded-full text-[10px] font-semibold text-white border-2 border-[#08080c] transition-opacity cursor-pointer hover:brightness-110 focus:outline-none focus:ring-2 focus:ring-white/30"
                style={{
                    background: peer.color,
                    opacity: dim ? 0.45 : 1,
                }}
                title={peer.displayName}
                aria-haspopup="dialog"
                aria-expanded={open}
            >
                {initials || '?'}
            </button>
            {open && (
                <PeerPopover
                    peer={peer}
                    onClose={onClose}
                    selfIsOwner={selfIsOwner}
                    onRemovePeer={onRemovePeer}
                />
            )}
        </div>
    );
}

function PeerPopover({ peer, onClose, selfIsOwner, onRemovePeer }: {
    peer: CollabPeer;
    onClose: () => void;
    selfIsOwner: boolean;
    onRemovePeer?: (peer: CollabPeer) => void | Promise<void>;
}) {
    // "Last seen": peers carry lastSeen as a presence timestamp (ms). For a
    // currently-connected peer that's basically now; for a peer who just left
    // (channel hasn't flushed yet) it tells us how stale they are.
    const ageSec = Math.max(0, Math.round((Date.now() - peer.lastSeen) / 1000));
    const seenLabel = ageSec < 10
        ? t('canvas.collab_peer.online_now')
        : t('canvas.collab_peer.last_seen_secs').replace('{n}', String(ageSec));

    // Remove-from-canvas is gated on three conditions:
    //   - the parent passed a handler
    //   - the local user is the owner of this canvas
    //   - the peer is a REAL collaborator (not a dev ghost peer, whose
    //     userId starts with "ghost_" — `klypix:devCollabGhost` setting)
    // If any of these is false we hide the action entirely rather than
    // showing a disabled-looking button.
    const canRemove = !!onRemovePeer && selfIsOwner && !peer.userId.startsWith('ghost_');
    const [removing, setRemoving] = useState(false);
    const handleRemove = async () => {
        if (!onRemovePeer || removing) return;
        // Use the OS confirm — small, modal, blocks until answered. We do
        // NOT have a styled in-app confirm component yet; a plain window.confirm
        // is honest and dismissible. The parent's handler also does its own
        // confirm, but doing it here keeps the click→action loop responsive.
        const ok = window.confirm(
            t('canvas.collab_peer.remove_confirm').replace('{name}', peer.displayName || 'this user')
        );
        if (!ok) return;
        setRemoving(true);
        try {
            await onRemovePeer(peer);
            onClose();
        } finally {
            setRemoving(false);
        }
    };

    return (
        <div
            role="dialog"
            aria-label={peer.displayName}
            // Anchor below the chip strip. The parent has -space-x-1.5 so the
            // chips overlap; we pin the popover to the chip's own left edge
            // and let absolute positioning float it just under the strip.
            // z-30 keeps it above the bottom-right title bar and zoom control.
            className="absolute top-7 left-0 z-30 w-56 rounded-xl border border-white/10 bg-[#0e0e14]/95 backdrop-blur-md shadow-2xl no-drag normal-case tracking-normal"
            style={{ boxShadow: '0 8px 24px rgba(0,0,0,0.5)' }}
        >
            <div className="px-3 pt-3 pb-2 flex items-center gap-3">
                <div
                    className="flex items-center justify-center w-10 h-10 rounded-full text-sm font-semibold text-white"
                    style={{ background: peer.color }}
                >
                    {(peer.displayName || '?').split(/\s+/).map(s => s[0]).filter(Boolean).slice(0, 2).join('').toUpperCase() || '?'}
                </div>
                <div className="min-w-0 flex-1">
                    <div className="text-white text-sm font-medium truncate">{peer.displayName || t('canvas.collab_peer.unknown')}</div>
                    <div className="text-white/40 text-[10px] truncate font-mono">{peer.userId.slice(0, 14)}</div>
                </div>
            </div>
            <div className="px-3 pb-2 border-t border-white/5 pt-2 space-y-1">
                <div className="flex items-center justify-between text-[11px]">
                    <span className="text-white/40">{t('canvas.collab_peer.status')}</span>
                    <span className="text-emerald-300 flex items-center gap-1.5">
                        <span className="w-1.5 h-1.5 rounded-full bg-emerald-400" />
                        {seenLabel}
                    </span>
                </div>
                <div className="flex items-center justify-between text-[11px]">
                    <span className="text-white/40">{t('canvas.collab_peer.device')}</span>
                    <span className="text-white/60 font-mono text-[10px]">{peer.deviceId.slice(0, 12)}</span>
                </div>
            </div>
            <div className="px-2 py-2 border-t border-white/5 flex gap-2">
                {canRemove && (
                    <button
                        type="button"
                        onClick={handleRemove}
                        disabled={removing}
                        className="flex items-center justify-center gap-1.5 text-[11px] text-red-300 hover:text-red-200 py-1.5 px-3 rounded-lg bg-red-500/10 hover:bg-red-500/20 border border-red-500/25 transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-wait"
                    >
                        <Trash2 size={11} />
                        {removing ? t('canvas.collab_peer.removing') : t('canvas.collab_peer.remove')}
                    </button>
                )}
                <button
                    type="button"
                    onClick={onClose}
                    className="flex-1 text-[11px] text-white/60 hover:text-white py-1.5 rounded-lg hover:bg-white/5 transition-colors cursor-pointer"
                >
                    {t('common.close')}
                </button>
            </div>
        </div>
    );
}
