// Phase 23 Day 2 — Klypix Search provider.
//
// THE MOAT. Searches across data Raycast literally cannot see:
//   1. Current canvas items (text/box/file/image/container labels)
//   2. Pinned chats (localStorage['pinned_chats'])
//   3. Recent chat memory events (localStorage['alt_space_memory_v1'])
//   4. Agent tools (the 22 main registry tools)
//
// Empty-state (no query): show recent canvas titles + pinned chat titles
// ordered by frecency boost.
//
// All sources fuzzy-filtered through Fuse with title weighted 2× over
// subtitle. Hits get a stable id like 'klypix:canvas-item:<itemId>' so
// frecency persists.

import type { PaletteProvider, PaletteResult, PaletteProviderContext } from './types';
import { Square, MessageSquare, FileText, Wrench, Pin } from 'lucide-react';
import React from 'react';
import { fuzzyFilter } from '../search';

// ── Data accessors ──────────────────────────────────────────────────

interface PinnedChat {
    id: string;
    title?: string;
    previewText?: string;
    messages?: Array<{ role: string; content: string }>;
    timestamp?: number;
}

function loadPinnedChats(): PinnedChat[] {
    try {
        const raw = localStorage.getItem('pinned_chats');
        if (!raw) return [];
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed : [];
    } catch { return []; }
}

interface MemoryEvent {
    timestamp?: number;
    app?: string;
    title?: string;
    query?: string;
    responsePreview?: string;
}

function loadMemoryEvents(): MemoryEvent[] {
    try {
        const raw = localStorage.getItem('alt_space_memory_v1');
        if (!raw) return [];
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed : [];
    } catch { return []; }
}

interface RecentCanvas {
    filePath?: string;
    title?: string;
    lastOpenedAt?: number;
}

function loadRecentCanvases(): RecentCanvas[] {
    // recentCanvasesStore writes to this key; we read it without coupling
    // to the canvas chunk (which is lazy-loaded). If the canvas was never
    // opened in this session the chunk hasn't even fetched yet, but the
    // localStorage entry from PRIOR sessions still works.
    try {
        const raw = localStorage.getItem('klypix:recentCanvases');
        if (!raw) return [];
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed : [];
    } catch { return []; }
}

// ── Current-canvas item search ──────────────────────────────────────
// Canvas state lives in a per-tab CanvasStoreProvider context. We can't
// useCanvasStore() inside a provider that isn't a React component, so we
// expose a setter the canvas chunk calls on mount to register a snapshot
// reader. Lazy + decoupled — no static import of the canvas tree.

interface CanvasSnapshot {
    items: Array<{ id: string; type: string; content?: string; title?: string }>;
}
let canvasReader: (() => CanvasSnapshot | null) | null = null;

export function registerCanvasReader(reader: (() => CanvasSnapshot | null) | null): void {
    canvasReader = reader;
}
// Expose on window so the lazy-loaded canvas chunk can register itself
// without importing this module (which would force the palette chunk to
// load when canvas does — defeating the lazy split).
if (typeof window !== 'undefined') {
    (window as any).klypixPaletteRegisterCanvas = registerCanvasReader;
}

function loadCanvasItems(): Array<{ id: string; type: string; label: string; sub: string }> {
    const snap = canvasReader?.();
    if (!snap) return [];
    const out: Array<{ id: string; type: string; label: string; sub: string }> = [];
    for (const it of snap.items) {
        const label = ((it.title || it.content || '') as string).trim();
        if (!label) continue;
        out.push({
            id: it.id,
            type: it.type,
            label: label.slice(0, 80),
            sub: it.type === 'container' ? 'Group' : it.type,
        });
    }
    return out;
}

// ── Agent tools ─────────────────────────────────────────────────────
// Hard-coded list matches what's in toolRegistry.ts. Keeping it here means
// the palette doesn't import the agent loop on chat-only sessions. If a
// tool name changes, this list goes stale — acceptable for v1 since the
// list is short and rarely churns.

const AGENT_TOOLS: Array<{ name: string; desc: string }> = [
    { name: 'capture_screenshot', desc: 'Take a screenshot of the user\'s screen' },
    { name: 'get_active_window', desc: 'Get info about the currently active window' },
    { name: 'read_active_file', desc: 'Read the file currently open in the foreground app' },
    { name: 'get_all_open_files', desc: 'List files open in any running app' },
    { name: 'read_file_by_title', desc: 'Read a file by matching a window title' },
    { name: 'read_file', desc: 'Read a file by absolute path' },
    { name: 'write_file', desc: 'Write a file at an absolute path' },
    { name: 'edit_file', desc: 'Edit a file in place' },
    { name: 'list_directory', desc: 'List directory contents' },
    { name: 'file_move', desc: 'Move or rename a file' },
    { name: 'file_delete', desc: 'Delete a file' },
    { name: 'run_shell', desc: 'Run a shell command' },
    { name: 'browser_navigate', desc: 'Open a URL in the user\'s browser' },
    { name: 'browser_click', desc: 'Click a browser element' },
    { name: 'browser_fill', desc: 'Fill a browser form field' },
    { name: 'read_web_content', desc: 'Read text content from a URL' },
    { name: 'system_open', desc: 'Open a file/app with the system default' },
    { name: 'system_type', desc: 'Type text into the focused field' },
    { name: 'clipboard_read', desc: 'Read the current clipboard contents' },
    { name: 'clipboard_write', desc: 'Write to the clipboard' },
    { name: 'ask_user', desc: 'Ask the user a question' },
    { name: 'generate_document', desc: 'Generate a DOCX / XLSX / PPTX / PDF document' },
];

// ── Mappers to PaletteResult ────────────────────────────────────────

