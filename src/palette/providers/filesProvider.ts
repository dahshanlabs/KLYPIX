// Phase 23 Day 5 — Files provider for the Command Palette.
//
// Lazy by design: only fires when query.length >= 2. Otherwise we'd
// hammer the filesystem with a walk on every keystroke from 'a' onward.
// IPC: window.electron.fileSearch.query / open / reveal. The main side
// caches the last query result for 30s.
//
// Result actions:
//   Enter        → open with system default (shell.openPath)
//   Shift+Enter  → reveal in Explorer
//   Ctrl+Enter   → copy file path
//   (Ctrl+Shift+Enter — drop on canvas — wired by canvas drop handler
//    when wired in a follow-up. For now copies path.)

import type { PaletteProvider, PaletteResult, PaletteProviderContext } from './types';
import { File, Folder } from 'lucide-react';
import React from 'react';

interface FileMatch {
    name: string;
    path: string;
    isDirectory: boolean;
    modifiedAt: number;
}

function ageLabel(ms: number): string {
    const sec = Math.max(0, Math.round((Date.now() - ms) / 1000));
    if (sec < 60) return `${sec}s ago`;
    const min = Math.round(sec / 60);
    if (min < 60) return `${min}m ago`;
    const hr = Math.round(min / 60);
    if (hr < 24) return `${hr}h ago`;
    const day = Math.round(hr / 24);
    if (day < 30) return `${day}d ago`;
    const mo = Math.round(day / 30);
    return `${mo}mo ago`;
}

function toResult(m: FileMatch): PaletteResult {
    const parent = m.path.replace(/[\\/][^\\/]+$/, '');
    return {
        id: `files:${m.path}`,
        title: m.name,
        subtitle: `${parent} · ${ageLabel(m.modifiedAt)}`,
        accent: m.isDirectory ? '#f59e0b' : '#9ca3af',
        icon: React.createElement(m.isDirectory ? Folder : File, { size: 14 }),
        primaryAction: {
            label: m.isDirectory ? 'Open folder' : 'Open file',
            handler: () => {
                const bridge: any = (window as any).electron?.fileSearch;
                if (bridge?.open) bridge.open(m.path);
            },
        },
        secondaryActions: [
            {
                label: 'Reveal in Explorer',
                chord: 'Shift+Enter',
                handler: () => {
                    const bridge: any = (window as any).electron?.fileSearch;
                    if (bridge?.reveal) bridge.reveal(m.path);
                },
            },
            {
                label: 'Copy path',
                chord: 'Ctrl+Enter',
                handler: async () => {
                    try { await navigator.clipboard.writeText(m.path); } catch { /* swallow */ }
                },
            },
            {
                label: 'Add to canvas',
                chord: 'Ctrl+Shift+Enter',
                handler: async () => {
                    try { await navigator.clipboard.writeText(m.path); } catch { /* swallow */ }
                },
            },
        ],
    };
}

export const filesProvider: PaletteProvider = {
    id: 'files',
    weight: 1.2,

    async query(input: string, ctx: PaletteProviderContext): Promise<PaletteResult[]> {
        const q = input.trim();
        if (q.length < 2) return [];
        const bridge: any = (window as any).electron?.fileSearch;
        if (!bridge?.query) return [];
        try {
            const matches: FileMatch[] = await bridge.query(q);
            if (ctx.signal.aborted) return [];
            return matches.map(toResult).slice(0, 8);
        } catch {
            return [];
        }
    },
};
