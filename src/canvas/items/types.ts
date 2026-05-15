// Minimal item + drawing types for Slice 2. Matches docs/CLAUDE-KLYPIX-CANVAS.md §1
// but trimmed to the shapes we actually use now. Extend as later slices add
// file/image/video/agent_response/etc.

export type ItemType = 'text' | 'box' | 'image' | 'file' | 'container' | 'approval' | 'link' | 'canvas-link' | 'video' | 'audio' | 'code';

export type ItemStatus = 'none' | 'todo' | 'in_progress' | 'in_review' | 'done' | 'blocked' | 'waiting';

export interface BaseItem {
    id: string;
    type: ItemType;
    x: number;
    y: number;
    w: number;
    h: number;
    // Numeric stacking cache, kept in step with `state.order` array index.
    // Read by the CSS layer (BoxItem etc.) — DOM stacking needs a number.
    // Re-synced by REORDER_ITEMS reducer; not the source of truth for order.
    zIndex: number;
    // Fractional sort key (e.g. "a0", "a0V", "a1"). Source of truth for
    // z-order from v2 onward. New items get a key larger than the current
    // top via fractional-indexing's generateKeyBetween — no renumbering of
    // siblings on insert. `state.order` array stays sorted in zKey order;
    // `zIndex` stays as a numeric mirror for CSS. Optional in the type
    // because v1 files predate it; the v1→v2 migration backfills every
    // item, and the canvasStore reducer fills it for runtime-created items.
    zKey?: string;
    locked: boolean;
    parentId: string | null;
    createdAt: number;
    createdBy: 'user' | 'agent';
    tags?: string[];              // lowercase labels, small
    status?: ItemStatus;          // small colored badge
    colorCode?: string;           // semantic color override (green/yellow/red/blue/purple)
    layerId?: string;             // defaults to 'content'
    comments?: Comment[];         // sticky notes attached to this item
    thread?: ThreadMessage[];     // multi-turn chat scoped to this item (Slice 3)
    // Whole-item opacity (0–1, default 1). Applied by the Fill panel's
    // opacity slider across every item type, not just boxes — keeping
    // the field on BaseItem so TypeScript doesn't complain when text
    // / image / container items get opacity via applyToSelection.
    opacity?: number;
    // Frozen geometry at the moment this item was placed inside its
    // container parent. Acts as the fixed baseline for vector-style
    // group scaling: when the container resizes, every child's current
    // x/y/w/h (and text fontSize/wrap) is DERIVED from these values
    // times the container's current/authored scale. Never mutated by
    // container resize — only by explicit user edit of the child while
    // the container is at its authored scale, or by re-seeding when the
    // item enters a new container. Cleared when the item leaves the
    // container. Result: stretch-and-shrink cycles return to exactly
    // the same pixel layout, no drift.
    authoredInParent?: {
        relX: number;           // x offset from container.x at authoring time
        relY: number;
        w: number;
        h: number;
        fontSize?: number;      // text items only
        authoredWidth?: number; // text wrap width, scaled proportionally
        // Box items: frozen border thickness at scale=1 so vector-scale
        // can grow/shrink it with the group. Without this, a group scaled
        // 5× down leaves borders at their original world-px value, making
        // them visually dominate the smaller box. Treated exactly like
        // fontSize — stored at authored scale, multiplied back in on
        // every container resize.
        borderWidth?: number;
    };
}

export interface Comment {
    id: string;
    author: string;
    text: string;
    timestamp: number;
}

export interface ThreadMessage {
    id: string;
    role: 'user' | 'assistant';
    content: string;
    timestamp: number;
    // 'streaming' while Gemini is still producing tokens; 'done' when complete;
    // 'error' if the call failed. UI shows a typing indicator for 'streaming'.
    status?: 'streaming' | 'done' | 'error';
}

