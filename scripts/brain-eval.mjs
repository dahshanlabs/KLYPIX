#!/usr/bin/env node
// brain-eval — does the project brain actually help an agent?
//
// A reproducible, honest RECALL benchmark (the LongMemEval shape, applied to a
// brain.klypix): we take the brain's OWN decision cards as ground truth, ask a
// model the questions those decisions answer — once WITH the tiered brief in
// context, once WITHOUT (cold) — and an LLM judge scores each answer against the
// recorded decision. The number is: how much project knowledge does the brain
// recover that a cold session would miss, and at what token cost.
//
// What this measures: recall/grounding (does the briefed agent know the
// project's decisions). What it does NOT measure: full agentic task success
// with tool use, or the tokens a cold agent burns RE-DISCOVERING state by
// grepping the repo (that needs a real harness). Stated plainly in the report.
//
//   GEMINI_API_KEY=... node scripts/brain-eval.mjs [--brain ./brain.klypix]
//        [--n 20] [--model gemini-2.5-flash] [--out brain-eval-report.md]
//   KLYPIX_EVAL_MOCK=1 node scripts/brain-eval.mjs   # offline pipeline self-test

import fs from 'fs';
import path from 'path';

const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d; };
const BRAIN = path.resolve(arg('brain', 'brain.klypix'));
const N = Math.max(1, parseInt(arg('n', '20'), 10) || 20);
const MODEL = arg('model', 'gemini-2.5-flash');
const OUT = path.resolve(arg('out', 'brain-eval-report.md'));
const MOCK = process.env.KLYPIX_EVAL_MOCK === '1';
const KEY = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || '';
const flat = (s) => String(s || '').replace(/\s+/g, ' ').trim();
const estTokens = (s) => Math.ceil(String(s || '').length / 4);

// ── Model layer (real Gemini, or a deterministic mock for the pipeline test) ─
let _genAI = null;
async function callModel({ system, user, json }) {
    if (MOCK) return mockModel({ system, user, json });
    if (!KEY) throw new Error('Set GEMINI_API_KEY (or run with KLYPIX_EVAL_MOCK=1 for the offline pipeline self-test).');
    if (!_genAI) { const { GoogleGenerativeAI } = await import('@google/generative-ai'); _genAI = new GoogleGenerativeAI(KEY); }
    const model = _genAI.getGenerativeModel({
        model: MODEL,
        ...(system ? { systemInstruction: system } : {}),
        ...(json ? { generationConfig: { responseMimeType: 'application/json' } } : {}),
    });
    const res = await model.generateContent(user);
    return res.response.text();
}
// Mock: perfect recall WITH the brief, "no context" WITHOUT — lets us verify
// selection/brief/judge/report math offline. Real runs give the honest middle.
function mockModel({ system, user, json }) {
    if (json && /Return JSON.*questions/s.test(user)) {
        const ids = [...user.matchAll(/"id":\s*"([^"]+)"/g)].map(m => m[1]);
        return JSON.stringify({ questions: ids.map(id => ({ id, q: `What did we decide about item ${id}?` })) });
    }
    if (json && /score/i.test(user)) {
        const ids = [...user.matchAll(/"id":\s*"([^"]+)"/g)].map(m => m[1]);
        return JSON.stringify({ scores: ids.map(id => ({ id, withScore: 2, withoutScore: 0 })) });
    }
    const briefed = /CURRENT PROJECT STATE/.test(system || '');
    return briefed ? 'Per the brief, the recorded decision applies.' : "I don't have that project context.";
}
async function withRetry(fn, label) {
    for (let i = 0; i < 3; i++) {
        try { return await fn(); }
        catch (e) { if (i === 2) throw e; await new Promise(r => setTimeout(r, 1500 * (i + 1))); process.stderr.write(`  retry ${label} (${e?.message || e})\n`); }
    }
}

