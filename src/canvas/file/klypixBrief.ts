// klypixBrief — turn a dropped/attached .klypix (or legacy .any) file into a
// text brief + image assets the in-app chat agent can reason over. This is the
// in-renderer twin of scripts/read-klypix.mjs: it closes the dogfood loop —
// drop a KLYPIX canvas onto KLYPIX's own chat and the AI reads the whole thing
// (cards + connection graph + [[wikilinks]] + #tags + the canvas's images).
//
// Kept deliberately standalone (its own ZIP parse, not the canvas store's
// deserializeV4) so a malformed/foreign file can never corrupt live canvas
// state — the worst case is a brief that says "couldn't read this".

import JSZip from 'jszip';

const WIKILINK = /\[\[([^[\]]+)\]\]/g;
const TAG = /(^|\s)(#[a-zA-Z][\w-]*)/g;
const IMAGE_EXT = /\.(png|jpe?g|gif|webp|bmp)$/i;
const MAX_BRIEF_IMAGES = 4; // cap vision payload; we log when we drop extras

export function isKlypixFile(nameOrExt: string): boolean {
    const s = String(nameOrExt || '').toLowerCase();
    return s.endsWith('.klypix') || s.endsWith('.any') || s === 'klypix' || s === 'any';
}

function extractLinks(text: string): string[] {
    const out: string[] = []; WIKILINK.lastIndex = 0; let m;
    while ((m = WIKILINK.exec(text || '')) !== null) out.push(m[1].trim());
    return out;
}
function extractTags(text: string): string[] {
    const out: string[] = []; TAG.lastIndex = 0; let m;
    while ((m = TAG.exec(text || '')) !== null) out.push(m[2].slice(1));
    return out;
}
function cardTitle(item: any): string | null {
    if (item?.type !== 'text') return null;
    for (const line of String(item.content ?? '').split('\n')) {
        const t = line.trim();
        if (t) return t.replace(/^([#>\-*•]+\s+|\d+\.\s+)/, '').trim() || t;
    }
    return null;
}
const shard = (id: string) => id.replace(/^[a-z]+[_:]/i, '').toLowerCase().slice(0, 2).padStart(2, '_');

export interface KlypixCard {
    id: string;
    type: string;
    title: string;
    text: string;
    tags: string[];
}

export interface KlypixBrief {
    title: string;
    markdown: string;
    imageAssets: string[]; // raw base64 (no data: prefix) — matches readFileBytes
    cards: KlypixCard[];   // structured per-card data (for search/indexing)
    counts: { cards: number; connections: number; assets: number };
}

/** Parse .klypix/.any bytes into a chat-ready brief. Throws on a non-canvas file.
 *  `skipImages` avoids decoding image assets to base64 — pass it when you only
 *  need text (e.g. building a search index), to skip the expensive work. */
export async function klypixBytesToBrief(
    bytes: Uint8Array | ArrayBuffer,
    fileName = 'canvas',
    opts: { skipImages?: boolean } = {},
): Promise<KlypixBrief> {
    const zip = await JSZip.loadAsync(bytes as any);
    const readText = async (p: string) => { const e = zip.file(p); return e ? e.async('string') : null; };

    const manifestRaw = await readText('manifest.json');
    const canvasRaw = await readText('canvas.json');
    if (!canvasRaw) throw new Error('Not a valid .klypix/.any — no canvas.json inside.');

    const manifest = manifestRaw ? JSON.parse(manifestRaw) : null;
    const canvas = JSON.parse(canvasRaw);
    const isV4 = (!!manifest && manifest.format === 'klypix' && manifest.version >= 4) || !!canvas.positions;

    // ---- gather items (v4 sharded, or legacy inline array) ----
    const order: string[] = Array.isArray(canvas.order) ? canvas.order : [];
    const items: Record<string, any> = {};
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
    const cards = order.length ? order.map(id => items[id]).filter(Boolean) : Object.values(items);
    const titleOf = (id: string) =>
        cardTitle(items[id]) || (items[id]?.type ? `${items[id].type} ${String(id).slice(0, 8)}` : String(id).slice(0, 8));

    // ---- assets: list all, extract a capped set of images for vision ----
    const assetPaths = Object.keys(zip.files).filter(p => p.startsWith('assets/') && !zip.files[p].dir);
    const imagePaths = assetPaths.filter(p => IMAGE_EXT.test(p));
    const imageAssets: string[] = [];
    if (!opts.skipImages) {
        for (const p of imagePaths.slice(0, MAX_BRIEF_IMAGES)) {
            try { imageAssets.push(await zip.file(p)!.async('base64')); } catch { /* skip unreadable asset */ }
        }
    }

    const title = manifest?.title || canvas.title || String(fileName).replace(IMAGE_EXT, '').replace(/\.(klypix|any)$/i, '');

    // ---- markdown brief (mirrors read-klypix.mjs) ----
    const L: string[] = [];
    L.push(`# ${title}`);
    L.push(`*KLYPIX canvas · ${cards.length} cards · ${connections.length} connections · ${assetPaths.length} assets*\n`);

    L.push(`## Cards`);
    for (const it of cards) {
        const t = cardTitle(it);
        const head = t || `(${it.type})`;
        L.push(`### ${head}  \`${it.type}\``);
        if (it.type === 'text' && it.content) {
            L.push(String(it.content).trim());
            const links = extractLinks(it.content), tags = extractTags(it.content);
            const meta: string[] = [];
            if (links.length) meta.push(`links: ${links.map(x => `[[${x}]]`).join(', ')}`);
            if (tags.length) meta.push(`tags: ${tags.map(x => `#${x}`).join(' ')}`);
            if (meta.length) L.push(`\n_${meta.join(' · ')}_`);
        } else {
            const ref = it.name || it.title || it.url;
            if (ref) L.push(`→ ${ref}`);
        }
        L.push('');
    }

    if (connections.length) {
        L.push(`## Connection graph`);
        for (const c of connections) {
            const rel = c.relationship ? ` —(${c.relationship})→ ` : ' → ';
            L.push(`- ${titleOf(c.fromId)}${rel}${titleOf(c.toId)}${c.label ? `  (${c.label})` : ''}`);
        }
        L.push('');
    }

    if (assetPaths.length) {
        const shown = Math.min(imagePaths.length, MAX_BRIEF_IMAGES);
        const dropped = imagePaths.length - shown;
        L.push(`## Images / files in this canvas`);
        if (imageAssets.length) L.push(`(${imageAssets.length} image${imageAssets.length > 1 ? 's' : ''} attached below for you to view${dropped > 0 ? `; ${dropped} more not shown` : ''}.)`);
        for (const p of assetPaths) L.push(`- ${p.replace(/^assets\//, '')}`);
        L.push('');
    }

    const structuredCards: KlypixCard[] = cards.map((it: any) => ({
        id: it.id,
        type: it.type,
        title: cardTitle(it) || '',
        text: it.type === 'text' ? String(it.content ?? '') : String(it.name || it.title || it.url || ''),
        tags: it.type === 'text' ? extractTags(it.content) : [],
    }));

    return {
        title,
        markdown: L.join('\n'),
        imageAssets,
        cards: structuredCards,
        counts: { cards: cards.length, connections: connections.length, assets: assetPaths.length },
    };
}
