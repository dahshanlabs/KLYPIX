#!/usr/bin/env node
// write-klypix — assemble a real .klypix canvas from a simple JSON spec.
//
// The reverse of read-klypix: an agent describes cards + connections, and this
// produces a valid .klypix v4 file the user opens in KLYPIX and sees as a
// spatial board. Closes the loop — the agent can now BUILD canvases, not just
// read them.
//
// Best-in-class touches (not just a dump):
//  • Content-aware sizing — each text card is sized to its longest line +
//    line count, so nothing is clipped and short notes aren't giant boxes.
//  • Connection-aware ordering + grid layout — cards are BFS-ordered from the
//    roots of the connection graph so linked cards land near each other, then
//    placed on a tidy grid. Result reads as intentional, not random.
//  • Exact v4 on-disk format (manifest + canvas.json + sharded items/) so it
//    opens cleanly — verified by round-tripping through read-klypix.
//
// Usage:
//   node scripts/write-klypix.mjs <spec.json> [--out <file.klypix>]
//   cat spec.json | node scripts/write-klypix.mjs --out board.klypix
//
// Spec shape:
//   {
//     "title": "My Board",
//     "cards": [
//       { "text": "Goal: ship v1", "heading": true },
//       { "text": "Risk: no tests", "color": "#ef4444" },
//       { "type": "text", "text": "Idea #brainstorm" }
//     ],
//     "connections": [ { "from": 0, "to": 1, "relationship": "blocks" } ]
//   }
//   - cards[].text is required for text cards. id optional (auto-generated).
//   - from/to reference a card by INDEX (number), generated id, or its title
//     (first line of text).
//   - relationship (optional): leads_to | depends_on | relates_to |
//     conflicts_with | supports | questions | costs | blocks.

import fs from 'fs';
import path from 'path';

let JSZip;
try { JSZip = (await import('jszip')).default; }
catch { console.error('write-klypix needs JSZip (npm i jszip / run from a KLYPIX checkout).'); process.exit(2); }

// ---- args + spec ----
const args = process.argv.slice(2);
const specPath = args.find(a => !a.startsWith('--'));
const outArg = (() => { const i = args.indexOf('--out'); return i >= 0 ? args[i + 1] : null; })();
let specRaw;
if (specPath) specRaw = fs.readFileSync(specPath, 'utf8');
else specRaw = fs.readFileSync(0, 'utf8'); // stdin
let spec;
try { spec = JSON.parse(specRaw); } catch (e) { console.error('Spec is not valid JSON:', e.message); process.exit(2); }
if (!spec || !Array.isArray(spec.cards) || spec.cards.length === 0) { console.error('Spec needs a non-empty "cards" array.'); process.exit(2); }

const now = Date.now();
const nowIso = new Date(now).toISOString();
const rand = () => Math.random().toString(36).slice(2, 10);

// ---- deterministic-ish ids ----
const cards = spec.cards.map((c, i) => {
    const type = c.type || 'text';
    const prefix = type === 'text' ? 'txt' : type === 'image' ? 'img' : type === 'container' ? 'ctn' : 'itm';
    return { ...c, type, _id: c.id || `${prefix}_${rand()}_${i}` };
});
const idByIndex = cards.map(c => c._id);
const firstLine = (t) => String(t ?? '').split('\n').map(s => s.trim()).find(Boolean) || '';
const idByTitle = new Map(cards.map(c => [firstLine(c.text).toLowerCase(), c._id]));
const resolveRef = (ref) => {
    if (typeof ref === 'number') return idByIndex[ref] ?? null;
    if (typeof ref === 'string') {
        if (idByIndex.includes(ref)) return ref;
        return idByTitle.get(ref.trim().toLowerCase()) ?? null;
    }
    return null;
};

// ---- connections ----
const REL = new Set(['leads_to', 'depends_on', 'relates_to', 'conflicts_with', 'supports', 'questions', 'costs', 'blocks']);
const connections = (Array.isArray(spec.connections) ? spec.connections : []).map((c, i) => {
    const fromId = resolveRef(c.from);
    const toId = resolveRef(c.to);
    if (!fromId || !toId || fromId === toId) return null;
    return {
        id: `con_${rand()}_${i}`,
        fromId, toId,
        relationship: REL.has(c.relationship) ? c.relationship : undefined,
        label: typeof c.label === 'string' ? c.label : undefined,
        arrowHead: true,
        width: 2,
        color: '#10b981',
        style: 'solid',
    };
}).filter(Boolean);

