#!/usr/bin/env node
// Build a .mcpb Desktop Extension bundle for klypix-mcp — the one-click install
// artifact (Claude Desktop → drag-in / double-click, no JSON editing, no npx).
// A .mcpb is a ZIP with a root manifest.json + a self-contained Node server
// (bin + src + bundled node_modules). Claude Desktop substitutes ${__dirname}
// to the unpacked extension dir and ${user_config.vault} to the folder the user
// picks in the install dialog.
//
// Run from the repo root:  node scripts/build-mcpb.mjs
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import JSZip from 'jszip';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const PKG = path.join(ROOT, 'packages', 'klypix-mcp');
const OUT_DIR = path.join(PKG, 'dist');
const pkg = JSON.parse(fs.readFileSync(path.join(PKG, 'package.json'), 'utf8'));

const manifest = {
    manifest_version: '0.2',
    name: 'klypix-mcp',
    display_name: 'KLYPIX Canvas',
    version: pkg.version,
    description: 'Read & write your open, local-first .klypix canvases from any agent — list, read (with images), search, create, and add cards.',
    long_description: 'KLYPIX canvases are one open, portable file (.klypix) that holds your whole project spatially — text, images, files, code, and the connections between them. This extension lets your agent read and write them over MCP. Local-first, model-agnostic, no lock-in.',
    author: { name: 'Dahshan Labs', url: 'https://klypix.com' },
    homepage: 'https://klypix.com',
    documentation: 'https://github.com/dahshanlabs/klypix-mcp',
    license: 'MIT',
    icon: 'icon.png',
    server: {
        type: 'node',
        entry_point: 'bin/klypix-mcp.mjs',
        mcp_config: {
            command: 'node',
            args: ['${__dirname}/bin/klypix-mcp.mjs', '--vault', '${user_config.vault}'],
        },
    },
    tools: [
        { name: 'list_canvases', description: 'List every .klypix canvas in the vault.' },
        { name: 'read_canvas', description: 'Read a canvas as structured markdown + its images.' },
        { name: 'search_canvases', description: 'Search cards, titles, and #tags across all canvases.' },
        { name: 'create_canvas', description: 'Create a new .klypix canvas from cards + connections.' },
        { name: 'add_to_canvas', description: 'Append cards (and connections) to an existing canvas.' },
    ],
    user_config: {
        vault: {
            type: 'directory',
            title: 'Canvas vault folder',
            description: 'The folder your .klypix canvases live in (e.g. your Desktop).',
            required: true,
            default: '${HOME}/Desktop',
        },
    },
    compatibility: { runtimes: { node: '>=18' } },
};

// Files/dirs to include in the bundle (self-contained: server + deps).
const INCLUDE = ['bin', 'src', 'index.mjs', 'package.json', 'README.md', 'FORMAT.md', 'LICENSE', 'node_modules'];

function addDirToZip(zip, absDir, zipPrefix) {
    for (const entry of fs.readdirSync(absDir, { withFileTypes: true })) {
        const abs = path.join(absDir, entry.name);
        const zp = zipPrefix ? `${zipPrefix}/${entry.name}` : entry.name;
        if (entry.isDirectory()) addDirToZip(zip, abs, zp);
        else if (entry.isFile()) zip.file(zp, fs.readFileSync(abs));
    }
}

async function main() {
    if (!fs.existsSync(path.join(PKG, 'node_modules'))) {
        console.error('node_modules missing in packages/klypix-mcp — run `npm install` there first.');
        process.exit(1);
    }
    const zip = new JSZip();
    zip.file('manifest.json', JSON.stringify(manifest, null, 2));
    let fileCount = 0;
    for (const item of INCLUDE) {
        const abs = path.join(PKG, item);
        if (!fs.existsSync(abs)) { console.warn(`skip (missing): ${item}`); continue; }
        if (fs.statSync(abs).isDirectory()) addDirToZip(zip, abs, item);
        else zip.file(item, fs.readFileSync(abs));
    }
    // Count for the report.
    fileCount = Object.values(zip.files).filter(f => !f.dir).length;

    fs.mkdirSync(OUT_DIR, { recursive: true });
    const outPath = path.join(OUT_DIR, 'klypix-mcp.mcpb');
    const buf = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 9 } });
    fs.writeFileSync(outPath, buf);

    // Verify: re-open the bundle and confirm the load-bearing files are present.
    const check = await JSZip.loadAsync(buf);
    const must = ['manifest.json', 'bin/klypix-mcp.mjs', 'src/klypix-format.mjs', 'node_modules/jszip/package.json'];
    const missing = must.filter(m => !check.file(m));
    const mb = (buf.length / 1024 / 1024).toFixed(1);
    if (missing.length) { console.error(`BUNDLE INVALID — missing: ${missing.join(', ')}`); process.exit(1); }
    console.log(`OK  ${outPath}\n    v${pkg.version} · ${fileCount} files · ${mb} MB · manifest + server + deps verified`);
}

main().catch((e) => { console.error(e); process.exit(1); });
