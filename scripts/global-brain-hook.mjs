#!/usr/bin/env node
// global-brain-hook — zero-setup project brain for ANY Claude Code project.
//
// Installed to ~/.claude/project-brain/ and wired into the GLOBAL
// ~/.claude/settings.json so it runs for every project:
//   SessionStart (no arg) → if ./brain.klypix exists, print its markdown brief
//     to stdout; the harness injects that as session context.
//   Stop (--capture)      → harvest "🧠 BRAIN [Area]: …" markers from the
//     transcript (hook JSON on stdin) into ./brain.klypix, deduped.
//
// Bulletproof by contract: it runs on EVERY session/turn in EVERY project, so
// it must be an INSTANT no-op when there's no ./brain.klypix, must NEVER throw,
// and must ALWAYS exit 0. The format/IO work is lazy-imported only when a brain
// is actually present, keeping non-brain projects to a bare existsSync.
//
// This is the source-of-truth copy (lives in the KLYPIX repo, version
// controlled); it is copied to ~/.claude/project-brain/ alongside
// klypix-format.mjs (+ a node_modules with jszip) where it actually runs.

import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import { execSync } from 'child_process';

const CWD = process.cwd();
const BRAIN = path.resolve(CWD, 'brain.klypix');
const STATE = path.resolve(CWD, '.claude', 'brain-capture-state.json');
// 🧠 BRAIN [Area]: decision  ·  [Area] ?: open question  ·  [Area] !: milestone
//                · [Area] ✓: resolves the matching existing card (archives it)
//                · [Area] ~: updates the matching card IN PLACE (small corrections)
const MARKER = /🧠\s*BRAIN\s*(?:\[([^\]]+)\])?\s*([?!✓~]?)\s*:\s*(.+)$/i;
const sha = (s) => crypto.createHash('sha1').update(s).digest('hex').slice(0, 16);
// Normalize a brain path so the SAME project resolves to ONE identity (registry
// entry AND cache key). On a case-insensitive FS the CWD can surface as "E:/…"
// one run and "e:/…" the next; without lowercasing the drive that split one
// project into two registry entries AND two parse-cache files.
const normBrainPath = (p) => String(p).replace(/\\/g, '/').replace(/^[a-zA-Z]:/, (m) => m.toLowerCase());

const readState = () => { try { return new Set(JSON.parse(fs.readFileSync(STATE, 'utf8')).seen || []); } catch { return new Set(); } };
const writeState = (seen) => { try { fs.mkdirSync(path.dirname(STATE), { recursive: true }); fs.writeFileSync(STATE, JSON.stringify({ seen: [...seen].slice(-2000) })); } catch { /* ignore */ } };

// --- Observability (added 2026-06-15) -----------------------------------
// The hook is bulletproof-by-contract: it swallows every error and exits 0,
// and it runs from a COPIED live file. That makes silent failure (stale copy,
// missing jszip, unreadable transcript) and silent corruption (junk markers
// captured as real cards) invisible. These two append-only logs make both
// observable without breaking the never-throw contract — every write is
// wrapped and best-effort.
//   LEDGER  (per-project): every capture DECISION — added / skipped-seen /
//           skipped-example / resolve / update — so you can see exactly what
//           the harvester did (and didn't) ingest, and why.
//   HEALTH  (global): one line per hook run — mode, ok/err, brain + brief
//           bytes — so a dead/stale/unsynced live copy stops being invisible.
const LEDGER = path.resolve(CWD, '.claude', 'brain-capture-log.jsonl');
const HEALTH = path.join(os.homedir(), '.claude', 'project-brain', '.hook-health.jsonl');
const LOCK = path.resolve(CWD, '.claude', 'brain-capture.lock');   // serialize concurrent captures
const DRY = process.argv.includes('--dry-run');   // inspect a capture without writing
const nowIso = () => { try { return new Date().toISOString(); } catch { return ''; } };
const brainBytes = () => { try { return fs.statSync(BRAIN).size; } catch { return 0; } };
function appendJsonl(file, obj, maxLines = 0) {
    try {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        if (maxLines > 0 && fs.existsSync(file)) {
            const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
            lines.push(JSON.stringify(obj));
            fs.writeFileSync(file, lines.slice(-maxLines).join('\n') + '\n');
        } else {
            fs.appendFileSync(file, JSON.stringify(obj) + '\n');
        }
    } catch { /* observability is best-effort — never break the session */ }
}

