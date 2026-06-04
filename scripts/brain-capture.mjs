#!/usr/bin/env node
// brain-capture — the "automatic" half of the project brain.
//
// Run by a Claude Code Stop hook. It reads the session transcript, finds the
// decision markers the agent left inline — lines of the form:
//     🧠 BRAIN: <one-line decision/finding>          (optionally  🧠 BRAIN [Area]: …)
// — and appends each as a card to brain.klypix, deduped so a marker is captured
// exactly once across the whole session.
//
// Why a marker (not pure auto): a hook can't reason, and auto-dumping every turn
// would make the brain noise. The AGENT curates (it only emits 🧠 BRAIN for real
// decisions); this script just harvests — so capture is automatic AND curated.
//
// Hook contract: receives the hook JSON on stdin (incl. transcript_path), cwd =
// project root. Output is ignored by Stop hooks; we stay silent + never throw.

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { appendToKlypix, atomicWrite } from './klypix-format.mjs';

const BRAIN = path.resolve('brain.klypix');
const STATE = path.resolve('.claude', 'brain-capture-state.json');
const MARKER = /🧠\s*BRAIN\s*(?:\[([^\]]+)\])?\s*:\s*(.+)$/i;

function readState() {
    try { return new Set(JSON.parse(fs.readFileSync(STATE, 'utf8')).seen || []); } catch { return new Set(); }
}
function writeState(seen) {
    try {
        fs.mkdirSync(path.dirname(STATE), { recursive: true });
        // Cap so the state file can't grow unbounded.
        fs.writeFileSync(STATE, JSON.stringify({ seen: [...seen].slice(-2000) }));
    } catch { /* ignore */ }
}
const hash = (s) => crypto.createHash('sha1').update(s).digest('hex').slice(0, 16);

// Pull every text fragment out of one transcript line (Claude Code JSONL: an
// assistant message whose content is a string or an array of {type:'text',text}).
function textOf(entry) {
    const m = entry?.message ?? entry;
    if (m?.role !== 'assistant') return '';
    const c = m.content;
    if (typeof c === 'string') return c;
    if (Array.isArray(c)) return c.filter(p => p?.type === 'text' && typeof p.text === 'string').map(p => p.text).join('\n');
    return '';
}

async function main() {
    if (!fs.existsSync(BRAIN)) return; // no brain in this project → nothing to do
    let transcriptPath = '';
    try {
        const raw = fs.readFileSync(0, 'utf8');
        transcriptPath = JSON.parse(raw || '{}').transcript_path || '';
    } catch { /* no stdin */ }
    if (!transcriptPath || !fs.existsSync(transcriptPath)) return;

    let lines;
    try { lines = fs.readFileSync(transcriptPath, 'utf8').split('\n').filter(Boolean); } catch { return; }

    const seen = readState();
    const newCards = [];
    for (const ln of lines) {
        let entry; try { entry = JSON.parse(ln); } catch { continue; }
        const text = textOf(entry);
        if (!text.includes('🧠')) continue;
        for (const raw of text.split('\n')) {
            const m = MARKER.exec(raw.trim());
            if (!m) continue;
            const area = (m[1] || '').trim();
            const body = m[2].trim();
            if (!body) continue;
            const card = (area ? `${area}: ${body}` : body) + (area ? `\n#${area.toLowerCase().replace(/[^a-z0-9]+/g, '-')}` : '');
            const key = hash((area + '|' + body).toLowerCase());
            if (seen.has(key)) continue;
            seen.add(key);
            newCards.push(card);
        }
    }
    if (newCards.length === 0) return;

    try {
        const buf = await appendToKlypix(fs.readFileSync(BRAIN), { cards: newCards.map(text => ({ text, color: '#8b9cff' })) });
        await atomicWrite(BRAIN, buf);
        writeState(seen);
        process.stderr.write(`[brain-capture] appended ${newCards.length} decision(s) to brain.klypix\n`);
    } catch (e) {
        process.stderr.write(`[brain-capture] append failed: ${e?.message || e}\n`);
    }
}

main();
