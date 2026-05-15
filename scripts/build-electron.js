import fs from 'node:fs';
import path from 'node:path';

// Ensure dist-electron/package.json enforces CommonJS to prevent ESM Require errors
const pkgPath = 'dist-electron/package.json';
fs.writeFileSync(pkgPath, JSON.stringify({ type: 'commonjs' }, null, 2));

// Recursively rename all .js files to .cjs in dist-electron/
function renameJsToCjs(dir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
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
