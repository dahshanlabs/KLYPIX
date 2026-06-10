// Solution ③ — install the GLOBAL project-brain hook so a new Claude Code session
// in ANY project with a ./brain.klypix auto-reads it (SessionStart) and auto-captures
// 🧠 markers (Stop). This writes the user's GLOBAL ~/.claude/settings.json, so every
// write is read → merge-only-our-entries → backup → temp → verify-parse → atomic
// rename, and uninstall removes ONLY our entries. Never clobbers other hooks.
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const CLAUDE_DIR = path.join(os.homedir(), '.claude');
const BRAIN_DIR = path.join(CLAUDE_DIR, 'project-brain');
const SETTINGS = path.join(CLAUDE_DIR, 'settings.json');
const HOOK_MARK = 'global-brain-hook'; // identifies OUR hook entries (never touch others)
const SCRIPTS = ['global-brain-hook.mjs', 'klypix-format.mjs', 'klypix-brain.mjs'];
const DEP_PKGS = ['jszip', 'fractional-indexing', 'lie', 'pako', 'immediate', 'setimmediate', 'readable-stream', 'safe-buffer', 'core-util-is', 'inherits', 'isarray', 'process-nextick-args', 'string_decoder', 'util-deprecate'];

function fwd(p: string): string { return p.replace(/\\/g, '/'); }
function exists(p: string): boolean { try { fs.statSync(p); return true; } catch { return false; } }

// Where the hook scripts + their node_modules live to copy FROM: packaged app
// ships them under resources/project-brain; in dev they're the repo scripts/.
function resolveAssetsDir(): { scriptsDir: string; modulesDir: string } | null {
    const resourcesPath = (process as any).resourcesPath as string | undefined;
    const candidates = [
        resourcesPath ? path.join(resourcesPath, 'project-brain') : '', // packaged (extraResources)
        path.join(__dirname, '..', 'scripts'),                                            // dist-electron → repo/scripts
        path.join(process.cwd(), 'scripts'),                                              // dev cwd
    ].filter(Boolean);
    for (const c of candidates) {
        if (exists(path.join(c, 'global-brain-hook.mjs'))) {
            // node_modules: packaged bundle sits next to the scripts; in dev it's repo root.
            const localMods = path.join(c, 'node_modules');
            const repoMods = path.join(c, '..', 'node_modules');
            return { scriptsDir: c, modulesDir: exists(localMods) ? localMods : repoMods };
        }
    }
    return null;
}

function copyDir(src: string, dest: string): void {
    fs.mkdirSync(dest, { recursive: true });
    for (const e of fs.readdirSync(src, { withFileTypes: true })) {
        const s = path.join(src, e.name), d = path.join(dest, e.name);
        if (e.isDirectory()) copyDir(s, d);
        else if (e.isFile()) fs.copyFileSync(s, d);
    }
}

// ── Safe settings.json hooks merge ──────────────────────────────────────────
interface ParsedSettings { ok: boolean; data?: any; raw?: string; error?: string; }
function readSettings(): ParsedSettings {
    if (!exists(SETTINGS)) return { ok: true, data: {}, raw: '' };
    let raw: string;
    try { raw = fs.readFileSync(SETTINGS, 'utf8'); } catch (e: any) { return { ok: false, error: `Can't read ${SETTINGS}: ${e?.message || e}` }; }
    const t = raw.trim();
    if (!t) return { ok: true, data: {}, raw };
    try { return { ok: true, data: JSON.parse(t), raw }; }
    catch (e: any) { return { ok: false, raw, error: `~/.claude/settings.json is invalid JSON (${e?.message || e}). Fix it and retry — KLYPIX won't overwrite a broken config.` }; }
}
function writeSettingsAtomic(data: any, raw?: string): void {
    fs.mkdirSync(CLAUDE_DIR, { recursive: true });
    if (raw) { try { fs.writeFileSync(SETTINGS + '.klypix-bak', raw, 'utf8'); } catch { /* best effort */ } }
    const tmp = SETTINGS + '.klypix-tmp';
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
    JSON.parse(fs.readFileSync(tmp, 'utf8')); // verify before swap
    fs.renameSync(tmp, SETTINGS);
}
function brainCommand(capture: boolean): string {
    return `node "${fwd(path.join(BRAIN_DIR, 'global-brain-hook.mjs'))}"${capture ? ' --capture' : ''}`;
}
// True if a hooks-array already contains one of OUR entries.
function hasOurs(arr: any[]): boolean {
    return Array.isArray(arr) && arr.some(g => Array.isArray(g?.hooks) && g.hooks.some((h: any) => typeof h?.command === 'string' && h.command.includes(HOOK_MARK)));
}
function stripOurs(arr: any[]): any[] {
    if (!Array.isArray(arr)) return [];
    return arr
        .map(g => (g && Array.isArray(g.hooks)) ? { ...g, hooks: g.hooks.filter((h: any) => !(typeof h?.command === 'string' && h.command.includes(HOOK_MARK))) } : g)
        .filter(g => !g || !Array.isArray(g.hooks) || g.hooks.length > 0);
}

