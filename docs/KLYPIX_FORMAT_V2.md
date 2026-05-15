# `.klypix` Format v2 (document version 4)

Internal schema bump: v3 → v4. The on-disk layout changes from "one big
`canvas.json`" to "manifest + per-item files + content-addressed assets."
This unlocks unlimited file size, lazy loading, and incremental save without
breaking any existing `.any` file (legacy v1/v2/v3 still readable).

## On-disk layout

```
<canvas-name>.klypix              ← zip (zip64 mode required for >4GB)
├── manifest.json                 ← small index, loaded first (always <100KB)
├── canvas.json                   ← spatial state: positions, connections, z-order
├── items/
│   ├── <id-prefix-2>/<id>.json   ← per-item content, sharded by id prefix
│   ├── ...
│   └── (e.g. items/ab/item_abcd1234.json)
├── assets/
│   ├── files/
│   │   └── <sha-prefix-2>/<sha-full>.bin    ← content-addressed user files
│   ├── images/
│   │   └── <sha-prefix-2>/<sha-full>.<ext>  ← extension preserved for native open
│   └── thumbs/
│       └── <item-id>.png         ← dashboard previews
└── ops/                          ← optional, CRDT ops log (added in Phase 6 sync prep)
    └── <timestamp>.ndjson
```

### Why sharded directories

OS filesystems (NTFS, ext4) struggle with single directories containing
tens of thousands of files. Sharding by the first 2 hex chars of the id
(items) or sha (assets) keeps any single directory bounded to ~256 entries
per shard. Git uses the same trick for its loose object store.

`items/ab/item_abcd1234.json` is portable; `items/item_abcd1234.json`
would degrade after ~10K items.

## File contents

### `manifest.json`

The index. Read first. Tells us format version, what's inside, and sync
metadata. Always small — KB scale regardless of total archive size.

```jsonc
{
  "format": "klypix",
  "version": 4,                    // on-disk LAYOUT version (this doc)
  "schemaVersion": 4,              // canvas DOCUMENT version (covers items, connections, etc.)
  "createdAt": "2026-05-14T10:00:00.000Z",
  "updatedAt": "2026-05-14T10:30:00.000Z",
  "title": "My Research Canvas",
  "stats": {
    "itemCount": 247,
    "assetCount": 18,
    "totalBytes": 1234567890        // uncompressed total — informational only
  },
  "sync": {
    "enabled": false,
    "lastSyncRev": null,
    "lastSyncAt": null,
    "deviceId": "<stable per-device uuid>"
  }
}
```

### `canvas.json`

Spatial state. Read after manifest. Used to render the canvas at zoom-out
view *without* having loaded any item content yet.

```jsonc
{
  "version": 4,
  "view": { "x": 0, "y": 0, "zoom": 1 },
  "order": ["item_abc", "item_def", ...],
  "connections": [...],            // arrows between items
  "lines": [...],                  // ruler lines
  "strokes": [...],                // freehand drawings
  "nextGroupNumber": 5,
  // Per-item POSITIONS only — no content here. Renderer draws empty frames
  // at these positions until item content lazy-loads.
  "positions": {
    "item_abc": { "x": 100, "y": 200, "w": 300, "h": 200, "zKey": "a0001", "parentId": null },
    "item_def": { "x": 500, "y": 100, "w": 200, "h": 400, "zKey": "a0002", "parentId": null }
  }
}
```

For a million-item canvas, `canvas.json` is ~50-100MB — still acceptable
single-load. If we ever need to scale past that, `positions` can be split
into a separate sharded structure. Defer until needed.

### `items/<prefix>/<id>.json`

Per-item content. Read lazily — only items in the current viewport (or
recently accessed) live in RAM. Each item file has the type-specific shape
that today's `CanvasItem` union already defines, MINUS position fields
(those live in canvas.json):

```jsonc
{
  "id": "item_abc",
  "type": "text",
  "content": "Hello world",
  "fontSize": 14,
  "color": "#fff",
  "locked": false,
  "createdAt": 1715683200000,
  "createdBy": "user"
  // No x, y, w, h — those are in canvas.json positions
}
```

For asset-bearing items (image, file):
```jsonc
{
  "id": "item_xyz",
  "type": "file",
  "fileName": "Report.docx",
  "fileExt": "docx",
  "assetRef": "sha256:abc123def...",   // points at assets/files/ab/<sha>.bin
  "embedMetadata": {
    "originalSize": 1234567,
    "originalPath": "C:\\Users\\...\\Report.docx",
    "addedAt": 1715683200000
  }
}
```

### `assets/files/<prefix>/<sha>.bin`, `assets/images/<prefix>/<sha>.<ext>`

Content-addressed binary store. Same file dropped twice = stored once.
Items reference assets by sha; multiple items can share an asset.

For images, the extension is preserved (`.png`, `.jpg`, `.svg`) so:
- Renderer can dispatch by extension without sniffing
- Extracted asset opens in the right native viewer

For files, the extension lives in the item metadata, not the asset path —
the binary is opaque from the archive's perspective.