// Serialize concurrent captures (3 simultaneous sessions all hit Stop). atomic-
// Write stops CORRUPTION but not LOST UPDATES — each session reads the same base
// and the last writer wins, so the others' cards vanish. Advisory lockfile:
// O_EXCL create wins the lock; a held lock is waited on (sync sleep via Atomics,
// no busy-spin); a STALE lock (older than a sub-second capture should ever take)
// is stolen so a crashed session can't wedge the brain forever. Best-effort: if
// it can't get the lock within the budget it writes anyway (better than dropping
// the markers) and flags it in the health log.
const LOCK_STALE_MS = 15000;
const sleepSync = (ms) => { try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch { /* */ } };
function acquireLock(lockPath, { tries = 60, waitMs = 60 } = {}) {
    try { fs.mkdirSync(path.dirname(lockPath), { recursive: true }); } catch { /* */ }
    for (let i = 0; i < tries; i++) {
        try { const fd = fs.openSync(lockPath, 'wx'); fs.writeSync(fd, String(process.pid)); fs.closeSync(fd); return true; }
        catch (e) {
            if (e && e.code !== 'EEXIST') return false;  // unexpected FS error → caller writes best-effort
            try { if (Date.now() - fs.statSync(lockPath).mtimeMs > LOCK_STALE_MS) { fs.unlinkSync(lockPath); continue; } } catch { /* lost a race on the stale file — just retry */ }
            sleepSync(waitMs);
        }
    }
    return false;  // contended past ~3.6s → write best-effort (rare; captures are sub-second)
}
function releaseLock(lockPath) { try { fs.unlinkSync(lockPath); } catch { /* */ } }

// Pull assistant text out of one transcript line (Claude Code JSONL: content is
// a string or an array of {type:'text',text}).
function textOf(entry) {
    const m = entry?.message ?? entry;
    if (m?.role !== 'assistant') return '';
    const c = m.content;
    if (typeof c === 'string') return c;
    if (Array.isArray(c)) return c.filter(p => p?.type === 'text' && typeof p.text === 'string').map(p => p.text).join('\n');
    return '';
}

// --- File anchoring (added 2026-06-15) ----------------------------------
// Pull the file paths a transcript turn touched out of its tool_use blocks
// (Edit/Write/Read/…). textOf() above keeps only assistant TEXT and throws
// these away — but they're how we tag a captured decision to the code it's
// about, so a later git-diff token can match the card precisely (see
// scoreCardsAgainstQuery). Tags use hyphens (#file-foo, #dir-bar) so the
// existing TAG regex + brain_connect cross-linking pick them up for free.
// WRITE tools only — a decision is anchored to files it CHANGED, not files it
// merely glanced at (Read/view would over-anchor every browsed file).
const FILE_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'edit_file', 'write_file']);
function filesInEntry(entry) {
    const c = (entry?.message ?? entry)?.content;
    if (!Array.isArray(c)) return [];
    const out = [];
    for (const p of c) {
        if (p?.type === 'tool_use' && FILE_TOOLS.has(p.name)) {
            const fp = p.input?.file_path || p.input?.path || p.input?.notebook_path;
            if (typeof fp === 'string' && fp) out.push(fp);
        }
    }
    return out;
}
const slugify = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
function fileTagsFor(p) {
    const parts = String(p).replace(/\\/g, '/').split('/').filter(Boolean);
    const base = parts[parts.length - 1] || '';
    const stem = slugify(base.replace(/\.[a-z0-9]+$/i, '')); // basename minus extension
    const dir = parts.length >= 2 ? slugify(parts[parts.length - 2]) : '';
    const tags = [];
    // Gate on the SLUG length (≥3), matching the query-token threshold, so any
    // segment that becomes a tag is reproducible as a query token (the old
    // `t.length > 6` on the whole prefixed tag was asymmetric: #file- is 6,
    // #dir- is 5, so a 1-char file stem survived but a 2-char dir didn't).
    if (stem.length >= 3) tags.push('#file-' + stem);
    if (dir.length >= 3) tags.push('#dir-' + dir);
    return tags;
}