// Pure transformation of the settings object: add (install) or remove (uninstall)
// ONLY our SessionStart+Stop entries. Idempotent. Never touches other hooks/keys.
export function mergeBrainHooks(data: any, install: boolean): any {
    const d = (data && typeof data === 'object' && !Array.isArray(data)) ? data : {};
    if (install) {
        if (!d.hooks || typeof d.hooks !== 'object' || Array.isArray(d.hooks)) d.hooks = {};
        for (const [evt, capture] of [['SessionStart', false], ['Stop', true]] as const) {
            const cleaned = stripOurs(Array.isArray(d.hooks[evt]) ? d.hooks[evt] : []); // drop stale ours → add fresh
            cleaned.push({ hooks: [{ type: 'command', command: brainCommand(capture) }] });
            d.hooks[evt] = cleaned;
        }
    } else if (d.hooks && typeof d.hooks === 'object') {
        for (const evt of ['SessionStart', 'Stop']) {
            if (Array.isArray(d.hooks[evt])) { d.hooks[evt] = stripOurs(d.hooks[evt]); if (d.hooks[evt].length === 0) delete d.hooks[evt]; }
        }
        if (Object.keys(d.hooks).length === 0) delete d.hooks;
    }
    return d;
}

export interface BrainHookStatus { installed: boolean; scriptsPresent: boolean; hooksPresent: boolean; settingsPath: string; brainDir: string; parseError: string | null; }
export function projectBrainStatus(): BrainHookStatus {
    const parsed = readSettings();
    const hooks = (parsed.ok && parsed.data?.hooks) ? parsed.data.hooks : {};
    const hooksPresent = hasOurs(hooks.SessionStart) || hasOurs(hooks.Stop);
    const scriptsPresent = exists(path.join(BRAIN_DIR, 'global-brain-hook.mjs')) && exists(path.join(BRAIN_DIR, 'node_modules', 'jszip'));
    return { installed: hooksPresent && scriptsPresent, scriptsPresent, hooksPresent, settingsPath: SETTINGS, brainDir: BRAIN_DIR, parseError: parsed.ok ? null : (parsed.error || null) };
}

export function installProjectBrainHook(): { ok: boolean; error?: string; backup?: string } {
    // 1) refuse if settings.json is broken (don't risk it)
    const parsed = readSettings();
    if (!parsed.ok) return { ok: false, error: parsed.error };
    // 2) copy scripts + deps into ~/.claude/project-brain
    const assets = resolveAssetsDir();
    if (!assets) return { ok: false, error: 'Could not locate the brain hook scripts to install.' };
    try {
        fs.mkdirSync(BRAIN_DIR, { recursive: true });
        for (const s of SCRIPTS) { const src = path.join(assets.scriptsDir, s); if (exists(src)) fs.copyFileSync(src, path.join(BRAIN_DIR, s)); }
        const destMods = path.join(BRAIN_DIR, 'node_modules');
        for (const pkg of DEP_PKGS) { const src = path.join(assets.modulesDir, pkg); if (exists(src) && !exists(path.join(destMods, pkg))) copyDir(src, path.join(destMods, pkg)); }
        fs.writeFileSync(path.join(BRAIN_DIR, 'package.json'), JSON.stringify({ name: 'klypix-project-brain', private: true, type: 'module' }, null, 2), 'utf8');
    } catch (e: any) { return { ok: false, error: `Failed to install hook scripts: ${e?.message || e}` }; }
    // 3) merge our SessionStart + Stop entries (idempotent; preserves others)
    const data = mergeBrainHooks(parsed.data, true);
    try { writeSettingsAtomic(data, parsed.raw); return { ok: true, backup: parsed.raw ? SETTINGS + '.klypix-bak' : undefined }; }
    catch (e: any) { return { ok: false, error: `Failed to write settings.json: ${e?.message || e}` }; }
}

export function uninstallProjectBrainHook(): { ok: boolean; error?: string } {
    const parsed = readSettings();
    if (!parsed.ok) return { ok: false, error: parsed.error };
    const data = mergeBrainHooks(parsed.data, false);
    try { writeSettingsAtomic(data, parsed.raw); return { ok: true }; }
    catch (e: any) { return { ok: false, error: `Failed to write settings.json: ${e?.message || e}` }; }
    // (Leaves ~/.claude/project-brain scripts in place — harmless; removing the hooks
    //  is what disables the behavior.)
}
