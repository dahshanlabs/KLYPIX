#!/usr/bin/env node
// global-brain-hook — zero-setup project brain for ANY Claude Code project.
//
// Installed to ~/.claude/project-brain/ and wired into the GLOBAL
// ~/.claude/settings.json so it runs for every project:
//   SessionStart (no arg) → if ./brain.klypix exists, print its markdown brief
//     to stdout; the harness injects that as session context.
//   Stop (--capture)      → harvest "🧠 BRAIN [Area]: …" markers from the
//     transcript (hook JSON on stdin) into ./brain.klypix, deduped.
//
// Bulletproof by contract: it runs on EVERY session/turn in EVERY project, so
// it must be an INSTANT no-op when there's no ./brain.klypix, must NEVER throw,
// and must ALWAYS exit 0. The format/IO work is lazy-imported only when a brain
// is actually present, keeping non-brain projects to a bare existsSync.
//
// This is the source-of-truth copy (lives in the KLYPIX repo, version
// controlled); it is copied to ~/.claude/project-brain/ alongside
// klypix-format.mjs (+ a node_modules with jszip) where it actually runs.

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

const CWD = process.cwd();
const BRAIN = path.resolve(CWD, 'brain.klypix');
const STATE = path.resolve(CWD, '.claude', 'brain-capture-state.json');
// 🧠 BRAIN [Area]: decision  ·  [Area] ?: open question  ·  [Area] !: milestone
const MARKER = /🧠\s*BRAIN\s*(?:\[([^\]]+)\])?\s*([?!]?)\s*:\s*(.+)$/i;
const sha = (s) => crypto.createHash('sha1').update(s).digest('hex').slice(0, 16);

const readState = () => { try { return new Set(JSON.parse(fs.readFileSync(STATE, 'utf8')).seen || []); } catch { return new Set(); } };
const writeState = (seen) => { try { fs.mkdirSync(path.dirname(STATE), { recursive: true }); fs.writeFileSync(STATE, JSON.stringify({ seen: [...seen].slice(-2000) })); } catch { /* ignore */ } };

// Pull assistant text out of one transcript line (Claude Code JSONL: content is
// a string or an array of {type:'text',text}).
function textOf(entry) {
    const m = entry?.message ?? entry;
    if (m?.role !== 'assistant') return '';
    const c = m.content;
    if (typeof c === 'string') return c;
    if (Array.isArray(c)) return c.filter(p => p?.type === 'text' && typeof p.text === 'string').map(p => p.text).join('\n');
    return '';
}

async function capture(lib) {
    let tp = '';
    try { tp = JSON.parse(fs.readFileSync(0, 'utf8') || '{}').transcript_path || ''; } catch { /* no stdin */ }
    if (!tp || !fs.existsSync(tp)) return;
    let lines; try { lines = fs.readFileSync(tp, 'utf8').split('\n').filter(Boolean); } catch { return; }
    const seen = readState();
    const cards = [];
    for (const ln of lines) {
        let e; try { e = JSON.parse(ln); } catch { continue; }
        const text = textOf(e);
        if (!text.includes('🧠')) continue;
        for (const raw of text.split('\n')) {
            const m = MARKER.exec(raw.trim()); if (!m) continue;
            const area = (m[1] || '').trim(), type = m[2] || '', body = m[3].trim(); if (!body) continue;
            // Type → scannable prefix + border color: ? open question (amber),
            // ! milestone (blue), else decision (green).
            const prefix = type === '?' ? '❓ ' : type === '!' ? '🏁 ' : '';
            const borderColor = type === '?' ? 'rgba(245,166,35,0.8)' : type === '!' ? 'rgba(59,130,246,0.8)' : 'rgba(16,185,129,0.6)';
            const card = (area ? `${area}: ${prefix}${body}` : `${prefix}${body}`) + (area ? `\n#${area.toLowerCase().replace(/[^a-z0-9]+/g, '-')}` : '');
            // Same hash as the legacy brain-capture.mjs so a project's existing
            // state file stays compatible (no double-capture during the switch
            // to the global hook). State is already per-project; the vault
            // cross-brain footgun is handled by per-brain state files in Phase 3.
            const key = sha((area + '|' + body).toLowerCase());
            if (seen.has(key)) continue;
            seen.add(key); cards.push({ text: card, area, borderColor });
        }
    }
    if (!cards.length) return;
    // Route each captured decision INTO its [Area] container (find-or-create) so
    // the brain stays a clean areas-as-containers map, not a rightward strip.
    const buf = await lib.appendIntoContainers(fs.readFileSync(BRAIN), { cards: cards.map(c => ({ text: c.text, color: '#e8e8ed', borderColor: c.borderColor, area: c.area })) });
    // Re-pack the whole grid so a container that grew never overlaps its neighbor.
    let out = buf; try { out = (await lib.tidyBrain(buf)).buffer; } catch { /* keep append result if tidy fails */ }
    await lib.atomicWrite(BRAIN, out);
    writeState(seen);
    process.stderr.write(`[brain] captured ${cards.length} decision(s) → brain.klypix\n`);
}

async function read(lib) {
    const { struct } = await lib.parseKlypix(fs.readFileSync(BRAIN));
    process.stdout.write(lib.structToMarkdown(struct));
}

async function main() {
    if (!fs.existsSync(BRAIN)) return;                  // not a brain project → instant no-op
    const lib = await import('./klypix-format.mjs');    // lazy: only when a brain exists
    if (process.argv.includes('--capture')) await capture(lib); else await read(lib);
}
main().catch(() => { /* never break a session */ }).finally(() => process.exit(0));
