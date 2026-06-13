import { GoogleGenerativeAI } from '@google/generative-ai';
import { getApiKeySync } from '../../api/gemini';
import { newId, type CanvasItem, type TextItem, type ContainerItem, type Connection } from '../items/types';

// The brain GARDENER — sleep-time consolidation with a visible audit trail
// (Letta's sleep-time compute, but on a board the human can inspect and undo):
// for every area that has accumulated more old cards than anyone re-reads, one
// Gemini call writes a tight synthesis card; the originals are stamped
// "⤵ consolidated", moved to Archive, and each gets an arrow → the synthesis.
// The WHOLE pass is one undo step (Ctrl+Z un-gardens), selection is
// deterministic (the model only writes prose, never chooses what to merge),
// and archived cards still exist verbatim — nothing is ever deleted.

const KEEP_NEWEST = 8;          // per area, never consolidate the newest N
const MIN_AGE_DAYS = 14;        // only cards older than this are candidates
const MIN_CANDIDATES = 3;       // don't bother merging fewer than this
// Areas the gardener must never touch: human steering + config + its own output.
const PROTECTED_AREA = /^(archive|📌?\s*focus|(🤖\s*)?(agent\s+)?instructions|open questions|pending)/i;

export interface GardenArea {
    containerId: string;
    title: string;
    candidates: TextItem[];
}

/** Deterministic candidate selection — pure, so the model never decides WHAT
 *  gets merged, only how to phrase the synthesis. */
export function selectConsolidationCandidates(
    items: Record<string, CanvasItem>,
    order: string[],
): GardenArea[] {
    const cutoff = Date.now() - MIN_AGE_DAYS * 86_400_000;
    const out: GardenArea[] = [];
    for (const id of order) {
        const ctn = items[id];
        if (!ctn || ctn.type !== 'container') continue;
        const title = (ctn.title || '').trim();
        if (!title || PROTECTED_AREA.test(title)) continue;
        const children = order
            .map(cid => items[cid])
            .filter((it): it is TextItem =>
                !!it && it.type === 'text' && it.parentId === id
                && !!(it.content || '').trim()
                && !/⤵|↩|✅/.test(it.content))     // already consolidated/superseded/resolved
            .sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
        const old = children.slice(0, Math.max(0, children.length - KEEP_NEWEST))
            .filter(c => (c.createdAt || 0) < cutoff);
        if (old.length >= MIN_CANDIDATES) out.push({ containerId: id, title, candidates: old });
    }
    return out;
}

export interface GardenCtx {
    getState: () => { items: Record<string, CanvasItem>; order: string[] };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    dispatch: (action: any) => void;
    pushSnapshot: () => void;
    onToast: (text: string) => void;
}