async function main() {
    if (!fs.existsSync(BRAIN)) { console.error(`No brain at ${BRAIN}`); process.exit(1); }
    const lib = await import('./klypix-format.mjs');
    const { struct } = await lib.parseKlypix(fs.readFileSync(BRAIN));

    // 1) Ground truth: substantive, real decision cards (no placeholders/noise,
    //    not archived/superseded). Deterministic: newest-first, take N.
    const NOISE = /<decision>|<open|placeholder|confirming antigravity|→ \*\*|marker\.\*\*|^x`|x` →/i;
    const truth = struct.cards
        .filter(c => c.type !== 'container' && (c.text || '').trim().length > 80
            && !NOISE.test(c.text) && !/^archive$/i.test(c.area || '')
            && !/↩|⤵/.test(c.text))
        .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
        .slice(0, N)
        .map((c, i) => ({ id: `d${i + 1}`, area: c.area || 'Notes', truth: flat(c.text) }));
    if (truth.length < 3) { console.error(`Only ${truth.length} usable decision cards — need ≥3.`); process.exit(1); }

    const brief = lib.structToBrief(struct);
    const briefTokens = estTokens(brief);
    process.stderr.write(`Brain: ${struct.counts.cards} cards · brief ≈${briefTokens} tokens · evaluating ${truth.length} decisions${MOCK ? ' (MOCK)' : ` via ${MODEL}`}…\n`);

    // 2) One question per decision (batched) — phrased WITHOUT leaking the answer.
    const qGen = await withRetry(() => callModel({
        json: true,
        system: 'You write questions for a project-knowledge quiz.',
        user: `For each decision below, write ONE natural question a teammate resuming the project would ask, that this decision ANSWERS — without revealing the answer in the question. Return JSON: {"questions":[{"id":"<id>","q":"<question>"}]}.\n\n${JSON.stringify(truth.map(t => ({ id: t.id, area: t.area, decision: t.truth })))}`,
    }), 'qgen');
    const qById = new Map();
    try { for (const x of JSON.parse(qGen).questions || []) qById.set(x.id, x.q); } catch { /* fall back below */ }
    for (const t of truth) t.q = qById.get(t.id) || `What did we decide regarding ${t.area}?`;

    // 3) Answer each question WITH the brief and WITHOUT it (isolated contexts).
    const SYS_WITH = `You are a teammate resuming work on this project. Answer the question concisely from the CURRENT PROJECT STATE below. If it isn't covered, say you don't know.\n\nCURRENT PROJECT STATE:\n${brief}`;
    const SYS_WITHOUT = 'You are a teammate resuming work on a software project. Answer the question concisely from what you know. If you do not have the project-specific context, say you don\'t know rather than guessing.';
    for (const t of truth) {
        t.aWith = flat(await withRetry(() => callModel({ system: SYS_WITH, user: t.q }), `ans-with ${t.id}`));
        t.aWithout = flat(await withRetry(() => callModel({ system: SYS_WITHOUT, user: t.q }), `ans-without ${t.id}`));
        process.stderr.write('.');
    }
    process.stderr.write('\n');

    // 4) Judge both answers against ground truth (batched). 0 wrong/unknown,
    //    1 partial, 2 correct.
    const judged = await withRetry(() => callModel({
        json: true,
        system: 'You are a strict grader. Score how well an answer matches the known correct decision.',
        user: `Score each answer 0 (wrong or "don't know"), 1 (partially correct), or 2 (correct — captures the decision). Grade WITH and WITHOUT independently. Return JSON: {"scores":[{"id":"<id>","withScore":N,"withoutScore":N}]}.\n\n${JSON.stringify(truth.map(t => ({ id: t.id, question: t.q, correct_decision: t.truth, answer_WITH: t.aWith, answer_WITHOUT: t.aWithout })))}`,
    }), 'judge');
    const scoreById = new Map();
    try { for (const s of JSON.parse(judged).scores || []) scoreById.set(s.id, s); } catch { console.error('Judge returned unparseable JSON; aborting.'); process.exit(1); }
    for (const t of truth) { const s = scoreById.get(t.id) || {}; t.withScore = Number(s.withScore) || 0; t.withoutScore = Number(s.withoutScore) || 0; }

    // 5) Report.
    const n = truth.length;
    const sum = (k) => truth.reduce((a, t) => a + t[k], 0);
    const pct = (v) => `${Math.round((v / (n * 2)) * 100)}%`;
    const recovered = truth.filter(t => t.withScore >= 1 && t.withoutScore === 0).length;
    const md = [];
    md.push(`# Brain eval — ${struct.title}`);
    md.push(`*${n} decisions · model ${MOCK ? 'MOCK' : MODEL} · brief ≈${briefTokens} tokens · ${new Date().toISOString().slice(0, 10)}*`);
    md.push('');
    md.push('| Metric | With brain | Without brain |');
    md.push('|---|---|---|');
    md.push(`| Recall accuracy (0–2 graded) | **${pct(sum('withScore'))}** | ${pct(sum('withoutScore'))} |`);
    md.push(`| Decisions answered correctly (=2) | ${truth.filter(t => t.withScore === 2).length}/${n} | ${truth.filter(t => t.withoutScore === 2).length}/${n} |`);
    md.push('');
    md.push(`**${recovered}/${n}** decisions the brain recovered that a cold session got wrong or didn't know. Brief cost: **≈${briefTokens} tokens/session**, flat as the brain grows.`);
    md.push('');
    md.push('<details><summary>Per-decision detail</summary>\n');
    md.push('| Area | Question | With | Without |');
    md.push('|---|---|---|---|');
    for (const t of truth) md.push(`| ${t.area} | ${t.q.replace(/\|/g, '\\|').slice(0, 80)} | ${t.withScore} | ${t.withoutScore} |`);
    md.push('\n</details>');
    md.push('');
    md.push('## Method & honest scope');
    md.push('- Ground truth = the brain\'s own decision cards; questions are LLM-generated from each decision (answer not leaked), answers LLM-judged 0/1/2.');
    md.push('- Measures **recall/grounding** (does a briefed agent know the project\'s decisions), the LongMemEval shape — NOT full agentic task success, and NOT the tokens a cold agent burns re-discovering state by grepping (that needs a live coding harness).');
    md.push('- Reproducible: same brain + model → re-run to verify. Self-generated questions favor recall; treat the WITH/WITHOUT *delta* as the signal, not the absolute.');
    const report = md.join('\n') + '\n';
    fs.writeFileSync(OUT, report);
    process.stderr.write(`\n${'='.repeat(60)}\n`);
    process.stdout.write(report);
    process.stderr.write(`${'='.repeat(60)}\nReport written to ${OUT}\n`);
}
main().catch(e => { console.error('eval failed:', e?.message || e); process.exit(1); });