export interface TextItem extends BaseItem {
    type: 'text';
    content: string;
    fontSize: number;
    color: string;
    border: boolean;
    borderColor: string;
    // Counter-zoomed stroke width in world-px for bordered cards. Created
    // via box double-click (inherits the box's borderWidth) or agent card
    // output; a plain text item with no border ignores this. Optional so
    // legacy files keep loading — undefined falls back to 1 world-px in
    // the render style.
    borderWidth?: number;
    // Optional background color for bordered cards. Inherited from the
    // source BoxItem when the user double-clicks a filled box to enter
    // text — previously we lost the fill and fell back to the dark
    // default. Undefined → default 'rgba(18,18,26,0.8)'.
    fillColor?: string;
    // Optional line style for the border. Inherited from the source
    // box on conversion (dashed/dotted borders were being flattened to
    // solid before). Undefined → 'solid'.
    lineStyle?: 'solid' | 'dashed' | 'dotted';
    // Optional font family — selected from the Text panel's curated list
    // (Inter, Space Grotesk, Newsreader, JetBrains Mono, Caveat, Bricolage
    // Grotesque). Undefined → inherit the canvas default (Outfit).
    fontFamily?: string;
    // Optional text decoration — 'underline' toggles the U button in the
    // Text panel. Undefined / 'none' renders with no decoration.
    textDecoration?: 'none' | 'underline';
    // Strikethrough is a parallel boolean instead of being baked into
    // textDecoration so it can combine freely with underline (CSS
    // text-decoration accepts both at once). Undefined → off.
    strikethrough?: boolean;
    heading: boolean;
    fontWeight?: 'normal' | 'bold';       // Ctrl+B toggle (optional for old files)
    fontStyle?: 'normal' | 'italic';      // Ctrl+I toggle
    // When undefined: width auto-fits content (max-content). When set:
    // text wraps at this width — used for "I shrunk the box, wrap the text"
    // behavior. Grow-drags scale font; shrink-drags set/shrink authoredWidth.
    authoredWidth?: number;
    // Text alignment inside a bordered card (hidden from plain text in the
    // UI because there's no box to align within). Both optional with
    // left/top defaults so legacy files render identically. 3×3 grid in the
    // right-click menu sets both axes at once.
    textAlign?: 'left' | 'center' | 'right';
    verticalAlign?: 'top' | 'middle' | 'bottom';
    // Per-range styling applied on top of the item-level defaults
    // (color / fontWeight / fontStyle / etc.). Runs are half-open
    // [start, end) over `content`, sorted by start, non-overlapping
    // after normalization. Unset props on a run inherit from the item
    // defaults. When a format covers the whole string uniformly it's
    // promoted back to item-level and the run is dropped, so legacy
    // files without any runs keep rendering identically.
    styleRuns?: StyleRun[];
    // Line-level list rendering. Applied as a visual prefix per `\n`-split
    // line in display mode (bullet '• ' or '1. 2. …'); not stored in
    // `content`, so the textarea/overlay character alignment used by
    // styleRuns stays untouched. Hidden during inline edit so the
    // textarea value stays the source of truth — bullets reappear on
    // blur. Undefined / 'none' → no list.
    listType?: 'bullet' | 'numbered';
    // Set true the moment the user manually resizes a bordered text
    // card's height. Tells the auto-grow observer in TextItem to stop
    // syncing item.h to the rendered display height — otherwise the
    // observer overrides the user's explicit smaller height the next
    // render. Cleared by entering edit mode (typing more text auto-
    // grows again) or by an explicit "fit to content" action. Absent
    // / false on legacy items so the existing auto-fit behavior still
    // applies to agent-authored cards out of the box.
    userResizedHeight?: boolean;
}

