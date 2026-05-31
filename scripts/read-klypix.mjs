#!/usr/bin/env node
// read-klypix — turn a .klypix (or legacy .any) file into structured markdown
// an AI agent can fully understand: every card's text, the connection graph,
// [[wikilinks]] + #tags, and a manifest of images/files (with extracted paths
// so the agent can read images with vision).
//
// This is the reference implementation behind the `read-klypix` Claude Code
// skill — the moment "the agent works from the single shared .klypix" becomes
// real. A human builds a spatial, multi-modal canvas; this hands the agent the
// whole thing as text + asset refs.
//
// Usage:
//   node scripts/read-klypix.mjs <file.klypix> [--assets <outDir>] [--json]
//
//   --assets <dir>  extract binary assets (images/files) into <dir> so the
//                   agent can open them (e.g. read an image with vision).
//   --json          emit a structured JSON object instead of markdown.
//
// .klypix v4 ZIP layout: manifest.json · canvas.json · items/<prefix>/<id>.json
// · assets/<assetId>. Legacy .any (v1–v3) has canvas.json at the root with an
// inline items array — handled too.

import fs from 'fs';
import path from 'path';

let JSZip;
try {
    JSZip = (await import('jszip')).default;
} catch {
    console.error('read-klypix needs JSZip. Run it from a KLYPIX checkout (npm i) or `npm i jszip` in the working dir.');
    process.exit(2);
}

// ---- args ----
const args = process.argv.slice(2);
const file = args.find(a => !a.startsWith('--'));
const assetsDir = (() => { const i = args.indexOf('--assets'); return i >= 0 ? args[i + 1] : null; })();
const asJson = args.includes('--json');
if (!file) { console.error('Usage: node read-klypix.mjs <file.klypix> [--assets <dir>] [--json]'); process.exit(2); }
if (!fs.existsSync(file)) { console.error(`File not found: ${file}`); process.exit(2); }

// ---- helpers ----
const WIKILINK = /\[\[([^[\]]+)\]\]/g;
const TAG = /(^|\s)(#[a-zA-Z][\w-]*)/g;
function extractLinks(text) {
    const out = []; WIKILINK.lastIndex = 0; let m;
    while ((m = WIKILINK.exec(text || '')) !== null) out.push(m[1].trim());
    return out;
}
function extractTags(text) {
    const out = []; TAG.lastIndex = 0; let m;
    while ((m = TAG.exec(text || '')) !== null) out.push(m[2].slice(1));
    return out;
}
function cardTitle(item) {
    if (item?.type !== 'text') return null;
    for (const line of String(item.content ?? '').split('\n')) {
        const t = line.trim();
        if (t) return t.replace(/^([#>\-*•]+\s+|\d+\.\s+)/, '').trim() || t;
    }
    return null;
}

// ---- load zip ----
const buf = fs.readFileSync(file);
const zip = await JSZip.loadAsync(buf);
const readText = async (p) => { const e = zip.file(p); return e ? e.async('string') : null; };

const manifestRaw = await readText('manifest.json');
const canvasRaw = await readText('canvas.json');
if (!canvasRaw) { console.error('Not a valid .klypix/.any — no canvas.json inside.'); process.exit(1); }

const manifest = manifestRaw ? JSON.parse(manifestRaw) : null;
const canvas = JSON.parse(canvasRaw);
const isV4 = !!manifest && manifest.format === 'klypix-v4' || !!canvas.positions;

// ---- gather items ----
// v4: per-item files under items/<prefix>/<id>.json keyed by canvas.json.order
//     + positions. v3/.any: canvas.json has an inline `items` array.
const shard = (id) => id.replace(/^[a-z]+[_:]/i, '').toLowerCase().slice(0, 2).padStart(2, '_');
const order = Array.isArray(canvas.order) ? canvas.order : [];
const items = {};
if (isV4 && canvas.positions) {
    for (const id of order) {
        const raw = await readText(`items/${shard(id)}/${id}.json`);
        if (!raw) continue;
        const content = JSON.parse(raw);
        const pos = canvas.positions[id] || {};
        items[id] = { id, ...pos, ...content };
    }
} else if (Array.isArray(canvas.items)) {
    for (const it of canvas.items) items[it.id] = it;
}

const connections = Array.isArray(canvas.connections) ? canvas.connections : [];
const titleOf = (id) => cardTitle(items[id]) || (items[id]?.type ? `${items[id].type} ${id.slice(0, 8)}` : id.slice(0, 8));

// ---- extract assets (optional) ----
const assetFiles = Object.keys(zip.files).filter(p => p.startsWith('assets/') && !zip.files[p].dir);
if (assetsDir && assetFiles.length) {
    fs.mkdirSync(assetsDir, { recursive: true });
    for (const p of assetFiles) {
        const bytes = await zip.file(p).async('nodebuffer');
        fs.writeFileSync(path.join(assetsDir, path.basename(p)), bytes);
    }
}

// ---- structured object ----
const cards = order.length ? order.map(id => items[id]).filter(Boolean) : Object.values(items);
const struct = {
    title: manifest?.title || canvas.title || path.basename(file).replace(/\.(klypix|any)$/i, ''),
    format: isV4 ? 'klypix-v4' : `legacy-v${canvas.version ?? '?'}`,
    counts: { cards: cards.length, connections: connections.length, assets: assetFiles.length },
    cards: cards.map(it => ({
        id: it.id, type: it.type,
        title: cardTitle(it),
        text: it.type === 'text' ? it.content : (it.name || it.title || it.url || null),
        links: it.type === 'text' ? extractLinks(it.content) : [],
        tags: it.type === 'text' ? extractTags(it.content) : [],
        pos: { x: it.x, y: it.y },
    })),
    connections: connections.map(c => ({ from: titleOf(c.fromId), to: titleOf(c.toId), relationship: c.relationship || null, label: c.label || null })),
    assets: assetFiles.map(p => path.basename(p)),
};

if (asJson) { console.log(JSON.stringify(struct, null, 2)); process.exit(0); }

// ---- markdown ----
const L = [];
L.push(`# ${struct.title}`);
L.push(`*${struct.format} · ${struct.counts.cards} cards · ${struct.counts.connections} connections · ${struct.counts.assets} assets*\n`);

L.push(`## Cards`);
for (const c of struct.cards) {
    const head = c.title || `(${c.type})`;
    L.push(`### ${head}  \`${c.type}\``);
    if (c.text) {
        const body = String(c.text).trim();
        L.push(c.type === 'text' ? body : `→ ${body}`);
    }
    const meta = [];
    if (c.links.length) meta.push(`links: ${c.links.map(t => `[[${t}]]`).join(', ')}`);
    if (c.tags.length) meta.push(`tags: ${c.tags.map(t => `#${t}`).join(' ')}`);
    if (meta.length) L.push(`\n_${meta.join(' · ')}_`);
    L.push('');
}

if (struct.connections.length) {
    L.push(`## Connection graph`);
    for (const e of struct.connections) {
        const rel = e.relationship ? ` —(${e.relationship})→ ` : ' → ';
        L.push(`- ${e.from}${rel}${e.to}${e.label ? `  (${e.label})` : ''}`);
    }
    L.push('');
}

if (struct.assets.length) {
    L.push(`## Assets (images / files)`);
    L.push(assetsDir
        ? `Extracted to \`${assetsDir}\` — open them to read images with vision:`
        : `Re-run with \`--assets <dir>\` to extract these for reading:`);
    for (const a of struct.assets) L.push(`- ${a}`);
    L.push('');
}

console.log(L.join('\n'));