export async function runBrainGardener(ctx: GardenCtx): Promise<void> {
    const s = ctx.getState();
    const areas = selectConsolidationCandidates(s.items, s.order);
    if (!areas.length) {
        ctx.onToast(`Nothing to garden — no area has ${MIN_CANDIDATES}+ cards older than ${MIN_AGE_DAYS} days beyond its newest ${KEEP_NEWEST}.`);
        return;
    }
    ctx.onToast(`Gardening ${areas.length} area(s)…`);

    // One Gemini call for all areas — the model writes prose only.
    const genAI = new GoogleGenerativeAI(getApiKeySync());
    const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash', generationConfig: { responseMimeType: 'application/json' } });
    const prompt = `You are consolidating an engineering project's decision log. For EACH area below, write ONE tight synthesis (3-6 sentences, plain prose, no markdown headers) that preserves every still-relevant fact, decision, and number from its cards — drop only repetition and play-by-play. Return JSON: {"areas": [{"title": "<area title exactly as given>", "synthesis": "<text>"}]}.

${areas.map(a => `AREA: ${a.title}\n${a.candidates.map(c => `- ${c.content.replace(/\s+/g, ' ').trim()}`).join('\n')}`).join('\n\n')}`;

    let parsed: { areas?: Array<{ title?: string; synthesis?: string }> };
    try {
        const res = await model.generateContent(prompt);
        parsed = JSON.parse(res.response.text());
    } catch (err) {
        ctx.onToast(`Gardener failed: ${(err as Error)?.message || 'Gemini call/parse error'} — brain unchanged.`);
        return;
    }
    const synthByTitle = new Map<string, string>();
    for (const a of parsed?.areas || []) {
        if (a?.title && typeof a.synthesis === 'string' && a.synthesis.trim()) synthByTitle.set(a.title.trim().toLowerCase(), a.synthesis.trim());
    }

    // Apply — ONE undo step for the whole pass.
    ctx.pushSnapshot();
    const now = Date.now();
    const today = new Date(now).toISOString().slice(0, 10);
    const cur = () => ctx.getState();

    // Find-or-create the Archive container (collapsed wouldn't matter — the
    // brief and gardener both skip it by title).
    let archiveId = s.order.find(id => {
        const it = s.items[id];
        return it?.type === 'container' && /^archive$/i.test((it as ContainerItem).title || '');
    }) ?? null;
    if (!archiveId) {
        const arc: ContainerItem = {
            id: newId('ctn'), type: 'container', x: 80, y: -380, w: 360, h: 300,
            zIndex: s.order.length, locked: false, parentId: null, createdAt: now, createdBy: 'agent',
            title: 'Archive', collapsed: false, scopeLocked: false, borderColor: 'rgba(120,120,135,0.6)',
        };
        ctx.dispatch({ type: 'ADD_ITEM', item: arc });
        archiveId = arc.id;
    }

    let merged = 0, made = 0;
    for (const area of areas) {
        const synthesis = synthByTitle.get(area.title.trim().toLowerCase());
        if (!synthesis) continue;   // model skipped this area — leave it untouched
        const ctn = cur().items[area.containerId];
        if (!ctn) continue;
        const span = `${new Date(area.candidates[0].createdAt || now).toISOString().slice(0, 10)} → ${new Date(area.candidates[area.candidates.length - 1].createdAt || now).toISOString().slice(0, 10)}`;
        const bottom = Math.max(ctn.y + 48, ...area.candidates.map(c => c.y + c.h + 10));
        const synth: TextItem = {
            id: newId('txt'), type: 'text', x: ctn.x + 20, y: bottom, w: 300, h: 120,
            zIndex: cur().order.length, locked: false, parentId: area.containerId,
            createdAt: now, createdBy: 'agent', createdVia: 'gardener',
            content: `${area.title}: 🌿 Consolidated history (${span}, ${area.candidates.length} cards)\n${synthesis}`,
            fontSize: 12, color: '#e8e8ed', border: true, borderColor: 'rgba(59,130,246,0.6)', heading: false,
        } as TextItem;
        ctx.dispatch({ type: 'ADD_ITEM', item: synth });
        made++;
        for (const c of area.candidates) {
            // Un-bake any group-shrink as the card enters the Archive (readable
            // storage, not a vector-scaled layout): restore its authored font /
            // width from the frozen baseline and drop it so it sits full-size.
            const a = c.authoredInParent;
            const unbake = a
                ? { fontSize: a.fontSize ?? c.fontSize, w: a.w ?? c.w, authoredWidth: a.authoredWidth, authoredInParent: undefined }
                : {};
            ctx.dispatch({ type: 'UPDATE_ITEM', id: c.id, patch: { content: `⤵ consolidated ${today}\n${c.content}`, parentId: archiveId, borderColor: 'rgba(120,120,135,0.5)', ...unbake } });
            const conn: Connection = { id: newId('conn'), fromId: c.id, toId: synth.id, label: 'consolidated into', color: 'rgba(120,120,135,0.7)', width: 1.5, arrowHead: true, style: 'solid', createdBy: 'agent' };
            ctx.dispatch({ type: 'ADD_CONNECTION', connection: conn });
            merged++;
        }
    }
    ctx.onToast(merged
        ? `🌿 Gardened: ${merged} old cards → ${made} synthesis card(s); originals archived with audit arrows. Ctrl+Z undoes the whole pass.`
        : 'Gardener made no changes (model returned no usable syntheses).');
}