// One span of custom formatting inside a TextItem's content. Half-open
// [start, end): `AGENT` at offset 12..17 is `{start: 12, end: 17}`, NOT
// `{start: 12, end: 16}`. `heading` is intentionally not overridable per
// range — it's a whole-item semantic flag, not a glyph style. Other
// item-level text fields (fontFamily etc.) live here so a partial-text
// selection can change them without touching the rest of the item.
export interface StyleRun {
    start: number;
    end: number;
    color?: string;
    bold?: boolean;
    italic?: boolean;
    underline?: boolean;
    strikethrough?: boolean;
    fontSize?: number;
    fontFamily?: string;
}

export type BoxShape = 'rect' | 'circle' | 'triangle' | 'diamond';

export interface BoxItem extends BaseItem {
    type: 'box';
    borderColor: string;
    borderWidth: number;
    fillColor: string;
    borderRadius: number;
    shape?: BoxShape;        // defaults to 'rect' for legacy items
    opacity?: number;        // 0–1, default 1
    lineStyle?: 'solid' | 'dashed' | 'dotted'; // default 'solid'
}

export interface ImageItem extends BaseItem {
    type: 'image';
    src: string;          // legacy data URL fallback. New drops use assetId; src is empty string.
    assetId?: string;     // key into renderer-side asset registry (bytes live in .any ZIP assets/)
    thumbnailAssetId?: string; // small downscaled preview — used at low zoom to cut GPU memory
    originalWidth: number;
    originalHeight: number;
    fileName: string;     // original filename, shown on hover / in exports
}

// Generic file card for any non-image drop. Bytes live in the .any ZIP's
// assets/ folder under assetId; preview (first PDF page, XLSX rows) is still
// embedded in the doc for fast render without extracting the asset.
export interface FileItem extends BaseItem {
    type: 'file';
    fileName: string;
    fileSize: number;     // bytes
    extension: string;    // lowercase, no dot (e.g. 'pdf')
    mimeType: string;
    assetId?: string;          // renderer registry key for original file bytes
    originalPath?: string;  // OS path when dropped from Explorer (for open-externally)
    previewDataUrl?: string;   // PDF first-page image, small
    previewPages?: number;     // for PDFs
    previewSheet?: {           // for XLSX: first 10 rows of first sheet
        sheetName: string;
        sheetCount: number;
        headers: string[];
        rows: string[][];
        totalRows: number;
    };
    previewHtml?: string;      // for DOCX: sanitized HTML snippet from mammoth (capped)
    previewWordCount?: number; // for DOCX: approximate word count of the source
}

// Sub-canvas / grouping frame. Items with parentId === container.id live inside.
// Container w/h define the frame; children are still stored at world coords
// (not relative), but they move together when the container moves.
export interface ContainerItem extends BaseItem {
    type: 'container';
    title: string;
    // Legacy: single collapse flag representing user intent. Preserved on
    // the type for backward compatibility with saved files. New code
    // reads `userCollapsed` instead — `collapsed` is dual-written for one
    // release cycle so old builds loading new files still behave
    // correctly. Remove after migration window closes.
    collapsed: boolean;
    // User's explicit collapse preference. Supersedes `collapsed` going
    // forward. Separated from zoom-collapsed so zoom transitions never
    // clobber user intent and vice versa (spec: Group Semantic Zoom).
    userCollapsed?: boolean;
    scopeLocked: boolean;     // agent commands outside can't see children
    borderColor: string;
    // Frame size at authoring time. Captured once on first render after
    // creation, then used as the baseline for chrome scaling: when the
    // container is resized, its own title bar height, title font size, and
    // resize handles — plus every child's resize handles — scale by the
    // ratio current/authored. Makes the group feel like a unified scaled
    // unit. `undefined` on legacy files; seeded lazily.
    authoredW?: number;
    authoredH?: number;
    // Tab width when collapsed — cosmetic and independent of w/h.
    //
    // w and h ALWAYS represent the expanded real dimensions. They are
    // NEVER mutated while the container is collapsed. Resizing the
    // collapsed tab only changes collapsedW; expanding just flips the
    // `collapsed` flag and rendering goes back to using w/h directly.
    //
    // undefined / null = "no custom tab width yet". On first collapse
    // we seed it via computeCompactCollapsedW — fits natural content
    // at the current zoom with a small generosity factor. The user
    // can then drag narrower or wider without ever affecting the
    // expanded layout. (Prior behavior seeded from item.w, which at
    // high zoom × wide group produced capsules ~10× natural size.)
    collapsedW?: number;
    // Schema marker for the collapsedW seed. v2 = compact-natural
    // formula. Absent/0 = pre-migration; anyFormat.ts deserialize
    // audits such items and, if capsuleScale-at-zoom-1 exceeds
    // PATHOLOGICAL_CAPSULE_SCALE, re-seeds. Bumped once per item to
    // keep load idempotent.
    collapsedWSeedVersion?: number;
}

