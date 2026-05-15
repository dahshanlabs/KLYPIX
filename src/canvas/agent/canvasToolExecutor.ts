import type { CanvasAction, CanvasState } from '../state/canvasStore';
import type { ApprovalItem, CanvasItem, ContainerItem, Connection, FileItem, ImageItem, TextItem } from '../items/types';
import { newId } from '../items/types';

/** Resolve the world-coord position for a newly-created agent card.
 *
 *  The LLM proposes (x, y) based on the scope snapshot it saw before
 *  running, but by the time the response lands the user may have cut
 *  + pasted the selection elsewhere — so the card would appear at the
 *  OLD world coords, far from where the user is now looking.
 *
 *  We override those proposed coords whenever they'd put the card off-
 *  screen or far from the live selection:
 *    - If selection exists: place to the right of its bbox.
 *    - Otherwise: place at the current viewport center.
 *
 *  The LLM's x/y is only honoured when it lands inside (or very near)
 *  the current viewport AND the scene doesn't have an obvious selection
 *  to anchor to — preserves the LLM's intent for agent-driven layouts
 *  without letting stale coords strand a response.
 */
function resolveAgentCardPosition(
    state: CanvasState,
    proposedX: number,
    proposedY: number,
    cardW: number,
    cardH: number,
): { x: number; y: number } {
    const z = Math.max(0.01, state.view.zoom);
    const vw = typeof window !== 'undefined' ? window.innerWidth : 1280;
    const vh = typeof window !== 'undefined' ? window.innerHeight : 720;
    const viewLeft = -state.view.panX / z;
    const viewTop = -state.view.panY / z;
    const viewRight = viewLeft + vw / z;
    const viewBottom = viewTop + vh / z;
    const viewCenterX = (viewLeft + viewRight) / 2;
    const viewCenterY = (viewTop + viewBottom) / 2;

    const selectedItems = state.selectedIds
        .map((id) => state.items[id])
        .filter(Boolean) as CanvasItem[];

    if (selectedItems.length > 0) {
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        for (const it of selectedItems) {
            if (it.x < minX) minX = it.x;
            if (it.y < minY) minY = it.y;
            if (it.x + it.w > maxX) maxX = it.x + it.w;
            if (it.y + it.h > maxY) maxY = it.y + it.h;
        }
        // To the right of the selection bbox, with a gap.
        const GAP = 24;
        return { x: maxX + GAP, y: minY };
    }

    // No selection: see if the LLM's proposed (x, y) is visible on screen.
    // If yes, trust it. If no, drop the card at viewport center.
    const margin = Math.max(cardW, cardH);
    const proposedInView =
        proposedX + cardW > viewLeft - margin
        && proposedX < viewRight + margin
        && proposedY + cardH > viewTop - margin
        && proposedY < viewBottom + margin;
    if (proposedInView && (proposedX !== 0 || proposedY !== 0)) {
        return { x: proposedX, y: proposedY };
    }
    return { x: viewCenterX - cardW / 2, y: viewCenterY - cardH / 2 };
}
import { base64ToBytes, getAsset, registerAsset, mimeFromExtension } from '../file/assetRegistry';
import { waitForApproval } from './approvalRegistry';
import { defaultTextColorFor, getCurrentGridSettings } from '../gridSettings';
import { compileToDOCX, compileToPPTX, compileToPdfMarkdown, compileToZip } from './canvasCompiler';
import * as XLSX from 'xlsx';

// Executes a single canvas tool call. Returns a short string (JSON or plain)
// that goes back to Gemini as the function result. Callers hand in:
//   - state getter (captures latest after each mutation so reads see writes)
//   - dispatch     (plain dispatch, no undo snapshot per tool — caller pushes
//                   ONE snapshot at run start for the whole multi-step op)
//   - onToast      (for canvas_create_toast — displayed by the UI layer)
//
// Every write returns a JSON blob describing the created/modified id so the
// model can reference it in later tool calls.

export interface ToolExecContext {
    getState: () => CanvasState;
    dispatch: (action: CanvasAction) => void;
    onToast: (text: string) => void;
}

export interface ToolCall {
    name: string;
    args: Record<string, any>;
}

export interface ToolResult {
    name: string;
    result: string;
    /** If true, the agent loop should stop after handling this call. */
    done?: boolean;
    /** Optional final message from canvas_done. */
    doneMessage?: string;
}

