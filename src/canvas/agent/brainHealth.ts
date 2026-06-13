import type { CanvasItem, Connection, TextItem } from '../items/types';
import { selectConsolidationCandidates } from './brainGardener';

// In-app, human-facing twin of the engine's brainInsights (klypix-format.mjs) —
// the SAME structural read (hubs / orphans / stale questions / areas) computed
// over live canvas state instead of a parsed .klypix, so the Brain Health pill
// can show it without an agent or the MCP. Pure, cheap, no model. Returns null
// on a non-brain / too-small canvas so the surface stays silent there.

type State = { items: Record<string, CanvasItem>; order: string[]; connections: Record<string, Connection> };

export interface BrainHealthCard { id: string; area: string | null; headline: string; }
export interface BrainHealth {
    hubs: Array<BrainHealthCard & { degree: number }>;
    orphans: BrainHealthCard[];
    staleQuestions: BrainHealthCard[];
    areas: Array<{ title: string; count: number }>;
    tidyable: number;       // cards the gardener would consolidate
    connectable: number;    // related-but-unlinked pairs (structural) the in-app connect would draw
}

const STALE_MS = 21 * 86_400_000;
const headline = (t: string) => String(t || '').replace(/\s+/g, ' ').trim().replace(/^(.*?)([.!?](\s|$)|$)/, '$1').slice(0, 90);
const areaTitleOf = (items: Record<string, CanvasItem>, it: CanvasItem): string | null =>
    it.parentId ? ((items[it.parentId] as { title?: string })?.title ?? null) : null;
const isArchived = (a: string | null) => /^archive$/i.test(a || '');

export function computeBrainHealth(state: State): BrainHealth | null {
    const { items, order, connections } = state;
    const deg = new Map<string, number>();
    for (const c of Object.values(connections)) {
        if (c.fromId) deg.set(c.fromId, (deg.get(c.fromId) || 0) + 1);
        if (c.toId) deg.set(c.toId, (deg.get(c.toId) || 0) + 1);
    }
    const textCards = order.map(id => items[id]).filter((it): it is TextItem => !!it && it.type === 'text' && !!(it.content || '').trim());
    const live = textCards.filter(it => !isArchived(areaTitleOf(items, it)));
    if (live.length < 4) return null; // not a brain (or too small to bother)

    const isQ = (it: TextItem) => /❓/.test(it.content);
    const card = (it: TextItem): BrainHealthCard => ({ id: it.id, area: areaTitleOf(items, it), headline: headline(it.content) });
    const orphans = live.filter(it => !isQ(it) && !/🌿|⤵/.test(it.content) && !((deg.get(it.id) || 0) > 0)).map(card);
    const staleQuestions = live.filter(it => isQ(it) && (it.createdAt || 0) < Date.now() - STALE_MS).map(card);
    const hubs = live
        .map(it => ({ ...card(it), degree: deg.get(it.id) || 0 }))
        .filter(x => x.degree > 0)
        .sort((a, b) => b.degree - a.degree)
        .slice(0, 6);
    const areas = order
        .map(id => items[id])
        .filter((it): it is CanvasItem & { title: string } => !!it && it.type === 'container' && !isArchived((it as { title?: string }).title ?? null))
        .map(c => ({ title: c.title, count: textCards.filter(t => t.parentId === c.id).length }))
        .sort((a, b) => b.count - a.count);
    const tidyable = selectConsolidationCandidates(items, order).reduce((n, a) => n + a.candidates.length, 0);
    const connectable = structuralConnectEdges(state).length;
    return { hubs, orphans, staleQuestions, areas, tidyable, connectable };
}

// In-app structural auto-connect — the twin of the engine's
// proposeStructuralConnections (kept logically identical): link related-but-
// unlinked cards by [[mention]] (strongest), shared tag across areas, then
// shared tag within an area. The area-name tag is dropped, and each card keeps
// at most MAX_PER_CARD links so a widely-shared tag can't form a clique. Pure —
// semantic linking lives in the MCP brain_connect, where the model is.
const MAX_PER_CARD = 2;
export function structuralConnectEdges(state: State): Array<{ fromId: string; toId: string }> {
    const { items, order, connections } = state;
    const live = order.map(id => items[id]).filter((it): it is TextItem =>
        !!it && it.type === 'text' && !!(it.content || '').trim() && !isArchived(areaTitleOf(items, it)));
    const linked = new Set<string>();
    for (const c of Object.values(connections)) if (c.fromId && c.toId) linked.add([c.fromId, c.toId].sort().join('|'));
    const tagsOf = (it: TextItem) => {
        const area = (areaTitleOf(items, it) || '').toLowerCase();
        return (it.content.match(/#[\p{L}\w-]+/gu) || [])
            .map(t => t.slice(1).toLowerCase())
            .filter(t => t && t !== 'area' && t !== area);
    };
    const titleIx = live.map(it => ({ id: it.id, t: headline(it.content).toLowerCase() }));
    const areaOf = (it: TextItem) => areaTitleOf(items, it) || '';
    const cand: Array<{ a: string; b: string; score: number }> = [];
    for (const it of live) {
        for (const m of (it.content.match(/\[\[([^\]]+)\]\]/g) || [])) {
            const want = m.slice(2, -2).trim().toLowerCase();
            const tgt = titleIx.find(e => e.id !== it.id && (e.t === want || e.t.startsWith(want)));
            if (tgt) cand.push({ a: it.id, b: tgt.id, score: 3 });
        }
        const tags = tagsOf(it);
        if (!tags.length) continue;
        for (const other of live) {
            if (other.id <= it.id) continue;
            if (tagsOf(other).some(t => tags.includes(t))) cand.push({ a: it.id, b: other.id, score: areaOf(it) !== areaOf(other) ? 2 : 1 });
        }
    }
    cand.sort((x, y) => y.score - x.score);
    const per = new Map<string, number>();
    const edges: Array<{ fromId: string; toId: string }> = [];
    for (const e of cand) {
        if (e.a === e.b) continue;
        const key = [e.a, e.b].sort().join('|');
        if (linked.has(key)) continue;
        if ((per.get(e.a) || 0) >= MAX_PER_CARD || (per.get(e.b) || 0) >= MAX_PER_CARD) continue;
        linked.add(key);
        per.set(e.a, (per.get(e.a) || 0) + 1);
        per.set(e.b, (per.get(e.b) || 0) + 1);
        edges.push({ fromId: e.a, toId: e.b });
    }
    return edges;
}
