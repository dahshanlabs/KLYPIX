import fs from 'node:fs';
import path from 'node:path';

// Ensure dist-electron/package.json enforces CommonJS to prevent ESM Require errors
const pkgPath = 'dist-electron/package.json';
fs.writeFileSync(pkgPath, JSON.stringify({ type: 'commonjs' }, null, 2));

// Recursively rename all .js files to .cjs in dist-electron/
// SKIP project-brain: that payload is a self-contained ESM bundle (scripts +
// pristine node_modules) shipped verbatim to ~/.claude/project-brain. On a
// RE-run, the renamer used to mangle the previous run's bundled node_modules
// (.js → .cjs broke jszip's main), and the bundle step's skip-if-exists guard
// then preserved the mangled copy forever — broken jszip in the installer.
function renameJsToCjs(dir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isDirectory() && entry.name === 'project-brain') continue;
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      renameJsToCjs(fullPath);
    } else if (entry.name.endsWith('.js') && !entry.name.endsWith('.cjs')) {
      const newPath = fullPath.replace(/\.js$/, '.cjs');
      if (fs.existsSync(newPath)) fs.unlinkSync(newPath);
      fs.renameSync(fullPath, newPath);
    }
  }
}

renameJsToCjs('dist-electron');

// Now fix require paths inside .cjs files to reference .cjs instead of .js
function fixRequirePaths(dir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isDirectory() && entry.name === 'project-brain') continue; // pristine ESM payload
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      fixRequirePaths(fullPath);
    } else if (entry.name.endsWith('.cjs')) {
      let content = fs.readFileSync(fullPath, 'utf8');
      // Fix require("./auth/tokenStore") → require("./auth/tokenStore.cjs")
      // Fix require("./generators/index") → require("./generators/index.cjs")
      const updated = content.replace(
        /require\("(\.\/[^"]+?)"\)/g,
        (match, reqPath) => {
          // If it already ends with .cjs or .json or .node, leave it
          if (reqPath.endsWith('.cjs') || reqPath.endsWith('.json') || reqPath.endsWith('.node')) return match;
          // If it ends with .js, replace with .cjs
          if (reqPath.endsWith('.js')) return `require("${reqPath.replace(/\.js$/, '.cjs')}")`;
          // Check if it's a directory import (./generators → ./generators/index.cjs)
          const fileDir = path.dirname(fullPath);
          const dirIndexPath = path.join(fileDir, reqPath, 'index.cjs');
          if (fs.existsSync(dirIndexPath)) {
            return `require("${reqPath}/index.cjs")`;
          }
          // Otherwise add .cjs extension
          return `require("${reqPath}.cjs")`;
        }
      );
      if (updated !== content) {
        fs.writeFileSync(fullPath, updated);
      }
    }
  }
}

fixRequirePaths('dist-electron');

console.log('Electron build fixup complete.');

// Bundle the project-brain hook assets so the packaged app can install them into
// ~/.claude/project-brain (Settings → "auto-load brains in Claude Code"). Ships the
// 3 scripts + their runtime deps; reaches resources/project-brain via extraResources.
const PB_OUT = 'dist-electron/project-brain';
// Always rebuild the payload FRESH — a stale dir from an earlier (pre-skip-fix)
// run may hold renamer-mangled node_modules that the copy guards would preserve.
fs.rmSync(PB_OUT, { recursive: true, force: true });
fs.mkdirSync(PB_OUT, { recursive: true });
for (const s of ['global-brain-hook.mjs', 'klypix-format.mjs', 'klypix-brain.mjs', 'klypix-mcp-server.mjs']) {
  const src = path.join('scripts', s);
  if (fs.existsSync(src)) fs.copyFileSync(src, path.join(PB_OUT, s));
}
const copyTree = (src, dest) => {
  fs.mkdirSync(dest, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const sp = path.join(src, e.name), dp = path.join(dest, e.name);
    if (e.isDirectory()) copyTree(sp, dp); else if (e.isFile()) fs.copyFileSync(sp, dp);
  }
};
for (const dep of ['jszip', 'fractional-indexing', 'lie', 'pako', 'immediate', 'setimmediate', 'readable-stream', 'safe-buffer', 'core-util-is', 'inherits', 'isarray', 'process-nextick-args', 'string_decoder', 'util-deprecate']) {
  const s = path.join('node_modules', dep);
  if (fs.existsSync(s) && !fs.existsSync(path.join(PB_OUT, 'node_modules', dep))) copyTree(s, path.join(PB_OUT, 'node_modules', dep));
}
// MCP server deps — DEPENDENCY CLOSURE (walk each package.json's deps, BFS) so
// @modelcontextprotocol/sdk's transitive tree ships too; a hand list would
// silently break on an SDK update. Powers the bundled klypix-mcp-server.mjs
// (node ~/.claude/project-brain/... — instant MCP boot, no npx download).
{
  const queue = ['zod', '@modelcontextprotocol/sdk'];
  const seen = new Set();
  // Enqueue a package dir's deps AND its NESTED node_modules packages' deps —
  // a nested copy (e.g. sdk/node_modules/ajv) resolves ITS deps (fast-uri)
  // from the hoisted top level, so those must ship too.
  const enqueueDepsOf = (pkgDir) => {
    try {
      const pj = JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf8'));
      for (const d of Object.keys(pj.dependencies || {})) queue.push(d);
    } catch { /* no readable package.json */ }
    const nested = path.join(pkgDir, 'node_modules');
    if (!fs.existsSync(nested)) return;
    for (const e of fs.readdirSync(nested, { withFileTypes: true })) {
      if (!e.isDirectory()) continue;
      if (e.name.startsWith('@')) {
        for (const s of fs.readdirSync(path.join(nested, e.name), { withFileTypes: true })) {
          if (s.isDirectory()) enqueueDepsOf(path.join(nested, e.name, s.name));
        }
      } else enqueueDepsOf(path.join(nested, e.name));
    }
  };
  while (queue.length) {
    const dep = queue.shift();
    if (seen.has(dep)) continue;
    seen.add(dep);
    const s = path.join('node_modules', dep);
    if (!fs.existsSync(s)) continue;
    if (!fs.existsSync(path.join(PB_OUT, 'node_modules', dep))) copyTree(s, path.join(PB_OUT, 'node_modules', dep));
    enqueueDepsOf(s);
  }
}
fs.writeFileSync(path.join(PB_OUT, 'package.json'), JSON.stringify({ name: 'klypix-project-brain', private: true, type: 'module' }, null, 2));
console.log('Bundled project-brain hook assets → ' + PB_OUT);
