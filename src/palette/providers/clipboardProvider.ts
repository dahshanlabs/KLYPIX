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
import { Clipboard, Image as ImageIcon, FileText, Pin, PinOff, Code, Trash2 } from 'lucide-react';
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
    /** Phase 23 follow-up: row originated from cross-device sync (server)
     *  rather than the local poller. Shown with a small cloud accent so
     *  the user knows where it came from. */
    fromSync?: boolean;
}

const SYNC_ENABLED_KEY = 'klypix:palette:clipboardSync:v1';
const isSyncEnabled = (): boolean => {
    try { return localStorage.getItem(SYNC_ENABLED_KEY) === '1'; } catch { return false; }
};

let listCache: { rows: ClipboardRow[]; fetchedAt: number } | null = null;
const LIST_TTL_MS = 800;
// Server pull happens at most once per palette open; cached for 30s.
let syncPullCache: { rows: ClipboardRow[]; fetchedAt: number } | null = null;
const SYNC_PULL_TTL_MS = 30_000;

async function fetchList(): Promise<ClipboardRow[]> {
    if (listCache && Date.now() - listCache.fetchedAt < LIST_TTL_MS) {
        return listCache.rows;
    }
    const bridge: any = (window as any).electron?.clipboardHistory;
    if (!bridge?.list) return [];
    try {
        const rows: ClipboardRow[] = await bridge.list();
        const arr = Array.isArray(rows) ? rows : [];

        // Merge server-side synced rows when opt-in is enabled. Pull is
        // throttled to 30s so a typing burst doesn't IPC-storm Supabase.
        let merged = arr;
        if (isSyncEnabled()) {
            const fresh = syncPullCache && Date.now() - syncPullCache.fetchedAt < SYNC_PULL_TTL_MS
                ? syncPullCache.rows
                : await pullSyncedRows();
            // Dedupe by digest-ish: if a server row has the same text +
            // captured_at-second, prefer the LOCAL one (it'll have a
            // proper id for paste); otherwise inject the server row.
            const localKeys = new Set(arr.map(r => `${r.kind}::${r.text ?? ''}::${Math.floor(r.capturedAt / 1000)}`));
            const additions = fresh.filter(s => !localKeys.has(`${s.kind}::${s.text ?? ''}::${Math.floor(s.capturedAt / 1000)}`));
            merged = arr.concat(additions);
            merged.sort((a, b) => b.capturedAt - a.capturedAt);
        }

        listCache = { rows: merged, fetchedAt: Date.now() };
        return merged;
    } catch { return []; }
}

async function pullSyncedRows(): Promise<ClipboardRow[]> {
    const cloud: any = (window as any).electron?.cloud;
    if (!cloud?.clipboardSyncPull) return [];
    try {
        const raw: Array<{ id: string; kind: string; text: string | null; image_data_url: string | null; file_paths: string[] | null; source_app: string | null; captured_at: string }> = await cloud.clipboardSyncPull();
        const rows: ClipboardRow[] = (Array.isArray(raw) ? raw : []).map(r => ({
            id: 'sync:' + r.id,
            kind: (r.kind as ClipboardRow['kind']) ?? 'text',
            text: r.text ?? undefined,
            imageDataUrl: r.image_data_url ?? undefined,
            filePaths: r.file_paths ?? undefined,
            sourceApp: r.source_app ?? undefined,
            pinned: true,                     // sync only carries pinned items
            capturedAt: new Date(r.captured_at).getTime() || Date.now(),
            fromSync: true,
        }));
        syncPullCache = { rows, fetchedAt: Date.now() };
        return rows;
    } catch {
        return [];
    }
}

/** Public helper called when a row is pinned/unpinned: push the just-pinned
 *  row to Supabase (or remove it from there on unpin). Wired by the
 *  Pin/Unpin action below. */
async function syncPinChange(row: ClipboardRow, nowPinned: boolean): Promise<void> {
    if (!isSyncEnabled()) return;
    const cloud: any = (window as any).electron?.cloud;
    if (!cloud) return;
    if (nowPinned) {
        if (cloud.clipboardSyncPush) {
            await cloud.clipboardSyncPush({
                kind: row.kind,
                text: row.text,
                imageDataUrl: row.imageDataUrl,
                filePaths: row.filePaths,
                sourceApp: row.sourceApp,
            }).catch(() => { /* migration missing or offline */ });
            syncPullCache = null;
        }
    } else {
        // For rows that originated from sync, the id is 'sync:<uuid>' —
        // strip prefix and DELETE on the server.
        if (row.id.startsWith('sync:') && cloud.clipboardSyncRemove) {
            const serverId = row.id.slice('sync:'.length);
            await cloud.clipboardSyncRemove(serverId).catch(() => { /* swallow */ });
            syncPullCache = null;
        }
        // Local-originated rows: there's no server-side mapping yet, so
        // unpinning doesn't propagate. v2 could store an opaque server-id
        // alongside the local row to enable bidirectional unpin.
    }
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
    // Best-in-class: for image rows we show the actual thumbnail inline
    // so the user can recognize what they copied at a glance instead of
    // a generic Image icon. The icon slot in the palette is 28x28; we
    // render the image as object-fit:cover at that size so portrait /
    // landscape / square all degrade gracefully.
    if (row.kind === 'image' && row.imageDataUrl) {
        return React.createElement('img', {
            src: row.imageDataUrl,
            alt: 'Clipboard image',
            style: {
                width: 28,
                height: 28,
                objectFit: 'cover',
                borderRadius: 4,
                display: 'block',
            },
        });
    }
    if (row.kind === 'image') return React.createElement(ImageIcon, { size: 14 });
    if (row.kind === 'files') return React.createElement(FileText, { size: 14 });
    if (row.kind === 'html') return React.createElement(Code, { size: 14 });
    return React.createElement(Clipboard, { size: 14 });
}