// Interactive card the agent uses to ask the user for approval before taking
// an action. Lifecycle: 'pending' until user clicks a button → frozen with a
// chosen option. Agent-side waiting is implemented via a module-level
// resolver registry (approvalRegistry), not via polling.
export interface ApprovalItem extends BaseItem {
    type: 'approval';
    question: string;
    details?: string;
    options: string[];           // e.g. ['Approve', 'Deny']. Default two options.
    decision: string | null;     // the picked option, or null while pending
    decidedAt?: number;          // ms epoch of the click
}

// Rich link preview card. Pasted URLs become plain TextItems by default;
// right-click → "Convert to link preview" fetches Open Graph metadata and
// produces one of these. Opens in the user's default browser on click.
export interface LinkItem extends BaseItem {
    type: 'link';
    url: string;
    title?: string;
    description?: string;
    imageUrl?: string;       // OG image, http(s) — LinkItem fetches it client-side
    siteName?: string;       // og:site_name, or hostname fallback
    favicon?: string;
    fetchedAt?: number;
    // true while metadata fetch is in flight (for spinner). set to false on
    // resolve/reject. Persisted false; never true across reloads.
    loading?: boolean;
    error?: string;
}

// Reference to another .any canvas document on disk. Click opens it in a
// new tab via a module-level handler registered by MultiCanvas.
export interface CanvasLinkItem extends BaseItem {
    type: 'canvas-link';
    filePath: string;
    title: string;
}

// Inline HTML5 video player card. Bytes live in the asset registry / .any ZIP;
// the <video> element streams from the blob URL so we don't pull the full
// file into memory at once (spec §23 L5 — stream, don't load).
export interface VideoItem extends BaseItem {
    type: 'video';
    fileName: string;
    fileSize: number;
    extension: string;    // lowercase, no dot (e.g. 'mp4')
    mimeType: string;
    assetId?: string;
    originalPath?: string;
    posterDataUrl?: string;    // single decoded frame for offscreen / low-zoom rendering
    naturalWidth?: number;
    naturalHeight?: number;
    durationSec?: number;
    currentTimeSec?: number;   // last scrub position — restored on reopen
}

// Inline audio player card with a simple waveform visual. Same streaming
// strategy as VideoItem.
export interface AudioItem extends BaseItem {
    type: 'audio';
    fileName: string;
    fileSize: number;
    extension: string;
    mimeType: string;
    assetId?: string;
    originalPath?: string;
    waveformPeaks?: number[];  // downsampled amplitudes 0..1, ~200 samples
    durationSec?: number;
    currentTimeSec?: number;
}

// Syntax-highlighted editable code block. Stored inline in canvas.json (no
// binary asset); language drives Prism highlighting and the "Run" button
// routes through canvas_run_code for supported languages.
export type CodeLanguage =
    | 'javascript' | 'typescript' | 'python' | 'bash' | 'json'
    | 'html' | 'css' | 'sql' | 'go' | 'rust' | 'java' | 'c' | 'cpp'
    | 'markdown' | 'yaml' | 'text';

