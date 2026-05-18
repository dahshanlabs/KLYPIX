import React from 'react';
import { t } from '../../i18n/strings';
import type { CollabPeer } from './useCanvasCollab';

interface Props {
    peers: CollabPeer[];
    connected: boolean;
}

/** Compact avatar strip showing other users in the same canvas. Renders
 *  nothing when no peers — a saved canvas with no collaborators stays
 *  visually identical to before. Up to 4 chips inline; overflow becomes
 *  a "+N" pill. Hoverable for full display name + connection state. */
export function CollabPresenceChips({ peers, connected }: Props) {
    if (peers.length === 0) return null;

    const VISIBLE = 4;
    const visible = peers.slice(0, VISIBLE);
    const overflow = peers.length - visible.length;

    return (
        <div
            data-canvas-ui="1"
            className="flex items-center -space-x-1.5"
            title={connected
                ? t('canvas.collab_n_here').replace('{n}', String(peers.length))
                : t('canvas.collab_disconnected')}
        >
            {visible.map((p) => (
                <PeerChip key={`${p.userId}::${p.deviceId}`} peer={p} dim={!connected} />
            ))}
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

function PeerChip({ peer, dim }: { peer: CollabPeer; dim: boolean }) {
    const initials = (peer.displayName || '?')
        .split(/\s+/)
        .map(s => s[0])
        .filter(Boolean)
        .slice(0, 2)
        .join('')
        .toUpperCase();
    return (
        <div
            className="flex items-center justify-center w-6 h-6 rounded-full text-[10px] font-semibold text-white border-2 border-[#08080c] no-drag transition-opacity"
            style={{
                background: peer.color,
                opacity: dim ? 0.45 : 1,
            }}
            title={peer.displayName}
        >
            {initials || '?'}
        </div>
    );
}
