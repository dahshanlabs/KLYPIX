// Recursively rename all .js files in dist-electron/ to .cjs
// and fix require() paths to use .cjs extension
const fs = require('fs');
const path = require('path');

const dir = path.join(__dirname, '..', 'dist-electron');

function walk(d) {
    const entries = fs.readdirSync(d, { withFileTypes: true });
    for (const entry of entries) {
        const full = path.join(d, entry.name);
        if (entry.isDirectory()) {
            walk(full);
        } else if (entry.name.endsWith('.js')) {
            const cjs = full.replace(/\.js$/, '.cjs');
            // Read content and fix require paths to .cjs
            let content = fs.readFileSync(full, 'utf-8');
            // Fix relative requires: require("./auth/authGuard") → require("./auth/authGuard.cjs")
            content = content.replace(/require\("(\.\.?\/[^"]+?)"\)/g, (match, p) => {
                // Don't touch node_modules or already .cjs paths
                if (p.includes('node_modules') || p.endsWith('.cjs') || p.endsWith('.json') || p.endsWith('.node')) return match;
                return `require("${p}.cjs")`;
            });
            if (fs.existsSync(cjs)) fs.unlinkSync(cjs);
            fs.writeFileSync(cjs, content, 'utf-8');
            fs.unlinkSync(full);
        }
    }
}

walk(dir);
console.log('Renamed all .js → .cjs in dist-electron/');