// Simple SVG chart renderer — no external deps. Bar / line / pie only.
function renderChartSvg(type: 'bar' | 'line' | 'pie', title: string, labels: string[], values: number[]): string {
    const W = 480, H = 300, PAD = 36;
    const max = Math.max(1, ...values);
    const COLORS = ['#10b981', '#3b82f6', '#f5a623', '#ef4444', '#a855f7', '#2dd4a0', '#e8e8ed', '#6b6b80'];
    const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');

    let body = '';
    if (type === 'bar') {
        const bw = (W - PAD * 2) / Math.max(1, values.length);
        values.forEach((v, i) => {
            const h = ((H - PAD * 2) * v) / max;
            const x = PAD + i * bw + 4;
            const y = H - PAD - h;
            body += `<rect x="${x}" y="${y}" width="${bw - 8}" height="${h}" fill="${COLORS[i % COLORS.length]}" rx="3"/>`;
            body += `<text x="${x + (bw - 8) / 2}" y="${H - PAD + 14}" font-size="10" fill="#8a8a9a" text-anchor="middle" font-family="system-ui">${esc((labels[i] || '').slice(0, 10))}</text>`;
        });
    } else if (type === 'line') {
        const step = (W - PAD * 2) / Math.max(1, values.length - 1);
        const pts = values.map((v, i) => `${PAD + i * step},${H - PAD - ((H - PAD * 2) * v) / max}`).join(' ');
        body += `<polyline points="${pts}" fill="none" stroke="#10b981" stroke-width="2"/>`;
        values.forEach((v, i) => {
            const x = PAD + i * step;
            const y = H - PAD - ((H - PAD * 2) * v) / max;
            body += `<circle cx="${x}" cy="${y}" r="3" fill="#10b981"/>`;
            body += `<text x="${x}" y="${H - PAD + 14}" font-size="10" fill="#8a8a9a" text-anchor="middle" font-family="system-ui">${esc((labels[i] || '').slice(0, 8))}</text>`;
        });
    } else {
        const total = values.reduce((a, b) => a + b, 0) || 1;
        const cx = W / 2, cy = H / 2 + 8, r = Math.min(W, H) / 3;
        let angle = -Math.PI / 2;
        values.forEach((v, i) => {
            const slice = (v / total) * Math.PI * 2;
            const x1 = cx + r * Math.cos(angle), y1 = cy + r * Math.sin(angle);
            angle += slice;
            const x2 = cx + r * Math.cos(angle), y2 = cy + r * Math.sin(angle);
            const large = slice > Math.PI ? 1 : 0;
            body += `<path d="M ${cx} ${cy} L ${x1} ${y1} A ${r} ${r} 0 ${large} 1 ${x2} ${y2} Z" fill="${COLORS[i % COLORS.length]}" opacity="0.85"/>`;
        });
        labels.forEach((lbl, i) => {
            body += `<rect x="${PAD}" y="${PAD + i * 14}" width="10" height="10" fill="${COLORS[i % COLORS.length]}"/>`;
            body += `<text x="${PAD + 14}" y="${PAD + i * 14 + 9}" font-size="10" fill="#cfcfd8" font-family="system-ui">${esc(lbl)}</text>`;
        });
    }

    return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
        <rect width="${W}" height="${H}" fill="#12121a" rx="10"/>
        <text x="${W / 2}" y="22" font-size="13" fill="#e8e8ed" text-anchor="middle" font-family="system-ui" font-weight="600">${esc(title)}</text>
        ${body}
    </svg>`;
}

function summarizeItem(it: CanvasItem): Record<string, any> {
    const base = { id: it.id, type: it.type, x: it.x, y: it.y, w: it.w, h: it.h };
    switch (it.type) {
        case 'text':
            return {
                ...base,
                content_preview: it.content.length > 80 ? it.content.slice(0, 80) + '…' : it.content,
                is_card: it.border,
                by: it.createdBy,
            };
        case 'box':
            return { ...base, color: it.borderColor };
        case 'image':
            return { ...base, file: it.fileName, size: `${it.originalWidth}x${it.originalHeight}` };
        case 'file':
            return { ...base, file: it.fileName, ext: it.extension, bytes: it.fileSize };
        case 'container':
            return { ...base, title: it.title, scope_locked: it.scopeLocked, collapsed: it.collapsed };
        case 'approval':
            return {
                ...base,
                question: it.question,
                options: it.options,
                status: it.decision === null ? 'pending' : 'resolved',
                decision: it.decision,
            };
        case 'link':
            return {
                ...base,
                url: it.url,
                site: it.siteName,
                title: it.title,
            };
        case 'canvas-link':
            return {
                ...base,
                canvas_path: it.filePath,
                title: it.title,
            };
        case 'video':
            return {
                ...base,
                file: it.fileName,
                ext: it.extension,
                bytes: it.fileSize,
                duration_sec: it.durationSec,
            };
        case 'audio':
            return {
                ...base,
                file: it.fileName,
                ext: it.extension,
                bytes: it.fileSize,
                duration_sec: it.durationSec,
            };
        case 'code':
            return {
                ...base,
                language: it.language,
                file: it.fileName,
                code_preview: it.code.length > 120 ? it.code.slice(0, 120) + '…' : it.code,
                lines: it.code.split('\n').length,
            };
    }
}

// Cap extracted text so a huge PDF doesn't blow the model context. The agent
// can request a second read with a page_range later if we add one.
const MAX_EXTRACT_CHARS = 40_000;

const TEXT_EXTENSIONS = new Set([
    'txt', 'md', 'markdown', 'csv', 'tsv', 'json', 'jsonl', 'yaml', 'yml', 'xml',
    'html', 'htm', 'css', 'scss', 'less', 'js', 'jsx', 'ts', 'tsx', 'mjs', 'cjs',
    'py', 'rb', 'go', 'rs', 'java', 'c', 'cpp', 'h', 'hpp', 'cs', 'php', 'sh',
    'bash', 'zsh', 'ps1', 'bat', 'ini', 'toml', 'env', 'log', 'sql', 'graphql',
]);

function truncate(s: string): { text: string; truncated: boolean } {
    if (s.length <= MAX_EXTRACT_CHARS) return { text: s, truncated: false };
    return { text: s.slice(0, MAX_EXTRACT_CHARS), truncated: true };
}

async function extractDocxText(bytes: Uint8Array): Promise<string> {
    // @ts-ignore — no types for mammoth/mammoth.browser.min.js
    const mammoth: any = await import('mammoth/mammoth.browser.min.js');
    // mammoth consumes the buffer; pass a copy so the registry bytes stay intact.
    const result = await mammoth.extractRawText({ arrayBuffer: bytes.slice().buffer });
    return result?.value || '';
}

async function extractPdfText(bytes: Uint8Array): Promise<string> {
    const pdfjs: any = await import('pdfjs-dist');
    // @ts-ignore — Vite ?url import
    const workerUrl = (await import('pdfjs-dist/build/pdf.worker.min.js?url')).default;
    pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;
    // pdfjs mutates the input; pass a copy so the registry's canonical bytes stay intact.
    const doc = await pdfjs.getDocument({ data: bytes.slice() }).promise;
    const parts: string[] = [];
    for (let i = 1; i <= doc.numPages; i++) {
        const page = await doc.getPage(i);
        const content = await page.getTextContent();
        const pageText = (content.items || []).map((it: any) => it.str || '').join(' ');
        parts.push(pageText);
        // Early exit when we've got enough — don't parse a 500-page PDF for 40K chars.
        if (parts.join('\n\n').length > MAX_EXTRACT_CHARS) break;
    }
    return parts.join('\n\n');
}

function extractSpreadsheetText(bytes: Uint8Array): string {
    const wb = XLSX.read(bytes, { type: 'array' });
    const sections: string[] = [];
    for (const name of wb.SheetNames) {
        const sheet = wb.Sheets[name];
        const csv = XLSX.utils.sheet_to_csv(sheet);
        sections.push(`# Sheet: ${name}\n${csv}`);
        if (sections.join('\n\n').length > MAX_EXTRACT_CHARS) break;
    }
    return sections.join('\n\n');
}