// --- Commit-body auto-capture (added 2026-06-15) ------------------------
// Turn rationale-bearing feat/fix/perf commits into cards on Stop, so the WHY
// in commit BODIES (which terse 🧠 markers often miss) lands in the brain
// automatically. HIGH-SIGNAL, not a commit-log dump: ONLY commits whose body
// carries a real rationale are taken; subject-only commits are skipped. A
// per-project last-seen sha (its OWN tiny file, so the dedup-state plumbing is
// untouched) makes it incremental + flood-proof — first run BASELINES to HEAD
// (captures nothing), later runs take only new commits (capped), and it
// re-baselines if history was rewritten (rebase/reset) so a non-ancestor range
// can never dump the whole history.
const COMMIT_STATE = path.resolve(CWD, '.claude', 'brain-last-commit');
const readLastCommit = () => { try { return fs.readFileSync(COMMIT_STATE, 'utf8').trim() || null; } catch { return null; } };
const writeLastCommit = (s) => { try { fs.mkdirSync(path.dirname(COMMIT_STATE), { recursive: true }); fs.writeFileSync(COMMIT_STATE, String(s || '')); } catch { /* best-effort */ } };
const git = (args) => execSync(`git ${args}`, { cwd: CWD, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 4000 }).trim();
const CC_RE = /^(feat|fix|perf)(?:\(([^)]+)\))?!?:\s*(.+)$/i;
function parseCommitLog(raw) {
    return String(raw).split('\x1e').map(s => s.trim()).filter(Boolean).map(rec => {
        const p = rec.split('\x1f');
        return { hash: (p[0] || '').trim(), subject: (p[1] || '').trim(), body: (p[2] || '').trim() };
    }).filter(c => c.hash && c.subject);
}
function commitToCard(c) {
    const m = CC_RE.exec(c.subject);
    if (!m) return null;                                                        // only feat / fix / perf
    const body = c.body.replace(/\s+/g, ' ').trim();
    if (body.length < 12) return null;                                          // RATIONALE-bearing only — keeps it high-signal, not a dump
    const type = m[1].toLowerCase(), scope = (m[2] || '').trim(), desc = m[3].trim();
    const area = scope || (type === 'feat' ? 'Milestones' : 'Fixes');
    const prefix = type === 'feat' ? '🏁 ' : '';
    return {
        text: `${area}: ${prefix}${desc}\n\n${body.slice(0, 400)}\n#${slugify(area)} #commit-${c.hash.slice(0, 7)}`,
        area, borderColor: type === 'feat' ? 'rgba(59,130,246,0.8)' : 'rgba(16,185,129,0.6)', createdVia: 'commit',
    };
}
async function gatherCommitCards(prevCommit) {
    let head = '';
    try { head = git('rev-parse HEAD'); } catch { return { cards: [], newLastCommit: prevCommit }; }
    if (!head) return { cards: [], newLastCommit: prevCommit };
    if (!prevCommit) return { cards: [], newLastCommit: head };                 // BASELINE: record HEAD, capture nothing
    if (head === prevCommit) return { cards: [], newLastCommit: head };         // no new commits
    try { execSync(`git merge-base --is-ancestor ${prevCommit} HEAD`, { cwd: CWD, stdio: 'ignore', timeout: 2000 }); }
    catch { return { cards: [], newLastCommit: head }; }                        // history rewritten → re-baseline, don't dump
    let raw = '';
    try { raw = git(`log ${prevCommit}..HEAD --no-merges --format=%x1e%H%x1f%s%x1f%b`); } catch { return { cards: [], newLastCommit: head }; }
    return { cards: parseCommitLog(raw).slice(0, 15).map(commitToCard).filter(Boolean), newLastCommit: head };
}