function canvasItemResult(it: { id: string; type: string; label: string; sub: string }): PaletteResult {
    return {
        id: `klypix:canvas-item:${it.id}`,
        title: it.label,
        subtitle: `Canvas · ${it.sub}`,
        accent: '#10b981',
        icon: React.createElement(Square, { size: 14 }),
        primaryAction: {
            label: 'Focus item',
            handler: () => {
                // Dispatch a CustomEvent the canvas can listen for. Avoids
                // importing the canvas store here (keeps this provider
                // chunk small + lazy-canvas-compatible).
                window.dispatchEvent(new CustomEvent('klypix:palette-focus-item', { detail: { itemId: it.id } }));
            },
        },
        secondaryActions: [
            {
                label: 'Copy text',
                chord: 'Shift+Enter',
                handler: async () => {
                    try { await navigator.clipboard.writeText(it.label); } catch { /* swallow */ }
                },
            },
        ],
    };
}

function pinnedChatResult(c: PinnedChat): PaletteResult {
    const title = (c.title || c.previewText || 'Pinned chat').slice(0, 80);
    const sub = c.previewText ? c.previewText.slice(0, 120) : 'Pinned conversation';
    return {
        id: `klypix:pinned-chat:${c.id}`,
        title,
        subtitle: sub,
        accent: '#a855f7',
        icon: React.createElement(Pin, { size: 14 }),
        primaryAction: {
            label: 'Open chat',
            handler: () => {
                window.dispatchEvent(new CustomEvent('klypix:palette-open-pinned-chat', { detail: { id: c.id } }));
            },
        },
    };
}

function memoryEventResult(m: MemoryEvent, i: number): PaletteResult {
    const title = (m.query || m.responsePreview || 'Recent chat').slice(0, 80);
    const ageMin = m.timestamp ? Math.round((Date.now() - m.timestamp) / 60_000) : null;
    const sub = ageMin !== null ? `Chat · ${ageMin < 60 ? `${ageMin}m ago` : `${Math.round(ageMin / 60)}h ago`}` : 'Recent chat';
    return {
        id: `klypix:chat-memory:${m.timestamp ?? i}`,
        title,
        subtitle: sub,
        accent: '#3b82f6',
        icon: React.createElement(MessageSquare, { size: 14 }),
        primaryAction: {
            label: 'Resume',
            handler: () => {
                window.dispatchEvent(new CustomEvent('klypix:palette-resume-chat', { detail: { query: m.query } }));
            },
        },
    };
}

function recentCanvasResult(c: RecentCanvas, i: number): PaletteResult {
    const title = (c.title || c.filePath?.split(/[\\/]/).pop() || 'Untitled canvas').slice(0, 80);
    return {
        id: `klypix:recent-canvas:${c.filePath || i}`,
        title,
        subtitle: c.filePath ? `Canvas · ${c.filePath}` : 'Canvas',
        accent: '#f59e0b',
        icon: React.createElement(FileText, { size: 14 }),
        primaryAction: {
            label: 'Open canvas',
            handler: () => {
                if (c.filePath) {
                    window.dispatchEvent(new CustomEvent('klypix:palette-open-canvas', { detail: { filePath: c.filePath } }));
                }
            },
        },
    };
}

function agentToolResult(tool: { name: string; desc: string }): PaletteResult {
    return {
        id: `klypix:agent-tool:${tool.name}`,
        title: tool.name,
        subtitle: tool.desc,
        accent: '#06b6d4',
        icon: React.createElement(Wrench, { size: 14 }),
        primaryAction: {
            label: 'Prefill prompt',
            handler: () => {
                window.dispatchEvent(new CustomEvent('klypix:palette-prefill-tool', { detail: { tool: tool.name } }));
            },
        },
    };
}

// ── Provider ────────────────────────────────────────────────────────

export const klypixSearchProvider: PaletteProvider = {
    id: 'klypix',
    weight: 0.6,

    emptyState(): PaletteResult[] {
        const out: PaletteResult[] = [];
        // Surface 3 most-recent canvases + 3 most-recent pinned chats so the
        // open palette is immediately useful even with no query typed.
        const canvases = loadRecentCanvases()
            .sort((a, b) => (b.lastOpenedAt ?? 0) - (a.lastOpenedAt ?? 0))
            .slice(0, 3);
        for (let i = 0; i < canvases.length; i++) out.push(recentCanvasResult(canvases[i], i));
        const pinned = loadPinnedChats()
            .sort((a, b) => (b.timestamp ?? 0) - (a.timestamp ?? 0))
            .slice(0, 3);
        for (const p of pinned) out.push(pinnedChatResult(p));
        return out;
    },

    async query(input: string, _ctx: PaletteProviderContext): Promise<PaletteResult[]> {
        const q = input.trim();
        if (q.length === 0) return [];

        const candidates: PaletteResult[] = [];

        // Canvas items (current canvas only — registered reader)
        for (const it of loadCanvasItems()) candidates.push(canvasItemResult(it));

        // Pinned chats
        for (const c of loadPinnedChats()) candidates.push(pinnedChatResult(c));

        // Recent chat memory
        const mems = loadMemoryEvents();
        for (let i = 0; i < mems.length; i++) candidates.push(memoryEventResult(mems[i], i));

        // Recent canvases (only when query likely targets them; canvas titles
        // appear in canvas-item results above when canvas is open)
        for (let i = 0; i < loadRecentCanvases().length; i++) {
            candidates.push(recentCanvasResult(loadRecentCanvases()[i], i));
        }

        // Agent tools
        for (const t of AGENT_TOOLS) candidates.push(agentToolResult(t));

        // Fuse-rank the merged candidate list against the user's query.
        // Cap to 10 results so the palette stays scannable.
        return fuzzyFilter(candidates, q).slice(0, 10);
    },
};