export async function executeToolCall(call: ToolCall, ctx: ToolExecContext): Promise<ToolResult> {
    const s = ctx.getState();
    switch (call.name) {
        case 'canvas_get_items': {
            const items = s.order.map(id => s.items[id]).filter(Boolean) as CanvasItem[];
            return { name: call.name, result: JSON.stringify(items.map(summarizeItem)) };
        }

        case 'canvas_read_item': {
            const item = s.items[call.args.item_id];
            if (!item) return { name: call.name, result: JSON.stringify({ error: 'not_found' }) };
            if (item.type === 'text') {
                return { name: call.name, result: JSON.stringify({ id: item.id, type: 'text', content: item.content }) };
            }
            if (item.type === 'file') {
                return { name: call.name, result: JSON.stringify({ id: item.id, type: 'file', file: item.fileName, ext: item.extension, bytes: item.fileSize }) };
            }
            if (item.type === 'image') {
                return { name: call.name, result: JSON.stringify({ id: item.id, type: 'image', file: item.fileName }) };
            }
            if (item.type === 'video' || item.type === 'audio') {
                return { name: call.name, result: JSON.stringify({ id: item.id, type: item.type, file: item.fileName, bytes: item.fileSize, durationSec: item.durationSec }) };
            }
            if (item.type === 'code') {
                return { name: call.name, result: JSON.stringify({ id: item.id, type: 'code', language: item.language, code: item.code.slice(0, 40_000) }) };
            }
            return { name: call.name, result: JSON.stringify({ id: item.id, type: item.type }) };
        }

        case 'canvas_search': {
            const q = String(call.args.query || '').toLowerCase();
            if (!q) return { name: call.name, result: JSON.stringify([]) };
            const hits: Array<{ id: string; snippet: string }> = [];
            for (const id of s.order) {
                const it = s.items[id];
                if (!it || it.type !== 'text') continue;
                const idx = it.content.toLowerCase().indexOf(q);
                if (idx >= 0) {
                    const start = Math.max(0, idx - 20);
                    const end = Math.min(it.content.length, idx + q.length + 40);
                    hits.push({ id, snippet: it.content.slice(start, end) });
                }
            }
            return { name: call.name, result: JSON.stringify(hits) };
        }

        case 'canvas_create_text': {
            const textW = 260, textH = 28;
            const pos = resolveAgentCardPosition(s, Number(call.args.x) || 0, Number(call.args.y) || 0, textW, textH);
            const item: TextItem = {
                id: newId('agent'),
                type: 'text',
                x: pos.x,
                y: pos.y,
                w: textW,
                h: textH,
                zIndex: s.order.length,
                locked: false,
                parentId: null,
                createdAt: Date.now(),
                createdBy: 'agent',
                content: String(call.args.content || ''),
                fontSize: call.args.heading ? 20 : 14,
                color: defaultTextColorFor(getCurrentGridSettings().background),
                border: false,
                borderColor: 'rgba(16,185,129,0.5)',
                heading: !!call.args.heading,
            };
            ctx.dispatch({ type: 'ADD_ITEM', item });
            return { name: call.name, result: JSON.stringify({ id: item.id, ok: true }) };
        }

        case 'canvas_create_card': {
            const cardW = 420, cardH = 140;
            const pos = resolveAgentCardPosition(s, Number(call.args.x) || 0, Number(call.args.y) || 0, cardW, cardH);
            const item: TextItem = {
                id: newId('agent'),
                type: 'text',
                x: pos.x,
                y: pos.y,
                w: cardW,
                h: cardH,
                zIndex: s.order.length,
                locked: false,
                parentId: null,
                createdAt: Date.now(),
                createdBy: 'agent',
                content: `${String(call.args.title || '').toUpperCase()}\n\n${String(call.args.body || '')}`,
                fontSize: 13,
                color: defaultTextColorFor(getCurrentGridSettings().background),
                border: true,
                borderColor: 'rgba(16,185,129,0.5)',
                heading: false,
            };
            ctx.dispatch({ type: 'ADD_ITEM', item });
            return { name: call.name, result: JSON.stringify({ id: item.id, ok: true }) };
        }

        case 'canvas_connect_items': {
            const from_id = String(call.args.from_id || '');
            const to_id = String(call.args.to_id || '');
            if (!s.items[from_id] || !s.items[to_id]) {
                return { name: call.name, result: JSON.stringify({ error: 'item_not_found' }) };
            }
            const conn: Connection = {
                id: newId('conn'),
                fromId: from_id,
                toId: to_id,
                label: String(call.args.label || ''),
                color: '#10b981',
                width: 2,
                arrowHead: true,
                style: 'solid',
                createdBy: 'agent',
            };
            ctx.dispatch({ type: 'ADD_CONNECTION', connection: conn });
            return { name: call.name, result: JSON.stringify({ id: conn.id, ok: true }) };
        }

        case 'canvas_update_item': {
            const id = String(call.args.item_id || '');
            if (!s.items[id]) return { name: call.name, result: JSON.stringify({ error: 'not_found' }) };
            const patch: Record<string, any> = {};
            if (typeof call.args.content === 'string' && s.items[id].type === 'text') patch.content = call.args.content;
            if (typeof call.args.x === 'number') patch.x = call.args.x;
            if (typeof call.args.y === 'number') patch.y = call.args.y;
            ctx.dispatch({ type: 'UPDATE_ITEM', id, patch });
            return { name: call.name, result: JSON.stringify({ id, ok: true }) };
        }

        case 'canvas_delete_item': {
            const id = String(call.args.item_id || '');
            if (!s.items[id]) return { name: call.name, result: JSON.stringify({ error: 'not_found' }) };
            ctx.dispatch({ type: 'DELETE_ITEMS', ids: [id] });
            return { name: call.name, result: JSON.stringify({ id, ok: true }) };
        }

        case 'canvas_add_border': {
            const id = String(call.args.item_id || '');
            const it = s.items[id];
            if (!it || it.type !== 'text') return { name: call.name, result: JSON.stringify({ error: 'not_a_text_item' }) };
            ctx.dispatch({ type: 'UPDATE_ITEM', id, patch: { border: !!call.args.border } });
            return { name: call.name, result: JSON.stringify({ id, ok: true }) };
        }

        case 'canvas_create_toast': {
            const msg = String(call.args.message || '');
            ctx.onToast(msg);
            return { name: call.name, result: JSON.stringify({ ok: true }) };
        }

        case 'canvas_get_connections': {
            const list = Object.values(s.connections).map(c => ({
                id: c.id, from: c.fromId, to: c.toId, label: c.label, by: c.createdBy,
            }));
            return { name: call.name, result: JSON.stringify(list) };
        }

        case 'canvas_read_file': {
            const id = String(call.args.item_id || '');
            const it = s.items[id];
            if (!it || it.type !== 'file') {
                return { name: call.name, result: JSON.stringify({ error: 'not_a_file_item' }) };
            }
            const asset = it.assetId ? getAsset(it.assetId) : undefined;
            const baseMeta = { id: it.id, file: it.fileName, ext: it.extension, bytes: it.fileSize };
            if (!asset) {
                // Legacy file items saved before assets/ migration, or a drop
                // where byte capture failed. No content to extract.
                return { name: call.name, result: JSON.stringify({ ...baseMeta, error: 'bytes_unavailable' }) };
            }
            const ext = (it.extension || '').toLowerCase();
            try {
                let raw = '';
                if (ext === 'pdf') {
                    raw = await extractPdfText(asset.bytes);
                } else if (ext === 'docx') {
                    raw = await extractDocxText(asset.bytes);
                } else if (ext === 'xlsx' || ext === 'xls' || ext === 'csv' || ext === 'tsv') {
                    raw = extractSpreadsheetText(asset.bytes);
                } else if (TEXT_EXTENSIONS.has(ext)) {
                    raw = new TextDecoder('utf-8', { fatal: false }).decode(asset.bytes);
                } else {
                    return { name: call.name, result: JSON.stringify({ ...baseMeta, error: 'unsupported_format' }) };
                }
                const { text, truncated } = truncate(raw);
                return {
                    name: call.name,
                    result: JSON.stringify({ ...baseMeta, content: text, truncated, total_chars: raw.length }),
                };
            } catch (err: any) {
                return {
                    name: call.name,
                    result: JSON.stringify({ ...baseMeta, error: 'extract_failed', message: err?.message || String(err) }),
                };
            }
        }

        case 'canvas_arrange_items': {
            const ids: string[] = Array.isArray(call.args.item_ids) ? call.args.item_ids : [];
            const layout = String(call.args.layout || 'grid');
            const ox = Number(call.args.origin_x) || 0;
            const oy = Number(call.args.origin_y) || 0;
            const gap = Number(call.args.gap) || 24;
            const found = ids.map(id => s.items[id]).filter(Boolean) as CanvasItem[];
            if (found.length === 0) return { name: call.name, result: JSON.stringify({ error: 'no_valid_items' }) };
            if (layout === 'horizontal') {
                let x = ox;
                for (const it of found) {
                    ctx.dispatch({ type: 'UPDATE_ITEM', id: it.id, patch: { x, y: oy } });
                    x += it.w + gap;
                }
            } else if (layout === 'vertical') {
                let y = oy;
                for (const it of found) {
                    ctx.dispatch({ type: 'UPDATE_ITEM', id: it.id, patch: { x: ox, y } });
                    y += it.h + gap;
                }
            } else {
                // grid: pack into rows that fit ~1200px wide.
                const MAX_W = 1200;
                let x = ox, y = oy, rowH = 0;
                for (const it of found) {
                    if (x - ox + it.w > MAX_W && x > ox) {
                        x = ox;
                        y += rowH + gap;
                        rowH = 0;
                    }
                    ctx.dispatch({ type: 'UPDATE_ITEM', id: it.id, patch: { x, y } });
                    x += it.w + gap;
                    if (it.h > rowH) rowH = it.h;
                }
            }
            return { name: call.name, result: JSON.stringify({ ok: true, arranged: found.length, layout }) };
        }

        case 'canvas_create_container': {
            const c: ContainerItem = {
                id: newId('ctn'),
                type: 'container',
                x: Number(call.args.x) || 0,
                y: Number(call.args.y) || 0,
                w: Math.max(200, Number(call.args.w) || 320),
                h: Math.max(120, Number(call.args.h) || 200),
                zIndex: s.order.length,
                locked: false,
                parentId: null,
                createdAt: Date.now(),
                createdBy: 'agent',
                title: String(call.args.title || 'Group'),
                collapsed: false,
                scopeLocked: false,
                borderColor: 'rgba(16,185,129,0.35)',
            };
            ctx.dispatch({ type: 'ADD_ITEM', item: c });
            return { name: call.name, result: JSON.stringify({ id: c.id, ok: true }) };
        }

        case 'canvas_group_into_container': {
            const ids: string[] = Array.isArray(call.args.item_ids) ? call.args.item_ids : [];
            const title = String(call.args.title || 'Group');
            const children = ids.map(id => s.items[id]).filter(Boolean) as CanvasItem[];
            if (children.length === 0) return { name: call.name, result: JSON.stringify({ error: 'no_valid_items' }) };
            let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
            for (const it of children) {
                if (it.x < minX) minX = it.x;
                if (it.y < minY) minY = it.y;
                if (it.x + it.w > maxX) maxX = it.x + it.w;
                if (it.y + it.h > maxY) maxY = it.y + it.h;
            }
            const PAD = 24;
            const container: ContainerItem = {
                id: newId('ctn'),
                type: 'container',
                x: minX - PAD,
                y: minY - PAD - 28, // account for title bar
                w: (maxX - minX) + PAD * 2,
                h: (maxY - minY) + PAD * 2 + 28,
                zIndex: s.order.length,
                locked: false,
                parentId: null,
                createdAt: Date.now(),
                createdBy: 'agent',
                title,
                collapsed: false,
                scopeLocked: false,
                borderColor: 'rgba(16,185,129,0.35)',
            };
            ctx.dispatch({ type: 'ADD_ITEM', item: container });
            // Reparent each child; clear stale authoredInParent so the new
            // container's scale-effect re-seeds from the child's current
            // state (vector-scale baseline reset).
            for (const it of children) {
                ctx.dispatch({
                    type: 'UPDATE_ITEM',
                    id: it.id,
                    patch: { parentId: container.id, authoredInParent: undefined } as Partial<CanvasItem>,
                });
            }
            return { name: call.name, result: JSON.stringify({ id: container.id, ok: true, children: ids.length }) };
        }

        case 'canvas_pin_chart': {
            const type = String(call.args.chart_type || 'bar') as 'bar' | 'line' | 'pie';
            const labels = (Array.isArray(call.args.labels) ? call.args.labels : []).map(String);
            const values = (Array.isArray(call.args.values) ? call.args.values : []).map((v: any) => Number(v) || 0);
            const svg = renderChartSvg(type, String(call.args.title || 'Chart'), labels, values);
            const dataUrl = `data:image/svg+xml;base64,${btoa(svg)}`;
            const img: ImageItem = {
                id: newId('chart'),
                type: 'image',
                x: Number(call.args.x) || 0,
                y: Number(call.args.y) || 0,
                w: 480,
                h: 300,
                zIndex: s.order.length,
                locked: false,
                parentId: null,
                createdAt: Date.now(),
                createdBy: 'agent',
                src: dataUrl,
                originalWidth: 480,
                originalHeight: 300,
                fileName: `${call.args.title || 'chart'}.svg`,
            };
            ctx.dispatch({ type: 'ADD_ITEM', item: img });
            return { name: call.name, result: JSON.stringify({ id: img.id, ok: true }) };
        }

        case 'canvas_set_tags': {
            const id = String(call.args.item_id || '');
            if (!s.items[id]) return { name: call.name, result: JSON.stringify({ error: 'not_found' }) };
            const tags = Array.isArray(call.args.tags) ? call.args.tags.map(String) : [];
            ctx.dispatch({ type: 'UPDATE_ITEM', id, patch: { tags } as any });
            return { name: call.name, result: JSON.stringify({ ok: true, tags }) };
        }

        case 'canvas_set_status': {
            const id = String(call.args.item_id || '');
            if (!s.items[id]) return { name: call.name, result: JSON.stringify({ error: 'not_found' }) };
            const status = String(call.args.status || 'none');
            const allowed = ['none', 'todo', 'in_progress', 'in_review', 'done', 'blocked', 'waiting'];
            if (!allowed.includes(status)) return { name: call.name, result: JSON.stringify({ error: 'invalid_status' }) };
            ctx.dispatch({ type: 'UPDATE_ITEM', id, patch: { status } as any });
            return { name: call.name, result: JSON.stringify({ ok: true }) };
        }

        case 'canvas_set_relationship': {
            const cid = String(call.args.connection_id || '');
            const c = s.connections[cid];
            if (!c) return { name: call.name, result: JSON.stringify({ error: 'not_found' }) };
            const rel = String(call.args.relationship || '');
            const allowed = ['leads_to', 'depends_on', 'relates_to', 'conflicts_with', 'supports', 'questions', 'costs', 'blocks'];
            if (!allowed.includes(rel)) return { name: call.name, result: JSON.stringify({ error: 'invalid_relationship' }) };
            const relColor: Record<string, string> = {
                leads_to: '#10b981', depends_on: '#3b82f6', relates_to: '#6b6b80',
                conflicts_with: '#ef4444', supports: '#2dd4a0', questions: '#a855f7',
                costs: '#f5a623', blocks: '#ef4444',
            };
            const relStyle: Record<string, 'solid' | 'dashed'> = {
                depends_on: 'dashed', questions: 'dashed', blocks: 'solid',
                leads_to: 'solid', relates_to: 'solid', conflicts_with: 'solid',
                supports: 'solid', costs: 'solid',
            };
            // Re-add the connection with patched fields (no UPDATE_CONNECTION action).
            ctx.dispatch({ type: 'ADD_CONNECTION', connection: {
                ...c,
                relationship: rel as any,
                color: relColor[rel] || c.color,
                style: relStyle[rel] || c.style,
            } });
            return { name: call.name, result: JSON.stringify({ ok: true }) };
        }

        case 'canvas_run_code': {
            const api: any = (window as any).electron?.sandbox;
            if (!api?.execute) {
                return { name: call.name, result: JSON.stringify({ error: 'sandbox_unavailable' }) };
            }
            const lang = String(call.args.language || 'python').toLowerCase();
            const code = String(call.args.code || '');
            const x = Number(call.args.x) || 0;
            const y = Number(call.args.y) || 0;
            const title = String(call.args.title || '').trim() || `Run (${lang})`;
            if (!code) return { name: call.name, result: JSON.stringify({ error: 'no_code' }) };
            // Run via the sandbox's execute IPC. Each language runs in a shell;
            // the sandbox itself decides where to stage the script.
            const runRes = await api.execute({ command: buildRunCommand(lang, code), timeout_ms: 30_000 });
            const stdout = String(runRes?.stdout || '');
            const stderr = String(runRes?.stderr || '');
            const exitCode = Number(runRes?.exitCode ?? 1);
            const sandboxCwd = runRes?.cwd || 'data';
            // Build the output card content: a fenced source block + a fenced
            // output block. The text item renders plain so no real fences are
            // interpreted; we just make it readable.
            const ok = exitCode === 0;
            const outBlock = ok
                ? (stdout.trim() || '(no stdout)')
                : `exit ${exitCode}\n${stderr.trim() || stdout.trim() || '(no output)'}`;
            const content = [
                title,
                '',
                `--- ${lang} ---`,
                code.trim(),
                '',
                ok ? '--- stdout ---' : '--- stderr ---',
                outBlock,
            ].join('\n');
            const card: TextItem = {
                id: newId('run'),
                type: 'text',
                x, y, w: 520, h: 320, zIndex: s.order.length, locked: false, parentId: null,
                createdAt: Date.now(), createdBy: 'agent',
                content,
                fontSize: 13,
                color: ok ? defaultTextColorFor(getCurrentGridSettings().background) : '#fca5a5',
                border: true,
                borderColor: ok ? 'rgba(16,185,129,0.4)' : 'rgba(239,68,68,0.4)',
                heading: false,
                tags: ['agent', lang],
            };
            ctx.dispatch({ type: 'ADD_ITEM', item: card });
            return {
                name: call.name,
                result: JSON.stringify({
                    ok,
                    item_id: card.id,
                    exit_code: exitCode,
                    stdout_chars: stdout.length,
                    stderr_chars: stderr.length,
                    sandbox_cwd: sandboxCwd,
                }),
            };
        }

        case 'canvas_pin_file': {
            const api: any = (window as any).electron?.canvas;
            if (!api?.readSandboxFileBytes) {
                return { name: call.name, result: JSON.stringify({ error: 'sandbox_bridge_unavailable' }) };
            }
            const sandboxPath = String(call.args.sandbox_path || '');
            const x = Number(call.args.x) || 0;
            const y = Number(call.args.y) || 0;
            if (!sandboxPath) return { name: call.name, result: JSON.stringify({ error: 'no_sandbox_path' }) };
            const res = await api.readSandboxFileBytes(sandboxPath);
            if (!res?.ok) return { name: call.name, result: JSON.stringify({ error: 'read_failed', message: res?.error }) };
            const fileName = res.fileName || sandboxPath.split('/').pop() || 'pinned';
            const ext = (fileName.split('.').pop() || '').toLowerCase();
            const bytes = base64ToBytes(res.base64);
            const asset = registerAsset({
                mime: mimeFromExtension(ext),
                extension: ext || 'bin',
                bytes,
                fileName,
            });
            const item: FileItem = {
                id: newId('file'),
                type: 'file',
                x, y, w: 280, h: 84, zIndex: s.order.length, locked: false, parentId: null,
                createdAt: Date.now(), createdBy: 'agent',
                fileName, fileSize: bytes.length,
                extension: ext || 'file',
                mimeType: mimeFromExtension(ext),
                assetId: asset.id,
                tags: ['agent'],
            };
            ctx.dispatch({ type: 'ADD_ITEM', item });
            return { name: call.name, result: JSON.stringify({ ok: true, item_id: item.id, size_bytes: bytes.length }) };
        }

        case 'canvas_pin_image': {
            const api: any = (window as any).electron?.canvas;
            if (!api?.readSandboxFileBytes) {
                return { name: call.name, result: JSON.stringify({ error: 'sandbox_bridge_unavailable' }) };
            }
            const sandboxPath = String(call.args.sandbox_path || '');
            const x = Number(call.args.x) || 0;
            const y = Number(call.args.y) || 0;
            if (!sandboxPath) return { name: call.name, result: JSON.stringify({ error: 'no_sandbox_path' }) };
            const res = await api.readSandboxFileBytes(sandboxPath);
            if (!res?.ok) return { name: call.name, result: JSON.stringify({ error: 'read_failed', message: res?.error }) };
            const fileName = res.fileName || sandboxPath.split('/').pop() || 'image.png';
            const ext = (fileName.split('.').pop() || '').toLowerCase();
            if (!['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg'].includes(ext)) {
                return { name: call.name, result: JSON.stringify({ error: 'not_an_image', extension: ext }) };
            }
            const bytes = base64ToBytes(res.base64);
            const asset = registerAsset({
                mime: mimeFromExtension(ext),
                extension: ext,
                bytes,
                fileName,
            });
            // Measure natural dimensions by loading the blob URL in an Image element.
            const dims = await measureImage(asset.blobUrl);
            // Same headroom rule as drop/paste: cap default display at
            // min(520, native/2) so users can scale up 2× without
            // exceeding native resolution and getting bitmap blur.
            const MAX_DEFAULT_W = 520;
            const capW = Math.min(MAX_DEFAULT_W, Math.max(40, dims.w / 2));
            const scale = dims.w > capW ? capW / dims.w : 1;
            const item: ImageItem = {
                id: newId('img'),
                type: 'image',
                x, y,
                w: Math.round(dims.w * scale), h: Math.round(dims.h * scale),
                zIndex: s.order.length, locked: false, parentId: null,
                createdAt: Date.now(), createdBy: 'agent',
                src: '',
                assetId: asset.id,
                originalWidth: dims.w,
                originalHeight: dims.h,
                fileName,
                tags: ['agent'],
            };
            ctx.dispatch({ type: 'ADD_ITEM', item });
            return { name: call.name, result: JSON.stringify({ ok: true, item_id: item.id, w: item.w, h: item.h }) };
        }

        case 'canvas_create_approval': {
            const question = String(call.args.question || '').trim();
            if (!question) return { name: call.name, result: JSON.stringify({ error: 'no_question' }) };
            const details = String(call.args.details || '').trim() || undefined;
            const rawOptions = Array.isArray(call.args.options) ? call.args.options : [];
            const options = rawOptions
                .map((o: any) => String(o || '').trim())
                .filter(Boolean)
                .slice(0, 4);
            const opts = options.length >= 2 ? options : ['Approve', 'Deny'];
            const x = Number(call.args.x) || 0;
            const y = Number(call.args.y) || 0;
            const timeoutSec = Math.max(15, Math.min(900, Number(call.args.timeout_seconds) || 180));

            // Size the card to fit details if provided; otherwise compact.
            const hasDetails = !!details;
            const item: ApprovalItem = {
                id: newId('apr'),
                type: 'approval',
                x, y,
                w: 360, h: hasDetails ? 220 : 140,
                zIndex: s.order.length, locked: false, parentId: null,
                createdAt: Date.now(), createdBy: 'agent',
                question,
                details,
                options: opts,
                decision: null,
                tags: ['agent', 'approval'],
            };
            ctx.dispatch({ type: 'ADD_ITEM', item });
            // Block until the user clicks a button (or timeout). The item's
            // UPDATE_ITEM patch is dispatched from the button handler, so by
            // the time this resolves, state already reflects the decision.
            const decision = await waitForApproval(item.id, {
                timeoutMs: timeoutSec * 1000,
                timeoutValue: '__timeout__',
            });
            const timedOut = decision === '__timeout__';
            const cancelled = decision === '__cancelled__';
            return {
                name: call.name,
                result: JSON.stringify({
                    item_id: item.id,
                    decision: timedOut || cancelled ? null : decision,
                    status: timedOut ? 'timeout' : cancelled ? 'cancelled' : 'resolved',
                }),
            };
        }

        case 'canvas_organize': {
            const by = String(call.args.by || 'type').toLowerCase();
            const ox = Number(call.args.origin_x) || 0;
            const oy = Number(call.args.origin_y) || 0;
            const rawIds: string[] | null = Array.isArray(call.args.item_ids) && call.args.item_ids.length > 0
                ? call.args.item_ids.map((x: any) => String(x))
                : null;
            const pool = (rawIds || s.order)
                .map(id => s.items[id])
                .filter(Boolean)
                .filter(it => !!it && it.type !== 'container' && it.type !== 'approval') as CanvasItem[];
            if (pool.length === 0) return { name: call.name, result: JSON.stringify({ error: 'no_items' }) };

            // Bucket key per item.
            const bucketKey = (it: CanvasItem): string => {
                if (by === 'type') return it.type;
                if (by === 'status') return (it.status && it.status !== 'none') ? it.status : 'unstatused';
                if (by === 'date') {
                    const d = new Date(it.createdAt);
                    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
                }
                if (by === 'tag') {
                    return (it.tags && it.tags[0]) || 'untagged';
                }
                if (by === 'connection') {
                    // Degree bucket: hubs (3+), connected (1-2), orphans (0)
                    let deg = 0;
                    for (const c of Object.values(s.connections)) {
                        if (c.fromId === it.id || c.toId === it.id) deg++;
                    }
                    if (deg >= 3) return 'hubs';
                    if (deg >= 1) return 'connected';
                    return 'orphans';
                }
                return 'all';
            };

            const buckets = new Map<string, CanvasItem[]>();
            for (const it of pool) {
                const k = bucketKey(it);
                (buckets.get(k) || buckets.set(k, []).get(k)!).push(it);
            }

            // Lay out buckets in a row of containers. Each container has a
            // grid of its items inside.
            const CONTAINER_GAP = 80;
            const CONTAINER_PAD = 24;
            const TITLE_BAR = 28;
            const GRID_W = 880;
            const ITEM_GAP = 24;

            let cursorX = ox;
            const createdContainerIds: string[] = [];
            const movedItemCount = { count: 0 };

            // Stable bucket order: by size desc.
            const bucketEntries = Array.from(buckets.entries()).sort((a, b) => b[1].length - a[1].length);

            for (const [label, items] of bucketEntries) {
                // Lay items in a grid to measure container bounds.
                let lx = 0, ly = 0, rowH = 0, maxX = 0, maxY = 0;
                const placements: Array<{ id: string; x: number; y: number }> = [];
                for (const it of items) {
                    if (lx + it.w > GRID_W && lx > 0) {
                        lx = 0;
                        ly += rowH + ITEM_GAP;
                        rowH = 0;
                    }
                    placements.push({ id: it.id, x: lx, y: ly });
                    lx += it.w + ITEM_GAP;
                    if (it.h > rowH) rowH = it.h;
                    if (lx > maxX) maxX = lx;
                    if (ly + it.h > maxY) maxY = ly + it.h;
                }
                const bW = Math.max(GRID_W, maxX) + CONTAINER_PAD * 2;
                const bH = maxY + CONTAINER_PAD * 2 + TITLE_BAR;
                const container: ContainerItem = {
                    id: newId('ctn'),
                    type: 'container',
                    x: cursorX,
                    y: oy,
                    w: bW,
                    h: bH,
                    zIndex: s.order.length + createdContainerIds.length,
                    locked: false,
                    parentId: null,
                    createdAt: Date.now(),
                    createdBy: 'agent',
                    title: `${titleCase(by)}: ${label}`,
                    collapsed: false,
                    scopeLocked: false,
                    borderColor: 'rgba(16,185,129,0.35)',
                };
                ctx.dispatch({ type: 'ADD_ITEM', item: container });
                createdContainerIds.push(container.id);

                // Apply placements in world coords; reparent.
                for (const p of placements) {
                    ctx.dispatch({
                        type: 'UPDATE_ITEM',
                        id: p.id,
                        patch: {
                            x: cursorX + CONTAINER_PAD + p.x,
                            y: oy + TITLE_BAR + CONTAINER_PAD + p.y,
                            parentId: container.id,
                        } as any,
                    });
                    movedItemCount.count++;
                }
                cursorX += bW + CONTAINER_GAP;
            }

            return {
                name: call.name,
                result: JSON.stringify({
                    ok: true,
                    by,
                    buckets: bucketEntries.map(([k, v]) => ({ label: k, count: v.length })),
                    containers_created: createdContainerIds,
                    items_moved: movedItemCount.count,
                }),
            };
        }

        case 'canvas_find_issues': {
            const requestedKinds: string[] = Array.isArray(call.args.kinds) && call.args.kinds.length > 0
                ? call.args.kinds.map((k: any) => String(k))
                : ['orphans', 'untagged', 'duplicates', 'near_aligned'];
            const rawIds: string[] | null = Array.isArray(call.args.item_ids) && call.args.item_ids.length > 0
                ? call.args.item_ids.map((x: any) => String(x))
                : null;
            const pool = (rawIds || s.order)
                .map(id => s.items[id])
                .filter(Boolean) as CanvasItem[];

            const report: Record<string, any> = {};

            if (requestedKinds.includes('orphans')) {
                const degree = new Map<string, number>();
                for (const c of Object.values(s.connections)) {
                    degree.set(c.fromId, (degree.get(c.fromId) || 0) + 1);
                    degree.set(c.toId, (degree.get(c.toId) || 0) + 1);
                }
                report.orphans = pool
                    .filter(it => it.type !== 'container' && it.type !== 'approval' && it.type !== 'box')
                    .filter(it => (degree.get(it.id) || 0) === 0 && !it.parentId)
                    .map(it => ({ id: it.id, type: it.type, label: labelFor(it) }));
            }
            if (requestedKinds.includes('untagged')) {
                report.untagged = pool
                    .filter(it => it.type !== 'container' && it.type !== 'approval' && it.type !== 'box')
                    .filter(it => !it.tags || it.tags.length === 0)
                    .map(it => ({ id: it.id, type: it.type, label: labelFor(it) }));
            }
            if (requestedKinds.includes('duplicates')) {
                // Exact-content match among text items; filename match among files.
                const byText = new Map<string, string[]>();
                const byName = new Map<string, string[]>();
                for (const it of pool) {
                    if (it.type === 'text') {
                        const k = it.content.trim();
                        if (k.length >= 8) (byText.get(k) || byText.set(k, []).get(k)!).push(it.id);
                    } else if (it.type === 'file' || it.type === 'image' || it.type === 'video' || it.type === 'audio') {
                        const k = (it as any).fileName;
                        if (k) (byName.get(k) || byName.set(k, []).get(k)!).push(it.id);
                    }
                }
                const dupes: Array<{ kind: string; key: string; ids: string[] }> = [];
                for (const [k, ids] of byText) if (ids.length > 1) dupes.push({ kind: 'text', key: k.slice(0, 80), ids });
                for (const [k, ids] of byName) if (ids.length > 1) dupes.push({ kind: 'file', key: k, ids });
                report.duplicates = dupes;
            }
            if (requestedKinds.includes('near_aligned')) {
                // Pairs of items whose edges are within 8 world pixels but not
                // exactly aligned — suggests a missed snap.
                const near: Array<{ a: string; b: string; axis: 'x' | 'y'; gap: number }> = [];
                const NEAR = 8;
                for (let i = 0; i < pool.length; i++) {
                    for (let j = i + 1; j < pool.length; j++) {
                        const a = pool[i];
                        const b = pool[j];
                        if (a.type === 'container' || b.type === 'container') continue;
                        const dxLeft = Math.abs(a.x - b.x);
                        if (dxLeft > 0 && dxLeft <= NEAR) near.push({ a: a.id, b: b.id, axis: 'x', gap: Math.round(dxLeft) });
                        const dyTop = Math.abs(a.y - b.y);
                        if (dyTop > 0 && dyTop <= NEAR) near.push({ a: a.id, b: b.id, axis: 'y', gap: Math.round(dyTop) });
                    }
                }
                report.near_aligned = near.slice(0, 40);
            }

            return { name: call.name, result: JSON.stringify({ ok: true, ...report }) };
        }

        case 'canvas_compile': {
            const format = String(call.args.format || '').toLowerCase();
            const title = String(call.args.title || '').trim() || 'Canvas export';
            const x = Number(call.args.x) || 0;
            const y = Number(call.args.y) || 0;
            if (!['pdf', 'docx', 'pptx', 'zip'].includes(format)) {
                return { name: call.name, result: JSON.stringify({ error: 'unsupported_format', format }) };
            }
            // Resolve target items. Explicit ids win; otherwise scope-default
            // is "everything on the canvas except UI-only approvals/boxes".
            const rawIds = Array.isArray(call.args.item_ids) ? call.args.item_ids : null;
            const target: CanvasItem[] = [];
            const visitedIds = rawIds && rawIds.length > 0
                ? rawIds.map((id: any) => String(id))
                : s.order;
            for (const id of visitedIds) {
                const it = s.items[id];
                if (!it) continue;
                if (it.type === 'box' || it.type === 'approval') continue;
                target.push(it);
            }
            if (target.length === 0) {
                return { name: call.name, result: JSON.stringify({ error: 'no_items_to_compile' }) };
            }

            let bytes: Uint8Array;
            let extension: string;
            let mime: string;
            try {
                if (format === 'zip') {
                    bytes = await compileToZip(target, title);
                    extension = 'zip';
                    mime = 'application/zip';
                } else {
                    const api: any = (window as any).electron?.canvas;
                    if (!api?.compileBytes) {
                        return { name: call.name, result: JSON.stringify({ error: 'compile_ipc_unavailable' }) };
                    }
                    const payload: any = { format, fileName: `${title}.${format}` };
                    if (format === 'pdf') {
                        payload.content = compileToPdfMarkdown(target, title);
                        payload.spec = { metadata: { title } };
                    } else if (format === 'docx') {
                        payload.spec = compileToDOCX(target, title);
                    } else if (format === 'pptx') {
                        payload.spec = compileToPPTX(target, title);
                    }
                    const res = await api.compileBytes(payload);
                    if (!res?.ok || !res?.base64) {
                        return { name: call.name, result: JSON.stringify({ error: 'compile_failed', message: res?.error || 'unknown' }) };
                    }
                    bytes = base64ToBytes(res.base64);
                    extension = format;
                    mime = res.mime || mimeFromExtension(format);
                }
            } catch (err: any) {
                return { name: call.name, result: JSON.stringify({ error: 'compile_exception', message: err?.message || String(err) }) };
            }

            const fileName = `${title}.${extension}`;
            const asset = registerAsset({ mime, extension, bytes, fileName });
            const card: FileItem = {
                id: newId('file'),
                type: 'file',
                x, y, w: 320, h: 100, zIndex: s.order.length, locked: false, parentId: null,
                createdAt: Date.now(), createdBy: 'agent',
                fileName,
                fileSize: bytes.length,
                extension,
                mimeType: mime,
                assetId: asset.id,
                tags: ['agent', 'compiled'],
            };
            ctx.dispatch({ type: 'ADD_ITEM', item: card });
            return {
                name: call.name,
                result: JSON.stringify({
                    ok: true,
                    item_id: card.id,
                    format,
                    file_name: fileName,
                    size_bytes: bytes.length,
                    item_count: target.length,
                }),
            };
        }

        case 'canvas_done': {
            return {
                name: call.name,
                result: JSON.stringify({ ok: true }),
                done: true,
                doneMessage: String(call.args.message || ''),
            };
        }
    }

    return { name: call.name, result: JSON.stringify({ error: 'unknown_tool' }) };
}