function detailFor(row: ClipboardRow): (() => React.ReactNode) | undefined {
    // Image rows: render the full image scaled-to-fit.
    if (row.kind === 'image' && row.imageDataUrl) {
        return () => React.createElement('div', { style: { display: 'flex', flexDirection: 'column', gap: 12, height: '100%' } },
            React.createElement('div', {
                style: {
                    flex: 1,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    background: 'rgba(0,0,0,0.3)',
                    borderRadius: 8,
                    padding: 8,
                    minHeight: 0,
                },
            },
                React.createElement('img', {
                    src: row.imageDataUrl,
                    alt: 'Clipboard image preview',
                    style: { maxWidth: '100%', maxHeight: '100%', objectFit: 'contain' },
                }),
            ),
            React.createElement('div', { style: { fontSize: 11, color: 'rgba(255,255,255,0.55)' } },
                React.createElement('div', null, `Image · ${ageLabel(row.capturedAt)}`),
                row.sourceApp ? React.createElement('div', null, `Source: ${row.sourceApp}`) : null,
            ),
        );
    }
    // File rows: list the paths in a monospace block.
    if (row.kind === 'files' && row.filePaths && row.filePaths.length > 0) {
        return () => React.createElement('div', { style: { display: 'flex', flexDirection: 'column', gap: 8 } },
            React.createElement('div', { style: { fontSize: 11, color: 'rgba(255,255,255,0.55)' } },
                `${row.filePaths!.length} file${row.filePaths!.length === 1 ? '' : 's'} · ${ageLabel(row.capturedAt)}`,
            ),
            React.createElement('div', {
                style: {
                    fontFamily: 'JetBrains Mono, ui-monospace, monospace',
                    fontSize: 11,
                    color: 'rgba(255,255,255,0.85)',
                    background: 'rgba(0,0,0,0.3)',
                    borderRadius: 6,
                    padding: '8px 10px',
                    whiteSpace: 'pre-wrap',
                    wordBreak: 'break-all',
                    maxHeight: 240,
                    overflow: 'auto',
                },
            }, row.filePaths!.join('\n')),
        );
    }
    // Text / HTML rows: detail panel only for content > 80 chars
    // (anything shorter fully fits in the title).
    if ((row.kind === 'text' || row.kind === 'html') && row.text && row.text.length > 80) {
        return () => React.createElement('div', { style: { display: 'flex', flexDirection: 'column', gap: 8, height: '100%' } },
            React.createElement('div', { style: { fontSize: 11, color: 'rgba(255,255,255,0.55)' } },
                `${row.kind === 'html' ? 'HTML' : 'Text'} · ${row.text!.length} chars · ${ageLabel(row.capturedAt)}` +
                (row.sourceApp ? ` · ${row.sourceApp}` : ''),
            ),
            React.createElement('div', {
                style: {
                    flex: 1,
                    fontFamily: 'Thmanyah Sans, system-ui, sans-serif',
                    fontSize: 12,
                    lineHeight: 1.5,
                    color: 'rgba(255,255,255,0.88)',
                    background: 'rgba(0,0,0,0.25)',
                    borderRadius: 6,
                    padding: '10px 12px',
                    whiteSpace: 'pre-wrap',
                    wordBreak: 'break-word',
                    overflow: 'auto',
                    minHeight: 0,
                },
            }, row.text),
        );
    }
    return undefined;
}

function toResult(row: ClipboardRow): PaletteResult {
    const sourceBadge = row.sourceApp ? ` · ${row.sourceApp}` : '';
    const syncBadge = row.fromSync ? ' · ☁ synced' : '';
    return {
        id: `clip:${row.id}`,
        title: row.pinned ? `📌 ${preview(row)}` : preview(row),
        subtitle: `${ageLabel(row.capturedAt)}${sourceBadge}${syncBadge}`,
        accent: row.fromSync ? '#a855f7' : (row.pinned ? '#f59e0b' : '#06b6d4'),
        icon: iconFor(row),
        detail: detailFor(row),
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
                // Inline-clickable so users don't need to learn the chord.
                // Yellow when not yet pinned, gray when already pinned —
                // matches the conventional "pin is golden" affordance.
                inlineIcon: React.createElement(row.pinned ? PinOff : Pin, { size: 12 }),
                inlineIconAccent: row.pinned ? '#9ca3af' : '#f59e0b',
                handler: async () => {
                    const bridge: any = (window as any).electron?.clipboardHistory;
                    if (bridge?.pin && !row.id.startsWith('sync:')) {
                        await bridge.pin(row.id, !row.pinned);
                    }
                    // Propagate to cross-device sync if opt-in is enabled.
                    await syncPinChange(row, !row.pinned);
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
                inlineIcon: React.createElement(Trash2, { size: 12 }),
                inlineIconAccent: '#ef4444',
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
