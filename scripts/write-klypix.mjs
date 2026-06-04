#!/usr/bin/env node
// write-klypix — assemble a real .klypix canvas from a simple JSON spec.
// The reverse of read-klypix. The build logic (content-aware sizing, BFS
// layout, v4 ZIP output) lives in ./klypix-format.mjs (shared with the MCP
// server) so it has exactly one home.
//
// Usage:
//   node scripts/write-klypix.mjs <spec.json> [--out <file.klypix>]
//   cat spec.json | node scripts/write-klypix.mjs --out board.klypix
//
// Spec:
//   { "title": "...", "cards": [{ "text": "...", "heading"?, "color"? }],
//     "connections": [{ "from": 0, "to": 1, "relationship"? }] }
//   from/to reference a card by INDEX, generated id, or its title (first line).
//   relationship ∈ leads_to | depends_on | relates_to | conflicts_with |
//   supports | questions | costs | blocks.

import fs from 'fs';
import { buildKlypix, atomicWrite } from './klypix-format.mjs';

const args = process.argv.slice(2);
const specPath = args.find(a => !a.startsWith('--'));
const outArg = (() => { const i = args.indexOf('--out'); return i >= 0 ? args[i + 1] : null; })();

let spec;
try {
    const raw = specPath ? fs.readFileSync(specPath, 'utf8') : fs.readFileSync(0, 'utf8');
    spec = JSON.parse(raw);
} catch (e) { console.error('Spec is not valid JSON:', e.message); process.exit(2); }

let buf;
try {
    buf = await buildKlypix(spec);
} catch (e) { console.error(e.message); process.exit(2); }

const outPath = outArg || `${(spec.title || 'untitled').replace(/[^\w\- ]+/g, '').trim() || 'untitled'}.klypix`;
await atomicWrite(outPath, buf);
const cardCount = spec.cards.length;
const connCount = Array.isArray(spec.connections) ? spec.connections.length : 0;
console.log(`Wrote ${outPath} — ${cardCount} cards, ${connCount} connections.`);
console.log(`Open it in KLYPIX (Canvas → Open), or verify: node scripts/read-klypix.mjs "${outPath}"`);