async function capture(lib) {
    let tp = '';
    try { tp = JSON.parse(fs.readFileSync(0, 'utf8') || '{}').transcript_path || ''; } catch { /* no stdin */ }
    if (!tp || !fs.existsSync(tp)) return;
    let lines; try { lines = fs.readFileSync(tp, 'utf8').split('\n').filter(Boolean); } catch { return; }
    const seen = readState();
    const cards = [];
    const resolutions = [];
    const updates = [];
    const ledger = [];   // one entry per marker decision (observability)
    // Rolling set of the most-recently-touched file/dir tags (deduped, newest
    // last). A marker emitted after some edits gets tagged with the files that
    // work touched — captured by scanning EVERY entry's tool_use, not just the
    // marker turns (markers carry no tool_use of their own).
    const recentTags = [];
    const noteFiles = (paths) => {
        for (const p of paths) for (const tag of fileTagsFor(p)) {
            const i = recentTags.indexOf(tag); if (i >= 0) recentTags.splice(i, 1);
            recentTags.push(tag);
        }
        while (recentTags.length > 8) recentTags.shift();
    };
    for (const ln of lines) {
        let e; try { e = JSON.parse(ln); } catch { continue; }
        noteFiles(filesInEntry(e));
        const text = textOf(e);
        if (!text.includes('🧠')) continue;
        for (const raw of text.split('\n')) {
            const m = MARKER.exec(raw.trim()); if (!m) continue;
            const area = (m[1] || '').trim(), type = m[2] || '', body = m[3].trim(); if (!body) continue;
            const preview = body.slice(0, 90);
            // EXAMPLE/doc guard — rejects marker-SYNTAX documentation (which
            // once polluted the brain) WITHOUT dropping real decisions. Three
            // SHAPE tests, deliberately narrow (an over-broad "any backtick" /
            // "any <…>" rule silently ate ~12% of real code-heavy decisions —
            // names like `npm run build`, <TextItem>, Map<string,number>):
            //   • a placeholder-WORD in angle brackets (<decision>, <open question>);
            //   • the marker shown INSIDE a code span (a backtick before the 🧠);
            //   • a syntax-explanation arrow ("→ open question (amber)" etc).
            if (/<(open question|one-line decision|decision|area|placeholder|open|milestone)[^>]*>/i.test(body)
                || /`[^`]*🧠/.test(raw)
                || /→\s*\**(open question|milestone|decision|resolve|update)\b/i.test(body)) {
                ledger.push({ action: 'skipped-example', area, preview });
                continue;
            }
            // Same hash as the legacy brain-capture.mjs so a project's existing
            // state file stays compatible (no double-capture during the switch
            // to the global hook). State is already per-project; the vault
            // cross-brain footgun is handled by per-brain state files in Phase 3.
            const key = sha((area + '|' + body).toLowerCase());
            if (seen.has(key)) { ledger.push({ action: 'skipped-seen', area, preview }); continue; }
            seen.add(key);
            // ✓ resolves an EXISTING card (stamped ✅ + archived) — not a new card.
            if (type === '✓') { resolutions.push({ area, text: body }); ledger.push({ action: 'resolve', area, preview }); continue; }
            // ~ updates the matching card in place (small corrections).
            if (type === '~') { updates.push({ area, text: body, createdVia: 'claude-code' }); ledger.push({ action: 'update', area, preview }); continue; }
            // Type → scannable prefix + border color: ? open question (amber),
            // ! milestone (blue), else decision (green).
            const prefix = type === '?' ? '❓ ' : type === '!' ? '🏁 ' : '';
            const borderColor = type === '?' ? 'rgba(245,166,35,0.8)' : type === '!' ? 'rgba(59,130,246,0.8)' : 'rgba(16,185,129,0.6)';
            // Tag line: the #area slug (existing) + up to the 4 most-recently-
            // touched #file-/#dir- tags so this decision is matchable by a later
            // git diff. Deduped against the area slug so it isn't repeated.
            const areaTag = area ? `#${slugify(area)}` : '';
            const fileTags = recentTags.slice(-4).filter(t => t !== areaTag);
            const tagLine = [areaTag, ...fileTags].filter(Boolean).join(' ');
            const card = (area ? `${area}: ${prefix}${body}` : `${prefix}${body}`) + (tagLine ? `\n${tagLine}` : '');
            cards.push({ text: card, area, borderColor });
            ledger.push({ action: type === '?' ? 'add-question' : type === '!' ? 'add-milestone' : 'add-decision', area, preview, files: fileTags });
        }
    }
    // Commit-body auto-capture: rationale-bearing feat/fix/perf commits since
    // the last run (independent of markers), pushed into the SAME capture batch.
    const prevCommit = readLastCommit();
    const { cards: commitCards, newLastCommit } = await gatherCommitCards(prevCommit);
    for (const cc of commitCards) { cards.push(cc); ledger.push({ action: 'commit', area: cc.area, preview: (cc.text.split('\n')[0] || '').slice(0, 90) }); }
    // DRY-RUN: show exactly what WOULD be captured (and what was skipped, and
    // why) without touching the brain or the dedup state. The inspection seam
    // the audit asked for — `node global-brain-hook.mjs --capture --dry-run < hook.json`.
    if (DRY) {
        appendJsonl(LEDGER, { ts: nowIso(), mode: 'dry-run', would: { cards: cards.length, resolutions: resolutions.length, updates: updates.length }, decisions: ledger }, 1000);
        process.stderr.write(`[brain] DRY-RUN — would capture ${cards.length} card(s), ${resolutions.length} resolution(s), ${updates.length} update(s):\n`);
        for (const d of ledger) process.stderr.write(`  ${d.action}: ${d.area ? '[' + d.area + '] ' : ''}${d.preview}\n`);
        return;
    }
    if (!cards.length && !resolutions.length && !updates.length) {
        // Record the commit baseline / advance even with nothing to capture, so
        // the next run doesn't re-scan the same commits.
        if (newLastCommit && newLastCommit !== prevCommit) writeLastCommit(newLastCommit);
        // Nothing new — but if markers were SEEN-and-skipped or example-rejected,
        // record that so "the brief looks stale" has a paper trail.
        if (ledger.length) appendJsonl(LEDGER, { ts: nowIso(), mode: 'capture', stats: { added: 0 }, decisions: ledger }, 1000);
        return;
    }
    // Capture under a lock so concurrent sessions serialize. INSIDE the lock we
    // re-read the brain (build on whatever a peer just wrote, not a stale base)
    // and UNION the dedup state (don't clobber a peer's seen-set). captureInto-
    // Brain supersedes heavily-overlapping old cards, applies ✓/~, routes new
    // cards into [Area] containers, and wires [[wikilink]] connections.
    const gotLock = acquireLock(LOCK);
    let stats;
    try {
        const merged = readState(); for (const k of seen) merged.add(k);
        const res = await lib.captureIntoBrain(fs.readFileSync(BRAIN), {
            cards: cards.map(c => ({ text: c.text, color: '#e8e8ed', borderColor: c.borderColor, area: c.area, createdVia: c.createdVia || 'claude-code' })),
            resolutions,
            updates,
        });
        stats = res.stats;
        // Re-pack the whole grid so a container that grew never overlaps its neighbor.
        let out = res.buffer; try { out = (await lib.tidyBrain(res.buffer)).buffer; } catch { /* keep append result if tidy fails */ }
        await lib.atomicWrite(BRAIN, out);
        writeState(merged);
        writeLastCommit(newLastCommit); // advance the commit baseline only after a successful write
        try { await refreshAgentsBrief(lib, out); } catch { /* AGENTS.md refresh is best-effort */ }
    } finally {
        if (gotLock) releaseLock(LOCK);
    }
    if (!gotLock) appendJsonl(HEALTH, { ts: nowIso(), project: path.basename(CWD), mode: 'capture', ok: false, err: 'lock-timeout — wrote best-effort' }, 500);
    const bits = [`${stats.added} added`];
    if (stats.resolved) bits.push(`${stats.resolved} resolved`);
    if (stats.updated) bits.push(`${stats.updated} updated`);
    if (stats.superseded) bits.push(`${stats.superseded} superseded`);
    if (stats.linked) bits.push(`${stats.linked} linked`);
    process.stderr.write(`[brain] capture: ${bits.join(' · ')} → brain.klypix\n`);
    appendJsonl(LEDGER, { ts: nowIso(), mode: 'capture', stats, decisions: ledger }, 1000);
    appendJsonl(HEALTH, { ts: nowIso(), project: path.basename(CWD), mode: 'capture', ok: true, brainBytes: brainBytes(), added: stats.added, skipped: ledger.filter(d => d.action.startsWith('skipped')).length }, 500);
}

