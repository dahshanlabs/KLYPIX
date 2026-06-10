#!/usr/bin/env node
// klypix-brain — a tiny global CLI to manage project brains across all your
// Claude Code projects (the management layer for the global brain hook).
//
//   node klypix-brain.mjs new [title]   create ./brain.klypix in cwd (won't clobber)
//   node klypix-brain.mjs read          print ./brain.klypix's markdown brief
//   node klypix-brain.mjs which         show the active brain path + status
//   node klypix-brain.mjs list [dir]    inventory *.klypix brains under a folder
//
// Lives in the KLYPIX repo (source) and is copied to ~/.claude/project-brain/
// next to klypix-format.mjs (which it imports for build/parse/atomic write).
// Safe by design: `new` refuses to overwrite an existing brain; nothing here
// deletes or moves files. The vault SWITCHER (symlink/Ctrl+O) is intentionally
// NOT here — symlink-swapping ./brain.klypix is a Windows-permission +
// wrong-brain-capture footgun, deferred to the harness UI.

import fs from 'fs';
import path from 'path';
import { buildKlypix, parseKlypix, structToMarkdown, atomicWrite, tidyBrain } from './klypix-format.mjs';

const [, , cmd, ...rest] = process.argv;
const BRAIN = path.resolve(process.cwd(), 'brain.klypix');

async function cmdNew() {
    if (fs.existsSync(BRAIN)) {
        console.error(`A brain already exists here: ${BRAIN}\nRefusing to overwrite. Use "read" to view it.`);
        process.exit(1);
    }
    const title = rest.join(' ').trim() || path.basename(process.cwd());
    const buf = await buildKlypix({
        title,
        cards: [
            { text: `${title} — project brain`, heading: true },
            { text: 'What this is\nThe living spatial memory for this project. Auto-read each session; mark decisions with "🧠 BRAIN [Area]: …" and they are auto-captured here.' },
            { text: 'Open questions\n(add as you go)' },
        ],
        connections: [{ from: 0, to: 1 }, { from: 0, to: 2 }],
    });
    await atomicWrite(BRAIN, buf);
    console.log(`Created ${BRAIN} — "${title}".`);
    console.log('Next session it is auto-read. Mark decisions with: 🧠 BRAIN [Area]: <decision>');
}

async function cmdRead() {
    if (!fs.existsSync(BRAIN)) { console.error(`No brain here. Create one: klypix-brain new`); process.exit(1); }
    const { struct } = await parseKlypix(fs.readFileSync(BRAIN));
    process.stdout.write(structToMarkdown(struct));
}

function cmdWhich() {
    const exists = fs.existsSync(BRAIN);
    console.log(`active brain: ${BRAIN}`);
    console.log(`status:       ${exists ? 'present' : 'absent (run: klypix-brain new)'}`);
    if (exists) {
        let link = '';
        try { if (fs.lstatSync(BRAIN).isSymbolicLink()) link = ` → ${fs.readlinkSync(BRAIN)}`; } catch { /* */ }
        if (link) console.log(`symlink:      ${link.trim()}`);
    }
}

async function cmdList() {
    const root = path.resolve(rest[0] || process.cwd());
    if (!fs.existsSync(root)) { console.error(`Not found: ${root}`); process.exit(1); }
    const found = [];
    const MAX = 2000; let seen = 0;
    const walk = (dir, depth) => {
        if (depth > 4 || seen > MAX) return;
        let entries; try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
        for (const e of entries) {
            if (seen++ > MAX) return;
            if (e.name === 'node_modules' || e.name === '.git' || e.name.startsWith('.tmp')) continue;
            const p = path.join(dir, e.name);
            if (e.isDirectory()) walk(p, depth + 1);
            else if (e.name.toLowerCase().endsWith('.klypix')) found.push(p);
        }
    };
    walk(root, 0);
    if (!found.length) { console.log(`No .klypix brains under ${root}`); return; }
    console.log(`${found.length} brain(s) under ${root}:`);
    for (const f of found) {
        let info = '';
        try { const { struct } = await parseKlypix(fs.readFileSync(f)); info = ` — ${struct.counts.cards} cards, ${struct.counts.connections} conns`; } catch { info = ' — (unreadable)'; }
        console.log(`  ${path.relative(root, f)}${info}`);
    }
}

async function cmdTidy() {
    if (!fs.existsSync(BRAIN)) { console.error('No brain here. Create one: klypix-brain new'); process.exit(1); }
    const orig = fs.readFileSync(BRAIN);
    // Back up first — tidy moves root cards into [Area] containers; the .bak is
    // the escape hatch. tidyBrain itself round-trip-verifies before returning.
    const bak = BRAIN + '.bak';
    try { fs.writeFileSync(bak, orig); } catch { /* non-fatal */ }
    const { buffer, moved, containers } = await tidyBrain(orig);
    await atomicWrite(BRAIN, buffer);
    console.log(`Tidied ${BRAIN} — grouped ${moved} card(s) into ${containers} area container(s).`);
    console.log(`Backup saved: ${bak}`);
}

async function main() {
    switch (cmd) {
        case 'new': return cmdNew();
        case 'read': return cmdRead();
        case 'which': return cmdWhich();
        case 'list': return cmdList();
        case 'tidy': return cmdTidy();
        default:
            console.log('usage: klypix-brain <new [title] | read | which | list [dir] | tidy>');
            process.exit(cmd ? 1 : 0);
    }
}
main().catch(e => { console.error(e?.message || e); process.exit(1); });
