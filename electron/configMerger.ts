// Safe, atomic merge of a single MCP server entry into a Claude Desktop config
// (claude_desktop_config.json). The entire "let the app write to the user's
// system file" story rests on this NEVER clobbering their other MCP servers
// (filesystem, github, brave-search, …): read → merge ONLY our entry → back up
// the original → write a temp file → verify it parses → atomic rename. Broken
// JSON aborts with a clear error instead of overwriting anything.
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

export interface ClaudeConfigLocation {
    path: string;
    exists: boolean;
    variant: 'standard' | 'store'; // installer (.exe) vs Microsoft Store package
}

function fileExists(p: string): boolean {
    try { return fs.statSync(p).isFile(); } catch { return false; }
}
function safeReaddir(p: string): string[] {
    try { return fs.readdirSync(p); } catch { return []; }
}

// Claude Desktop on Windows stores claude_desktop_config.json in ONE of two
// places depending on how it was installed:
//   • standard installer → %APPDATA%\Claude\claude_desktop_config.json
//   • Microsoft Store     → %LOCALAPPDATA%\Packages\Claude_*\LocalCache\Roaming\Claude\claude_desktop_config.json
// We probe both (the Store build is what most users on Win11 actually have).
export function findClaudeConfigLocations(): ClaudeConfigLocation[] {
    const locs: ClaudeConfigLocation[] = [];
    const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
    const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');

    const std = path.join(appData, 'Claude', 'claude_desktop_config.json');
    locs.push({ path: std, exists: fileExists(std), variant: 'standard' });

    const pkgs = path.join(localAppData, 'Packages');
    for (const name of safeReaddir(pkgs)) {
        if (!/^Claude_/i.test(name)) continue;
        const p = path.join(pkgs, name, 'LocalCache', 'Roaming', 'Claude', 'claude_desktop_config.json');
        locs.push({ path: p, exists: fileExists(p), variant: 'store' });
    }
    return locs;
}

// The single best path to write to: an existing config wins (prefer the Store
// variant if present — the packaged Claude ignores the %APPDATA% one). If none
// exist we return the standard path and let the caller create it.
export function resolveClaudeConfigPath(): { path: string; exists: boolean; variant: 'standard' | 'store'; allExisting: string[] } {
    const locs = findClaudeConfigLocations();
    const existing = locs.filter(l => l.exists);
    if (existing.length) {
        const chosen = existing.find(l => l.variant === 'store') || existing[0];
        return { path: chosen.path, exists: true, variant: chosen.variant, allExisting: existing.map(l => l.path) };
    }
    const std = locs.find(l => l.variant === 'standard') || locs[0];
    return { path: std.path, exists: false, variant: 'standard', allExisting: [] };
}

export interface ParsedConfig { ok: boolean; data?: any; raw?: string; error?: string; }
export function safeReadJsonConfig(p: string): ParsedConfig {
    if (!fileExists(p)) return { ok: true, data: {}, raw: '' }; // missing == empty config
    let raw: string;
    try { raw = fs.readFileSync(p, 'utf8'); } catch (e: any) { return { ok: false, error: `Can't read ${p}: ${e?.message || e}` }; }
    const trimmed = raw.trim();
    if (!trimmed) return { ok: true, data: {}, raw };
    try { return { ok: true, data: JSON.parse(trimmed), raw }; }
    catch (e: any) {
        return { ok: false, raw, error: `${path.basename(p)} contains invalid JSON (${e?.message || e}). Open it and fix the syntax, then try again — KLYPIX won't overwrite a broken config.` };
    }
}

export interface MergeResult {
    ok: boolean;
    action?: 'connected' | 'updated' | 'unchanged';
    name?: string;
    path?: string;
    backup?: string;
    otherServers?: string[];
    error?: string;
}

// Merge ONLY the named MCP server entry; every other key and server is left
// byte-for-byte intact. Returns 'unchanged' when our entry already matches.
export function connectMcpServer(opts: { configPath: string; name: string; entry: any }): MergeResult {
    const { configPath, name, entry } = opts;
    const parsed = safeReadJsonConfig(configPath);
    if (!parsed.ok) return { ok: false, error: parsed.error };

    const data = (parsed.data && typeof parsed.data === 'object' && !Array.isArray(parsed.data)) ? parsed.data : {};
    if (!data.mcpServers || typeof data.mcpServers !== 'object' || Array.isArray(data.mcpServers)) data.mcpServers = {};

    const existed = Object.prototype.hasOwnProperty.call(data.mcpServers, name);
    const before = JSON.stringify(data.mcpServers[name] ?? null);
    data.mcpServers[name] = entry;
    const after = JSON.stringify(entry);
    const otherServers = Object.keys(data.mcpServers).filter(k => k !== name);

    if (existed && before === after) return { ok: true, action: 'unchanged', name, path: configPath, otherServers };

    try {
        fs.mkdirSync(path.dirname(configPath), { recursive: true });
        let backup: string | undefined;
        if (parsed.raw) {
            backup = configPath + '.klypix-bak';
            try { fs.writeFileSync(backup, parsed.raw, 'utf8'); } catch { backup = undefined; }
        }
        const tmp = configPath + '.klypix-tmp';
        fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
        JSON.parse(fs.readFileSync(tmp, 'utf8')); // paranoia: verify the temp parses before swapping
        fs.renameSync(tmp, configPath);            // libuv MoveFileEx → atomic replace on Windows
        return { ok: true, action: existed ? 'updated' : 'connected', name, path: configPath, backup, otherServers };
    } catch (e: any) {
        return { ok: false, error: `Couldn't write ${configPath}: ${e?.message || e}` };
    }
}
