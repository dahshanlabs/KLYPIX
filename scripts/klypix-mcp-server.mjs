#!/usr/bin/env node
// klypix-mcp-server — a Model Context Protocol server that gives any MCP client
// (Claude Desktop, Claude Code, "cowork", …) full READ + WRITE access to your
// .klypix canvas library. It turns the one-off read-klypix / write-klypix
// skills into a standing, tool-based connection: an outside agent can list your
// canvases, read one (cards + connection graph + [[links]] + #tags), search
// across all of them, create a new board, or add cards to an existing one.
//
// It operates on the .klypix FILES in a "vault" folder — no need for the KLYPIX
// desktop app to be running, and nothing here can corrupt a live canvas.
//
// Run (stdio):   node scripts/klypix-mcp-server.mjs --vault "C:\\path\\to\\canvases"
//   or set env:  KLYPIX_VAULT=...   (default: ~/Documents)
//
// Register in Claude Code (.mcp.json) or Claude Desktop (claude_desktop_config
// .json) — see docs/KLYPIX_MCP.md.

import fs from 'fs';
import os from 'os';
import path from 'path';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { parseKlypix, buildKlypix, appendToKlypix, structToMarkdown, atomicWrite } from './klypix-format.mjs';

// IMPORTANT: stdout is the JSON-RPC channel. Never console.log — only stderr.
const log = (...a) => console.error('[klypix-mcp]', ...a);

const vaultArgIdx = process.argv.indexOf('--vault');
const VAULT = path.resolve(
    vaultArgIdx >= 0 ? process.argv[vaultArgIdx + 1]
        : process.env.KLYPIX_VAULT || path.join(os.homedir(), 'Documents'),
);
const IS_CANVAS = /\.(klypix|any)$/i;
const SKIP_DIRS = new Set(['node_modules', '.git', '.cache', 'AppData', '$Recycle.Bin', 'Windows']);
const MAX_FILES = 400;

function walkVault() {
    const out = [];
    const visit = (dir, depth) => {
        if (out.length >= MAX_FILES || depth > 6) return;
        let entries;
        try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
        for (const e of entries) {
            if (out.length >= MAX_FILES) return;
            if (e.name.startsWith('.') || SKIP_DIRS.has(e.name)) continue;
            const full = path.join(dir, e.name);
            if (e.isDirectory()) visit(full, depth + 1);
            else if (e.isFile() && IS_CANVAS.test(e.name)) out.push(full);
        }
    };
    visit(VAULT, 0);
    return out;
}

// Resolve a user-supplied canvas reference: absolute path, vault-relative path,
// or a bare filename (matched against the walked list, case-insensitively).
function resolveCanvas(ref) {
    if (!ref) return null;
    if (path.isAbsolute(ref) && fs.existsSync(ref)) return ref;
    const rel = path.join(VAULT, ref);
    if (fs.existsSync(rel)) return rel;
    const want = path.basename(ref).toLowerCase();
    const matches = walkVault().filter(f => path.basename(f).toLowerCase() === want
        || path.basename(f).toLowerCase() === want + '.klypix'
        || path.basename(f).toLowerCase() === want + '.any');
    return matches[0] || null;
}

function safeName(title) {
    const base = String(title || 'untitled').replace(/[^\w\- ]+/g, '').trim() || 'untitled';
    let name = base, n = 1;
    while (fs.existsSync(path.join(VAULT, `${name}.klypix`))) name = `${base} ${++n}`;
    return `${name}.klypix`;
}

const cardSchema = z.object({
    text: z.string().describe('Card text. First line is the card title.'),
    heading: z.boolean().optional().describe('Bold title card for the main goal/topic.'),
    color: z.string().optional().describe('Hex color, e.g. #ef4444 for a risk/blocker.'),
});
const connSchema = z.object({
    from: z.union([z.number(), z.string()]).describe('Source card: index (0-based), title, or id.'),
    to: z.union([z.number(), z.string()]).describe('Target card: index, title, or id.'),
    relationship: z.string().optional().describe('leads_to|depends_on|relates_to|conflicts_with|supports|questions|costs|blocks'),
    label: z.string().optional(),
});

const server = new McpServer({ name: 'klypix-canvas', version: '1.0.0' });

