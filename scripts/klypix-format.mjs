// klypix-format — the single source of truth for reading & writing .klypix
// (and legacy .any) canvas files. Shared by read-klypix.mjs, write-klypix.mjs,
// and klypix-mcp-server.mjs so the format logic lives in exactly one place.
//
// .klypix v4 ZIP layout: manifest.json · canvas.json · items/<prefix>/<id>.json
// · assets/<assetId>. Legacy .any (v1–v3) keeps an inline items array in
// canvas.json at the root — handled by parseKlypix too.

import JSZip from 'jszip';
import path from 'path';
import fs from 'fs';
import { generateKeyBetween } from 'fractional-indexing';

// Valid fractional-indexing z-keys. Hand-rolled keys (e.g. 'a0000' / 'z00013')
// are REJECTED by the fractional-indexing lib the KLYPIX app uses and crash it
// the moment you edit such a canvas — so the writer MUST emit lib-valid keys.
// makeZKeyGen() returns an increasing-key generator starting just above `after`
// (or from the bottom if `after` is null/invalid).
const isValidZKey = (k) => { try { generateKeyBetween(k, null); return true; } catch { return false; } };
function makeZKeyGen(after = null) {
    let last = (after && isValidZKey(after)) ? after : null;
    return () => (last = generateKeyBetween(last, null));
}

