#!/usr/bin/env node
// brain-conflicts — surface ONLY genuine contradictions between live cards
// (parallel sessions can each decide the SAME thing OPPOSITE ways). It is
// precision-first by design: topical similarity, duplication, and sequential
// supersession are NOT conflicts and are never flagged.
//
// Pipeline: a cheap lexical pre-filter (detectConflicts) finds CANDIDATES
// (same-subject + explicit reversal language); then an LLM contradiction-check
// confirms each before ANYTHING is drawn. No GEMINI_API_KEY → it lists
// candidates but draws NOTHING (never a false-conflict dump). Confirmed
// conflicts get a red `conflicts_with` arrow (canvas + brief). Never auto-
// resolves; never deletes — arbitration is yours.
//
//   node scripts/brain-conflicts.mjs            # show candidates; with a key, which are REAL conflicts
//   node scripts/brain-conflicts.mjs --apply    # back up + draw arrows for LLM-CONFIRMED conflicts only

import fs from 'fs';
import path from 'path';
import { parseKlypix, detectConflicts, addBrainConnections, atomicWrite } from './klypix-format.mjs';

const BRAIN = path.resolve(process.cwd(), 'brain.klypix');
const APPLY = process.argv.includes('--apply');
const KEY = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || '';
const MODEL = 'gemini-2.5-flash';
const head = (t) => (String(t || '').split('\n')[0] || '').replace(/\s+/g, ' ').slice(0, 72);

// LLM gate: returns true ONLY for a genuine contradiction. Anything it can't
// confirm (no key, parse failure, model says no) → false → nothing surfaces.
async function isRealConflict(a, b) {
    if (!KEY) return null; // can't verify
    try {
        const { GoogleGenerativeAI } = await import('@google/generative-ai');
        const model = new GoogleGenerativeAI(KEY).getGenerativeModel({ model: MODEL, generationConfig: { responseMimeType: 'application/json' } });
        const res = await model.generateContent(
            `Two notes from a software project's memory. Do they GENUINELY CONTRADICT — i.e. you could NOT honor both because they make OPPOSING decisions about the SAME thing?\n` +
            `Answer true ONLY for a real contradiction. Merely related, similar, overlapping, duplicate, or one-supersedes-the-other-in-sequence is NOT a contradiction → false.\n` +
            `Return JSON: {"conflict": true|false, "why": "<one short sentence>"}.\n\nNOTE A:\n${a}\n\nNOTE B:\n${b}`
        );
        const v = JSON.parse(res.response.text());
        return { conflict: v.conflict === true, why: String(v.why || '').slice(0, 140) };
    } catch (e) {
        return { conflict: false, why: 'verify-failed: ' + (e?.message || e) };
    }
}

async function main() {
    if (!fs.existsSync(BRAIN)) { console.error('No brain.klypix in', process.cwd()); process.exit(1); }
    const buf = fs.readFileSync(BRAIN);
    const { struct } = await parseKlypix(buf);
    const candidates = detectConflicts(struct);
    if (!candidates.length) { console.log('✓ No conflict candidates (no same-subject pair carries reversal language).'); process.exit(0); }

    console.log(`${candidates.length} candidate pair(s) found by the lexical pre-filter — these are NOT conflicts yet:\n`);
    for (const p of candidates) { console.log(`  ?  A: ${head(p.a)}`); console.log(`     B: ${head(p.b)}`); }

    if (!KEY) {
        console.log('\nNo GEMINI_API_KEY set → cannot verify which (if any) are REAL contradictions.');
        console.log('Drawing NOTHING — a candidate is not a conflict. Set GEMINI_API_KEY and re-run to confirm before any arrow is drawn.');
        process.exit(0);
    }

    console.log('\nVerifying each with the contradiction-check…');
    const confirmed = [];
    for (const p of candidates) {
        const v = await isRealConflict(p.a, p.b);
        if (v && v.conflict) { confirmed.push(p); console.log(`  ⚔️  REAL: ${head(p.a)}  vs  ${head(p.b)}  — ${v.why}`); }
        else console.log(`  ·  not a conflict: ${head(p.a)} / ${head(p.b)}`);
    }
    if (!confirmed.length) { console.log('\n✓ No real contradictions — every candidate was merely related/duplicate. Nothing drawn.'); process.exit(0); }

    if (!APPLY) { console.log(`\n${confirmed.length} REAL conflict(s). Re-run with --apply to draw the arrows (a .bak is made first).`); process.exit(0); }

    const bak = `${BRAIN}.bak-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    fs.copyFileSync(BRAIN, bak);
    const edges = confirmed.map(p => ({ fromId: p.aId, toId: p.bId, relationship: 'conflicts_with', label: 'conflict', color: '#ef4444' }));
    const { buffer: out, added } = await addBrainConnections(buf, edges);
    if (!added) { console.log('All confirmed pairs already connected — nothing to draw.'); process.exit(0); }
    await atomicWrite(BRAIN, out);
    console.log(`\nBacked up → ${path.basename(bak)}\n✓ Drew ${added} conflicts_with arrow(s) for VERIFIED contradictions (they show on the canvas + in the brief).`);
}

main().catch(e => { console.error('brain-conflicts failed:', e?.message || e); process.exit(1); });