// ---- BFS order so connected cards land near each other ----
function bfsOrder() {
    const adj = new Map(idByIndex.map(id => [id, []]));
    for (const c of connections) { adj.get(c.fromId)?.push(c.toId); adj.get(c.toId)?.push(c.fromId); }
    const indeg = new Map(idByIndex.map(id => [id, 0]));
    for (const c of connections) indeg.set(c.toId, (indeg.get(c.toId) || 0) + 1);
    const visited = new Set();
    const out = [];
    // start from low-indegree (roots) first, in original order
    const starts = [...idByIndex].sort((a, b) => (indeg.get(a) - indeg.get(b)) || (idByIndex.indexOf(a) - idByIndex.indexOf(b)));
    for (const s of starts) {
        if (visited.has(s)) continue;
        const q = [s];
        while (q.length) {
            const id = q.shift();
            if (visited.has(id)) continue;
            visited.add(id); out.push(id);
            for (const n of (adj.get(id) || [])) if (!visited.has(n)) q.push(n);
        }
    }
    return out;
}
const order = bfsOrder();

// ---- content-aware sizing + tidy grid layout ----
const FONT = 20, PAD = 28, LINE_H = FONT * 1.35;
function sizeFor(card) {
    if (card.x != null && card.w != null) return { w: card.w, h: card.h ?? 40 };
    const lines = String(card.text ?? '').split('\n');
    const longest = lines.reduce((m, l) => Math.max(m, l.length), 0);
    const w = Math.max(160, Math.min(360, Math.round(longest * (FONT * 0.55)) + PAD));
    const h = Math.max(40, Math.round(lines.length * LINE_H) + 14);
    return { w, h };
}
const cols = Math.max(1, Math.ceil(Math.sqrt(order.length)));
const GAP_X = 80, GAP_Y = 70, COL_W = 380, START = 80;
const positions = {};
let zi = 0;
order.forEach((id, idx) => {
    const card = cards[idByIndex.indexOf(id)];
    const { w, h } = sizeFor(card);
    const col = idx % cols, row = Math.floor(idx / cols);
    positions[id] = {
        x: card.x ?? (START + col * COL_W),
        y: card.y ?? (START + row * (180 + GAP_Y) + (col % 2) * 12),
        w, h,
        zKey: 'a' + String(idx).padStart(4, '0'),
        zIndex: zi++,
        parentId: null,
    };
});

// ---- per-item content json (text item shape, exact match) ----
function itemJson(card) {
    if (card.type === 'text') {
        return {
            type: 'text', locked: false, createdAt: now, createdBy: 'agent',
            content: String(card.text ?? ''),
            fontSize: FONT,
            color: card.color || '#1a1a1f',
            border: !!card.border,
            borderColor: '#1e1e2e',
            heading: !!card.heading,
            fontFamily: 'Thmanyah Sans',
            fontWeight: card.heading ? 'bold' : 'normal',
            fontStyle: 'normal', textDecoration: 'none',
            textAlign: 'left', verticalAlign: 'top',
        };
    }
    // Minimal fallback for non-text types (rare in agent-authored boards).
    return { type: card.type, locked: false, createdAt: now, createdBy: 'agent', ...card._raw };
}

const shard = (id) => id.replace(/^[a-z]+[_:]/i, '').toLowerCase().slice(0, 2).padStart(2, '_');

// ---- assemble zip ----
const zip = new JSZip();
const manifest = {
    format: 'klypix', version: 4, schemaVersion: 4,
    createdAt: nowIso, updatedAt: nowIso,
    title: spec.title || 'Untitled',
    stats: { itemCount: order.length, assetCount: 0, totalBytes: 0 },
    sync: { enabled: false, lastSyncRev: null, lastSyncAt: null, deviceId: `dev_${rand()}${rand()}` },
};
// Center the view on the laid-out content (rough fit).
const xs = Object.values(positions);
const minX = Math.min(...xs.map(p => p.x)), minY = Math.min(...xs.map(p => p.y));
const canvasJson = {
    version: 4,
    view: { panX: 120 - minX * 0.7, panY: 120 - minY * 0.7, zoom: 0.7 },
    order,
    connections,
    lines: [],
    strokes: [],
    nextGroupNumber: 1,
    positions,
    settings: { background: '#0a0a0f' },
};

zip.file('manifest.json', JSON.stringify(manifest));
zip.file('canvas.json', JSON.stringify(canvasJson));
for (const id of order) {
    const card = cards[idByIndex.indexOf(id)];
    zip.file(`items/${shard(id)}/${id}.json`, JSON.stringify(itemJson(card)));
}

const outPath = outArg || `${(spec.title || 'untitled').replace(/[^\w\- ]+/g, '').trim() || 'untitled'}.klypix`;
const blob = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
fs.writeFileSync(outPath, blob);
console.log(`Wrote ${outPath} — ${order.length} cards, ${connections.length} connections.`);
console.log(`Open it in KLYPIX (Canvas → Open), or verify: node scripts/read-klypix.mjs "${outPath}"`);
