#!/usr/bin/env node
// backfill-file-tags — make the file-anchor relevance loop work on EXISTING
// cards, not just future captures. The Stop hook now stamps #file-/#dir- tags
// from a turn's edits, but the 89 cards already in the brain have none — so a
// `git diff` token has nothing to match. This scans each card's TEXT for file
// mentions (e.g. "electron/main.ts", "KlypixCanvas.tsx", "global-brain-hook.mjs")
// and stamps the same hyphen-slug anchor tags the hook uses, so retrieval lands
// on the right historical decision immediately.
//
// SAFE: dry-run unless --apply. With --apply it backs up to a timestamped .bak,
// edits each card's item JSON in place, re-zips, asserts referential integrity,
// refuses to write unless it round-trips through parseKlypix, then atomicWrites.
//
//   node scripts/backfill-file-tags.mjs            # dry-run: show what it WOULD tag
//   node scripts/backfill-file-tags.mjs --apply    # back up + tag + verify

import fs from 'fs';
import path from 'path';
import { parseKlypix, shard, atomicWrite } from './klypix-format.mjs';

const BRAIN = path.resolve(process.cwd(), 'brain.klypix');
const APPLY = process.argv.includes('--apply');

// Same slug + tag shape the live hook (fileTagsFor) uses, so a backfilled tag is
// byte-identical to one the hook would stamp — and matches fileQueryTokens.
const slugify = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
// Start only at a real boundary (not mid-word/mid-path), optional dir prefix,
// then stem.ext. The lookbehind + the precision gate below kill prose-fragment
// garbage like "rver.mjs" while keeping genuine filenames.
const FILE_RE = /(?<![\w.\-/\\])((?:[\w-]+[/\\])+)?([A-Za-z0-9][\w-]*)\.(tsx?|jsx?|[mc]js|json|css|scss|md|py|sh|sql|ya?ml|html)\b/g;
function fileTagsFromText(text) {
    const tags = new Set();
    let m;
    FILE_RE.lastIndex = 0;
    while ((m = FILE_RE.exec(String(text || '')))) {
        const pathPart = m[1] || '';
        const rawStem = m[2];
        const stem = slugify(rawStem);
        // Precision gate: keep only filename-shaped stems — has a path, is
        // CamelCase, is hyphenated, or is ≥5 chars. Drops fragments like "rver".
        if (!(pathPart || /[A-Z]/.test(rawStem) || stem.includes('-') || stem.length >= 5)) continue;
        const dir = pathPart ? slugify(pathPart.split(/[/\\]/).filter(Boolean).pop() || '') : '';
        if (stem.length >= 3) tags.add('#file-' + stem);
        if (dir.length >= 3) tags.add('#dir-' + dir);
    }
    return [...tags];
}

async function main() {
    if (!fs.existsSync(BRAIN)) { console.error('No brain.klypix in', process.cwd()); process.exit(1); }
    const { struct, zip, canvas, manifest, isV4 } = await parseKlypix(fs.readFileSync(BRAIN));
    if (!isV4 || !canvas.positions) { console.error('backfill-file-tags supports v4 .klypix only.'); process.exit(1); }

    // For each text card, the file tags it should have minus the ones it already has.
    const plan = [];
    for (const c of struct.cards) {
        if (c.type !== 'text' || !(c.text || '').trim()) continue;
        const existing = new Set((c.tags || []).map(t => String(t).toLowerCase()));
        const want = fileTagsFromText(c.text).filter(t => !existing.has(t.toLowerCase()));
        if (want.length) plan.push({ id: c.id, add: want.slice(0, 5), head: (c.text.split('\n')[0] || '').slice(0, 64) });
    }

    if (!plan.length) { console.log('✓ Nothing to backfill — every card that mentions a file is already tagged.'); process.exit(0); }

    console.log(`Would tag ${plan.length} card(s)${APPLY ? '' : ' (dry-run — pass --apply)'}:\n`);
    for (const p of plan) console.log(`  • ${p.head}  +  ${p.add.join(' ')}`);

    if (!APPLY) { console.log('\nDry-run only. Re-run with --apply (a .bak is made first).'); process.exit(0); }

    const bak = `${BRAIN}.bak-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    fs.copyFileSync(BRAIN, bak);
    console.log(`\nBacked up → ${path.basename(bak)}`);

    // Edit each card's item JSON in place (append the new tags on their own line).
    for (const p of plan) {
        const itemPath = `items/${shard(p.id)}/${p.id}.json`;
        const raw = await (zip.file(itemPath)?.async('string'));
        if (!raw) continue;
        const item = JSON.parse(raw);
        item.content = String(item.content || '').replace(/\s*$/, '') + '\n' + p.add.join(' ');
        zip.file(itemPath, JSON.stringify(item));
    }
    if (manifest) { manifest.updatedAt = new Date().toISOString(); zip.file('manifest.json', JSON.stringify(manifest)); }

    const out = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
    const check = await parseKlypix(out);
    if (check.struct.counts.cards !== struct.counts.cards) throw new Error(`card count changed (${struct.counts.cards} → ${check.struct.counts.cards}) — aborting`);
    const tagged = check.struct.cards.filter(c => (c.tags || []).some(t => /^#?(file|dir)-/.test(String(t)))).length;
    console.log(`Re-parsed OK: ${check.struct.counts.cards} cards, ${tagged} now carry a #file-/#dir- anchor.`);
    await atomicWrite(BRAIN, out);
    console.log('✓ Backfill written.');
}

main().catch(e => { console.error('backfill-file-tags failed:', e?.message || e); process.exit(1); });