// Keep a compact brain-brief block inside AGENTS.md so agents that read
// AGENTS.md but run no hooks (Codex, Cursor, OpenCode, …) still get current
// project state — the ecosystem-widening half of "agent-neutral". Headlines
// only + rewritten ONLY when content actually changed, so git diffs stay
// quiet. We refresh an existing AGENTS.md, never create one (that's the
// 🧠 plug's job).
async function refreshAgentsBrief(lib, buffer) {
    const agentsPath = path.resolve(CWD, 'AGENTS.md');
    if (!fs.existsSync(agentsPath) || typeof lib.structToBrief !== 'function') return;
    const { struct } = await lib.parseKlypix(buffer);
    const brief = lib.structToBrief(struct, { recentDays: 7, maxRecent: 10, maxMilestones: 3, maxConnections: 5 }).trim();
    const START = '<!-- klypix-brain-brief:start -->', END = '<!-- klypix-brain-brief:end -->';
    const block = `${START}\n<!-- auto-refreshed by the brain hook on capture · headlines only · full cards via the klypix-canvas MCP -->\n${brief}\n${END}`;
    const txt = fs.readFileSync(agentsPath, 'utf8');
    const re = new RegExp(`${START}[\\s\\S]*?${END}`);
    const next = re.test(txt) ? txt.replace(re, block) : (txt.trimEnd() + '\n\n' + block + '\n');
    if (next !== txt) fs.writeFileSync(agentsPath, next, 'utf8');
}

