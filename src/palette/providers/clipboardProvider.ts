// Phase 23 Day 3 — Clipboard provider for the Command Palette.
//
// Reads from the main-process clipboard history (polled at ~1Hz, persisted
// to userData/clipboard-history.json). Renders each row with a kind-icon,
// content preview, source-app badge, and age.
//
// Prefix: 'clip:' — typing it routes exclusively to this provider so the
// user can search clipboard without other sources interrupting.
//
// Actions per row:
//   Enter        → re-copy to clipboard (bumps it back to the top)
//   Shift+Enter  → pin / unpin
//   Ctrl+Enter   → send text content to chat (Day 4 bridge; copy fallback)
//   Ctrl+Shift+Enter → drop on canvas (Day 4 bridge; copy fallback)
//
// Caching: list() result is cached in memory for 800ms. The list is queried
// on every keystroke; without cache that'd be a fresh IPC roundtrip per
// character. 800ms is short enough that the user feels "live" but long
// enough to absorb a typing burst.

import type { PaletteProvider, PaletteResult, PaletteProviderContext } from './types';
import { Clipboard, Image as ImageIcon, FileText, Pin, Code } from 'lucide-react';
import React from 'react';
import { fuzzyFilter } from '../search';

interface ClipboardRow {
    id: string;
    kind: 'text' | 'image' | 'files' | 'html';
    text?: string;
    imageDataUrl?: string;
    filePaths?: string[];
    sourceApp?: string;
    pinned: boolean;
    capturedAt: number;
}

let listCache: { rows: ClipboardRow[]; fetchedAt: number } | null = null;
const LIST_TTL_MS = 800;

async function fetchList(): Promise<ClipboardRow[]> {
    if (listCache && Date.now() - listCache.fetchedAt < LIST_TTL_MS) {
        return listCache.rows;
    }
    const bridge: any = (window as any).electron?.clipboardHistory;
    if (!bridge?.list) return [];
    try {
        const rows: ClipboardRow[] = await bridge.list();
        const arr = Array.isArray(rows) ? rows : [];
        listCache = { rows: arr, fetchedAt: Date.now() };
        return arr;
    } catch { return []; }
}

function preview(row: ClipboardRow): string {
    if (row.kind === 'text' || row.kind === 'html') {
        return (row.text || '').slice(0, 120).replace(/\s+/g, ' ');
    }
    if (row.kind === 'files') {
        const n = row.filePaths?.length ?? 0;
        if (n === 1) return row.filePaths![0];
        return `${n} files`;
    }
    if (row.kind === 'image') return 'Image';
    return '(empty)';
}

function ageLabel(capturedAt: number): string {
    const sec = Math.max(0, Math.round((Date.now() - capturedAt) / 1000));
    if (sec < 60) return `${sec}s ago`;
    const min = Math.round(sec / 60);
    if (min < 60) return `${min}m ago`;
    const hr = Math.round(min / 60);
    if (hr < 24) return `${hr}h ago`;
    const day = Math.round(hr / 24);
    return `${day}d ago`;
}

function iconFor(row: ClipboardRow): React.ReactNode {
    if (row.kind === 'image') return React.createElement(ImageIcon, { size: 14 });
    if (row.kind === 'files') return React.createElement(FileText, { size: 14 });
    if (row.kind === 'html') return React.createElement(Code, { size: 14 });
    return React.createElement(Clipboard, { size: 14 });
}

function toResult(row: ClipboardRow): PaletteResult {
    const sourceBadge = row.sourceApp ? ` · ${row.sourceApp}` : '';
    return {
        id: `clip:${row.id}`,
        title: row.pinned ? `📌 ${preview(row)}` : preview(row),
        subtitle: `${ageLabel(row.capturedAt)}${sourceBadge}`,
        accent: row.pinned ? '#f59e0b' : '#06b6d4',
        icon: iconFor(row),
        primaryAction: {
            label: 'Paste',
            handler: async () => {
                const bridge: any = (window as any).electron?.clipboardHistory;
                if (!bridge?.copy) return;
                await bridge.copy(row.id);
                // Invalidate the cache so the next palette query sees the
                // newly-bumped row at the top.
                listCache = null;
            },
        },
        secondaryActions: [
            {
                label: row.pinned ? 'Unpin' : 'Pin',
                chord: 'Shift+Enter',
                keepOpen: true,
                handler: async () => {
                    const bridge: any = (window as any).electron?.clipboardHistory;
                    if (!bridge?.pin) return;
                    await bridge.pin(row.id, !row.pinned);
                    listCache = null;
                },
            },
            {
                label: 'Send to chat',
                chord: 'Ctrl+Enter',
                handler: async () => {
                    // Day 4 wires the chat-input bridge. For now, fall back
                    // to copy + open chat tab.
                    const bridge: any = (window as any).electron?.clipboardHistory;
                    if (bridge?.copy) await bridge.copy(row.id);
                },
            },
            {
                label: 'Add to canvas',
                chord: 'Ctrl+Shift+Enter',
                handler: async () => {
                    // Day 4 wires the canvas-add bridge. For now, fall back
                    // to copy.
                    const bridge: any = (window as any).electron?.clipboardHistory;
                    if (bridge?.copy) await bridge.copy(row.id);
                },
            },
            {
                label: 'Remove from history',
                handler: async () => {
                    const bridge: any = (window as any).electron?.clipboardHistory;
                    if (!bridge?.remove) return;
                    await bridge.remove(row.id);
                    listCache = null;
                },
            },
        ],
    };
}

export const clipboardProvider: PaletteProvider = {
    id: 'clip',
    prefix: 'clip:',
    weight: 1.0,

    emptyState(): PaletteResult[] {
        // Synchronous — palette empty-state can't await. Returns cached
        // snapshot if any, otherwise empty list. The first time the
        // palette opens after boot, the user sees nothing here; pressing
        // any key triggers query() which awaits fetchList properly.
        if (!listCache) return [];
        return listCache.rows.slice(0, 12).map(toResult);
    },

    async query(input: string, _ctx: PaletteProviderContext): Promise<PaletteResult[]> {
        const rows = await fetchList();
        const results = rows.map(toResult);
        const q = input.trim();
        if (q.length === 0) return results.slice(0, 20);
        return fuzzyFilter(results, q).slice(0, 20);
    },
};