export interface CodeItem extends BaseItem {
    type: 'code';
    code: string;
    language: CodeLanguage;
    fileName?: string;        // optional label (e.g. "seed.sql")
    wrap?: boolean;           // soft-wrap long lines, default false
    lastRun?: {
        stdout: string;
        stderr: string;
        exitCode: number;
        ranAt: number;
    };
}

export type CanvasItem = TextItem | BoxItem | ImageItem | FileItem | ContainerItem | ApprovalItem | LinkItem | CanvasLinkItem | VideoItem | AudioItem | CodeItem;

// --- Drawings / connections (stubbed for Slice 2; rendered in Slice 2.1) ---

export interface DrawnLine {
    id: string;
    x1: number;
    y1: number;
    x2: number;
    y2: number;
    color: string;
    width: number;
    arrowHead: boolean;
    // Same fractional sort key as BaseItem.zKey. Sits in the same z-order
    // namespace as items, so a line can be sent behind a box via the
    // Arrange menu. Optional in the type because pre-v3 files predate it;
    // the v2→v3 migration backfills every line.
    zKey?: string;
    // Optional container ancestor. Drawings created inside a focused
    // group, or added to a group by Ctrl+G, carry this. Used for copy-
    // descendants, group auto-delete when empty, ungroup, and focus-mode
    // visibility. Null/undefined = top-level drawing.
    parentId?: string | null;
    // Frozen geometry at the moment this line was placed inside its
    // container parent. Same contract as BaseItem.authoredInParent: the
    // vector-scale effect in ContainerItem.tsx DERIVES current x1/y1/x2/y2
    // and width from these values times the container's current/authored
    // scale on every resize. Endpoints are stored RELATIVE to container
    // (x, y) so a shift-and-scale still lands them correctly.
    authoredInParent?: {
        x1: number; y1: number; x2: number; y2: number;
        width: number;
    };
}

export interface FreehandStroke {
    id: string;
    // pressure is optional 0..1 captured from the pointer event when the
    // input device exposes it (stylus, trackpad force-touch). Mouse
    // pointers report 0.5 in most browsers; perfect-freehand falls back
    // to 0.5 when the field is absent, so older saved files render
    // identically.
    points: { x: number; y: number; pressure?: number }[];
    color: string;
    width: number;
    parentId?: string | null;
    // Same fractional sort key as BaseItem.zKey. Sits in the same z-order
    // namespace as items, so a stroke can be sent behind a box via the
    // Arrange menu. Optional in the type because pre-v3 files predate it;
    // the v2→v3 migration backfills every stroke.
    zKey?: string;
    authoredInParent?: {
        points: { x: number; y: number; pressure?: number }[];
        width: number;
    };
}

export type RelationshipType = 'leads_to' | 'depends_on' | 'relates_to' | 'conflicts_with' | 'supports' | 'questions' | 'costs' | 'blocks';

export interface Connection {
    id: string;
    fromId: string;
    toId: string;
    label: string;
    color: string;
    width: number;
    arrowHead: boolean;
    style: 'solid' | 'dashed';
    createdBy: 'user' | 'agent';
    relationship?: RelationshipType;  // typed meaning; drives color + icon
}

// --- Viewport / tool state ---

export interface ViewState {
    panX: number;
    panY: number;
    zoom: number;
}

export type CanvasTool = 'type' | 'select' | 'box' | 'line' | 'pen' | 'connect' | 'eraser';

export const DEFAULT_VIEW: ViewState = { panX: 0, panY: 0, zoom: 1 };

export const DEFAULT_TEXT_COLOR = '#e8e8ed';
export const DEFAULT_BOX_BORDER = '#10b981';
export const DEFAULT_BOX_FILL = 'transparent';

// ID generator — local, no external dep. Collision-resistant enough for canvas
// items (which are small in count).
let idCounter = 0;
export function newId(prefix: string): string {
    idCounter += 1;
    return `${prefix}_${Date.now().toString(36)}_${idCounter}`;
}