server.registerTool('list_canvases', {
    title: 'List KLYPIX canvases',
    description: 'List all .klypix / .any canvas files in the vault, with card and connection counts.',
    inputSchema: {},
}, async () => {
    const files = walkVault();
    if (files.length === 0) {
        return { content: [{ type: 'text', text: `No .klypix/.any files found under vault: ${VAULT}\nSet --vault or KLYPIX_VAULT to your canvas folder.` }] };
    }
    const rows = [];
    for (const f of files) {
        try {
            const { struct } = await parseKlypix(fs.readFileSync(f));
            const st = fs.statSync(f);
            rows.push(`- ${path.relative(VAULT, f)} — "${struct.title}" · ${struct.counts.cards} cards, ${struct.counts.connections} connections · ${new Date(st.mtimeMs).toISOString().slice(0, 10)}`);
        } catch {
            rows.push(`- ${path.relative(VAULT, f)} — (unreadable)`);
        }
    }
    return { content: [{ type: 'text', text: `# Canvases in ${VAULT}\n\n${rows.join('\n')}` }] };
});

const IMG_RE = /\.(png|jpe?g|gif|webp|bmp)$/i;
const IMG_MIME = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp' };

server.registerTool('read_canvas', {
    title: 'Read a KLYPIX canvas',
    description: 'Read a canvas as structured markdown (every card, the connection graph, [[wikilinks]], #tags) AND return its images so you can SEE them, not just their filenames. Pass the canvas TITLE directly (e.g. "SS2") — a filename, vault-relative path, or absolute path also work; you do NOT need to list or search first.',
    inputSchema: { canvas: z.string().describe('Canvas title or filename (e.g. "SS2"), vault-relative path, or absolute path.') },
}, async ({ canvas }) => {
    const file = resolveCanvas(canvas);
    if (!file) return { content: [{ type: 'text', text: `Canvas not found: ${canvas} (vault: ${VAULT})` }], isError: true };
    try {
        const { struct, zip, assetPaths } = await parseKlypix(fs.readFileSync(file));
        const content = [{ type: 'text', text: structToMarkdown(struct) }];
        // Return image assets as actual image content so a vision-capable model
        // SEES them — the whole point of a multimodal canvas. Capped (count +
        // per-image size) so the response stays sane.
        let included = 0;
        for (const p of assetPaths) {
            if (included >= 8) break;
            if (!IMG_RE.test(p)) continue;
            try {
                const b64 = await zip.file(p).async('base64');
                if (!b64 || b64.length > 7_000_000) continue; // skip > ~5MB
                const ext = p.split('.').pop().toLowerCase();
                content.push({ type: 'image', data: b64, mimeType: IMG_MIME[ext] || 'image/png' });
                included++;
            } catch { /* skip unreadable asset */ }
        }
        if (included > 0) content.push({ type: 'text', text: `\n(${included} image${included > 1 ? 's' : ''} from this canvas are attached above — read them directly.)` });
        return { content };
    } catch (e) {
        return { content: [{ type: 'text', text: `Failed to read ${file}: ${e.message}` }], isError: true };
    }
});

server.registerTool('search_canvases', {
    title: 'Search inside all canvases',
    description: 'Search card text, titles, and #tags across every canvas in the vault. Returns the canvases and the matching cards.',
    inputSchema: { query: z.string().describe('Text or #tag to find inside canvases.') },
}, async ({ query }) => {
    const q = String(query || '').trim().toLowerCase();
    if (!q) return { content: [{ type: 'text', text: 'Provide a non-empty query.' }], isError: true };
    const hits = [];
    for (const f of walkVault()) {
        let struct;
        try { ({ struct } = await parseKlypix(fs.readFileSync(f))); } catch { continue; }
        const rel = path.relative(VAULT, f);
        // Match the canvas TITLE + FILENAME too — not just card text — so
        // searching a canvas by its name (e.g. "SS2") actually finds it.
        const nameMatch = (struct.title || '').toLowerCase().includes(q) || rel.toLowerCase().includes(q);
        const matched = struct.cards.filter(c =>
            (c.title || '').toLowerCase().includes(q) ||
            String(c.text || '').toLowerCase().includes(q) ||
            (c.tags || []).some(t => ('#' + t).toLowerCase().includes(q)));
        if (nameMatch || matched.length) {
            // Rich hits: type + id + position + tags + a longer snippet, so the
            // agent can FIND a card (and tell duplicates apart) before it WRITES.
            const head = `## ${rel} — "${struct.title}" · ${struct.counts.cards} cards, ${struct.counts.connections} connections${nameMatch && !matched.length ? '  (name/title match)' : ''}`;
            const body = matched.slice(0, 8).map(c => {
                const pos = (c.pos && c.pos.x != null) ? ` @(${Math.round(c.pos.x)},${Math.round(c.pos.y)})` : '';
                const tags = (c.tags && c.tags.length) ? ' ' + c.tags.map(t => '#' + t).join(' ') : '';
                return `- [${c.type}] "${c.title || '(card)'}" (${c.id})${pos}${tags}\n    ${String(c.text || '').replace(/\s+/g, ' ').slice(0, 240)}`;
            }).join('\n');
            hits.push(matched.length ? `${head}\n${body}` : head);
        }
    }
    return { content: [{ type: 'text', text: hits.length ? `# Matches for "${query}"\n\n${hits.join('\n\n')}` : `No matches for "${query}" in ${VAULT}.` }] };
});

