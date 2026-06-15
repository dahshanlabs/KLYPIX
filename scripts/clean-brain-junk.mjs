#!/usr/bin/env node
// clean-brain-junk — one-off remover for cards the harvester ingested by
// mistake: marker-SYNTAX documentation captured as real decision/question
// cards (e.g. "Area: ❓ <open question>", "Area: x` → open question (amber)").
//
// The Stop-hook guard was tightened (global-brain-hook.mjs, 2026-06-15) so no
// MORE of these get in; this cleans the ones already there.
//
// SAFE BY DEFAULT: dry-run unless you pass --apply. With --apply it first
// copies brain.klypix to a timestamped .bak, then removes the junk cards (and
// an emptied placeholder "Area" container), re-zips, and refuses to write if
// the result doesn't round-trip through parseKlypix.
//
//   node scripts/clean-brain-junk.mjs            # dry-run: list what it WOULD remove
//   node scripts/clean-brain-junk.mjs --apply    # back up + remove + verify

import fs from 'fs';
import path from 'path';
import { parseKlypix, shard, atomicWrite } from './klypix-format.mjs';

const BRAIN = path.resolve(process.cwd(), 'brain.klypix');
const APPLY = process.argv.includes('--apply');
// Optional targeted sweep: `--match <regex>` also removes text cards whose
// content matches (case-insensitive) — for known noise the shape-rules miss
// (e.g. stale "Test: confirming…" cards). Still dry-run + backup + round-trip.
const MATCH = (() => { const i = process.argv.indexOf('--match'); try { return i >= 0 && process.argv[i + 1] ? new RegExp(process.argv[i + 1], 'i') : null; } catch { return null; } })();

// A text card is junk when its content is marker-syntax documentation, not a
// real finding. Conservative on purpose — every match is printed for eyeball
// before --apply touches anything.
function isJunkText(text) {
    const t = String(text || '');
    const first = (t.split('\n')[0] || '').trim();
    // SHAPE-based only — a card is junk when it IS marker-syntax documentation,
    // never merely because it names a real area "Area" or mentions a legend term
    // mid-sentence (those over-matched real decisions). Three anchored tests:
    const hasPlaceholder = /<(open question|one-line decision|decision|area|placeholder|open|milestone)[^>]*>/i.test(t);
    const hasSyntaxArrow = /→\s*\**(open question|milestone|decision|resolve|update)\b/i.test(t);
    // The first line IS the legend glossary (starts with it) — not a real card
    // discussing "the open question (amber) cards need a border fix".
    const isLegendLine = /^[`*\s❓🏁]*(open question \(amber|milestone \(blue|decision \(green)/i.test(first);
    return hasPlaceholder || hasSyntaxArrow || isLegendLine;
}

async function main() {
    if (!fs.existsSync(BRAIN)) { console.error('No brain.klypix in', process.cwd()); process.exit(1); }
    const buf = fs.readFileSync(BRAIN);
    const { struct, zip, canvas, manifest, isV4 } = await parseKlypix(buf);
    // The surgery below mutates v4-only constructs (order/positions/shard files).
    // A legacy .any keeps items inline, so refuse rather than no-op-and-claim-success.
    if (!isV4 || !canvas.positions) { console.error('clean-brain-junk supports v4 .klypix only (this looks like a legacy .any — open + re-save it in KLYPIX to migrate).'); process.exit(1); }

    const junk = struct.cards.filter(c => c.type === 'text' && (isJunkText(c.text) || (MATCH && MATCH.test(c.text))));
    const junkIds = new Set(junk.map(c => c.id));

    // Remove any container left FULLY empty by the removal (the placeholder
    // "Area" bucket, or e.g. a "Test" container whose only cards were swept) —
    // only when every child is going away, so no live card is ever orphaned.
    for (const ctn of struct.cards.filter(c => c.type === 'container')) {
        const children = struct.cards.filter(c => c.parentId === ctn.id);
        if (children.length > 0 && children.every(c => junkIds.has(c.id))) junkIds.add(ctn.id);
    }

    if (junkIds.size === 0) { console.log('✓ No junk cards found — brain is clean.'); process.exit(0); }

    console.log(`Found ${junkIds.size} card(s) to remove${APPLY ? '' : ' (dry-run — pass --apply to remove)'}:\n`);
    for (const id of junkIds) {
        const c = struct.cards.find(x => x.id === id);
        const label = c ? (c.type === 'container' ? `[container] ${c.title}` : (String(c.text || '').split('\n')[0] || '').slice(0, 90)) : id;
        console.log(`  • ${label}`);
    }

    if (!APPLY) { console.log('\nDry-run only. Re-run with --apply to remove (a .bak is made first).'); process.exit(0); }

    // 1) Back up.
    const bak = `${BRAIN}.bak-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    fs.copyFileSync(BRAIN, bak);
    console.log(`\nBacked up → ${path.basename(bak)}`);

    // 2) Surgically remove from order, positions, item files, and connections.
    canvas.order = (Array.isArray(canvas.order) ? canvas.order : []).filter(id => !junkIds.has(id));
    if (canvas.positions) for (const id of junkIds) delete canvas.positions[id];
    if (Array.isArray(canvas.connections)) canvas.connections = canvas.connections.filter(c => !junkIds.has(c.fromId) && !junkIds.has(c.toId));
    for (const id of junkIds) { try { zip.remove(`items/${shard(id)}/${id}.json`); } catch { /* already gone */ } }

    // 2b) Referential integrity — abort (leaving the .bak) if removal would
    // orphan a surviving card or strand a connection. The round-trip check
    // below can't catch this (parseKlypix nulls a missing parent silently).
    const survivors = new Set(canvas.order);
    for (const c of struct.cards) {
        if (survivors.has(c.id) && c.parentId && !survivors.has(c.parentId)) throw new Error(`integrity: card ${c.id} would be orphaned (parent ${c.parentId} removed)`);
    }
    for (const c of (canvas.connections || [])) {
        if (!survivors.has(c.fromId) || !survivors.has(c.toId)) throw new Error(`integrity: connection ${c.id} references a removed card`);
    }

    zip.file('canvas.json', JSON.stringify(canvas));
    // Keep the manifest's itemCount invariant (= order length), like finalizeBrainZip.
    if (manifest) { manifest.updatedAt = new Date().toISOString(); manifest.stats = manifest.stats || {}; manifest.stats.itemCount = canvas.order.length; zip.file('manifest.json', JSON.stringify(manifest)); }

    // 3) Re-zip and REFUSE to write unless it round-trips (mirrors finalizeBrainZip).
    const out = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
    const check = await parseKlypix(out);
    console.log(`Re-parsed OK: ${check.struct.counts.cards} cards remain (was ${struct.counts.cards}).`);
    await atomicWrite(BRAIN, out);
    console.log('✓ Cleaned brain.klypix written.');
}

main().catch(e => { console.error('clean-brain-junk failed:', e?.message || e); process.exit(1); });