// --- Task-aware retrieval (UserPromptSubmit, added 2026-06-15) -----------
// The SessionStart brief is query-blind — the same ~11KB every session. The
// ONE moment the task is actually known is the prompt; this mode reads it (+
// the current git diff), ranks the brain's cards against it with the shared
// scorer, and injects only the few that are RELEVANT (or nothing, costing zero
// tokens). That's the write→read relevance loop the audit identified as the
// real unbuilt frontier.
// Key the parse cache on the NORMALIZED path (same identity the registry uses)
// so a drive-case/separator flip reuses one cache file instead of orphaning a
// new one each run.
const CACHE = path.join(os.homedir(), '.claude', 'project-brain', `.brief-cache-${sha(normBrainPath(BRAIN))}.json`);
// Best-effort: keep the cache dir from accumulating orphaned brief-cache files
// (deleted/moved brains, old case-variants). Only runs on a cache MISS (rare),
// so it adds no per-prompt cost.
function pruneCacheDir(keep = 40) {
    try {
        const dir = path.join(os.homedir(), '.claude', 'project-brain');
        const files = fs.readdirSync(dir).filter(f => f.startsWith('.brief-cache-') && f.endsWith('.json'));
        if (files.length <= keep) return;
        files.map(f => { const p = path.join(dir, f); let m = 0; try { m = fs.statSync(p).mtimeMs; } catch { /* */ } return { p, m }; })
            .sort((a, b) => b.m - a.m).slice(keep).forEach(({ p }) => { try { fs.unlinkSync(p); } catch { /* */ } });
    } catch { /* best-effort */ }
}
// mtime-keyed parse cache so we don't unzip the brain on every prompt.
async function cachedStruct(lib) {
    let mtimeMs = 0; try { mtimeMs = fs.statSync(BRAIN).mtimeMs; } catch { /* */ }
    try { const c = JSON.parse(fs.readFileSync(CACHE, 'utf8')); if (c && c.mtimeMs === mtimeMs && c.struct) return c.struct; } catch { /* miss */ }
    const { struct } = await lib.parseKlypix(fs.readFileSync(BRAIN));
    try { fs.writeFileSync(CACHE, JSON.stringify({ mtimeMs, struct })); pruneCacheDir(); } catch { /* cache is best-effort */ }
    return struct;
}
// Generic directory names anchor to a huge fraction of the brain, so they drown
// out the prompt's real intent — keep precise basenames, drop the generic dirs.
const GENERIC_DIRS = new Set(['src', 'app', 'lib', 'components', 'component', 'canvas', 'scripts', 'dist', 'build', 'public', 'tabs', 'interaction', 'items', 'hooks', 'utils', 'dashboard', 'core', 'api', 'test', 'tests', 'assets', 'styles', 'types', 'electron']);
// Tokens from a changed-file path, sluggified to MATCH the #file-/#dir- tag
// stems capture stamps on cards (so a git diff lands on the right decision).
function fileQueryTokens(p) {
    const parts = String(p).replace(/\\/g, '/').split('/').filter(Boolean);
    const base = slugify((parts.pop() || '').replace(/\.[a-z0-9]+$/i, ''));
    const dirs = parts.map(slugify).filter(s => s.length >= 3 && !GENERIC_DIRS.has(s));
    return [base, ...dirs].filter(s => s.length >= 3);
}
async function promptRetrieve(lib) {
    // Version-skew guard: if the live klypix-format.mjs is older than this hook
    // (the new exports missing), log a clean breadcrumb and no-op rather than
    // throwing into main().catch as a mislabeled failure.
    if (typeof lib.queryTokens !== 'function' || typeof lib.scoreCardsAgainstQuery !== 'function') {
        appendJsonl(HEALTH, { ts: nowIso(), project: path.basename(CWD), mode: 'prompt', ok: false, err: 'skew: missing query exports' }, 500);
        return;
    }
    let prompt = '';
    try { const j = JSON.parse(fs.readFileSync(0, 'utf8') || '{}'); prompt = j.prompt || j.user_prompt || j.userPrompt || ''; } catch { /* no stdin */ }
    const ptoks = lib.queryTokens(prompt);
    // The git diff is a FALLBACK signal — only spawn it (≈200ms) when the prompt
    // itself is too terse to retrieve on. Code-shaped prompts skip the spawn.
    let fileToks = [];
    if (ptoks.length < 2) {
        try {
            const diff = execSync('git diff --name-only HEAD', { cwd: CWD, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 1500 });
            fileToks = diff.split('\n').filter(Boolean).flatMap(fileQueryTokens);
        } catch { /* not a git repo / no diff — the prompt alone is enough */ }
    }
    const tokens = [...new Set(ptoks.concat(fileToks))];
    if (!tokens.length) return;
    const struct = await cachedStruct(lib);
    const hits = lib.scoreCardsAgainstQuery(struct, tokens, { topK: 5, minScore: 3 });
    if (!hits.length) return; // nothing relevant → zero output, zero added context
    const flat = (s) => String(s || '').replace(/\s+/g, ' ').trim();
    const lines = ["# Relevant prior decisions from this project's brain (task-matched; full brain via the klypix-canvas MCP)"];
    for (const h of hits) lines.push(`- ${flat(h.card.text)}`);
    process.stdout.write(lines.join('\n') + '\n'); // UserPromptSubmit injects stdout as context
}