// Cross-project memory: search EVERY brain this machine has touched, not just
// this vault. The SessionStart/Stop hook registers each ./brain.klypix it runs
// against into ~/.claude/project-brain/registry.json — so simply having worked
// in a project makes its decisions findable from any other project ("what did
// I decide about auth — in ANY project?"). Lexical scoring v1: term hits
// weighted title>tag>text, with a recency boost; the on-device embedding
// upgrade ranks the same index later without changing this tool's shape.
server.registerTool('search_all_brains', {
    title: 'Search every project brain on this machine',
    description: 'Cross-project memory search: looks through every brain.klypix this machine has worked with (auto-registered by the brain hook), not just the current vault. Use when the answer may live in ANOTHER project\'s decisions.',
    inputSchema: { query: z.string().describe('What to find across all project brains.') },
}, async ({ query }) => {
    const q = String(query || '').trim().toLowerCase();
    if (!q) return { content: [{ type: 'text', text: 'Provide a non-empty query.' }], isError: true };
    const reg = path.join(os.homedir(), '.claude', 'project-brain', 'registry.json');
    let brains = [];
    try { brains = (JSON.parse(fs.readFileSync(reg, 'utf8')).brains || []).filter(b => b && b.path); } catch { /* no registry yet */ }
    if (!brains.length) return { content: [{ type: 'text', text: 'No brains registered yet — the brain hook registers each project as you work in it.' }] };
    const terms = q.split(/[^\p{L}\p{N}#]+/u).filter(t => t.length >= 3);
    if (!terms.length) return { content: [{ type: 'text', text: 'Query too short — use words of 3+ characters.' }], isError: true };
    const fresh = Date.now() - 30 * 86_400_000;
    const scored = [];
    for (const b of brains) {
        let struct;
        try { ({ struct } = await parseKlypix(fs.readFileSync(b.path))); } catch { continue; }
        for (const c of struct.cards) {
            if (c.type === 'container') continue;
            const text = String(c.text || '').toLowerCase();
            const title = String(c.title || '').toLowerCase();
            const tags = (c.tags || []).map(t => ('#' + t).toLowerCase());
            let score = 0;
            for (const t of terms) {
                if (title.includes(t)) score += 3;
                if (tags.some(g => g.includes(t))) score += 2;
                if (text.includes(t)) score += 1;
            }
            if (!score) continue;
            if ((c.createdAt || 0) >= fresh) score += 1;            // recency boost
            if (/^archive$/i.test(c.area || '')) score -= 0.5;      // superseded ranks lower
            scored.push({ score, project: b.project || path.basename(path.dirname(b.path)), area: c.area, c });
        }
    }
    if (!scored.length) return { content: [{ type: 'text', text: `No matches for "${query}" across ${brains.length} registered brain(s).` }] };
    scored.sort((a, b2) => b2.score - a.score);
    const top = scored.slice(0, 20);
    const lines = top.map(h => {
        const when = h.c.createdAt ? new Date(h.c.createdAt).toISOString().slice(0, 10) : '';
        return `- [${h.project}${h.area ? ' › ' + h.area : ''}] ${when} ${String(h.c.text || '').replace(/\s+/g, ' ').slice(0, 240)}`;
    });
    return { content: [{ type: 'text', text: `# Cross-project matches for "${query}" (${scored.length} hits in ${brains.length} brains, top ${top.length})\n\n${lines.join('\n')}` }] };
});

// Format the cards (optionally only a set of new ids) + connection graph so an
// agent that just wrote can chain follow-ups: reference card IDs, place near a
// position, or draw an arrow to something it created. Additive — appended after
// the human-readable line.
function cardDetailBlock(struct, onlyIds) {
    const cards = onlyIds ? struct.cards.filter(c => onlyIds.has(c.id)) : struct.cards;
    if (!cards.length) return '';
    const lines = cards.map(c => {
        const pos = (c.pos && c.pos.x != null) ? `(${Math.round(c.pos.x)},${Math.round(c.pos.y)})` : '(?)';
        const tags = (c.tags && c.tags.length) ? ' ' + c.tags.map(t => '#' + t).join(' ') : '';
        const title = c.title || (c.text ? String(c.text).replace(/\s+/g, ' ').slice(0, 40) : '(untitled)');
        return `- ${c.id} · ${c.type} · ${pos} · "${title}"${tags}`;
    });
    let out = `\n\nCards you can reference (id · type · pos · title):\n${lines.join('\n')}`;
    if (struct.connections && struct.connections.length) {
        out += `\nConnections: ` + struct.connections.map(cn => `${cn.from} ${cn.relationship ? '—' + cn.relationship + '→' : '→'} ${cn.to}`).join('; ');
    }
    return out;
}

server.registerTool('create_canvas', {
    title: 'Create a KLYPIX canvas',
    description: 'Create a new .klypix canvas from cards + connections and save it to the vault. The user opens it in KLYPIX (Canvas → Open). Prefer short, titled cards (one idea each) connected by meaningful arrows.',
    inputSchema: {
        title: z.string().describe('Canvas title (also the filename).'),
        cards: z.array(cardSchema).min(1).describe('The cards. 5-12 atomic cards is ideal.'),
        connections: z.array(connSchema).optional().describe('Arrows between cards.'),
        filename: z.string().optional().describe('Override the output filename (without extension).'),
    },
}, async ({ title, cards, connections, filename }) => {
    if (!fs.existsSync(VAULT)) { try { fs.mkdirSync(VAULT, { recursive: true }); } catch { /* ignore */ } }
    try {
        const buf = await buildKlypix({ title, cards, connections });
        const name = filename ? safeName(filename.replace(IS_CANVAS, '')) : safeName(title);
        const out = path.join(VAULT, name);
        await atomicWrite(out, buf);
        let detail = '';
        try { const { struct } = await parseKlypix(buf); detail = cardDetailBlock(struct); } catch { /* detail is optional */ }
        return { content: [{ type: 'text', text: `Created ${out} — ${cards.length} cards, ${(connections || []).length} connections. Open it in KLYPIX (Canvas → Open).${detail}` }] };
    } catch (e) {
        return { content: [{ type: 'text', text: `Create failed: ${e.message}` }], isError: true };
    }
});

server.registerTool('add_to_canvas', {
    title: 'Add cards to an existing canvas',
    description: 'Append cards (and optional connections) to an existing v4 .klypix, preserving all existing items and their positions. New cards are placed to the right of the current content. Connections may reference new cards (by index/title) or existing cards (by title).',
    inputSchema: {
        canvas: z.string().describe('Canvas filename, vault-relative path, or absolute path.'),
        cards: z.array(cardSchema).min(1).describe('Cards to add.'),
        connections: z.array(connSchema).optional(),
    },
}, async ({ canvas, cards, connections }) => {
    const file = resolveCanvas(canvas);
    if (!file) return { content: [{ type: 'text', text: `Canvas not found: ${canvas}` }], isError: true };
    try {
        const original = fs.readFileSync(file);
        // Snapshot existing ids so we can report ONLY the newly-added cards back.
        let beforeIds = new Set();
        try { const b = await parseKlypix(original); beforeIds = new Set(b.struct.cards.map(c => c.id)); } catch { /* new/legacy → treat all as new */ }
        const buf = await appendToKlypix(original, { cards, connections });
        await atomicWrite(file, buf);
        let detail = '';
        try {
            const { struct } = await parseKlypix(buf);
            detail = cardDetailBlock(struct, new Set(struct.cards.map(c => c.id).filter(id => !beforeIds.has(id))));
        } catch { /* detail is optional */ }
        return { content: [{ type: 'text', text: `Added ${cards.length} card(s) to ${path.relative(VAULT, file)}. Reopen the canvas in KLYPIX to see them.${detail}` }] };
    } catch (e) {
        return { content: [{ type: 'text', text: `Add failed: ${e.message}` }], isError: true };
    }
});

const transport = new StdioServerTransport();
await server.connect(transport);
log(`ready · vault=${VAULT}`);