export const WIKILINK = /\[\[([^[\]]+)\]\]/g;
export const TAG = /(^|\s)(#[a-zA-Z][\w-]*)/g;

export function extractLinks(text) {
    const out = []; WIKILINK.lastIndex = 0; let m;
    while ((m = WIKILINK.exec(text || '')) !== null) out.push(m[1].trim());
    return out;
}
export function extractTags(text) {
    const out = []; TAG.lastIndex = 0; let m;
    while ((m = TAG.exec(text || '')) !== null) out.push(m[2].slice(1));
    return out;
}
export function cardTitle(item) {
    if (item?.type === 'container') return item.title || null;
    if (item?.type !== 'text') return null;
    for (const line of String(item.content ?? '').split('\n')) {
        const t = line.trim();
        if (t) return t.replace(/^([#>\-*•]+\s+|\d+\.\s+)/, '').trim() || t;
    }
    return null;
}
// v4 shards item files by the first 2 hex chars of the id's random part.
export const shard = (id) => id.replace(/^[a-z]+[_:]/i, '').toLowerCase().slice(0, 2).padStart(2, '_');

/**
 * Atomically persist a .klypix buffer: verify it round-trips, write a sibling
 * .tmp, then rename over the target. A concurrent reader (e.g. the shared-brain
 * watcher) therefore never parses a half-written ZIP, and a failed/garbage
 * write leaves the previous good file intact. Use this for ALL brain writes
 * instead of fs.writeFileSync.
 */
export async function atomicWrite(filePath, buf) {
    try { await parseKlypix(buf); }
    catch (e) { throw new Error('refusing to write an unparseable .klypix (' + path.basename(filePath) + '): ' + (e?.message || e)); }
    const tmp = filePath + '.tmp-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    fs.writeFileSync(tmp, buf);
    try { fs.renameSync(tmp, filePath); }    // Node uses MoveFileEx(REPLACE_EXISTING) on Windows → overwrites atomically
    catch (e) { try { fs.rmSync(tmp); } catch { /* */ } throw e; }
}

/**
 * Parse a .klypix/.any buffer into a structured object + the loaded zip (so
 * callers can extract binary assets). Throws on a non-canvas file.
 */
export async function parseKlypix(buffer) {
    const zip = await JSZip.loadAsync(buffer);
    const readText = async (p) => { const e = zip.file(p); return e ? e.async('string') : null; };

    const manifestRaw = await readText('manifest.json');
    const canvasRaw = await readText('canvas.json');
    if (!canvasRaw) throw new Error('Not a valid .klypix/.any — no canvas.json inside.');

    const manifest = manifestRaw ? JSON.parse(manifestRaw) : null;
    const canvas = JSON.parse(canvasRaw);
    // v4 manifests are {format:"klypix", version:4}; positions presence is the
    // robust fallback (legacy .any keeps an inline items array, no positions).
    const isV4 = (!!manifest && manifest.format === 'klypix' && manifest.version >= 4) || !!canvas.positions;

    const order = Array.isArray(canvas.order) ? canvas.order : [];
    const items = {};
    if (isV4 && canvas.positions) {
        for (const id of order) {
            const raw = await readText(`items/${shard(id)}/${id}.json`);
            if (!raw) continue;
            items[id] = { id, ...(canvas.positions[id] || {}), ...JSON.parse(raw) };
        }
    } else if (Array.isArray(canvas.items)) {
        for (const it of canvas.items) items[it.id] = it;
    }

    const connections = Array.isArray(canvas.connections) ? canvas.connections : [];
    const titleOf = (id) => cardTitle(items[id]) || (items[id]?.type ? `${items[id].type} ${String(id).slice(0, 8)}` : String(id).slice(0, 8));
    const assetPaths = Object.keys(zip.files).filter(p => p.startsWith('assets/') && !zip.files[p].dir);
    const cards = order.length ? order.map(id => items[id]).filter(Boolean) : Object.values(items);

    const struct = {
        title: manifest?.title || canvas.title || 'Untitled',
        format: isV4 ? 'klypix-v4' : `legacy-v${canvas.version ?? '?'}`,
        counts: { cards: cards.length, connections: connections.length, assets: assetPaths.length },
        cards: cards.map(it => ({
            id: it.id, type: it.type,
            title: cardTitle(it),
            text: it.type === 'text' ? it.content : (it.name || it.title || it.url || null),
            links: it.type === 'text' ? extractLinks(it.content) : [],
            tags: it.type === 'text' ? extractTags(it.content) : [],
            pos: { x: it.x, y: it.y },
        })),
        connections: connections.map(c => ({
            from: titleOf(c.fromId), to: titleOf(c.toId),
            relationship: c.relationship || null, label: c.label || null,
        })),
        assets: assetPaths.map(p => path.basename(p)),
    };
    return { struct, zip, assetPaths, isV4, canvas, manifest };
}

const REL = new Set(['leads_to', 'depends_on', 'relates_to', 'conflicts_with', 'supports', 'questions', 'costs', 'blocks']);

/**
 * Build a real .klypix v4 file (nodebuffer) from a simple spec:
 *   { title, cards: [{id?, type?, text, heading?, color?, x?, y?, w?}], connections: [{from, to, relationship?, label?}] }
 * from/to reference a card by INDEX, generated id, or its title (first line).
 * Cards are content-sized and laid out on a BFS-ordered grid so linked cards
 * land near each other.
 */
export async function buildKlypix(spec) {
    if (!spec || !Array.isArray(spec.cards) || spec.cards.length === 0) {
        throw new Error('spec needs a non-empty "cards" array');
    }
    const now = Date.now();
    const nowIso = new Date(now).toISOString();
    const rand = () => Math.random().toString(36).slice(2, 10);

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
        if (typeof ref === 'string') { if (idByIndex.includes(ref)) return ref; return idByTitle.get(ref.trim().toLowerCase()) ?? null; }
        return null;
    };

    const connections = (Array.isArray(spec.connections) ? spec.connections : []).map((c, i) => {
        const fromId = resolveRef(c.from), toId = resolveRef(c.to);
        if (!fromId || !toId || fromId === toId) return null;
        return {
            id: `con_${rand()}_${i}`, fromId, toId,
            relationship: REL.has(c.relationship) ? c.relationship : undefined,
            label: typeof c.label === 'string' ? c.label : undefined,
            arrowHead: true, width: 2, color: '#10b981', style: 'solid',
        };
    }).filter(Boolean);

    // BFS order so connected cards land near each other.
    const adj = new Map(idByIndex.map(id => [id, []]));
    for (const c of connections) { adj.get(c.fromId)?.push(c.toId); adj.get(c.toId)?.push(c.fromId); }
    const indeg = new Map(idByIndex.map(id => [id, 0]));
    for (const c of connections) indeg.set(c.toId, (indeg.get(c.toId) || 0) + 1);
    const visited = new Set();
    const order = [];
    const starts = [...idByIndex].sort((a, b) => (indeg.get(a) - indeg.get(b)) || (idByIndex.indexOf(a) - idByIndex.indexOf(b)));
    for (const s of starts) {
        if (visited.has(s)) continue;
        const q = [s];
        while (q.length) {
            const id = q.shift();
            if (visited.has(id)) continue;
            visited.add(id); order.push(id);
            for (const n of (adj.get(id) || [])) if (!visited.has(n)) q.push(n);
        }
    }

    const FONT = 20, PAD = 28, LINE_H = FONT * 1.35;
    const sizeFor = (card) => {
        if (card.x != null && card.w != null) return { w: card.w, h: card.h ?? 40 };
        const lines = String(card.text ?? '').split('\n');
        const longest = lines.reduce((m, l) => Math.max(m, l.length), 0);
        const w = Math.max(160, Math.min(360, Math.round(longest * (FONT * 0.55)) + PAD));
        const h = Math.max(40, Math.round(lines.length * LINE_H) + 14);
        return { w, h };
    };
    const cols = Math.max(1, Math.ceil(Math.sqrt(order.length)));
    const COL_W = 380, GAP_Y = 70, START = 80;
    const positions = {};
    let zi = 0;
    const nextZKey = makeZKeyGen();
    order.forEach((id, idx) => {
        const card = cards[idByIndex.indexOf(id)];
        const { w, h } = sizeFor(card);
        const col = idx % cols, row = Math.floor(idx / cols);
        positions[id] = {
            x: card.x ?? (START + col * COL_W),
            y: card.y ?? (START + row * (180 + GAP_Y) + (col % 2) * 12),
            w, h, zKey: nextZKey(), zIndex: zi++, parentId: null,
        };
    });

    const itemJson = (card) => {
        if (card.type === 'text') {
            return {
                type: 'text', locked: false, createdAt: now, createdBy: 'agent',
                content: String(card.text ?? ''), fontSize: FONT,
                color: card.color || '#1a1a1f', border: !!card.border, borderColor: '#1e1e2e',
                heading: !!card.heading, fontFamily: 'Thmanyah Sans',
                fontWeight: card.heading ? 'bold' : 'normal', fontStyle: 'normal',
                textDecoration: 'none', textAlign: 'left', verticalAlign: 'top',
            };
        }
        return { type: card.type, locked: false, createdAt: now, createdBy: 'agent', ...(card._raw || {}) };
    };

    const zip = new JSZip();
    const manifest = {
        format: 'klypix', version: 4, schemaVersion: 4,
        createdAt: nowIso, updatedAt: nowIso,
        title: spec.title || 'Untitled',
        stats: { itemCount: order.length, assetCount: 0, totalBytes: 0 },
        sync: { enabled: false, lastSyncRev: null, lastSyncAt: null, deviceId: `dev_${rand()}${rand()}` },
    };
    const xs = Object.values(positions);
    const minX = Math.min(...xs.map(p => p.x)), minY = Math.min(...xs.map(p => p.y));
    const canvasJson = {
        version: 4,
        view: { panX: 120 - minX * 0.7, panY: 120 - minY * 0.7, zoom: 0.7 },
        order, connections, lines: [], strokes: [], nextGroupNumber: 1,
        positions, settings: { background: '#0a0a0f' },
    };
    zip.file('manifest.json', JSON.stringify(manifest));
    zip.file('canvas.json', JSON.stringify(canvasJson));
    for (const id of order) {
        const card = cards[idByIndex.indexOf(id)];
        zip.file(`items/${shard(id)}/${id}.json`, JSON.stringify(itemJson(card)));
    }
    return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

/**
 * Append cards (+ optional connections) to an EXISTING v4 .klypix, preserving
 * every existing item and its position. New cards are placed in a column just
 * to the right of the current content and stacked on top (z above existing).
 * connection from/to may reference a NEW card by index/title, or an EXISTING
 * card by its title. Returns a nodebuffer of the updated file.
 */
export async function appendToKlypix(buffer, addition) {
    const { zip, canvas, manifest, isV4, struct } = await parseKlypix(buffer);
    if (!isV4 || !canvas.positions) {
        throw new Error('append supports v4 .klypix only; for a legacy .any, create a new canvas instead');
    }
    const newCards = (addition?.cards || []).filter(c => c && typeof c.text === 'string' && c.text.trim());
    if (newCards.length === 0) throw new Error('nothing to add — provide cards[] with text');

    const now = Date.now();
    const rand = () => Math.random().toString(36).slice(2, 10);
    const FONT = 20, LINE_H = FONT * 1.35;

    const ex = Object.values(canvas.positions);
    const maxX = ex.length ? Math.max(...ex.map(p => p.x + (p.w || 160))) : 80;
    const minY = ex.length ? Math.min(...ex.map(p => p.y)) : 80;
    const startX = maxX + 80;

    const titleToId = new Map();
    for (const c of struct.cards) { const t = (c.title || '').toLowerCase(); if (t && !titleToId.has(t)) titleToId.set(t, c.id); }

    let zTop = Array.isArray(canvas.order) ? canvas.order.length : 0;
    const added = newCards.map((c, i) => {
        const lines = String(c.text).split('\n');
        const longest = lines.reduce((m, l) => Math.max(m, l.length), 0);
        const w = Math.max(160, Math.min(360, Math.round(longest * (FONT * 0.55)) + 28));
        const h = Math.max(40, Math.round(lines.length * LINE_H) + 14);
        return { id: `txt_${rand()}_${i}`, card: c, x: startX, y: minY + i * 160, w, h, z: zTop + i };
    });

    const addedTitle = new Map(added.map(a => [String(a.card.text).split('\n').map(s => s.trim()).find(Boolean)?.toLowerCase() || '', a.id]));
    const resolve = (ref) => {
        if (typeof ref === 'number') return added[ref]?.id ?? null;
        if (typeof ref === 'string') {
            const k = ref.trim().toLowerCase();
            return addedTitle.get(k) || titleToId.get(k) || (canvas.positions[ref] ? ref : null);
        }
        return null;
    };

    canvas.order = Array.isArray(canvas.order) ? canvas.order : [];
    // New cards go above the existing top — generate valid keys starting just
    // above the highest existing VALID key (ignoring any legacy bad keys).
    const existingTop = Object.values(canvas.positions || {}).map(p => p && p.zKey).filter(k => k && isValidZKey(k)).sort().pop() || null;
    const nextZKey = makeZKeyGen(existingTop);
    for (const a of added) {
        zip.file(`items/${shard(a.id)}/${a.id}.json`, JSON.stringify({
            type: 'text', locked: false, createdAt: now, createdBy: 'agent',
            content: String(a.card.text), fontSize: FONT,
            color: a.card.color || '#1a1a1f', border: !!a.card.border, borderColor: '#1e1e2e',
            heading: !!a.card.heading, fontFamily: 'Thmanyah Sans',
            fontWeight: a.card.heading ? 'bold' : 'normal', fontStyle: 'normal',
            textDecoration: 'none', textAlign: 'left', verticalAlign: 'top',
        }));
        canvas.positions[a.id] = { x: a.x, y: a.y, w: a.w, h: a.h, zKey: nextZKey(), zIndex: a.z, parentId: null };
        canvas.order.push(a.id);
    }

    canvas.connections = Array.isArray(canvas.connections) ? canvas.connections : [];
    (addition?.connections || []).forEach((cn, i) => {
        const fromId = resolve(cn.from), toId = resolve(cn.to);
        if (!fromId || !toId || fromId === toId) return;
        canvas.connections.push({
            id: `con_${rand()}_${i}`, fromId, toId,
            relationship: REL.has(cn.relationship) ? cn.relationship : undefined,
            label: typeof cn.label === 'string' ? cn.label : undefined,
            arrowHead: true, width: 2, color: '#10b981', style: 'solid',
        });
    });

    if (manifest) {
        manifest.updatedAt = new Date(now).toISOString();
        manifest.stats = manifest.stats || {};
        manifest.stats.itemCount = canvas.order.length;
        zip.file('manifest.json', JSON.stringify(manifest));
    }
    zip.file('canvas.json', JSON.stringify(canvas));
    const out = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
    // Parse-resilience: never return a buffer that doesn't round-trip — the
    // caller keeps the last-known-good file rather than writing corruption.
    try { await parseKlypix(out); }
    catch (e) { throw new Error('append produced an unparseable .klypix — aborting to protect the brain: ' + (e?.message || e)); }
    return out;
}

// ── Area-grouped layout (project brain) ──────────────────────────────────────
// Captured decisions carry an [Area]; these route cards INTO titled area
// containers (find-or-create) so the brain stays a clean areas-as-containers map
// instead of a rightward strip. Non-destructive, valid z-keys, atomic round-trip.
const BRAIN_GEOM = { TITLE_BAR: 40, PAD: 14, CARD_GAP: 10, CARD_W: 300, FONT: 12, LINE_H: 17, START: 80, COL_GAP: 44 };
BRAIN_GEOM.AREA_W = BRAIN_GEOM.CARD_W + BRAIN_GEOM.PAD * 2;

function measureCardH(text) {
    // Estimate WRAPPED lines at CARD_W — captured decisions are long prose with
    // few explicit newlines; counting only "\n" lines under-sizes them and cards
    // overlap. ~CARD_W/(FONT*0.5) chars fit per line.
    const cpl = Math.max(8, Math.floor(BRAIN_GEOM.CARD_W / (BRAIN_GEOM.FONT * 0.5)));
    let lines = 0;
    for (const ln of String(text ?? '').split('\n')) lines += Math.max(1, Math.ceil((ln.length || 1) / cpl));
    return Math.max(40, Math.round(lines * BRAIN_GEOM.LINE_H) + 18);
}
// Container the next NEW area goes to the right of the rightmost item.
function nextContainerX(canvas) {
    const all = Object.values(canvas.positions);
    return all.length ? Math.max(...all.map(p => (p.x || 0) + (p.w || BRAIN_GEOM.AREA_W))) + BRAIN_GEOM.COL_GAP : BRAIN_GEOM.START;
}
// Bottom y of a container's current children (where the next card stacks).
function containerChildBottom(canvas, ctnId) {
    const ctn = canvas.positions[ctnId];
    let cy = ctn.y + BRAIN_GEOM.TITLE_BAR + BRAIN_GEOM.PAD;
    for (const id of canvas.order) {
        const p = canvas.positions[id];
        if (p && p.parentId === ctnId) cy = Math.max(cy, p.y + (p.h || 40) + BRAIN_GEOM.CARD_GAP);
    }
    return cy;
}
// Best-effort area name for a card: "Area: …" first-line prefix → first #tag → 'Notes'.
function areaOfCard(card) {
    const line1 = String(card.text || '').split('\n')[0].trim();
    const m = line1.match(/^([^:\n]{1,40}):\s+\S/);
    if (m) return m[1].trim();
    if (Array.isArray(card.tags) && card.tags[0]) return String(card.tags[0]);
    return 'Notes';
}
async function finalizeBrainZip(zip, canvas, manifest, now) {
    if (manifest) {
        manifest.updatedAt = new Date(now).toISOString();
        manifest.stats = manifest.stats || {};
        manifest.stats.itemCount = canvas.order.length;
        zip.file('manifest.json', JSON.stringify(manifest));
    }
    zip.file('canvas.json', JSON.stringify(canvas));
    const out = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
    try { await parseKlypix(out); }
    catch (e) { throw new Error('brain write produced an unparseable .klypix — aborting to protect the brain: ' + (e?.message || e)); }
    return out;
}

// Append cards routed INTO their [Area] container (find-or-create), so captures
// self-organize. addition.cards = [{ text, color?, area? }]. Non-destructive to
// existing items. Falls back to the flat appender for legacy/no-positions files.
export async function appendIntoContainers(buffer, addition) {
    const { zip, canvas, manifest, isV4, struct } = await parseKlypix(buffer);
    if (!isV4 || !canvas.positions) return appendToKlypix(buffer, addition);
    const newCards = (addition?.cards || []).filter(c => c && typeof c.text === 'string' && c.text.trim());
    if (newCards.length === 0) throw new Error('nothing to add — provide cards[] with text');

    const now = Date.now();
    const rand = () => Math.random().toString(36).slice(2, 10);
    const G = BRAIN_GEOM;
    canvas.order = Array.isArray(canvas.order) ? canvas.order : [];
    const existingTop = Object.values(canvas.positions).map(p => p && p.zKey).filter(k => k && isValidZKey(k)).sort().pop() || null;
    const nextZKey = makeZKeyGen(existingTop);

    const byTitle = new Map();
    for (const c of struct.cards) if (c.type === 'container') { const t = (c.title || '').trim().toLowerCase(); if (t && !byTitle.has(t)) byTitle.set(t, c.id); }
    let ctnX = nextContainerX(canvas);
    const ensureContainer = (area) => {
        const key = area.toLowerCase();
        let id = byTitle.get(key);
        if (id) return id;
        id = `ctn_${rand()}`;
        zip.file(`items/${shard(id)}/${id}.json`, JSON.stringify({
            type: 'container', locked: false, createdAt: now, createdBy: 'agent',
            title: area, collapsed: false, scopeLocked: false, borderColor: '#10b981',
        }));
        canvas.positions[id] = { x: ctnX, y: G.START, w: G.AREA_W, h: G.TITLE_BAR + G.PAD * 2, zKey: nextZKey(), zIndex: canvas.order.length, parentId: null };
        canvas.order.push(id);
        byTitle.set(key, id);
        ctnX += G.AREA_W + G.COL_GAP;
        return id;
    };

    for (const card of newCards) {
        const area = (card.area || areaOfCard(card)).toString().trim() || 'Notes';
        const ctnId = ensureContainer(area);
        const ctn = canvas.positions[ctnId];
        const h = measureCardH(card.text);
        const cy = containerChildBottom(canvas, ctnId);
        const id = `txt_${rand()}`;
        zip.file(`items/${shard(id)}/${id}.json`, JSON.stringify({
            type: 'text', locked: false, createdAt: now, createdBy: 'agent',
            content: String(card.text), fontSize: G.FONT,
            color: card.color || '#e8e8ed', border: true, borderColor: card.color || 'rgba(16,185,129,0.35)',
            fillColor: 'rgba(18,18,26,0.85)', heading: !!card.heading, fontFamily: 'Thmanyah Sans',
            fontWeight: card.heading ? 'bold' : 'normal', fontStyle: 'normal',
            textDecoration: 'none', textAlign: 'left', verticalAlign: 'top',
        }));
        canvas.positions[id] = { x: ctn.x + G.PAD, y: cy, w: G.CARD_W, h, zKey: nextZKey(), zIndex: canvas.order.length, parentId: ctnId };
        canvas.order.push(id);
        ctn.h = (cy + h + G.PAD) - ctn.y;
    }
    return finalizeBrainZip(zip, canvas, manifest, now);
}

// Tidy an EXISTING brain: re-parent every root-level text card into its [Area]
// container (find-or-create), grouping the messy strip into clean areas. Moves
// cards (keeps their ids → connections preserved); never drops a card. Caller
// should back up first; this round-trip-verifies before returning.
export async function tidyBrain(buffer) {
    const { zip, canvas, manifest, isV4, struct } = await parseKlypix(buffer);
    if (!isV4 || !canvas.positions) throw new Error('tidy supports v4 .klypix only');
    const now = Date.now();
    const rand = () => Math.random().toString(36).slice(2, 10);
    const G = BRAIN_GEOM;
    canvas.order = Array.isArray(canvas.order) ? canvas.order : [];
    const top = Object.values(canvas.positions).map(p => p && p.zKey).filter(k => k && isValidZKey(k)).sort().pop() || null;
    const nextZKey = makeZKeyGen(top);

    // Normalize every text card to the compact brain font (so the render matches
    // our height measure → no overlap) + cache each card's measured height.
    const meta = new Map(); // id -> { h }
    for (const c of struct.cards) {
        if (c.type === 'container') continue;
        meta.set(c.id, { h: measureCardH(String(c.text ?? '')) });
        const ip = `items/${shard(c.id)}/${c.id}.json`;
        try { const f = zip.file(ip); if (f) { const j = JSON.parse(await f.async('string')); j.fontSize = G.FONT; zip.file(ip, JSON.stringify(j)); } } catch { /* leave as-is */ }
    }

    const containerIds = new Set(struct.cards.filter(c => c.type === 'container').map(c => c.id));
    const byTitle = new Map();
    for (const c of struct.cards) if (c.type === 'container') { const t = (c.title || '').trim().toLowerCase(); if (t && !byTitle.has(t)) byTitle.set(t, c.id); }

    // Group ROOT text cards by [Area].
    const rootText = struct.cards.filter(c => c.type !== 'container' && canvas.positions[c.id] && canvas.positions[c.id].parentId == null);
    const groups = new Map(); // key -> { title, ids: [] }
    for (const c of rootText) { const a = areaOfCard(c); const k = a.toLowerCase(); if (!groups.has(k)) groups.set(k, { title: a, ids: [] }); groups.get(k).ids.push(c.id); }

    // Create new-area containers, shelf-packed into a GRID below existing content;
    // assign every root card a parentId (final positions come in the re-flow).
    const allPos = Object.values(canvas.positions);
    const baseY = allPos.length ? Math.max(...allPos.map(p => (p.y || 0) + (p.h || 0))) + 60 : G.START;
    const newAreas = [...groups.values()].filter(g => !byTitle.has(g.title.toLowerCase()));
    const cols = Math.max(1, Math.min(4, Math.ceil(Math.sqrt(Math.max(1, newAreas.length)))));
    let colIdx = 0, rowTopY = baseY, rowMaxH = 0, colX = G.START, moved = 0;
    const assignTo = (ctnId, ids) => { for (const id of ids) { const p = canvas.positions[id]; canvas.positions[id] = { ...p, parentId: ctnId, zKey: (p && p.zKey && isValidZKey(p.zKey)) ? p.zKey : nextZKey() }; moved++; } };

    for (const grp of groups.values()) {
        const existingId = byTitle.get(grp.title.toLowerCase());
        if (existingId) { assignTo(existingId, grp.ids); continue; }
        const estH = G.TITLE_BAR + G.PAD + grp.ids.reduce((s, id) => s + (meta.get(id)?.h || 40) + G.CARD_GAP, 0) + G.PAD;
        if (colIdx >= cols) { rowTopY += rowMaxH + G.COL_GAP; rowMaxH = 0; colIdx = 0; colX = G.START; }
        const ax = colX, ay = rowTopY;
        const ctnId = `ctn_${rand()}`;
        zip.file(`items/${shard(ctnId)}/${ctnId}.json`, JSON.stringify({ type: 'container', locked: false, createdAt: now, createdBy: 'agent', title: grp.title, collapsed: false, scopeLocked: false, borderColor: '#10b981' }));
        canvas.order.push(ctnId);
        canvas.positions[ctnId] = { x: ax, y: ay, w: G.AREA_W, h: estH, zKey: nextZKey(), zIndex: canvas.order.length, parentId: null };
        byTitle.set(grp.title.toLowerCase(), ctnId); containerIds.add(ctnId);
        assignTo(ctnId, grp.ids);
        colX += G.AREA_W + G.COL_GAP; colIdx++; rowMaxH = Math.max(rowMaxH, estH);
    }

    // FINAL re-flow: stack EVERY container's children at the compact height so
    // nothing overlaps (fixes pre-existing map containers too) + grow each box.
    for (const ctnId of containerIds) {
        const ctn = canvas.positions[ctnId]; if (!ctn) continue;
        const kids = canvas.order.filter(id => canvas.positions[id] && canvas.positions[id].parentId === ctnId);
        let cy = ctn.y + G.TITLE_BAR + G.PAD;
        for (const id of kids) {
            const h = meta.get(id)?.h || 40;
            canvas.positions[id] = { ...canvas.positions[id], x: ctn.x + G.PAD, y: cy, w: G.CARD_W, h };
            cy += h + G.CARD_GAP;
        }
        ctn.h = Math.max(G.TITLE_BAR + G.PAD * 2, (cy - G.CARD_GAP + G.PAD) - ctn.y);
    }

    const out = await finalizeBrainZip(zip, canvas, manifest, now);
    return { buffer: out, moved, containers: byTitle.size };
}

/**
 * Build a RICH "map" .klypix: areas become titled containers, their cards
 * stack inside, connections draw across. Produces a real spatial board (used by
 * the project brain) rather than a flat grid. Spec:
 *   { title, areas: [{ title, color?, cards: [{text, heading?, color?}] }],
 *     connections: [{ from, to, relationship?, label? }] }   // from/to by card title
 */
export async function buildKlypixMap(spec) {
    if (!spec || !Array.isArray(spec.areas) || spec.areas.length === 0) {
        throw new Error('map spec needs a non-empty "areas" array');
    }
    const now = Date.now();
    const nowIso = new Date(now).toISOString();
    const rand = () => Math.random().toString(36).slice(2, 10);

    const TITLE_BAR = 44, PAD = 16, CARD_GAP = 12, CARD_W = 280, FONT = 15, LINE_H = FONT * 1.4;
    const AREA_W = CARD_W + PAD * 2;
    const COL_GAP = 48, ROW_GAP = 48, START = 80;
    const cols = Math.max(1, Math.min(4, Math.ceil(Math.sqrt(spec.areas.length))));

    const positions = {};
    const order = [];
    const items = {}; // id -> json
    const titleToId = new Map(); // card title -> id (for connections)
    const firstLine = (t) => String(t ?? '').split('\n').map(s => s.trim()).find(Boolean) || '';
    let z = 0;
    const nextZKey = makeZKeyGen();

    // Shelf-pack areas into rows of `cols`; each row's height = tallest area.
    let rowTopY = START, rowMaxH = 0, colX = START, colIdx = 0;
    spec.areas.forEach((area, ai) => {
        const cards = (area.cards || []).filter(c => c && typeof c.text === 'string' && c.text.trim());
        // measure card heights
        const measured = cards.map(c => {
            const lines = String(c.text).split('\n').length;
            return Math.max(40, Math.round(lines * LINE_H) + 18);
        });
        const innerH = measured.reduce((s, h) => s + h + CARD_GAP, 0);
        const areaH = TITLE_BAR + PAD + innerH + PAD;

        if (colIdx >= cols) { // new row
            rowTopY += rowMaxH + ROW_GAP;
            rowMaxH = 0; colIdx = 0; colX = START;
        }
        const ax = colX, ay = rowTopY;

        const ctnId = `ctn_${rand()}_${ai}`;
        items[ctnId] = {
            type: 'container', locked: false, createdAt: now, createdBy: 'agent',
            title: area.title || `Area ${ai + 1}`, collapsed: false, scopeLocked: false,
            borderColor: area.color || '#10b981',
        };
        positions[ctnId] = { x: ax, y: ay, w: AREA_W, h: areaH, zKey: nextZKey(), zIndex: z, parentId: null };
        order.push(ctnId); z++;

        let cy = ay + TITLE_BAR + PAD;
        cards.forEach((c, ci) => {
            const id = `txt_${rand()}_${ai}_${ci}`;
            const h = measured[ci];
            items[id] = {
                type: 'text', locked: false, createdAt: now, createdBy: 'agent',
                content: String(c.text), fontSize: FONT,
                color: c.color || '#e8e8ed', border: true,
                borderColor: c.color || 'rgba(16,185,129,0.35)',
                fillColor: 'rgba(18,18,26,0.85)',
                heading: !!c.heading,
                fontWeight: c.heading ? 'bold' : 'normal', fontStyle: 'normal',
                textDecoration: 'none', textAlign: 'left', verticalAlign: 'top',
                fontFamily: 'Thmanyah Sans',
            };
            positions[id] = { x: ax + PAD, y: cy, w: CARD_W, h, zKey: nextZKey(), zIndex: z, parentId: ctnId };
            order.push(id); z++;
            const t = firstLine(c.text).toLowerCase();
            if (t && !titleToId.has(t)) titleToId.set(t, id);
            cy += h + CARD_GAP;
        });

        rowMaxH = Math.max(rowMaxH, areaH);
        colX += AREA_W + COL_GAP;
        colIdx++;
    });

    // Connections (by card title, across all areas).
    const REL = new Set(['leads_to', 'depends_on', 'relates_to', 'conflicts_with', 'supports', 'questions', 'costs', 'blocks']);
    const resolve = (ref) => {
        if (typeof ref === 'string') return titleToId.get(ref.trim().toLowerCase()) || null;
        return null;
    };
    const connections = (Array.isArray(spec.connections) ? spec.connections : []).map((c, i) => {
        const fromId = resolve(c.from), toId = resolve(c.to);
        if (!fromId || !toId || fromId === toId) return null;
        return {
            id: `con_${rand()}_${i}`, fromId, toId,
            relationship: REL.has(c.relationship) ? c.relationship : undefined,
            label: typeof c.label === 'string' ? c.label : undefined,
            arrowHead: true, width: 2, color: '#10b981', style: 'solid',
        };
    }).filter(Boolean);

    const zip = new JSZip();
    const manifest = {
        format: 'klypix', version: 4, schemaVersion: 4, createdAt: nowIso, updatedAt: nowIso,
        title: spec.title || 'Brain', stats: { itemCount: order.length, assetCount: 0, totalBytes: 0 },
        sync: { enabled: false, lastSyncRev: null, lastSyncAt: null, deviceId: `dev_${rand()}${rand()}` },
    };
    const xs = Object.values(positions);
    const minX = Math.min(...xs.map(p => p.x)), minY = Math.min(...xs.map(p => p.y));
    const canvasJson = {
        version: 4, view: { panX: 120 - minX * 0.55, panY: 120 - minY * 0.55, zoom: 0.55 },
        order, connections, lines: [], strokes: [], nextGroupNumber: spec.areas.length + 1,
        positions, settings: { background: '#0a0a0f' },
    };
    zip.file('manifest.json', JSON.stringify(manifest));
    zip.file('canvas.json', JSON.stringify(canvasJson));
    for (const id of order) zip.file(`items/${shard(id)}/${id}.json`, JSON.stringify(items[id]));
    return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

/** Render a parsed struct to the markdown brief (shared by read-klypix + MCP). */
export function structToMarkdown(struct, { assetsDir } = {}) {
    const L = [];
    L.push(`# ${struct.title}`);
    L.push(`*${struct.format} · ${struct.counts.cards} cards · ${struct.counts.connections} connections · ${struct.counts.assets} assets*\n`);
    L.push(`## Cards`);
    for (const c of struct.cards) {
        L.push(`### ${c.title || `(${c.type})`}  \`${c.type}\``);
        if (c.text) L.push(c.type === 'text' ? String(c.text).trim() : `→ ${c.text}`);
        const meta = [];
        if (c.links?.length) meta.push(`links: ${c.links.map(t => `[[${t}]]`).join(', ')}`);
        if (c.tags?.length) meta.push(`tags: ${c.tags.map(t => `#${t}`).join(' ')}`);
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
    return L.join('\n');
}