async function read(lib) {
    const { struct } = await lib.parseKlypix(fs.readFileSync(BRAIN));
    // Default = TIERED brief (open questions + recent + area map) so the
    // session-start cost stays flat as the brain grows. --full = everything.
    const outStr = (!process.argv.includes('--full') && typeof lib.structToBrief === 'function')
        ? lib.structToBrief(struct)
        : lib.structToMarkdown(struct);
    process.stdout.write(outStr);
    // Heartbeat: prove the brief actually injected (and how big) so a dead or
    // stale live-copy of the hook stops being a silent no-op.
    appendJsonl(HEALTH, { ts: nowIso(), project: path.basename(CWD), mode: 'read', ok: true, briefBytes: Buffer.byteLength(outStr), cards: struct?.counts?.cards ?? null }, 500);
}

// Registry of every brain this machine has touched — written on each hook run,
// read by the MCP's search_all_brains for vault-wide, cross-project memory
// ("what did I decide about auth — in ANY project?"). Zero-config data gravity:
// just having worked in a brain project makes it searchable. Never throws.
function registerBrain() {
    try {
        const dir = path.join(os.homedir(), '.claude', 'project-brain');
        const reg = path.join(dir, 'registry.json');
        fs.mkdirSync(dir, { recursive: true });
        let data = { brains: [] };
        try { data = JSON.parse(fs.readFileSync(reg, 'utf8')); } catch { /* fresh */ }
        if (!Array.isArray(data.brains)) data.brains = [];
        const norm = normBrainPath(BRAIN);
        // Collapse pre-existing case-variant duplicates by normalized key,
        // keeping the newest lastSeen — so the registry self-heals on next run.
        const byKey = new Map();
        for (const b of data.brains) {
            if (!b || !b.path) continue;
            const k = normBrainPath(b.path);
            const prev = byKey.get(k);
            const merged = { ...(prev || {}), ...b, path: k };
            if (!prev || (merged.lastSeen || 0) >= (prev.lastSeen || 0)) byKey.set(k, merged);
        }
        byKey.set(norm, { ...(byKey.get(norm) || {}), path: norm, project: path.basename(CWD), lastSeen: Date.now() });
        data.brains = [...byKey.values()].filter(b => { try { return fs.existsSync(b.path); } catch { return false; } }).slice(-200);
        fs.writeFileSync(reg, JSON.stringify(data, null, 2));
    } catch { /* registry is best-effort */ }
}

async function main() {
    if (!fs.existsSync(BRAIN)) return;                  // not a brain project → instant no-op
    const lib = await import('./klypix-format.mjs');    // lazy: only when a brain exists
    // Per-prompt retrieval runs on EVERY prompt — skip the registry write and
    // go straight to the (mtime-cached) ranked lookup to keep it cheap.
    if (process.argv.includes('--prompt')) { await promptRetrieve(lib); return; }
    registerBrain();
    if (process.argv.includes('--capture')) await capture(lib); else await read(lib);
}
main().catch((e) => {
    // The whole point of the observability work: a real failure (missing jszip
    // at the live path, unreadable transcript, corrupt brain) used to vanish
    // here. Now it leaves a breadcrumb — without breaking the never-throw,
    // always-exit-0 contract.
    try {
        const mode = process.argv.includes('--prompt') ? 'prompt' : process.argv.includes('--capture') ? 'capture' : 'read';
        appendJsonl(HEALTH, { ts: nowIso(), project: path.basename(CWD), mode, ok: false, err: String((e && e.message) || e).slice(0, 200) }, 500);
    } catch { /* even the breadcrumb is best-effort */ }
}).finally(() => process.exit(0));