// Wrap the agent's snippet in a one-liner the sandbox shell can run. We write
function titleCase(s: string): string {
    if (!s) return s;
    return s.slice(0, 1).toUpperCase() + s.slice(1);
}

function labelFor(it: CanvasItem): string {
    if (it.type === 'text') return (it.content || '(empty)').slice(0, 60);
    if (it.type === 'container') return it.title;
    if (it.type === 'code') return it.fileName || `${it.language} snippet`;
    if ((it as any).fileName) return (it as any).fileName;
    return `(${it.type})`;
}

// to a temp file and invoke the appropriate interpreter rather than eval'ing
// inline — avoids shell-escaping issues with multi-line code.
function buildRunCommand(lang: string, code: string): string {
    const b64 = btoa(unescape(encodeURIComponent(code)));
    switch (lang) {
        case 'bash':
        case 'sh':
            return `f=$(mktemp /tmp/klypix_XXXXXX.sh); echo '${b64}' | base64 -d > "$f"; bash "$f"; rm -f "$f"`;
        case 'node':
        case 'js':
        case 'javascript':
            return `f=$(mktemp /tmp/klypix_XXXXXX.js); echo '${b64}' | base64 -d > "$f"; node "$f"; rm -f "$f"`;
        case 'python':
        case 'py':
        default:
            return `f=$(mktemp /tmp/klypix_XXXXXX.py); echo '${b64}' | base64 -d > "$f"; python3 "$f"; rm -f "$f"`;
    }
}

function measureImage(src: string): Promise<{ w: number; h: number }> {
    return new Promise((resolve) => {
        const img = new Image();
        img.onload = () => resolve({ w: img.naturalWidth || 400, h: img.naturalHeight || 300 });
        img.onerror = () => resolve({ w: 400, h: 300 });
        img.src = src;
    });
}