### `assets/thumbs/<item-id>.png`

Generated thumbnails for the dashboard. Lazy — created on first dashboard
render, cached afterward, regenerated when item content changes. 200x150 PNG
keeps dashboard load fast even for canvases with hundreds of items.

### `ops/<timestamp>.ndjson` (added in Phase 6, not v4 initial)

CRDT-style operation log. Empty in Phase 1. Populated by sync layer in
Phase 6 with one JSON op per line:

```
{"t":1715683200000,"op":"item.move","id":"item_abc","x":150,"y":250,"by":"<deviceId>"}
{"t":1715683201500,"op":"item.update","id":"item_abc","field":"content","value":"New text","by":"<deviceId>"}
```

Periodically compacted into `canvas.json` snapshot when ops/ gets large
(>10MB). Compaction is server-side in cloud sync; local-only canvases
never accumulate ops.

## Read protocol (open canvas)

```
1. Unzip just manifest.json → parse → check format/version
2. If version < 4: dispatch to legacy v3 reader (anyFormat.deserialize)
3. If version === 4:
   a. Read canvas.json (gives positions, connections, viewport)
   b. Render placeholder frames at all positions
   c. Compute which item IDs are in the current viewport (or near it)
   d. Read those items/<prefix>/<id>.json files concurrently
   e. As user pans/zooms, fetch more items just-in-time
4. Assets: never load eagerly. Only when an item is opened or thumb requested.
```

Open time target: **<1s** for any canvas size up to ~50GB on SSD. Linear in
viewport item count, not total item count.

## Write protocol (save canvas)

```
1. Compute set of changed items since last save (renderer tracks dirty flags)
2. Compute set of new assets (sha not in previous manifest.assetCount)
3. Compute set of orphaned assets (in manifest but no item references them)
4. Open .klypix.tmp as a zip writer, NOT a copy of original
5. Stream-copy unchanged entries from original .klypix into .tmp
   (this is fast — zip entries can be copied without decompress/recompress)
6. Write modified items, new assets, fresh manifest.json, fresh canvas.json
7. Skip orphaned assets (effectively deleting them)
8. Close zip, sync to disk
9. Atomic rename .tmp → final path
```

Save time target: **<500ms** for any canvas, dominated by the size of
items/assets that ACTUALLY changed, never by total archive size.

## Migration from v3 (`.any` files)

Lazy, on first save. Never destroys user data.

```
1. User opens mycanvas.any → loaded via legacy v3 codec → state in memory
2. User edits or just presses Ctrl+S
3. Save dialog defaults to mycanvas.klypix (extension changes)
4. Codec writes v4 layout
5. Original mycanvas.any stays untouched — user deletes when ready
```

No batch migration tool needed. No "you must upgrade" prompts. v3 readers
stay in the codebase forever for legacy file support (small, ~150 lines).

## Required dependencies

The current codebase uses `jszip` for `.any` ZIP reading/writing.

For v4 we need additional capabilities `jszip` doesn't provide:

| Need | Library | Why |
|---|---|---|
| Zip64 write | `archiver` or `yazl` | jszip's zip64 support is limited |
| Streaming read with random access | `yauzl` | Read one entry without decompressing the whole zip — essential for big files |
| Entry-copy (no recompress) on save | `yauzl` + `yazl` | The "fast save unchanged entries" trick in the write protocol above |

These are server-grade Node libraries — perfect fit for Electron main
process. The renderer can keep using jszip for the (rare) in-renderer zip
ops since they only happen during cloud sync upload prep.

## What this format is NOT

- Not a database. No queries beyond opening one item by id or one asset by
  sha. If users want SQL-like canvas queries, that's a separate index file
  built on top, not part of the canonical format.
- Not encrypted at rest by default. Encryption is a Phase 6+ feature for
  cloud-sync payloads. Local files are plaintext unless user opts in.
- Not signed/authenticated. No tampering detection. Add later if needed.
- Not optimized for diffing. The ops log in Phase 6 provides that; the
  base v4 format is just snapshots.

## Open questions for the implementation phase

1. **Item ID format.** Today's items use random UUID-ish strings. Should
   item filenames preserve that, or use a shorter encoding? Suggest: keep
   as-is, no need to optimize until proven necessary.

2. **Compression.** Should items/canvas.json be zip-compressed (deflate) or
   stored uncompressed inside the zip? Deflate is good for text; assets
   already stored uncompressed (binary). Suggest: deflate for .json, store
   for already-compressed binaries.

3. **Limits on individual asset size.** Plan says unlimited. In practice:
   should we warn (not block) at certain sizes (e.g., a 10GB single PDF
   inside a canvas)? Decide during implementation; default to warning only.

4. **Cleanup of unreferenced assets.** Run on every save (slight overhead)
   or weekly background task? Suggest: on every save, since it's the same
   pass as identifying which entries to copy.

## Sign-off

This spec is the contract. Implementation in `src/canvas/file/klypixFormatV4.ts`
must match. Changes to this spec require updating this doc first, then code.
