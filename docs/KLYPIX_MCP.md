# KLYPIX MCP server — give Claude live read + write to your canvases

`scripts/klypix-mcp-server.mjs` is a [Model Context Protocol](https://modelcontextprotocol.io)
server. Connect it to any MCP client (Claude Desktop, Claude Code, "cowork", …)
and that client gets standing tools to work with your `.klypix` canvas library —
no copy-pasting files, no KLYPIX desktop app required.

It's the productized version of the `read-klypix` / `write-klypix` skills: same
format logic (`scripts/klypix-format.mjs`), exposed as real MCP tools.

## Tools

| Tool | What it does |
|---|---|
| `list_canvases` | List every `.klypix`/`.any` in the vault with card + connection counts |
| `read_canvas` | Read one canvas as markdown — cards, the connection graph, `[[wikilinks]]`, `#tags`, assets |
| `search_canvases` | Search card text/titles/`#tags` across **all** canvases |
| `create_canvas` | Build a new canvas from cards + connections and save it to the vault |
| `add_to_canvas` | Append cards (+ connections) to an existing canvas, **preserving** existing items + positions |
| `search_all_brains` | Search every registered project brain (`~/.claude/project-brain/registry.json`) — cross-project recall |

It operates on the `.klypix` **files** in a "vault" folder. Nothing here touches
a running canvas, so it can't corrupt live state — worst case is a clear error.

## The vault

The server reads/writes canvases under one folder, chosen by (in order):

1. `--vault "C:\path\to\canvases"` argument, or
2. `KLYPIX_VAULT` environment variable, or
3. default: `~/Documents`.

Point it at wherever you keep your `.klypix` files (e.g. your Desktop or a
`Canvases` folder). It scans recursively (skipping hidden/system dirs), up to
400 files.

## Register it

### Claude Code (this repo)

A project-scoped [`.mcp.json`](../.mcp.json) is already committed, so Claude Code
offers the `klypix-canvas` server when you work in this repo. Set your vault
first (PowerShell):

```powershell
$env:KLYPIX_VAULT = "C:\Users\you\Desktop"
```

…or edit `.mcp.json` to pass `--vault` directly in `args`. Approve the server
when Claude Code prompts.

### Claude Desktop

Add to `claude_desktop_config.json` (Settings → Developer → Edit Config):

```json
{
  "mcpServers": {
    "klypix-canvas": {
      "command": "node",
      "args": [
        "E:\\ANTIGRAVITY\\KLYPIX\\scripts\\klypix-mcp-server.mjs",
        "--vault", "C:\\Users\\you\\Desktop"
      ]
    }
  }
}
```

Use absolute paths. Restart Claude Desktop; "klypix-canvas" appears in the tools
(🔌) menu.

> Requires `node` on PATH and the repo's `node_modules` (it imports
> `@modelcontextprotocol/sdk`, `zod`, `jszip`). Run from a KLYPIX checkout, or
> `npm install` those three next to the script.

## Try it

In the MCP client:

- *"List my KLYPIX canvases."* → `list_canvases`
- *"Read the Roadmap canvas and summarize what's missing."* → `read_canvas`
- *"Search my canvases for #risk."* → `search_canvases`
- *"Make a canvas called Launch Plan with these steps…"* → `create_canvas`
- *"Add a 'Phase 2' card to the Roadmap canvas, connected to the goal."* →
  `add_to_canvas`

Then open the created/edited file in KLYPIX (Canvas → Open) to see it spatially.

## Scope / limits

- File-based, not a live link to the running app — edits land in the `.klypix`
  file; reopen the canvas in KLYPIX to see them.
- `add_to_canvas` supports v4 `.klypix` (the current format); for a legacy
  `.any`, create a new canvas instead.
- New cards are text cards; images/files are read (listed) but not authored by
  the server.
