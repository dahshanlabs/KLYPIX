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
cp scripts/klypix-format.mjs scripts/global-brain-hook.mjs "$PB/"
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

Just create a brain and start working:

```bash
echo '{ "title": "<project>", "cards": [{ "text": "kickoff" }] }' \
  | node <HOME>/.claude/project-brain/global-brain-hook.mjs   # (or write-klypix)
```

…or copy an existing `brain.klypix` to the project root. Next session it's
auto-read; decisions you mark with `🧠 BRAIN [Area]: …` are auto-captured.

## Notes

- **One brain per project** (`./brain.klypix` at the repo root). A vault/
  portfolio of brains + a Ctrl+O switcher is Phase 3.
- KLYPIX itself **dogfoods the global path** — its old per-project hooks in
  `.claude/settings.json` were removed in favor of this global hook.
- To keep the global script current after editing the repo source, re-copy
  `scripts/global-brain-hook.mjs` + `scripts/klypix-format.mjs` to
  `~/.claude/project-brain/`.
