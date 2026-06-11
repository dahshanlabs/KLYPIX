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
import { Clipboard, Image as ImageIcon, FileText, Pin, PinOff, Trash2, Link as LinkIcon, Palette as PaletteIcon, ExternalLink } from 'lucide-react';
import React from 'react';
import { fuzzyFilter } from '../search';
import { getSnapshot } from '../paletteStore';

interface ClipboardRow {
    id: string;
    kind: 'text' | 'image' | 'files' | 'html' | 'link' | 'color';
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
    if (row.kind === 'text' || row.kind === 'html' || row.kind === 'link' || row.kind === 'color') {
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

/** A small monospace "TxT" chip used as the icon for text/html rows. */
function txtBadge(): React.ReactNode {
    return React.createElement('div', {
        style: {
            fontFamily: 'JetBrains Mono, ui-monospace, monospace',
            fontSize: 9,
            fontWeight: 700,
            letterSpacing: '0.5px',
            lineHeight: 1,
            color: 'rgba(255,255,255,0.72)',
            border: '1px solid rgba(255,255,255,0.18)',
            borderRadius: 4,
            padding: '2px 3px',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
        },
    }, 'TxT');
}

/** Order rows by capture time honoring the user's browse-sort preference
 *  (newest-first by default). Applied BEFORE slicing the top 20 so the
 *  correct time-window survives the cap. */
function orderRows(rows: ClipboardRow[]): ClipboardRow[] {
    const dir = getSnapshot().clipSort;
    return rows.slice().sort((a, b) =>
        dir === 'oldest' ? a.capturedAt - b.capturedAt : b.capturedAt - a.capturedAt,
    );
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
    // Text-like rows (plain text + browser-copied HTML) get a literal "TxT"
    // badge — more self-evidently "this is text you copied" than the old
    // <> code glyph, which read as "this is code".
    if (row.kind === 'html' || row.kind === 'text') return txtBadge();
    if (row.kind === 'link') return React.createElement(LinkIcon, { size: 14 });
    if (row.kind === 'color' && row.text) {
        // Render an actual color swatch instead of a generic palette icon.
        // The text is the literal color value (we validate strictly in
        // clipboardHistory.classifyText), so CSS interprets it directly.
        return React.createElement('div', {
            style: {
                width: 22,
                height: 22,
                borderRadius: 6,
                background: row.text,
                border: '1px solid rgba(255,255,255,0.2)',
                boxShadow: 'inset 0 0 0 1px rgba(0,0,0,0.15)',
            },
        });
    }
    if (row.kind === 'color') return React.createElement(PaletteIcon, { size: 14 });
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
    // Color row: large swatch + the literal value.
    if (row.kind === 'color' && row.text) {
        return () => React.createElement('div', { style: { display: 'flex', flexDirection: 'column', gap: 12, height: '100%' } },
            React.createElement('div', {
                style: {
                    flex: 1,
                    minHeight: 120,
                    borderRadius: 10,
                    background: row.text,
                    border: '1px solid rgba(255,255,255,0.15)',
                    boxShadow: 'inset 0 0 0 1px rgba(0,0,0,0.2)',
                },
            }),
            React.createElement('div', {
                style: {
                    fontFamily: 'JetBrains Mono, ui-monospace, monospace',
                    fontSize: 14,
                    color: 'rgba(255,255,255,0.95)',
                    background: 'rgba(0,0,0,0.3)',
                    borderRadius: 6,
                    padding: '8px 10px',
                    textAlign: 'center',
                    userSelect: 'all',
                },
            }, row.text),
            React.createElement('div', { style: { fontSize: 11, color: 'rgba(255,255,255,0.55)' } },
                `Color · ${ageLabel(row.capturedAt)}${row.sourceApp ? ' · ' + row.sourceApp : ''}`,
            ),
        );
    }
    // Link row: show the URL prominently in monospace.
    if (row.kind === 'link' && row.text) {
        return () => React.createElement('div', { style: { display: 'flex', flexDirection: 'column', gap: 12, height: '100%' } },
            React.createElement('div', {
                style: {
                    fontFamily: 'JetBrains Mono, ui-monospace, monospace',
                    fontSize: 13,
                    color: '#7dd3fc',
                    background: 'rgba(14,165,233,0.08)',
                    border: '1px solid rgba(14,165,233,0.2)',
                    borderRadius: 8,
                    padding: '10px 12px',
                    wordBreak: 'break-all',
                    userSelect: 'all',
                },
            }, row.text),
            React.createElement('div', { style: { fontSize: 11, color: 'rgba(255,255,255,0.55)' } },
                `Link · ${ageLabel(row.capturedAt)}${row.sourceApp ? ' · ' + row.sourceApp : ''}`,
            ),
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
        // Lets the palette order the browse list by real capture time
        // instead of frecency rank (see paletteStore.sortClipChronologically).
        sortTs: row.capturedAt,
        primaryAction: (() => {
            // Best-in-class: read the smart-paste target from the palette
            // store at row-build time. When known, primary action becomes
            // a one-keystroke SendKeys ^v into the target app (Raycast
            // parity). When unknown (boot, no recent foreground), fall back
            // to the old "re-copy to OS clipboard and let the user paste".
            const target = getSnapshot().target;
            const canSmartPaste = !!(target?.hwnd && row.kind !== 'files');
            return {
                label: canSmartPaste ? `Paste to ${target!.app}` : 'Paste',
                toast: canSmartPaste ? `Pasted to ${target!.app}` : 'Copied to clipboard',
                handler: async () => {
                    const bridge: any = (window as any).electron;
                    if (canSmartPaste && bridge?.smartPaste) {
                        const res = await bridge.smartPaste({ hwnd: target!.hwnd, rowId: row.id });
                        listCache = null;
                        if (res?.ok) return;
                        // Smart-paste failed (target window closed, perms,
                        // etc.) — fall back to the copy-only path so the
                        // user can still manually paste.
                    }
                    if (bridge?.clipboardHistory?.copy) {
                        await bridge.clipboardHistory.copy(row.id);
                        listCache = null;
                    }
                },
            };
        })(),
        secondaryActions: [
            ...(row.kind === 'link' && row.text ? [{
                label: 'Open in browser',
                chord: 'Alt+Enter',
                toast: 'Opening…',
                inlineIcon: React.createElement(ExternalLink, { size: 12 }),
                inlineIconAccent: '#7dd3fc',
                handler: async () => {
                    const bridge: any = (window as any).electron;
                    if (bridge?.openExternal) await bridge.openExternal(row.text!);
                },
            }] : []),
            {
                label: row.pinned ? 'Unpin' : 'Pin',
                chord: 'Shift+Enter',
                keepOpen: true,
                toast: row.pinned ? 'Unpinned' : 'Pinned',
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
                    // Force re-pull so the Pin/PinOff icon morphs immediately.
                    const { refresh } = await import('../paletteStore');
                    refresh();
                },
            },
            {
                label: 'Send to chat',
                chord: 'Ctrl+Enter',
                // Real bridge: images attach as files (round-trip data URL →
                // temp file via save-pasted-image), File Explorer rows attach
                // their paths directly, text/html rows append into the chat
                // textarea. App.tsx listens for these CustomEvents and also
                // flips the tab to 'chat' so the user sees the result.
                toast: row.kind === 'image' || row.kind === 'files' ? 'Attached to chat' : 'Sent to chat',
                handler: async () => {
                    if (row.kind === 'image' && row.imageDataUrl) {
                        const m = row.imageDataUrl.match(/^data:(image\/[\w+.-]+);base64,(.*)$/);
                        if (!m) return;
                        const mime = m[1];
                        const bin = atob(m[2]);
                        const bytes = new Uint8Array(bin.length);
                        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
                        const save = (window as any).electron?.savePastedImage;
                        if (!save) return;
                        const res = await save(bytes.buffer, mime);
                        if (res?.ok && res.path) {
                            window.dispatchEvent(new CustomEvent('klypix:chat-attach', { detail: { paths: [res.path] } }));
                        }
                        return;
                    }
                    if (row.kind === 'files' && row.filePaths && row.filePaths.length > 0) {
                        window.dispatchEvent(new CustomEvent('klypix:chat-attach', { detail: { paths: row.filePaths.slice() } }));
                        return;
                    }
                    if ((row.kind === 'text' || row.kind === 'html') && row.text) {
                        window.dispatchEvent(new CustomEvent('klypix:chat-input-append', { detail: { text: row.text } }));
                        return;
                    }
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
                toast: 'Removed',
                inlineIcon: React.createElement(Trash2, { size: 12 }),
                inlineIconAccent: '#ef4444',
                // keepOpen so users can clean up multiple rows in a single
                // palette session without having to reopen. The list rebuilds
                // on every paletteStore refresh so the deleted row vanishes
                // immediately after the action handler resolves.
                keepOpen: true,
                handler: async () => {
                    const bridge: any = (window as any).electron?.clipboardHistory;
                    if (!bridge?.remove) return;
                    await bridge.remove(row.id);
                    listCache = null;
                    // Force a re-pull so the deleted row drops out of the
                    // visible list immediately. Without this the cached
                    // list stays for up to 800ms before the next fetch.
                    const { refresh } = await import('../paletteStore');
                    refresh();
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
        // First open: listCache is null because no query has fetched yet
        // and emptyState is synchronous (can't await). Kick off a
        // background fetch + refresh so the palette repopulates within
        // a tick — without this, users saw "no clip rows" on first
        // Ctrl+K until they typed any character.
        if (!listCache) {
            void (async () => {
                await fetchList();
                try {
                    const { refresh } = await import('../paletteStore');
                    refresh();
                } catch { /* swallow */ }
            })();
            return [];
        }
        return withSectionHeaders(orderRows(listCache.rows).slice(0, 20));
    },

    async query(input: string, _ctx: PaletteProviderContext): Promise<PaletteResult[]> {
        const rows = await fetchList();
        const q = input.trim();
        if (q.length === 0) return withSectionHeaders(orderRows(rows).slice(0, 20));
        // When the user is searching, section dividers add noise — show a
        // flat fuzzy-ranked list instead. Pinned rows still get their
        // 📌 prefix so they're recognizable.
        const results = rows.map(toResult);
        return fuzzyFilter(results, q).slice(0, 20);
    },
};

// Insert 📌 PINNED / RECENT section headers between pinned and unpinned
// rows when both groups exist. Removes the "did pin actually do
// anything" ambiguity — pinned rows now visibly cluster under a labeled
// header instead of just having a small emoji prefix.
function withSectionHeaders(rows: ClipboardRow[]): PaletteResult[] {
    const pinned = rows.filter(r => r.pinned);
    const unpinned = rows.filter(r => !r.pinned);
    const out: PaletteResult[] = [];
    if (pinned.length > 0) {
        out.push({
            id: 'clip:section:pinned',
            title: `📌 PINNED (${pinned.length})`,
            sectionHeader: 'pinned',
            accent: '#f59e0b',
            primaryAction: { label: '', handler: () => {} },
        });
        for (const r of pinned) out.push(toResult(r));
    }
    if (unpinned.length > 0) {
        // Only show "Recent" label when there's also a Pinned section
        // above — otherwise it's redundant.
        if (pinned.length > 0) {
            out.push({
                id: 'clip:section:recent',
                title: 'RECENT',
                sectionHeader: 'recent',
                accent: '#9ca3af',
                primaryAction: { label: '', handler: () => {} },
            });
        }
        for (const r of unpinned) out.push(toResult(r));
    }
    return out;
}
