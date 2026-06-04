# Project Brain — global setup (Phase 2)

The project-brain loop (auto-read on session start, auto-capture of `🧠 BRAIN`
markers on stop) is now **global**: it works in **any** Claude Code project that
has a `./brain.klypix` at its root, with **zero per-project configuration**.

## How it works

- A single bulletproof script, `global-brain-hook.mjs`, is installed to
  `~/.claude/project-brain/` (alongside `klypix-format.mjs` + a `node_modules`
  with `jszip`).
- Two hooks in the **global** `~/.claude/settings.json` call it:
  - `SessionStart` → `node ~/.claude/project-brain/global-brain-hook.mjs`
    (prints `./brain.klypix`'s markdown brief to stdout → injected as context).
  - `Stop` → `… global-brain-hook.mjs --capture`
    (harvests `🧠 BRAIN [Area]: …` markers from the transcript into
    `./brain.klypix`, deduped via `./.claude/brain-capture-state.json`).
- The hook is an **instant no-op** in any project that has no `./brain.klypix`
  (a bare `existsSync` before any heavy import), **never throws**, and **always
  exits 0** — so it cannot slow down or break a session anywhere.

The source of truth for the script lives in this repo at
[scripts/global-brain-hook.mjs](../scripts/global-brain-hook.mjs); the copy under
`~/.claude/project-brain/` is what actually runs.

## Install / reproduce on another machine

```bash
# from a KLYPIX checkout
PB="$HOME/.claude/project-brain"
mkdir -p "$PB"
cp scripts/klypix-format.mjs scripts/global-brain-hook.mjs scripts/klypix-brain.mjs "$PB/"
cd "$PB" && npm init -y >/dev/null && npm install jszip
```

Then add to `~/.claude/settings.json` (merge with any existing config):

```json
{
  "hooks": {
    "SessionStart": [
      { "matcher": "startup|resume",
        "hooks": [{ "type": "command", "command": "node <HOME>/.claude/project-brain/global-brain-hook.mjs" }] }
    ],
    "Stop": [
      { "hooks": [{ "type": "command", "command": "node <HOME>/.claude/project-brain/global-brain-hook.mjs --capture" }] }
    ]
  }
}
```

(Use an absolute path; node accepts forward slashes on Windows.)

## Using it in a new project

Bootstrap a brain with the `klypix-brain` CLI (Phase 3), then just work:

```bash
cd <your project>
node <HOME>/.claude/project-brain/klypix-brain.mjs new "<project title>"
```

…or copy an existing `brain.klypix` to the project root. Next session it's
auto-read; decisions you mark with `🧠 BRAIN [Area]: …` are auto-captured.

### `klypix-brain` CLI (manage brains across projects)

```
klypix-brain new [title]   create ./brain.klypix here (won't overwrite an existing one)
klypix-brain read          print this project's brain brief
klypix-brain which         show the active brain path + status
klypix-brain list [dir]    inventory every *.klypix brain under a folder (your "vault")
```

A tip alias makes it ergonomic, e.g. (PowerShell)
`function klypix-brain { node "$HOME/.claude/project-brain/klypix-brain.mjs" @args }`.

## Notes

- **One brain per project** (`./brain.klypix` at the repo root). `list` gives you
  the portfolio view across a vault folder.
- **Deferred (Phase 3 tail):** a Ctrl+O brain *switcher* that repoints
  `./brain.klypix` between vault brains. That's a Claude Code harness UI feature
  (not buildable from this repo), and symlink-swapping the active brain is a
  Windows-permission + wrong-brain-capture footgun — so it's intentionally left
  to the harness. `klypix-brain new`/`list` cover the safe, useful core today.
- KLYPIX itself **dogfoods the global path** — its old per-project hooks in
  `.claude/settings.json` were removed in favor of this global hook.
- To keep the global script current after editing the repo source, re-copy
  `scripts/global-brain-hook.mjs` + `scripts/klypix-format.mjs` to
  `~/.claude/project-brain/`.
