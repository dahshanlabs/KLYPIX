# CLAUDE.md — KLYPIX Canvas: The .any Workspace

## Project Context

KLYPIX is a Windows desktop AI assistant built with Electron 33 / React 19 / TypeScript / Vite / TailwindCSS. It has a working Chat mode, Agent mode with Hybrid Router, Flash Hardening, WSL2 Sandbox, and Memory system.

**What we're building:** A new Canvas mode — an infinite surface where the user types, drops files, draws, and commands an AI agent. Everything saves in a single `.any` file. This sits alongside Chat and Agent modes as a new tab.

**What this is NOT:** A whiteboard app. A note-taking app. A chat interface. It's a shared workspace between a human and an AI where everything is spatial, everything is connected, and everything lives in one portable file.

**Core philosophy:** As simple as a blank text file. Click anywhere to type. Drop anything. / to talk to the agent. Everything just works.

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────────┐
│ KLYPIX              ☁ Chat   📋 Canvas   ⚡ Agent  🧠   │
├─────────────────────────────────────────────────────────┤
│                                                          │
│  Canvas Surface (infinite, pannable, zoomable)           │
│  ┌────────────────────────────────────────────────────┐  │
│  │ Items: text, files, images, video, audio, code,    │  │
│  │        websites, containers, boxes, lines, arrows  │  │
│  │                                                    │  │
│  │ Agent: reads the canvas, builds on the canvas      │  │
│  │                                                    │  │
│  │ Everything saves → project.any (ZIP container)     │  │
│  └────────────────────────────────────────────────────┘  │
│                                                          │
│  ┌──────────────────────────────────────┐                │
│  │ / command bar (appears on / press)    │                │
│  └──────────────────────────────────────┘                │
└─────────────────────────────────────────────────────────┘
```

---

## File Structure

```
src/
├── canvas/
│   ├── KlypixCanvas.tsx              # Main canvas component (entry point)
│   ├── CanvasEngine.ts               # Core canvas logic (pan, zoom, transforms)
│   ├── CanvasRenderer.tsx            # Renders all items on the transform layer
│   │
│   ├── items/
│   │   ├── types.ts                  # All item type definitions
│   │   ├── TextItem.tsx              # Click-to-type text
│   │   ├── FileCard.tsx              # Any dropped file
│   │   ├── ImageItem.tsx             # Images (inline, resizable)
│   │   ├── VideoItem.tsx             # Video player card
│   │   ├── AudioItem.tsx             # Audio player card
│   │   ├── CodeItem.tsx              # Syntax-highlighted code block
│   │   ├── WebEmbed.tsx              # Live website browser card
│   │   ├── LinkPreview.tsx           # URL preview card
│   │   ├── ContainerItem.tsx         # Grouping container (sub-canvas)
│   │   ├── BoxItem.tsx               # Drawn rectangle
│   │   └── ChartItem.tsx             # Agent-generated charts
│   │
│   ├── drawing/
│   │   ├── LineDrawing.tsx           # Straight lines
│   │   ├── ConnectionArrow.tsx       # Curved arrows between items
│   │   ├── FreehandStroke.tsx        # Pen tool strokes
│   │   └── DrawingSVGLayer.tsx       # SVG overlay for all drawings
│   │
│   ├── interaction/
│   │   ├── SelectionManager.ts       # Single, multi, rubber-band selection
│   │   ├── DragManager.ts            # Item dragging + multi-drag
│   │   ├── ResizeHandles.tsx         # Corner/edge resize for all items
│   │   ├── ContextMenu.tsx           # Right-click menu
│   │   ├── CommandBar.tsx            # / command input at bottom
│   │   ├── ToastResponse.tsx         # Temporary agent answer (pin to keep)
│   │   ├── ChatThread.tsx            # Mini chat panel attached to item
│   │   └── KeyboardShortcuts.ts      # All hotkeys
│   │
│   ├── agent/
│   │   ├── canvasAgentTools.ts       # Tool definitions for agent
│   │   ├── canvasScopeResolver.ts    # Determines what agent can see
│   │   ├── canvasCommandParser.ts    # Parses / commands
│   │   ├── responseClassifier.ts     # Toast vs card vs thread decision
│   │   └── followUpManager.ts        # Nested follow-up tracking
│   │
│   ├── media/
│   │   ├── videoPlayer.ts            # Video playback logic
│   │   ├── audioPlayer.ts            # Audio playback logic
│   │   ├── voiceInput.ts             # Mic → text transcription
│   │   ├── videoAnalyzer.ts          # Frame extraction + vision analysis
│   │   └── audioTranscriber.ts       # Whisper transcription
│   │
│   ├── file/
│   │   ├── anyFormat.ts              # .any ZIP read/write
│   │   ├── fileDrop.ts               # Drag-and-drop handler
│   │   ├── thumbnailGenerator.ts     # Generate previews for files
│   │   ├── autoSave.ts              # Auto-save every 30s
│   │   └── exportEngine.ts           # Export canvas → PDF/PPTX/PNG
│   │
│   ├── layout/
│   │   ├── viewportCulling.ts        # Only render visible items
│   │   ├── snapGrid.ts              # Optional snap-to-grid
│   │   ├── autoArrange.ts           # Auto-layout algorithms
│   │   └── minimap.tsx              # Overview minimap
│   │
│   └── state/
│       ├── canvasStore.ts            # Central state (items, connections, settings)
│       ├── undoRedo.ts               # Undo/redo stack
│       └── canvasHistory.ts          # Action history for undo
│
├── electron/
│   └── canvas/
│       ├── anyFileHandler.ts         # .any ZIP operations in main process
│       ├── fileAssociation.ts        # Register .any with Windows
│       └── thumbnailWorker.ts        # Background thumbnail generation
```

---

## 1. Item Types (`items/types.ts`)

```typescript
// ---- BASE ----

export interface CanvasItem {
  id: string;
  type: ItemType;
  x: number;
  y: number;
  w?: number;
  h?: number;
  zIndex: number;
  locked: boolean;                      // prevent accidental move
  parentId: string | null;              // container parent (null = root canvas)
  createdAt: number;
  createdBy: 'user' | 'agent';
  metadata?: Record<string, any>;
}

export type ItemType =
  | 'text'
  | 'file'
  | 'image'
  | 'video'
  | 'audio'
  | 'code'
  | 'web_embed'
  | 'link_preview'
  | 'container'
  | 'box'
  | 'chart'
  | 'agent_response'
  | 'approval';

// ---- TEXT ----

export interface TextItem extends CanvasItem {
  type: 'text';
  content: string;                      // plain text or simple markdown
  fontSize: number;                     // default 16
  fontWeight: 'normal' | 'bold';
  fontStyle: 'normal' | 'italic';
  color: string;                        // text color
  border: boolean;                      // has visible border (card mode)
  borderColor: string;
  heading: boolean;                     // heading style (larger, bolder)
  codeBlock: boolean;                   // monospace + dark background
  checklist: boolean;                   // lines become checkboxes
  maxWidth: number;                     // wrap width (default 500)
}

// ---- FILE ----

export interface FileItem extends CanvasItem {
  type: 'file';
  fileName: string;
  fileSize: number;
  extension: string;
  assetPath: string;                    // path inside .any ZIP: assets/a1_file.pdf
  thumbnailPath: string | null;         // path to generated thumbnail
  mimeType: string;
}

// ---- IMAGE ----

export interface ImageItem extends CanvasItem {
  type: 'image';
  assetPath: string;
  originalWidth: number;
  originalHeight: number;
  // w and h from CanvasItem used for display size
}

// ---- VIDEO ----

export interface VideoItem extends CanvasItem {
  type: 'video';
  assetPath: string;
  duration: number;                     // seconds
  thumbnailPath: string;
  transcriptPath: string | null;        // path to transcript JSON if generated
  currentTime: number;                  // playback position (saved)
}

// ---- AUDIO ----

export interface AudioItem extends CanvasItem {
  type: 'audio';
  assetPath: string;
  duration: number;
  transcriptPath: string | null;
  currentTime: number;
}

// ---- CODE ----

export interface CodeItem extends CanvasItem {
  type: 'code';
  content: string;
  language: string;                     // auto-detected or user-set
  runnable: boolean;                    // show Run button if sandbox available
  lastOutput: string | null;            // output from last run
  lastExitCode: number | null;
}

// ---- WEB EMBED ----

export interface WebEmbedItem extends CanvasItem {
  type: 'web_embed';
  url: string;
  title: string;
  // w and h for viewport size
}

// ---- LINK PREVIEW ----

export interface LinkPreviewItem extends CanvasItem {
  type: 'link_preview';
  url: string;
  title: string;
  description: string;
  thumbnailPath: string | null;
}

// ---- CONTAINER ----

export interface ContainerItem extends CanvasItem {
  type: 'container';
  title: string;
  collapsed: boolean;                   // true = shows only title bar
  scopeLocked: boolean;                 // true = agent cannot see outside
  borderColor: string;
  childCount: number;                   // cached count of children
  // w and h define the container boundary
}

// ---- BOX (shape) ----

export interface BoxItem extends CanvasItem {
  type: 'box';
  borderColor: string;
  borderWidth: number;
  fillColor: string;                    // 'transparent' or color
  borderRadius: number;
}

// ---- CHART ----

export interface ChartItem extends CanvasItem {
  type: 'chart';
  chartImagePath: string;               // rendered chart as PNG
  chartData: any;                       // raw data for re-rendering
  chartType: 'bar' | 'line' | 'pie' | 'donut' | 'scatter';
}

// ---- AGENT RESPONSE ----

export interface AgentResponseItem extends CanvasItem {
  type: 'agent_response';
  content: string;
  sourceCommand: string;                // the / command that triggered this
  sourceItemIds: string[];              // items the agent read to produce this
  followUps: FollowUp[];               // nested follow-up Q&As
  isToast: boolean;                     // true = temporary, false = permanent card
}

export interface FollowUp {
  id: string;
  question: string;
  answer: string;
  timestamp: number;
}

// ---- APPROVAL ----

export interface ApprovalItem extends CanvasItem {
  type: 'approval';
  description: string;                  // what the agent wants to do
  status: 'pending' | 'approved' | 'denied';
  agentAction: any;                     // serialized action to execute if approved
}

// ---- CONNECTION ----

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
}

// ---- LINE ----

export interface DrawnLine {
  id: string;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  color: string;
  width: number;
  arrowHead: boolean;
}

// ---- FREEHAND STROKE ----

export interface FreehandStroke {
  id: string;
  points: { x: number; y: number }[];
  color: string;
  width: number;
}

// ---- CHAT THREAD ----

export interface ChatThread {
  itemId: string;                       // attached to which canvas item
  messages: ThreadMessage[];
  collapsed: boolean;
}

export interface ThreadMessage {
  role: 'user' | 'agent';
  content: string;
  timestamp: number;
}
```

---

## 2. Canvas Modes & Tools

```typescript
export type CanvasMode =
  | 'type'      // T — default. Click empty space → create text
  | 'select'    // V — click to select, drag to rubber-band
  | 'line'      // L — drag to draw line
  | 'box'       // B — drag to draw box
  | 'pen'       // P — freehand drawing
  | 'connect';  // C — click item A, click item B → arrow

// Default mode is always 'type'. User returns to type by pressing T or Escape.
```

**Left toolbar layout:**

```
┌─────┐
│  T  │  Type (default)
│  ↗  │  Select
├─────┤
│  ─  │  Line
│  □  │  Box
│  ⌇  │  Pen
│  ⤳  │  Connect
├─────┤
│ 🎨  │  Color picker (10 colors)
│ ━━━ │  Line width (1, 2, 4)
├─────┤
│ 🎤  │  Voice input (hold to speak)
└─────┘
```

---

## 3. The / Command System

### Command Bar (`interaction/CommandBar.tsx`)

When user presses `/` anywhere:

```typescript
interface CommandBarState {
  visible: boolean;
  input: string;
  scope: CommandScope;
  selectedItemIds: string[];
  containerId: string | null;           // if inside a container
  autocompleteResults: string[];
}

interface CommandScope {
  type: 'selected' | 'container' | 'nearby' | 'full_canvas';
  itemIds: string[];                    // resolved items the agent will read
  description: string;                  // "2 items selected" or "inside Q3 container"
}
```

**Command bar UI:**

```
┌──────────────────────────────────────────────────────┐
│ /  summarize these documents                          │
│   📎 2 items selected · inside Q3 container    [⏎]   │
│                                                       │
│   /summarize    /compare    /translate    /chart      │  ← autocomplete
│   /research     /export     /email       /run         │
└──────────────────────────────────────────────────────┘
```

**Also works inline:** User can type / directly on canvas (creates a text item starting with /). Agent detects it and runs it. The / text fades to a small gray label after execution.

### Command Autocomplete

```typescript
const CANVAS_COMMANDS = [
  { cmd: '/summarize',   desc: 'Summarize selected items or nearby content' },
  { cmd: '/compare',     desc: 'Compare two or more selected items' },
  { cmd: '/translate',   desc: 'Translate selected text to another language' },
  { cmd: '/chart',       desc: 'Create chart from data' },
  { cmd: '/research',    desc: 'Research a topic, pin findings to canvas' },
  { cmd: '/export',      desc: 'Export canvas or selection as PDF/PPTX/PNG' },
  { cmd: '/email',       desc: 'Draft email from selected content' },
  { cmd: '/run',         desc: 'Execute selected code card' },
  { cmd: '/transcribe',  desc: 'Transcribe selected video or audio' },
  { cmd: '/analyze',     desc: 'Deep analysis of selected item' },
  { cmd: '/arrange',     desc: 'Auto-layout items on canvas' },
  { cmd: '/schedule',    desc: 'Create a recurring task' },
  { cmd: '/monitor',     desc: 'Watch a URL for changes' },
  { cmd: '/search',      desc: 'Search text across entire canvas' },
  { cmd: '/connect',     desc: 'Draw relationships between items' },
];
```

---

## 4. Agent Scope Resolution (`agent/canvasScopeResolver.ts`)

```typescript
/**
 * SCOPE RESOLUTION — Determines what the agent can see for each command.
 *
 * Priority order:
 * 1. Explicitly selected items → SCOPE: selected
 * 2. Inside a container → SCOPE: container contents
 * 3. Nothing selected, not in container → SCOPE: nearby items (radius from / position)
 * 4. User says "entire canvas" / "all" / "everything" → SCOPE: full canvas
 */

function resolveScope(
  command: string,
  selectedItemIds: string[],
  commandPosition: { x: number; y: number } | null,
  activeContainerId: string | null,
  allItems: CanvasItem[]
): CommandScope {

  // SCOPE 1: Selected items
  if (selectedItemIds.length > 0) {
    return {
      type: 'selected',
      itemIds: selectedItemIds,
      description: `${selectedItemIds.length} items selected`,
    };
  }

  // SCOPE 2: Inside a container
  if (activeContainerId) {
    const children = allItems.filter(i => i.parentId === activeContainerId);
    return {
      type: 'container',
      itemIds: children.map(i => i.id),
      description: `inside "${allItems.find(i => i.id === activeContainerId)?.title}" container`,
    };
  }

  // SCOPE 3: Full canvas (explicit keywords)
  const fullCanvasKeywords = /entire canvas|all items|everything|full canvas|this project|whole/i;
  if (fullCanvasKeywords.test(command)) {
    return {
      type: 'full_canvas',
      itemIds: allItems.map(i => i.id),
      description: 'full canvas',
    };
  }

  // SCOPE 4: Nearby items (default)
  if (commandPosition) {
    const RADIUS = 600; // pixels in canvas space
    const nearby = allItems.filter(i => {
      const dx = i.x - commandPosition.x;
      const dy = i.y - commandPosition.y;
      return Math.sqrt(dx * dx + dy * dy) < RADIUS;
    });
    return {
      type: 'nearby',
      itemIds: nearby.map(i => i.id),
      description: `${nearby.length} nearby items`,
    };
  }

  // Fallback: everything
  return {
    type: 'full_canvas',
    itemIds: allItems.map(i => i.id),
    description: 'full canvas',
  };
}
```

---

## 5. Agent Response Classification (`agent/responseClassifier.ts`)

```typescript
/**
 * Decides if the agent's response is a toast (temporary) or a card (permanent).
 *
 * TOAST: quick answers, lookups, yes/no, calculations
 * CARD: summaries, analyses, charts, tables, files, anything substantial
 */

type ResponseType = 'toast' | 'card' | 'file_card';

function classifyResponse(
  command: string,
  responseText: string,
  filesCreated: string[],
  chartsCreated: string[]
): ResponseType {

  // Any files or charts → always permanent card
  if (filesCreated.length > 0 || chartsCreated.length > 0) return 'file_card';

  // Short answer to simple question → toast
  if (responseText.length < 200) {
    const simplePatterns = /^(what time|how many|what is|how much|yes|no|calculate|convert)/i;
    if (simplePatterns.test(command)) return 'toast';
  }

  // Everything else → permanent card
  return 'card';
}
```

**Toast behavior:**
- Appears as floating card near the command location
- Fades after 10 seconds
- Has a [📌 Pin] button — click to make permanent
- Click the toast body to keep it visible (pauses timer)
- Pinning converts it to a permanent agent_response card on canvas

**Card behavior:**
- Appears as a bordered card at a logical position (below command, or near source items)
- Stays permanently
- Agent auto-draws connection arrows from source items to the response card
- Right-click → delete to remove

---

## 6. Follow-Up System (`agent/followUpManager.ts`)

```typescript
/**
 * FOLLOW-UP PATTERNS:
 *
 * Pattern 1: Sequential commands in command bar
 *   Agent remembers previous command context.
 *   /summarize this PDF → creates card
 *   /go deeper on revenue → creates nested card inside the previous one
 *
 * Pattern 2: Right-click item → "Ask follow-up"
 *   Opens command bar scoped to that item.
 *   Answer appears nested inside the clicked item's card.
 *
 * Pattern 3: Chat thread on item
 *   Right-click → "Open chat thread"
 *   Mini chat panel opens attached to the item.
 *   Multi-turn conversation scoped to that item.
 *   Saved in .any file. Collapsible.
 */

interface FollowUpContext {
  previousCommandId: string | null;
  previousResponseId: string | null;
  conversationHistory: { role: string; content: string }[];
  scopeItemIds: string[];
}
```

**Nesting visual:**

```
┌─── 🤖 Agent: Summary ──────────────────────┐
│ Revenue was $4.2M. KSA drove 60%.           │
│                                              │
│ ┌─── Follow-up ────────────────────────────┐│
│ │ You: what about R&D?                     ││
│ │ Agent: R&D was $251K (1%), notably low.  ││
│ │                                          ││
│ │ ┌─── Follow-up ────────────────────────┐ ││
│ │ │ You: compare to industry average     │ ││
│ │ │ Agent: Industry average is 8-12%.    │ ││
│ │ │ JPI is significantly under-investing.│ ││
│ │ └──────────────────────────────────────┘ ││
│ └──────────────────────────────────────────┘│
└──────────────────────────────────────────────┘
```

Follow-ups collapse/expand with a toggle. Collapsed shows: "💬 2 follow-ups"

---

## 7. Chat Thread on Item (`interaction/ChatThread.tsx`)

```typescript
/**
 * A mini chat panel attached to any canvas item.
 * For deep, multi-turn discussion about one specific item.
 *
 * Opens via: right-click item → "Open chat thread"
 * Closes via: click X or collapse
 * Saved: stored in .any file per item
 * Scope: agent only sees this item + thread history (not full canvas)
 */
```

**Visual:**

```
┌─── 📄 Q3 Report.pdf ───────────────────────┐
│   [page preview]                             │
├─── 💬 Thread ────────────────────── [▼] [✕] ┤
│ You: what was the biggest expense?           │
│ 🤖: Manufacturing at $8.9M (35%)            │
│                                              │
│ You: is that higher than Q2?                 │
│ 🤖: Yes, up 12% from $7.9M in Q2.          │
│                                              │
│ ┌──────────────────────────────────────┐     │
│ │ type here...                    [⏎]  │     │
│ └──────────────────────────────────────┘     │
└──────────────────────────────────────────────┘
```

---

## 8. Container System (`items/ContainerItem.tsx`)

```typescript
/**
 * CONTAINERS — Sub-canvases that group items and scope the agent.
 *
 * Creation:
 *   - Draw a box with box tool → double-click it → becomes container (gets title bar)
 *   - Or: select multiple items → right-click → "Group into container"
 *   - Or: agent creates one via create_container tool
 *
 * Behavior:
 *   - Items placed inside are children (parentId = container.id)
 *   - Move container → children move with it
 *   - Resize container → boundary changes, children stay
 *   - Collapse → hide all children, show only title bar + item count
 *   - Lock scope → agent cannot see outside this container, outside cannot see in
 *
 * Nesting:
 *   - Containers can be inside other containers (max 3 levels deep)
 *   - Each level indents the title bar slightly
 */
```

**Expanded:**
```
┌─── Q3 Analysis ──────────────────────── ▼ ✕ ┐
│                                              │
│  📄 Q3 Report.pdf    📊 Revenue Chart       │
│                                              │
│  Revenue was $4.2M                           │
│  KSA drove 60% of growth                    │
│                                              │
│  ┌─── Sub-group: Expenses ──── ▼ ┐          │
│  │  📄 Expense breakdown         │          │
│  │  📊 Expense chart             │          │
│  └────────────────────────────────┘          │
│                                              │
└──────────────────────────────────────────────┘
```

**Collapsed:**
```
┌─── Q3 Analysis ──────── 7 items ────── ▶ ✕ ┐
```

**Locked (agent isolation):**
```
┌─── 🔒 Confidential Data ──────────── ▼ ✕ ┐
│                                            │
│  Agent commands outside this container     │
│  cannot read anything in here.             │
│                                            │
└────────────────────────────────────────────┘
```

---

## 9. Agent Canvas Tools (`agent/canvasAgentTools.ts`)

These tools are registered with the Hybrid Router when Canvas mode is active.

```typescript
// ---- READ TOOLS ----

canvas_get_items(scope)
  // Returns all items within the resolved scope
  // Each item: id, type, position, content summary
  // Used by agent to understand the workspace

canvas_read_item(item_id)
  // Returns full content of one item
  // Text → full text. File → extracted text. Code → source.

canvas_read_file(item_id)
  // Extracts file from .any ZIP to sandbox, returns content
  // PDF → extracted text. Excel → parsed data. Image → description.

canvas_get_connections()
  // Returns all arrows/connections with from/to ids and labels
  // Agent uses this to understand relationships

canvas_search(query)
  // Full-text search across all items on canvas
  // Returns matching items with highlighted context

// ---- WRITE TOOLS ----

canvas_create_text(content, x, y, options?)
  // Creates a text item at position
  // options: { border, heading, codeBlock, fontSize, color }

canvas_create_card(title, body, x, y)
  // Creates a bordered text card (text with border=true, heading title)

canvas_create_container(title, x, y, w, h)
  // Creates a container with title bar

canvas_pin_file(sandbox_file_path, x, y)
  // Copies file from sandbox into .any assets, creates file card

canvas_pin_image(sandbox_image_path, x, y, w?, h?)
  // Copies image from sandbox into .any assets, creates image item

canvas_pin_chart(chart_type, chart_data, x, y)
  // Renders chart to PNG, pins as chart card

canvas_connect_items(from_id, to_id, label?, color?)
  // Draws arrow between two items

canvas_update_item(item_id, updates)
  // Modifies content, position, style of existing item

canvas_delete_item(item_id)
  // Removes item (requires approval if user-created)

canvas_add_border(item_id, color?)
  // Adds border to a text item, making it a card

canvas_arrange_items(item_ids, layout)
  // Auto-arranges items: 'grid' | 'tree' | 'horizontal' | 'vertical'

canvas_group_into_container(item_ids, title)
  // Wraps selected items in a new container

// ---- ACTION TOOLS ----

canvas_run_code(item_id)
  // Executes a code card in WSL2 sandbox, shows output

canvas_create_approval(description, action)
  // Creates an approval card the user must approve/deny before agent proceeds

canvas_create_toast(message)
  // Shows a temporary floating message (for quick answers)
```

---

## 10. The .any File Format (`file/anyFormat.ts`)

```typescript
/**
 * .ANY FILE FORMAT
 *
 * A .any file is a ZIP archive with this structure:
 *
 * project.any (ZIP)
 * ├── canvas.json           ← all items, connections, settings, view state
 * ├── assets/               ← embedded files (originals, no conversion)
 * │   ├── a001_report.pdf
 * │   ├── a002_video.mp4
 * │   ├── a003_chart.png
 * │   └── ...
 * ├── thumbnails/           ← generated previews (small, for fast loading)
 * │   ├── a001_report.jpg
 * │   ├── a002_video.jpg
 * │   └── ...
 * ├── transcripts/          ← generated transcriptions
 * │   ├── a002_video.json
 * │   └── ...
 * ├── threads/              ← chat threads per item
 * │   ├── item_xyz.json
 * │   └── ...
 * └── agent/                ← agent metadata
 *     ├── history.json      ← what commands ran, when, what they produced
 *     └── skills.json       ← learned patterns from this canvas
 */

interface CanvasDocument {
  version: '1.0';
  createdAt: string;
  updatedAt: string;
  title: string;

  // View state (restored on open)
  viewState: {
    panX: number;
    panY: number;
    zoom: number;
  };

  // All items on the canvas
  items: CanvasItem[];

  // All connections (arrows between items)
  connections: Connection[];

  // All drawn lines
  lines: DrawnLine[];

  // All freehand strokes
  strokes: FreehandStroke[];

  // Chat threads
  threads: Record<string, ChatThread>;

  // Canvas settings
  settings: {
    gridVisible: boolean;
    snapToGrid: boolean;
    theme: 'dark' | 'light';
    defaultFontSize: number;
  };
}
```

**Save logic:**

```typescript
async function saveAnyFile(
  doc: CanvasDocument,
  assets: Map<string, ArrayBuffer>,     // assetPath → file bytes
  filePath: string
): Promise<void> {
  // Use JSZip in renderer or yazl in main process
  const zip = new JSZip();

  // Add canvas JSON
  zip.file('canvas.json', JSON.stringify(doc, null, 2));

  // Add assets (files stored as-is, no encoding)
  for (const [path, buffer] of assets) {
    zip.file(path, buffer);
  }

  // Generate ZIP and write to disk
  const blob = await zip.generateAsync({ type: 'arraybuffer' });
  await fs.writeFile(filePath, Buffer.from(blob));
}
```

**Open logic:**

```typescript
async function openAnyFile(filePath: string): Promise<{
  doc: CanvasDocument;
  assets: Map<string, ArrayBuffer>;
}> {
  const data = await fs.readFile(filePath);
  const zip = await JSZip.loadAsync(data);

  const canvasJson = await zip.file('canvas.json')?.async('string');
  const doc: CanvasDocument = JSON.parse(canvasJson!);

  // Lazy-load assets (only load thumbnails initially, full files on demand)
  const assets = new Map<string, ArrayBuffer>();
  // Thumbnails loaded immediately for fast rendering
  for (const [path, file] of Object.entries(zip.files)) {
    if (path.startsWith('thumbnails/')) {
      assets.set(path, await file.async('arraybuffer'));
    }
  }

  return { doc, assets };
}
```

**File association (Windows):**

```typescript
// Register .any extension so double-click opens KLYPIX
// In electron/canvas/fileAssociation.ts

function registerAnyFileType() {
  if (process.platform === 'win32') {
    const { app } = require('electron');
    app.setAsDefaultProtocolClient('klypix');
    // Also register via Windows registry for .any extension
    // HKEY_CLASSES_ROOT\.any → KLYPIX.AnyFile
    // HKEY_CLASSES_ROOT\KLYPIX.AnyFile\shell\open\command → "klypix.exe" "%1"
  }
}
```

---

## 11. Voice Input (`media/voiceInput.ts`)

```typescript
/**
 * VOICE INPUT
 *
 * Hold mic button (or Ctrl+M) → speak → text appears on canvas.
 * Works for both notes and / commands.
 *
 * Uses Web Speech API (built into Chromium/Electron) for real-time.
 * Falls back to Whisper API for better accuracy + Arabic support.
 */

class VoiceInput {
  private recognition: SpeechRecognition;
  private onResult: (text: string) => void;

  constructor() {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    this.recognition = new SR();
    this.recognition.continuous = false;
    this.recognition.interimResults = true;
    this.recognition.lang = 'en-US';    // also support 'ar-SA' for Arabic
  }

  start(callback: (text: string, isFinal: boolean) => void) {
    this.recognition.onresult = (event) => {
      const result = event.results[event.results.length - 1];
      callback(result[0].transcript, result.isFinal);
    };
    this.recognition.start();
  }

  stop() {
    this.recognition.stop();
  }

  setLanguage(lang: 'en-US' | 'ar-SA') {
    this.recognition.lang = lang;
  }
}
```

**UX:** While holding the mic button, a waveform indicator shows. Interim text appears in real-time at the cursor position. On release, final text is committed. If the text starts with `/`, it triggers the agent command.

---

## 12. Video Analysis (`media/videoAnalyzer.ts`)

```typescript
/**
 * VIDEO ANALYSIS
 *
 * Extracts key frames + audio → sends to Gemini multimodal → analysis card.
 *
 * Approach:
 * 1. Extract audio → transcribe with Whisper (or Gemini)
 * 2. Extract key frames (1 per 10-30 seconds, detect scene changes)
 * 3. Send frames + transcript to Gemini Flash vision
 * 4. Generate: summary, key moments, action items
 * 5. Key moments are clickable → seek video to that timestamp
 */

async function analyzeVideo(
  videoAssetPath: string,
  analysisType: 'summary' | 'transcribe' | 'action_items' | 'key_moments'
): Promise<VideoAnalysisResult> {

  // Step 1: Extract to sandbox
  // Copy video from .any to WSL2 sandbox workspace

  // Step 2: Extract audio (ffmpeg in sandbox)
  // ffmpeg -i video.mp4 -vn -acodec pcm_s16le audio.wav

  // Step 3: Transcribe audio
  // Use Whisper locally or Gemini API

  // Step 4: Extract key frames
  // ffmpeg -i video.mp4 -vf "select=gt(scene\,0.3)" -vsync vfr frame_%04d.jpg

  // Step 5: Send frames + transcript to Gemini Flash (multimodal)
  // Get analysis

  // Step 6: Return structured result with timestamps
  return {
    summary: "Board meeting discussing Q3...",
    keyMoments: [
      { timestamp: 200, label: "Revenue chart presented", frame: "frame_0012.jpg" },
      { timestamp: 765, label: "KSA expansion discussion", frame: "frame_0034.jpg" },
    ],
    actionItems: [...],
    transcript: [...],
  };
}
```

---

## 13. Keyboard Shortcuts (`interaction/KeyboardShortcuts.ts`)

```typescript
const SHORTCUTS = {
  // Mode switching
  't':                'mode:type',
  'v':                'mode:select',
  'l':                'mode:line',
  'b':                'mode:box',
  'p':                'mode:pen',
  'c':                'mode:connect',

  // Commands
  '/':                'open:commandbar',
  'Escape':           'cancel',

  // Edit
  'ctrl+z':           'undo',
  'ctrl+shift+z':     'redo',
  'ctrl+c':           'copy',
  'ctrl+v':           'paste',
  'ctrl+d':           'duplicate',
  'ctrl+a':           'select:all',
  'Delete':           'delete:selected',
  'Backspace':        'delete:selected',

  // File
  'ctrl+s':           'file:save',
  'ctrl+o':           'file:open',
  'ctrl+n':           'file:new',
  'ctrl+shift+s':     'file:saveas',

  // View
  'ctrl+0':           'view:fitall',
  'ctrl+=':           'view:zoomin',
  'ctrl+-':           'view:zoomout',
  'ctrl+f':           'search',

  // Text formatting (only when editing text)
  'ctrl+b':           'text:bold',
  'ctrl+i':           'text:italic',

  // Voice
  'ctrl+m':           'voice:toggle',

  // When none of the above, and in type mode:
  // Any printable key → creates text at cursor position
};
```

---

## 14. Undo/Redo System (`state/undoRedo.ts`)

```typescript
/**
 * Every canvas action is recorded as an UndoAction.
 * Ctrl+Z reverses it. Ctrl+Shift+Z re-applies it.
 * Stack: 100 levels deep.
 *
 * Actions that are undoable:
 * - Create item
 * - Delete item
 * - Move item (records start + end position)
 * - Resize item
 * - Edit text content
 * - Draw line/stroke
 * - Create/delete connection
 * - Change item style (border, color, etc.)
 * - Agent creates item (undo removes agent output)
 */

interface UndoAction {
  type: string;
  timestamp: number;
  forward: () => void;      // do or redo the action
  backward: () => void;     // undo the action
  description: string;      // "Move Q3 Report.pdf" for UI
}
```

---

## 15. Auto-Save (`file/autoSave.ts`)

```typescript
/**
 * AUTO-SAVE
 *
 * - Saves every 30 seconds if canvas has changes
 * - Saves immediately on: file drop, agent completes work, user presses Ctrl+S
 * - Saves to the current .any file path
 * - If no file path yet (new canvas), saves to %APPDATA%/klypix/autosave/untitled.any
 * - Dirty indicator: dot (•) in title bar when unsaved changes exist
 * - On crash recovery: detect autosave file on next launch, offer to restore
 */
```

---

## 16. Performance (`layout/viewportCulling.ts`)

```typescript
/**
 * VIEWPORT CULLING
 *
 * Only render items visible in the current viewport.
 * Critical for canvases with 100+ items.
 *
 * Logic:
 * 1. Calculate visible rectangle from pan + zoom
 * 2. Filter items whose bounding box intersects the visible rect
 * 3. Only mount React components for visible items
 * 4. Items off-screen are unmounted (saves memory + CPU)
 * 5. Thumbnails used for items at low zoom levels (far away)
 *
 * Target: smooth 60fps with 1000+ items on canvas
 */
```

---

## 17. Integration with Existing KLYPIX

### Tab system

```
┌─────────────────────────────────────────────┐
│ KLYPIX         ☁ Chat   📋 Canvas   ⚡ Agent │
└─────────────────────────────────────────────┘
```

- Chat: existing chat mode (unchanged)
- Canvas: new .any workspace (this spec)
- Agent: existing agent mode (unchanged)

Canvas mode shares the same Hybrid Router, Flash Engine, WSL2 Sandbox, and Memory system. The only new thing is the canvas UI and the canvas-specific agent tools.

### Router integration

When Canvas mode is active, register canvas tools alongside existing tools:

```typescript
function getAvailableTools(mode: 'chat' | 'canvas' | 'agent'): Tool[] {
  const base = [...CORE_TOOLS];

  if (sandboxReady) base.push(...SANDBOX_TOOLS);

  if (mode === 'canvas') {
    base.push(...CANVAS_AGENT_TOOLS);  // canvas_get_items, canvas_create_text, etc.
  }

  return base;
}
```

### Memory integration

Canvas-level memories: "Last time user worked on the Q3 canvas, they focused on KSA expenses." Extracted from canvas agent history, stored in the memory system.

---

## 18. Implementation Order

```
Phase 1 — Core canvas (Week 1-2)
  MUST HAVE before anything else:
  ├── Canvas surface with pan/zoom
  ├── Click to type (text items)
  ├── Drag to move all items
  ├── Selection (single + multi + rubber band)
  ├── Resize handles on all items
  ├── Draw lines, boxes
  ├── Connect items with arrows
  ├── Freehand pen tool
  ├── Color picker + line width
  ├── Context menu (right-click)
  ├── Keyboard shortcuts
  ├── Undo/redo (CRITICAL)
  └── Drop files (appear as cards)

Phase 2 — Persistence (Week 2-3)
  ├── .any file format (ZIP save/load)
  ├── Auto-save every 30s
  ├── Ctrl+S / Ctrl+O / Ctrl+N
  ├── Dirty indicator in title
  ├── .any file association on Windows
  ├── Viewport culling for performance
  └── Image items with resize

Phase 3 — Media (Week 3-4)
  ├── Video player card (inline HTML5 video)
  ├── Audio player card
  ├── Voice input (Web Speech API)
  ├── Code cards with syntax highlighting
  ├── Link preview cards (paste URL)
  └── Thumbnail generation for files

Phase 4 — Agent integration (Week 4-5)
  ├── / command bar
  ├── Command autocomplete
  ├── Scope resolution (selected, container, nearby, full)
  ├── Canvas agent tools (read + write)
  ├── Response classification (toast vs card)
  ├── Follow-up nesting
  ├── Chat threads on items
  ├── Agent draws connections automatically
  └── Container system (group, collapse, scope lock)

Phase 5 — Advanced (Week 5-6)
  ├── Web embed (Electron webview)
  ├── Video analysis (frame extraction + Gemini vision)
  ├── Audio transcription (Whisper)
  ├── Runnable code cards (execute in sandbox)
  ├── Approval cards
  ├── Export canvas → PDF / PPTX / PNG
  ├── Minimap
  ├── Alignment guides (snap lines)
  └── Light theme

Phase 6 — Power features (Week 6+)
  ├── Canvas zones (auto-processing areas)
  ├── Scheduled task cards
  ├── Web monitor cards
  ├── Drag-and-drop workflows (file onto card = action)
  ├── Canvas-to-slides export
  └── Agent skill learning from canvas work
```

---

## 19. Summary for Claude Code

When executing this spec:

1. Build Phase 1 first — core canvas MUST be solid before adding features
2. Use the existing React prototype (KlypixNotes.jsx) as starting point — extend it, don't rewrite
3. Canvas is a new TAB alongside existing Chat and Agent — don't modify existing modes
4. Register canvas tools with the Hybrid Router when canvas tab is active
5. Undo/redo is CRITICAL — implement early, not as an afterthought
6. .any save/load is CRITICAL — without persistence the canvas is useless
7. Performance matters — implement viewport culling by Phase 2
8. Agent integration (Phase 4) depends on Phases 1-3 being solid
9. Test with real use cases: drop 3 PDFs, ask agent to compare, verify the full flow works
10. Commit after each phase

**The canvas must feel as simple as a text file. If it feels complicated, something is wrong. Strip complexity until it feels effortless.**

---

## 20. ADDENDUM — Missing Features

### A. Drawing Enhancement

Full freeform drawing capability:
- Pen tool: smooth freehand curves (quadratic bezier smoothing on raw points)
- Line styles: solid, dashed (strokeDasharray "8 4"), dotted ("2 4"), arrow
- Shapes: rectangle, circle/ellipse, triangle, diamond, star, custom polygon (click-to-close)
- Fill: transparent (default), solid color, semi-transparent
- Opacity slider: 0-100% per stroke/shape (highlighter effect at 30%)
- Thickness slider: 1px to 20px
- Color: full color picker with hex input + eyedropper + 10 presets
- Eraser: removes strokes intersecting the eraser path
- Edit after drawing: select drawn shape → change color/style/fill/thickness
- Convert shape to container: right-click shape → "Make container"

### B. File Compile / Bundle

/compile command gathers selected items into one output file:
- /compile into PDF → items become pages (top-to-bottom, left-to-right order)
- /compile into PPTX → each item/container becomes a slide
- /compile into DOCX → items become document sections
- /compile into ZIP → all selected files bundled
- /compile into email → text = body, files = attachments, creates draft card
Canvas spatial layout determines document order. Containers = chapters.

### C. Tier-Based File Support

Tier 1 (native preview): images, video, audio, PDF, Excel/CSV, code, markdown, JSON
Tier 2 (card + open externally): DWG, DXF, ZIP, RAR, DOCX, PPTX, PSD, AI, STL, OBJ, FBX
Tier 3 (agent-processable): anything else via WSL2 sandbox tools
ZIP files show content listing on card. Click → extract or agent unzips.
AutoCAD: agent converts DWG→PDF/SVG in sandbox for preview.

### D. Multiple Canvases / Tabs

Multiple .any files open as tabs. Switch instantly. Drag items between tabs. Agent can reference other open canvases. Recent files dashboard on empty state.

### E. Canvas-to-Canvas Links

Link items across .any files. Click link → opens the other file and jumps to that item. Like hyperlinks between workspaces.

### F. Version History / Time Travel

Every save creates a version snapshot inside the .any ZIP (versions/ folder). History sidebar: preview past versions, restore, see user vs agent changes in different colors.

### G. Presentation Mode

Select items/containers in order → /present. Canvas becomes a slideshow with smooth zoom-pan transitions between items. Fullscreen, arrow keys to navigate. Like Prezi from your workspace.

### H. Templates / Starter Canvases

New canvas → choose: Blank, Project Planning, Research Board, Competitive Analysis, Meeting Notes, CAPEX Review, or Custom. Templates are .any files in %APPDATA%/klypix/templates/. Users can save any canvas as template.

### I. Search Across Everything

Ctrl+F: search text across all items on current canvas + inside embedded files. Ctrl+Shift+F: search across ALL .any files on disk. Results highlighted, click to jump.

### J. Bookmarks / Jump Points

Ctrl+1 through Ctrl+9: save/recall view positions. Named bookmarks in sidebar. Click → smooth pan+zoom to that area.

### K. Filter / Focus View

Toggle visibility by item type (text, files, images, agent outputs, drawings, connections). Focus mode: select container → everything outside fades to 10% opacity. Esc to exit.

### L. Tags / Labels

Any item can have colored tags: [urgent] [finance] [review]. Filter canvas by tag. Agent can tag items: /tag all financial documents as "finance".

### M. Arabic / RTL Support

RTL text direction for Arabic. Mixed RTL+LTR on same canvas. Arabic voice input (ar-SA). Agent responds in Arabic when user writes Arabic. Font: Noto Sans Arabic. /translate between Arabic↔English.

### N. Encryption / Password Protection

.any ZIP with AES-256 encryption. Password required to open. Individual containers can be password-locked separately from rest of canvas.

### O. Notifications

Scheduled task completed, web monitor change, agent finished analysis, approval pending → badge on canvas tab + system tray notification if minimized.

### P. Minimap

Bottom-right: overview showing all items as dots. Current viewport as rectangle. Click to jump. Drag to pan. Toggle on/off.

### Q. Snap & Alignment

Snap lines when aligned with other items (Figma-style). Optional snap-to-grid. Distribute evenly. Align left/center/right/top/bottom for selected items.

### R. Import from Other Tools

File → Import: Notion (HTML/MD), Miro (JSON), plain text, folder (each file → card), clipboard, browser tab → web embed, screenshot (PrintScreen → auto-paste).

### S. Split View

View two areas of same canvas side by side. Or two .any files. Drag items between viewports.

### T. Comments / Annotations

Yellow sticky note comments on any item. Collapse to 💬 badge. Comment threads for human notes (separate from agent chat threads). /review → agent reads all comments and summarizes.

### U. Timeline View

Sidebar showing chronological history of all canvas actions (user + agent). Click entry → pan to that item. Filter by user-only or agent-only. Export as activity log.

### V. Offline Mode

Canvas works fully offline (all items local). Agent commands queue until online. Indicator: "Online" or "Offline — agent unavailable". Only agent, web embeds, and monitors need internet.

### W. Plugin / Extension System (Future)

Third-party canvas plugins: new item types, new agent tools, new export formats, new file previewers. Installed via marketplace. Stored as .klypix-plugin files. Phase 4 platform play.

### Updated Implementation Phases

Phase 1 (Week 1-2): Core canvas + full drawing + undo/redo + keyboard shortcuts + selection + resize
Phase 2 (Week 2-3): .any format + auto-save + file drop (all tiers) + thumbnails + viewport culling + minimap
Phase 3 (Week 3-4): Media (video/audio/code/web) + voice input + Arabic RTL + multiple tabs
Phase 4 (Week 4-5): Agent integration (/ commands, scope, toast/card, follow-ups, threads, containers)
Phase 5 (Week 5-6): Search + bookmarks + tags + filter/focus + snap/align + compile + presentation mode
Phase 6 (Week 6-7): Version history + templates + import + split view + comments + timeline
Phase 7 (Week 7+): Encryption + notifications + offline + scheduled tasks + web monitors + zones
Phase 8 (Future): Canvas-to-canvas links + plugin system + collaboration (web version)

---

## 21. ADDENDUM — MS Office & Project Management Native Support

### The Problem

Target users live in Microsoft Office and project management tools. If they have to leave the canvas to view a Word doc, edit an Excel, or check a Gantt chart — the canvas fails. These files must render INTERACTIVELY on the canvas, not just as dumb file cards.

### Microsoft Office — Native Canvas Rendering

Every MS Office file dropped on canvas renders as a live preview, not just an icon.

**Word (.docx)**
```
┌─── 📝 Quarterly_Report.docx ──── 12 pages ──┐
│                                                │
│  [Rendered first page of the document]         │
│                                                │
│  Executive Summary                             │
│  The Q3 results demonstrate strong growth...   │
│                                                │
│  ◀ Page 1 of 12 ▶                             │
│                                                │
│  [Open in Word] [Edit Text] [Ask Agent]        │
└────────────────────────────────────────────────┘
```
- Pages scroll inside the card
- Basic text editing directly on canvas (bold, italic, headings)
- /edit this document → agent modifies content in sandbox, updates card
- /summarize → agent reads full text, creates summary card
- Implementation: mammoth.js (DOCX→HTML) for rendering, docx lib for editing

**Excel (.xlsx, .csv)**
```
┌─── 📊 CAPEX_Budget.xlsx ──── 4 sheets ──────┐
│                                                │
│  Sheet: [JPI ▼]                                │
│  ┌──────┬────────────┬──────────┬──────────┐  │
│  │ Item │ Asset Type │ Priority │ Budget   │  │
│  ├──────┼────────────┼──────────┼──────────┤  │
│  │ KSA  │ Buildings  │ Strategy │ $6.0M    │  │
│  │ PP   │ Machinery  │ Strategy │ $1.9M    │  │
│  │ Coat │ Machinery  │ Direct   │ $800K    │  │
│  │ ...  │ ...        │ ...      │ ...      │  │
│  └──────┴────────────┴──────────┴──────────┘  │
│                                                │
│  ↕ Showing 10 of 65 rows  [Expand Full Table] │
│                                                │
│  [Open in Excel] [Sort] [Filter] [Chart]       │
│  [Ask Agent]                                   │
└────────────────────────────────────────────────┘
```
- Switch between sheets via dropdown
- Sort any column (click header)
- Filter rows (click filter icon on header)
- Scroll through all rows inside the card
- /chart this → agent creates chart card from the data
- /pivot by asset type → agent creates pivot summary
- Edit cells directly on canvas (basic edits)
- Implementation: SheetJS (xlsx) for parsing, ag-grid or custom table for rendering

**PowerPoint (.pptx)**
```
┌─── 📽️ Board_Presentation.pptx ──── 15 slides ┐
│                                                 │
│  ┌───────────────────────────────────────────┐  │
│  │                                           │  │
│  │     [Slide rendered as image]             │  │
│  │                                           │  │
│  │     2025 CAPEX Budget Review              │  │
│  │     Jordanian Pharmaceutical Mfg.         │  │
│  │                                           │  │
│  └───────────────────────────────────────────┘  │
│                                                 │
│  ◀ Slide 1 of 15 ▶   [🔲 Grid View]           │
│                                                 │
│  [Open in PowerPoint] [Present] [Ask Agent]     │
└─────────────────────────────────────────────────┘
```
- Navigate slides with arrows
- Grid view: shows all slides as thumbnails (click to focus one)
- /present this → enters presentation mode directly from the card
- /add a slide about R&D → agent modifies the PPTX in sandbox
- /summarize all slides → agent reads each slide, creates summary
- Implementation: pptxgenjs for creation, render slides as images via LibreOffice in sandbox

**Outlook Email (.msg, .eml)**
```
┌─── 📧 RE: Q4 Budget Review ─────────────────┐
│                                                │
│  From: ahmed@company.com                       │
│  To: abdullah@company.com                      │
│  Date: Apr 10, 2026                            │
│  Subject: RE: Q4 Budget Review                 │
│                                                │
│  Hi Abdullah,                                  │
│  Attached is the revised Q4 budget.            │
│  Please review the KSA section...              │
│                                                │
│  📎 Q4_Budget_Revised.xlsx                     │
│                                                │
│  [Open in Outlook] [Reply Draft] [Ask Agent]   │
└────────────────────────────────────────────────┘
```
- Email renders with from/to/subject/body
- Attachments shown as sub-cards (click to extract onto canvas)
- /reply → agent drafts reply card below
- /extract attachment → drops the attached file as separate canvas item
- Implementation: mailparser (npm) for .eml, msg-reader for .msg

**Visio (.vsdx)**
```
┌─── 📐 Network_Diagram.vsdx ─────────────────┐
│                                                │
│  [Rendered diagram as SVG/image]               │
│                                                │
│  [Open in Visio] [Ask Agent]                   │
└────────────────────────────────────────────────┘
```
- Rendered as image/SVG via LibreOffice or Aspose in sandbox
- /describe this diagram → agent analyzes the visual
- Implementation: convert to SVG in sandbox, render SVG on canvas

### Project Management Files — Interactive Rendering

**MS Project (.mpp)**
```
┌─── 📋 KSA_Complex_Project.mpp ──────────────────────┐
│                                                       │
│  Project: KSA Complex Development                     │
│  Start: Jan 2025  |  End: Dec 2026  |  Tasks: 47     │
│                                                       │
│  ┌─── Gantt Chart ────────────────────────────────┐  │
│  │ Task              │ Q1  │ Q2  │ Q3  │ Q4  │25│  │
│  │ Site Preparation  │ ███ │     │     │     │  │  │
│  │ Foundation        │  ██ │ ██  │     │     │  │  │
│  │ Civil Works       │     │ ███ │ ███ │     │  │  │
│  │ Equipment Install │     │     │  ██ │ ███ │  │  │
│  │ Testing & QA      │     │     │     │ ██  │██│  │
│  └────────────────────────────────────────────────┘  │
│                                                       │
│  [Open in MS Project] [Timeline View]                 │
│  [Critical Path] [Ask Agent]                          │
└───────────────────────────────────────────────────────┘
```
- Gantt chart renders interactively inside the card
- Color-coded by status: green (on track), yellow (at risk), red (delayed)
- Click a task → shows details (duration, dependencies, resources)
- /what's the critical path? → agent analyzes and highlights it
- /what tasks are delayed? → agent creates summary card
- /update: foundation is 80% complete → agent creates updated status card
- Implementation: Parse .mpp with mpxj (Java lib, run in sandbox) or MPXJS, render Gantt with d3.js or custom SVG

**Primavera P6 (.xer)**
```
┌─── 📋 Plant_Expansion.xer ──────────────────┐
│                                                │
│  [Gantt chart similar to MS Project]           │
│                                                │
│  Activities: 234  |  WBS Levels: 4             │
│  Critical: 18 activities                       │
│                                                │
│  [Timeline] [Resource View] [Ask Agent]        │
└────────────────────────────────────────────────┘
```
- Same Gantt rendering as MS Project
- Parse .xer (tab-delimited format, parseable in Python)
- /compare with the MS Project plan → agent overlays both timelines

**Jira / Monday.com / Asana Export (CSV/JSON)**
```
┌─── 📋 Sprint_Board.csv (from Jira) ─────────┐
│                                                │
│  ┌──────────┬──────────┬──────────┐           │
│  │ To Do (8)│ In Prog  │ Done (12)│           │
│  │          │   (5)    │          │           │
│  │ ▪ KLPX-  │ ▪ KLPX-  │ ▪ KLPX-  │           │
│  │   45     │   42     │   38     │           │
│  │ ▪ KLPX-  │ ▪ KLPX-  │ ▪ KLPX-  │           │
│  │   46     │   43     │   39     │           │
│  │ ▪ KLPX-  │ ▪ KLPX-  │ ▪ KLPX-  │           │
│  │   47     │   44     │   40     │           │
│  └──────────┴──────────┴──────────┘           │
│                                                │
│  [Table View] [Board View] [Ask Agent]         │
└────────────────────────────────────────────────┘
```
- Auto-detects Kanban columns from CSV/JSON structure
- Board view (cards in columns) or Table view (rows)
- /what's blocking the sprint? → agent analyzes and reports
- Drag tasks between columns directly on canvas
- Implementation: detect PM structure from column names (status, assignee, priority), render with custom Kanban component

### Native Canvas Project Management (Built-in)

Beyond importing PM files, the canvas itself can BE a project management tool:

**Kanban Board (built-in canvas item)**
```
User: /create kanban board for KLYPIX development

Agent creates:
┌─── 📋 KLYPIX Development ─────────────────────────┐
│                                                     │
│  ┌──── Backlog ────┐ ┌─── In Progress ─┐ ┌─ Done ─┐│
│  │                 │ │                  │ │        ││
│  │ ▪ Memory #4    │ │ ▪ Flash bug fix  │ │ ▪ Rtr  ││
│  │ ▪ Canvas v1    │ │ ▪ Sandbox UI     │ │ ▪ Hrd  ││
│  │ ▪ V2 Graph     │ │                  │ │ ▪ WSL  ││
│  │                 │ │                  │ │        ││
│  └─────────────────┘ └──────────────────┘ └────────┘│
│                                                     │
│  Drag cards between columns. Click card for details.│
└─────────────────────────────────────────────────────┘
```

**Timeline / Gantt (built-in canvas item)**
```
User: /create timeline for this project

Agent creates:
┌─── 📅 Project Timeline ─────────────────────────┐
│                                                   │
│  Apr      May      Jun      Jul      Aug         │
│  │        │        │        │        │           │
│  ██ Memory System                                │
│     ████ Canvas Core                             │
│           ██████ Agent Integration               │
│                    ████ Testing                   │
│                         ██ Launch                 │
│                                                   │
│  [Add Task] [Set Dependencies] [Ask Agent]        │
└───────────────────────────────────────────────────┘
```

**Progress Tracker (built-in canvas item)**
```
┌─── 📊 KLYPIX Progress ──────────────────────┐
│                                               │
│  Overall: ████████████░░░░  72%              │
│                                               │
│  Router:     █████████████ 95%    ✅         │
│  Flash:      █████████████ 100%   ✅         │
│  Sandbox:    ██████████░░░ 80%    🟡         │
│  Memory:     █░░░░░░░░░░░ 10%    🔴         │
│  Canvas:     ░░░░░░░░░░░░ 0%     ⬜         │
│                                               │
│  [Update Progress] [Ask Agent]                │
└───────────────────────────────────────────────┘
```

### Compile — MS Office Output

/compile now supports full MS Office output:

```
/compile into Word
  → Agent gathers all canvas items in spatial order
  → Text items → paragraphs with formatting preserved
  → Images → embedded figures
  → Charts → embedded chart images
  → Tables → formatted Word tables
  → Containers → document sections with headers
  → Creates .docx in sandbox → pins as file card
  → [Open in Word] [Email] [Print]

/compile into Excel
  → Agent gathers all table/data items
  → Each table card → separate sheet
  → Charts linked to their data
  → Creates .xlsx → pins as file card

/compile into PowerPoint
  → Each container or selected group → one slide
  → Text items → slide text boxes
  → Images/charts → slide media
  → Maintains canvas visual layout on slides
  → Creates .pptx → pins as file card
  → [Open in PowerPoint] [Present from Canvas]

/compile into MS Project
  → Agent reads all timeline/Gantt/task items on canvas
  → Constructs project plan with dependencies
  → Creates .mpp (via mpxj in sandbox) → pins as file card

/compile into Outlook email
  → Text items → email body (HTML formatted)
  → File items → email attachments
  → Creates .eml → opens in Outlook
  → Or: agent sends via SMTP if configured
```

### Two-Way Sync (Future — Phase 8+)

Eventually, MS Office items on canvas should sync bidirectionally:
- Edit the .xlsx on canvas → changes reflect when opened in Excel
- Edit in Excel → changes sync back to canvas card on next focus
- Requires file watching (fs.watch on the extracted temp file)
- Complex but powerful — the canvas becomes a live dashboard of your Office files

### Implementation Notes

Libraries needed (install in sandbox or bundle with Electron):

| Format | Parse Library | Render Method |
|--------|--------------|---------------|
| DOCX | mammoth.js (npm) | HTML rendering on canvas |
| XLSX | SheetJS (npm) | Custom table component |
| PPTX | pptxgenjs + LibreOffice | Render slides as images |
| MSG/EML | mailparser, msg-reader (npm) | Custom email card component |
| VSDX | LibreOffice in sandbox | Convert to SVG, render SVG |
| MPP | mpxj (Java, sandbox) or manual XML parse | Custom Gantt component (d3.js) |
| XER | Python parser in sandbox | Same Gantt component |
| Jira CSV | Papa Parse (npm) | Kanban or table component |

Heavy conversions (PPTX slide rendering, VSDX, MPP) happen in WSL2 sandbox. LibreOffice headless is the universal converter:
```
libreoffice --headless --convert-to pdf document.pptx
libreoffice --headless --convert-to svg diagram.vsdx
```

Lightweight parsing (DOCX text, XLSX data, CSV, email) happens in the renderer process via npm libraries — no sandbox needed.

---

## 22. ADDENDUM — Navigation, Recording, Collaboration, Layers & KLYPIX Eyes

### A. Canvas Replay System

Two recording modes built into every .any file:

**Replay (JSON event log — lightweight, unique feature)**

Every action is recorded as a timestamped event inside the .any file:

```typescript
interface ReplayEvent {
  t: number;                  // milliseconds from session start
  action: string;             // 'create' | 'move' | 'edit' | 'delete' | 'agent' | 'connect' | 'draw'
  actor: 'user' | 'agent';
  itemId?: string;
  data: any;                  // action-specific payload
}

// Stored in .any ZIP as replay/session_TIMESTAMP.json
// Each session creates one replay file
// All replays preserved — full history of the canvas
```

Replay controls (appear when user opens replay mode):

```
┌──────────────────────────────────────────────────────┐
│ ⏮  ◀◀  ▶ Play   ▶▶  ⏭   ──●─────────── 3:24 / 47:00 │
│                                                        │
│ Speed: [0.5x] [1x] [2x] [4x]    Filter: [All ▼]      │
│                                                        │
│ [👤 User only] [🤖 Agent only] [All actions]           │
└────────────────────────────────────────────────────────┘
```

- Play: canvas rebuilds itself action by action with smooth animations
- Scrub: drag the timeline bar to any point
- Speed: slow-mo for demos, 4x for quick review
- Filter: show only user actions, only agent actions, or both
- Items fade in as they're created during replay
- Connections draw themselves animated
- Agent actions highlighted with a glow effect

**Screen Capture (MP4 — for sharing outside KLYPIX)**

```
Toolbar button: 🔴 Record
  → Captures canvas viewport using Electron desktopCapturer
  → Records mouse movements, zoom, pan
  → Stop → .mp4 file card appears on canvas
  → Share the video anywhere (Slack, email, presentation)
```

### B. Full Navigation System

Six navigation methods, all working together:

**1. Minimap**

```
Bottom-right corner, always visible (toggle with M key):

┌──────────────────────────────────┐
│ Canvas                           │
│                                  │
│                                  │
│                    ┌────────┐    │
│                    │ ·· · · │    │
│                    │ · ·· · │    │
│                    │ ·[██]· │ ←─── viewport rectangle
│                    │ · · ·· │    │
│                    └────────┘    │
└──────────────────────────────────┘

- Each dot = an item (colored by type)
- Rectangle = current viewport
- Click anywhere on minimap → canvas flies there
- Drag rectangle → pan canvas
- Minimap auto-scales to show all content
```

**2. Outline Sidebar**

```
Toggle with Ctrl+E or sidebar icon:

┌─── Outline ──────────────── ✕ ┐
│ 🔍 Search outline...          │
│                                │
│ 📁 Q3 Analysis          ▼    │
│   📄 Q3 Report.pdf            │
│   📊 Revenue Chart            │
│   🤖 Summary                  │
│   💬 3 follow-ups             │
│ 📁 Q4 Analysis          ▶    │  ← collapsed
│ ─────────────────────         │
│ 📝 Meeting Notes              │
│ 📋 Comparison Table           │
│ 🤖 Final Report               │
│ ─────────────────────         │
│ 🎨 Drawings (12)        ▶    │
│ ⤳ Connections (8)       ▶    │
│                                │
│ Items: 47  |  Layers: 3       │
└────────────────────────────────┘

- Click any item → canvas smoothly flies to it and highlights it
- Drag items in outline → reorder z-index on canvas
- Right-click → same context menu as on canvas
- Collapsible containers match canvas containers
- Badge shows item count for collapsed groups
- Search box filters outline in real-time
```

**3. Breadcrumbs (inside nested containers)**

```
When zoomed into a container:

Canvas  ›  Q3 Analysis  ›  Expenses  ›  Detail
  ↑            ↑              ↑
  click to     click to       current view
  see all      see Q3
```

Each breadcrumb is clickable → canvas zooms out to that level with smooth animation.

**4. Search Jump (Ctrl+F)**

```
┌─── Search ──────────────────────────────────┐
│ 🔍 KSA                                      │
│                                              │
│ Found 7 results:                             │
│                                              │
│ 📄 "KSA Complex- Civil Works" (text)    [→] │
│ 📄 "KSA Complex- Machines" (text)       [→] │
│ 📊 Chart mentioning "KSA" (chart)       [→] │
│ 🤖 "KSA drove 60% of growth" (agent)   [→] │
│ ...                                          │
└──────────────────────────────────────────────┘

Click [→] → canvas flies to that item, highlights it in yellow pulse.
Arrow keys → cycle through results.
Enter → jump to current result.
```

**5. Bookmarks (Ctrl+1-9 to save, 1-9 to jump)**

```
Settings sidebar shows named bookmarks:

┌─── Bookmarks ──────────────┐
│ 1  📌 Source Documents      │
│ 2  📌 Agent Outputs         │
│ 3  📌 KSA Section           │
│ 4  (empty)                  │
│ ...                          │
│ +  Add bookmark              │
└──────────────────────────────┘

Ctrl+1 = save current view as bookmark 1
Press 1 = jump to bookmark 1 (smooth fly animation)
Named bookmarks also appear as tiny pins on minimap
```

**6. Fit All (Ctrl+0)**

One keypress → canvas zooms and pans to show every item. The "helicopter view." Press again → returns to previous view.

**7. Go To Last Agent Output (Ctrl+G)**

Jumps to the most recent item the agent created. Useful when agent works while you're looking elsewhere.

### C. Canvas Layers

```
Layers panel (toggle with L key or layers icon):

┌─── Layers ─────────────────────────────┐
│                                         │
│ [+] Add Layer                           │
│                                         │
│ 👁 🔒  Layer 4: Agent Outputs          │
│ 👁     Layer 3: My Analysis            │
│ 👁     Layer 2: Source Documents       │
│ 👁     Layer 1: Drawings & Arrows      │
│                                         │
│ 👁 = visible (click to toggle)         │
│ 🔒 = locked (click to toggle)          │
│                                         │
│ Drag layers to reorder                  │
└─────────────────────────────────────────┘
```

**Layer behaviors:**
- Each item belongs to one layer
- New user items go to the active (selected) layer
- Agent items automatically go to "Agent Outputs" layer
- Drawings go to "Drawings" layer automatically
- Hidden layer → all its items invisible (but still in .any file)
- Locked layer → items visible but cannot be selected, moved, or edited
- Useful for: hide all drawings to see content only, lock source docs to prevent accidental moves, hide agent outputs while focusing on your own work
- Layers stored in canvas.json, each item has a `layerId` field
- Default canvas starts with 2 layers: "Content" and "Drawings"

### D. Async Collaboration (No Server Required)

**Built on .any file sharing — no web version needed for v1.**

**Comments & Mentions**

```
Right-click any item → "Add Comment"

┌─── 📄 Q3 Report.pdf ──────────────────────┐
│                                             │
│   [page preview]                            │
│                                             │
│   💬 2 comments                       [+]   │
│   ┌─────────────────────────────────────┐   │
│   │ 👤 Abdullah (Apr 14, 10:30 AM)      │   │
│   │ @Ahmed please check the KSA numbers │   │
│   │                                     │   │
│   │ 👤 Ahmed (Apr 14, 2:15 PM)          │   │
│   │ Confirmed. Numbers look correct.    │   │
│   │                                     │   │
│   │ [type reply...]              [Send] │   │
│   └─────────────────────────────────────┘   │
└─────────────────────────────────────────────┘

- Comments saved inside .any file
- When User B opens the same .any file → sees all comments
- Each comment has author name, timestamp
- @mentions highlight items for specific people
- Comments collapse to a small 💬 badge (click to expand)
- /review comments → agent reads all comments and creates action summary
```

**Change Tracking**

```
When a .any file is opened that someone else modified:

┌─── Changes Detected ──────────────────────────┐
│                                                 │
│ Ahmed made 5 changes since you last opened:     │
│                                                 │
│ ✏️ Edited "Q4 Budget" text                     │
│ ➕ Added "Revised Projections" card             │
│ 💬 Commented on Q3 Report                      │
│ 🤖 Agent: created comparison chart              │
│ 🗑️ Deleted old draft                           │
│                                                 │
│ [Show All Changes] [Dismiss]                    │
│                                                 │
│ Click any change → canvas jumps to that item    │
└─────────────────────────────────────────────────┘

Changes detected by comparing canvas.json timestamps and item hashes.
Each item has `modifiedBy` and `modifiedAt` fields.
Changed items pulse briefly with a colored ring when first viewed.
```

### E. 3D Item Viewers (Not 3D Canvas)

Canvas stays 2D. But 3D content renders inside item cards:

```
┌─── 🧊 Building_Model.stl ──────────────────┐
│                                              │
│  ┌────────────────────────────────────────┐  │
│  │                                        │  │
│  │     [Interactive 3D model viewer]      │  │
│  │      Rotate: drag                      │  │
│  │      Zoom: scroll                      │  │
│  │      Pan: right-drag                   │  │
│  │                                        │  │
│  └────────────────────────────────────────┘  │
│                                              │
│  Vertices: 12,450  |  Size: 3.2 MB          │
│  [Open in Viewer]  [Screenshot]  [Analyze]   │
└──────────────────────────────────────────────┘
```

Supported 3D formats: STL, OBJ, GLTF, FBX, 3DS
Implementation: Three.js renderer inside the card (already available in React artifacts)
/analyze this model → agent describes dimensions, geometry, features

### F. KLYPIX Eyes — The AI Character

KLYPIX Eyes is a small animated character that represents the agent on the canvas. Not a chatbot avatar — a living presence that shows the agent's state.

**Design: Minimalist eyes only. No face, no body. Just two expressive eyes.**

```
Normal (idle):          ◉ ◉      Two calm circles
Thinking:               ◑ ◑      Half-closed, rotating
Reading:                ◉ ◉      Eyes move left-right (scanning)
                        ↔ ↔
Working:                ◉ ◉      Eyes focused on the item being processed
                         ↘↙      (eyes look toward the active item)
Success:                ◠ ◠      Happy squint
Error:                  ◎ ◎      Wide open, concerned
Waiting for user:       ◉ ◉      Slow gentle blink
                        ◡ ◡
Sleeping (idle >30s):   ─ ─      Closed lines, gentle breathing animation
Waking up:              ◉ ◉      Eyes open with a stretch animation
```

**Where KLYPIX Eyes lives:**

```
Option A — Floating on canvas (follows viewport)

  Eyes float in the bottom-left of the viewport.
  Small (32x32px). Semi-transparent when idle.
  Becomes full opacity when agent is active.
  User can drag to reposition.
  Double-click → opens command bar.
  
  ┌──────────────────────────────────────────┐
  │                                          │
  │     📄 Report    📊 Chart               │
  │                                          │
  │                                          │
  │                                          │
  │  ◉ ◉                                    │  ← KLYPIX Eyes
  │  KLYPIX             100%  ─  +           │
  └──────────────────────────────────────────┘

Option B — In the status bar (fixed position)

  Eyes sit in the bottom status bar, always visible.
  
  ┌──────────────────────────────────────────┐
  │ Canvas content...                        │
  │                                          │
  ├──────────────────────────────────────────┤
  │ ◉ ◉ KLYPIX    47 items   Layer: Content │
  └──────────────────────────────────────────┘

Recommend: Option A (floating). Feels more alive and personal.
```

**Behavioral animations:**

```typescript
interface EyesState {
  state: 'idle' | 'thinking' | 'reading' | 'working' | 'success' | 'error' | 'waiting' | 'sleeping';
  lookAt: { x: number; y: number } | null;   // eyes look toward a canvas position
  message: string | null;                       // tiny speech bubble text
}
```

**Eyes react to what's happening:**

```
User drops a file:
  Eyes: look at the file → ◉ ◉ (curious glance toward the dropped item)

User types / command:
  Eyes: ◑ ◑ (thinking) → ◉ ◉ scanning (reading canvas) → ◉ ◉ focused (working)

Agent finishes:
  Eyes: ◠ ◠ (satisfied squint) for 2 seconds → back to idle

Agent hits an error:
  Eyes: ◎ ◎ (wide open) → tiny speech bubble: "hmm, trying another way..."

User hasn't interacted for 30 seconds:
  Eyes: slowly close → ─ ─ (sleeping) with gentle up-down breathing

User starts typing after idle:
  Eyes: ─ ─ → ◉ ◉ (wake up animation, 0.3s)

User selects multiple items:
  Eyes: look at the selection area

User is in a container:
  Eyes: peek over the container edge (playful)
```

**Micro speech bubbles:**

The eyes occasionally show tiny one-line messages. Not agent responses — just personality. These fade after 3 seconds.

```
On first launch:        "click anywhere ◉ ◉"
After idle >2 min:      "need anything? ◉ ◉"
After agent success:    "done ◠ ◠"
After agent error:      "hmm, retrying... ◑ ◑"
When user drops file:   "got it ◉ ◉"
When canvas is empty:   "drop something here ◉ ◉"
At 100+ items:          "busy canvas ◉ ◉"
```

**KLYPIX Eyes settings:**

```
Settings → KLYPIX Eyes:
  [✅] Show KLYPIX Eyes
  [✅] Show speech bubbles
  [  ] Always visible (disable sleep)
  Size: [Small ▼]  (Small / Medium / Large)
  Position: [Bottom-left ▼]  (or drag to reposition)
```

**KLYPIX Eyes as brand identity:**

The eyes ARE the brand. They appear on:
- Canvas (alive, animated)
- App icon (static)
- Loading screen (blinking)
- .any file icon (eyes peeking from a document)
- Error pages (concerned eyes)
- Empty states (eyes with speech bubble)
- Marketing site (eyes follow cursor)

The eyes give KLYPIX personality. It's not "a tool." It's a character that lives on your canvas, watches what you do, and helps when you ask. Nobody else has this. Every other AI is a text box. KLYPIX is a presence.

**Implementation:**

```typescript
// KlypixEyes.tsx — React component

// Eyes are two SVG circles with dynamic properties:
// - Pupil position (look direction)
// - Eyelid height (open/closed/squint)
// - Animation curves (CSS transitions)
// - Speech bubble (optional text with fade)

// The eyes component subscribes to agent state:
// - agentState.working → thinking animation
// - agentState.reading → scanning animation
// - agentState.complete → success squint
// - agentState.error → concerned wide eyes
// - userActivity.idle → sleeping animation
// - userActivity.active → wake up

// The lookAt system:
// - Eyes track the mouse cursor gently (not 1:1, slight lag)
// - When agent is working on an item, eyes look at that item
// - When user drops a file, eyes glance at the drop point
// - Smooth interpolation, never snappy
// - Maximum pupil offset: 4px from center (subtle, not cartoon)

// Performance:
// - Pure CSS animations for state transitions
// - requestAnimationFrame for pupil tracking
// - No re-renders of canvas when eyes animate
// - Eyes are a separate overlay div, not part of canvas transform
```

### G. State-of-the-Art .any Interface Design

The .any canvas interface is the brand. It must feel like nothing else on the market.

**Design Language: "Dark Clarity"**

```
Philosophy:
  Not flashy. Not minimal. CLEAR.
  Every pixel earns its place.
  Dark background = your content glows.
  Accent color = teal (#0f7b6c) = KLYPIX identity.
  The interface disappears. The work shines.
```

**Color System:**

```
Background:     #0a0a0f     (near-black with slight blue)
Surface:        #12121a     (cards, containers, panels)
Border:         #1e1e2e     (subtle, only when needed)
Text primary:   #e8e8ed     (high contrast but not pure white)
Text secondary: #6b6b80     (muted, for metadata)
Accent:         #0f7b6c     (teal — KLYPIX brand)
Accent hover:   #14a090     (lighter teal on hover)
Success:        #2dd4a0     (agent completed)
Warning:        #f5a623     (needs attention)
Error:          #ef4444     (something went wrong)
Agent glow:     #0f7b6c20   (subtle teal glow around agent items)
```

**Typography:**

```
Canvas text:    'JetBrains Mono' or 'SF Mono' (monospace, crisp)
UI text:        'Inter' or system-ui (clean, readable)
Headings:       Same as canvas but bold, larger
Code blocks:    'Fira Code' with ligatures

Font sizes:
  Canvas text default:  16px
  Heading 1:           28px bold
  Heading 2:           22px bold
  Heading 3:           18px bold
  UI labels:           12px
  Status bar:          11px
  Minimap labels:      9px
```

**Canvas Surface:**

```
Background: solid #0a0a0f
Grid: subtle dots at 40px intervals
  Dot color: #1a1a2a (barely visible)
  Dot size: 1px
  Grid helps with alignment but never distracts

When item is being dragged:
  Snap lines appear: thin #0f7b6c30 lines
  Alignment guides: same color, dashed

Canvas edge: infinite, no visible boundary
  User never hits a "wall"
  Minimap shows where content lives
```

**Item Card Design:**

```
All items share a base card style:

┌─────────────────────────────────────┐
│                                     │  Background: #12121a
│  Content here                       │  Border: 1px solid #1e1e2e
│                                     │  Border-radius: 8px
│                                     │  Shadow: 0 4px 24px #00000040
└─────────────────────────────────────┘  Padding: 12px 16px

Selected:
  Border: 2px solid #0f7b6c
  Shadow: 0 0 0 4px #0f7b6c20 (teal glow ring)

Agent-created:
  Left border: 3px solid #0f7b6c (teal accent bar)
  Subtle gradient: linear-gradient(135deg, #0f7b6c08, transparent)
  
  ┌───────────────────────────────────┐
  ┃                                   │  ← teal left bar = "agent made this"
  ┃  Agent-generated content          │
  ┃                                   │
  └───────────────────────────────────┘

Hovered:
  Border: 1px solid #2a2a3e (slightly brighter)
  Transform: translateY(-1px) (micro lift)
  Transition: all 0.15s ease

Dragging:
  Opacity: 0.85
  Shadow: 0 8px 32px #00000060 (deeper shadow)
  Scale: 1.01 (micro enlarge)
  Cursor: grabbing
```

**Connection Arrows:**

```
Default: curved bezier, 2px, #0f7b6c, 50% opacity
Hovered: 100% opacity, +1px thickness
Selected: glow effect, arrowhead highlighted
Agent-created: dashed until user approves, then solid
Label: small text on midpoint, background pill #12121a

Animation on creation: arrow draws itself from start to end (0.5s)
```

**Toolbar Design:**

```
Left toolbar: floating pill, glass morphism effect

  Background: #12121a + backdrop-filter: blur(12px)
  Border: 1px solid #1e1e2e
  Border-radius: 14px
  Position: left center, 12px from edge
  
  ┌─────┐
  │  T  │  ← 36x36px buttons
  │  ↗  │     Active: bg #0f7b6c20, color #0f7b6c
  ├─────┤     Inactive: color #6b6b80
  │  ─  │     Hover: bg #1e1e2e
  │  □  │
  │  ⌇  │  ← pen (freehand)
  │  ⤳  │  ← connect
  ├─────┤
  │ 🎨  │  ← color: shows current color as filled circle
  │ ━━  │  ← thickness: shows current width as bars
  ├─────┤
  │ 🎤  │  ← voice: red dot when recording
  └─────┘
  
  Toolbar auto-hides after 5s of no hover (slide left, only edge visible)
  Hover near left edge → slides back in
  Or pin it with a small 📌 button at top
```

**Top Status Bar:**

```
Centered, floating, glass morphism:

┌────────────────────────────────────────────────────────────┐
│ ◉ ◉  KLYPIX Notes  •  project.any  •  47 items  •  100%  │
└────────────────────────────────────────────────────────────┘

  Eyes on the left = KLYPIX presence
  File name shown (or "untitled" if new)
  Item count
  Zoom percentage with +/- buttons
  Dot separator between items
  
  Background: #12121a90 + blur(12px)
  Border: 1px solid #1e1e2e
  Border-radius: 12px
  Height: 36px
  Font: 12px, #6b6b80
  Accent text (KLYPIX Notes): #0f7b6c
  
  When canvas is dirty (unsaved):
    File name shows dot: "• project.any"
  
  When agent is working:
    Subtle teal pulse animation on the entire bar
```

**Command Bar:**

```
Appears at bottom center when / is pressed:

┌──────────────────────────────────────────────────────────────┐
│ /  summarize the documents above                              │
│                                                                │
│   📎 2 items selected · inside Q3 container          [⏎ Run] │
├──────────────────────────────────────────────────────────────┤
│  /summarize    /compare    /translate    /chart    /compile   │
│  /research     /export     /email       /run      /analyze   │
└──────────────────────────────────────────────────────────────┘

  Background: #12121a + blur(16px)
  Border: 1px solid #0f7b6c40 (teal-tinted border)
  Border-radius: 16px
  Width: 600px max
  Shadow: 0 -8px 32px #00000040
  
  Input text: 16px, #e8e8ed
  Scope info: 12px, #6b6b80
  Autocomplete: 13px, each item has hover highlight
  
  Animation: slides up from bottom (0.2s ease-out)
  Dismiss: slides down (0.15s ease-in)
  
  / character: colored #0f7b6c (brand accent)
```

**Toast Response (temporary agent answer):**

```
Appears near the command location, floats:

┌─────────────────────────────────────┐
│ ◉ ◉  It's 2:30 AM in Tokyo     📌 │
└─────────────────────────────────────┘

  Background: #1a1a2a
  Border: 1px solid #0f7b6c30
  Border-radius: 10px
  KLYPIX Eyes on the left (tiny, 16px)
  Pin button on the right
  
  Appears: fade in + slide up (0.3s)
  Disappears: fade out after 10 seconds
  Pinned: stays, becomes permanent card with teal left bar
```

**Empty State (brand moment):**

```
When canvas is completely empty:

                         ◉ ◉
                        KLYPIX
                  
              click anywhere to start
           drop files · / for commands
           
  Large KLYPIX Eyes (64px) centered on canvas.
  Gentle idle breathing animation.
  Text below in #6b6b80, 14px.
  
  When user first clicks → eyes do a happy squint ◠ ◠
  then fade to their small floating position.
  
  This IS the onboarding. No tutorial needed.
  The eyes and the hint text tell you everything.
```

**Loading / Working States:**

```
Agent processing → KLYPIX Eyes thinking ◑ ◑
Below eyes, a progress line appears:

  ◑ ◑
  ───●────────── Reading Q3 Report...
  
  Thin teal line that fills left to right.
  Current action shown as text.
  When complete: line fills → eyes squint ◠ ◠ → result appears.
```

**File Cards (specific to .any interface):**

```
PDF card:
┌─── 📄 ──────────────────────────────┐
│ ┌──────────────────────────────────┐│
│ │                                  ││
│ │   [First page rendered]          ││  ← live page render
│ │                                  ││
│ └──────────────────────────────────┘│
│ Q3_Financial_Report.pdf             │
│ 12 pages  •  2.4 MB      ◀ 1/12 ▶ │
└──────────────────────────────────────┘

Excel card:
┌─── 📊 ──────────────────────────────┐
│ CAPEX_Budget.xlsx  •  4 sheets      │
│ ┌────┬──────────┬──────────┬──────┐ │
│ │ #  │ Item     │ Type     │ $    │ │
│ ├────┼──────────┼──────────┼──────┤ │
│ │ 1  │ KSA Comp │ Building │ 6.0M │ │
│ │ 2  │ PP CAM   │ Machine  │ 1.9M │ │
│ │ 3  │ Coating  │ Machine  │ 800K │ │
│ └────┴──────────┴──────────┴──────┘ │
│ Sheet: [JPI ▼]        ↕ 3 of 65    │
└──────────────────────────────────────┘

Video card:
┌─── 🎬 ──────────────────────────────┐
│ ┌──────────────────────────────────┐│
│ │                                  ││
│ │           ▶ (play icon)          ││  ← thumbnail with play overlay
│ │                                  ││
│ └──────────────────────────────────┘│
│ Board_Meeting.mp4                   │
│ 45:00  •  720p  •  340 MB          │
└──────────────────────────────────────┘

Generic file card:
┌─── ┐
│ DWG│  KSA_Building_Plan.dwg        │
│    │  AutoCAD Drawing  •  18 MB    │
│    │  [Open] [Ask Agent]           │
└────┘──────────────────────────────────┘
  Extension badge: bold text in #0f7b6c15 background
```

**Container Design:**

```
Expanded:
┌─── Q3 Analysis ────────────────────── ▼ ✕ ─┐
│ │                                            │
│ │  Content lives here with generous padding  │
│ │                                            │
│ │  Container border: 1px dashed #1e1e2e     │
│ │  Title bar: #12121a, text #e8e8ed         │
│ │  Collapse ▼ and close ✕ on right          │
│ │                                            │
└──┘────────────────────────────────────────────┘

Collapsed:
┌─── Q3 Analysis ──── 7 items ──────── ▶ ✕ ─┐
└────────────────────────────────────────────────┘
  Single line. Item count shown. ▶ to expand.

Locked (agent-isolated):
┌─── 🔒 Confidential ──────────────── ▼ ✕ ─┐
│ ┃                                          │
│ ┃  Left border: 2px solid #f5a623 (amber)  │
│ ┃  Lock icon in title                      │
│ ┃                                          │
└──┘──────────────────────────────────────────┘
```

**Context Menu:**

```
Right-click any item:

┌──────────────────────────────┐
│ ✏️  Edit                     │
│ 📋  Duplicate         Ctrl+D │
│ 📌  Add Border               │
│ 🏷️  Add Tag                  │
│ 💬  Add Comment              │
│ ───────────────────────────  │
│ 🤖  Ask Agent                │
│ 💬  Open Chat Thread         │
│ ───────────────────────────  │
│ 📁  Move to Container    ▶  │
│ 📎  Move to Layer        ▶  │
│ 🔼  Bring to Front          │
│ 🔽  Send to Back            │
│ ───────────────────────────  │
│ 🗑️  Delete            Del   │
└──────────────────────────────┘

  Background: #12121a
  Border: 1px solid #1e1e2e
  Border-radius: 10px
  Shadow: 0 8px 32px #00000060
  Item hover: #1e1e2e background
  Danger items (delete): #ef444480 on hover
  
  Sub-menus (▶) slide out to the right.
  Keyboard accessible (arrow keys + enter).
```

**Animations (make it feel alive):**

```
All transitions: 0.15s ease (fast, not sluggish)

Item creation: scale(0.95) → scale(1.0) + fade in (0.2s)
Item deletion: scale(1.0) → scale(0.95) + fade out (0.15s)
Item move: no animation (instant, follows cursor)
Connection draw: SVG stroke-dashoffset animation (line draws itself)
Container collapse: height transition (0.25s ease)
Panel open: slide in from edge (0.2s ease-out)
Panel close: slide out (0.15s ease-in)
Toast appear: translateY(10px) → translateY(0) + fade in
Toast dismiss: fade out (0.5s)
Zoom: smooth interpolation (not stepped)
Pan: immediate (0 delay, follows input exactly)
Eyes state change: 0.3s ease (smooth, natural)
Eyes blink: 0.15s close, 0.05s hold, 0.15s open (realistic)
Search result highlight: yellow pulse glow (2 cycles, 0.5s each)
Fit All: smooth fly animation (0.6s ease-in-out)
Bookmark jump: smooth fly (0.4s ease-in-out)
```

### Updated Implementation Phase Order

```
Phase 1 (Week 1-2): FOUNDATION
  ├── Canvas surface with pan/zoom/dot grid
  ├── Click to type (text items, no box needed)
  ├── Full freeform drawing (pen, shapes, lines, eraser)
  ├── Line styles (solid, dashed, dotted, arrow)
  ├── Color picker + thickness + opacity
  ├── Selection (single, multi, rubber-band)
  ├── Resize handles on all items
  ├── Connect items with curved arrows + labels
  ├── Context menu
  ├── Keyboard shortcuts (all of them)
  ├── Undo/redo (50 levels)
  ├── Drag to move (single + multi)
  ├── KLYPIX Eyes (idle, thinking, sleeping states)
  └── Empty state with KLYPIX Eyes

Phase 2 (Week 2-3): PERSISTENCE + FILES
  ├── .any ZIP format (save/load)
  ├── Auto-save every 30s
  ├── Ctrl+S / Ctrl+O / Ctrl+N
  ├── File drop handler (all file types)
  ├── Image items (render, resize)
  ├── PDF cards (page render, navigation)
  ├── Excel cards (table view, sort, filter, sheet tabs)
  ├── Word cards (rendered text, page scroll)
  ├── PowerPoint cards (slide viewer, grid view)
  ├── Generic file cards (icon + ext badge)
  ├── Thumbnail generation
  ├── Viewport culling (performance)
  ├── Minimap
  ├── Outline sidebar
  ├── Fit All (Ctrl+0)
  ├── .any file association on Windows
  └── Multiple canvas tabs

Phase 3 (Week 3-4): MEDIA + NAVIGATION
  ├── Video player cards (inline HTML5)
  ├── Audio player cards (waveform)
  ├── Voice input (Web Speech API + Arabic)
  ├── Code cards (syntax highlight, edit)
  ├── Link preview cards (paste URL)
  ├── Layers system (visibility, locking)
  ├── Containers (group, collapse, nest, lock scope)
  ├── Bookmarks (Ctrl+1-9)
  ├── Breadcrumbs for nested containers
  ├── Search jump (Ctrl+F)
  ├── Canvas replay (JSON event recording)
  ├── KLYPIX Eyes (all states: reading, working, success, error)
  └── Eyes speech bubbles

Phase 4 (Week 4-5): AGENT INTEGRATION
  ├── / command bar with autocomplete
  ├── Scope resolution (selected, container, nearby, full)
  ├── Token budget system (compression, progressive loading)
  ├── Canvas agent tools (read + write + connect + arrange)
  ├── Response classification (toast vs card)
  ├── Follow-up nesting
  ├── Chat threads on items
  ├── Agent draws connections automatically
  ├── Right-click → Ask Agent
  ├── Agent creates containers, cards, charts
  ├── KLYPIX Eyes tracks agent activity (looks at active item)
  └── /compile command (PDF, PPTX, DOCX, ZIP, email)

Phase 5 (Week 5-6): POWER FEATURES
  ├── MS Project (.mpp) Gantt card
  ├── Jira/PM CSV → Kanban board card
  ├── Built-in Kanban (/create kanban)
  ├── Built-in Timeline (/create timeline)
  ├── Built-in Progress Tracker
  ├── Outlook .msg/.eml email cards
  ├── Visio .vsdx diagram cards
  ├── 3D file viewers (STL, OBJ — Three.js)
  ├── Web embed (Electron webview)
  ├── Runnable code cards (execute in sandbox)
  ├── Video analysis (frame extraction + Gemini vision)
  ├── Audio transcription (Whisper)
  ├── Screen recording (Electron desktopCapturer)
  ├── Export canvas → PDF / PNG
  └── Presentation mode (/present)

Phase 6 (Week 6-7): COLLABORATION + POLISH
  ├── Comments & mentions on items
  ├── Change tracking (detect modifications by others)
  ├── Tags / labels on items + filter by tag
  ├── Filter / focus view (by type, by tag)
  ├── Snap & alignment guides
  ├── Templates / starter canvases
  ├── Import (Notion, Miro, folders)
  ├── Split view (two viewports)
  ├── Outline sidebar drag reorder
  ├── Canvas-to-canvas links
  ├── Arabic RTL full support
  └── Light theme option

Phase 7 (Week 7+): ADVANCED
  ├── Encryption / password protection
  ├── Notifications (system tray)
  ├── Offline mode (queue agent commands)
  ├── Scheduled task cards
  ├── Web monitor cards
  ├── Canvas zones (auto-processing areas)
  ├── Drag file onto card = action triggers
  ├── Version history / time travel
  ├── Two-way MS Office sync
  ├── Agent skill learning from canvas work
  └── KLYPIX Eyes personality expansion

Phase 8 (Future): PLATFORM
  ├── Plugin / extension system
  ├── Template marketplace
  ├── .any as a standard (documentation, spec)
  └── API for embedding KLYPIX canvas in other apps
```

---

## 23. ADDENDUM — Performance Architecture (Speed Is The Product)

### The Rule

Nothing loads until you see it. Nothing renders until you need it. A 10GB .any file opens in 1 second.

### Layer 1: File Opening — Instant Canvas Load

On open, load ONLY:
- canvas.json (~50KB) — all positions, text, connections, settings
- thumbnails/ (~2MB) — tiny JPG previews for every file

Total: ~2MB. Opens in under 1 second. The other 99.9% of the file stays in the ZIP untouched.

Full assets (PDFs, videos, images, spreadsheets) load ONLY when the user interacts with a specific item (clicks, scrolls to it, zooms in).

### Layer 2: Viewport Culling — Only Render What's Visible

Canvas has 200 items. Screen shows ~15 at once. Only those 15 are mounted as React components. Items outside viewport are unmounted from DOM = zero memory, zero CPU.

Padding of 200px outside viewport for smooth scroll (items pre-mount before entering view). On every pan/zoom: recalculate visible set (pure math, sub-1ms). Only mount/unmount components that entered/left the viewport.

### Layer 3: Progressive Asset Loading — Thumbnails First

Every file item goes through three states:

State 1 PLACEHOLDER (instant): just file name + size from canvas.json. Zero bytes loaded.
State 2 THUMBNAIL (0.5s): small JPG from thumbnails/ folder. ~30KB each. Loaded on file open.
State 3 FULL PREVIEW (on demand): actual file loaded from ZIP. Only when user clicks, selects, or zooms in close.

Render level decision: zoom < 0.3 = placeholder. zoom < 0.7 = thumbnail. zoom >= 0.7 = thumbnail until interaction. User clicks/selects = full load.

### Layer 4: Lazy File Extraction From ZIP

Files stay compressed inside the .any ZIP until needed. LazyAssetLoader manages a cache with eviction:
- getAsset(path): loads from ZIP on first request, caches in memory
- Prevents duplicate concurrent loads for same asset
- evict(path): frees memory when item leaves viewport
- evictStale(): removes assets not accessed in 60 seconds
- Memory cache bounded by MemoryBudget (Layer 10)

### Layer 5: Video & Audio — Stream, Don't Load

Never load a whole video into memory. Create Object URL from ZIP blob. HTML5 video player handles buffering internally — only ~20MB of active playback buffer in RAM regardless of video size. Revoke URL when item leaves viewport.

### Layer 6: Image Quality Tiers

Zoom < 0.3: use 100px thumbnail (~30KB). Zoom 0.3-1.0: use 400px medium quality (generated on first request, cached). Zoom > 1.0: load full resolution original. A canvas with 50 images at overview zoom = 50 × 30KB = 1.5MB instead of 50 × 8MB = 400MB.

### Layer 7: Text Rendering Optimization

Up to 500 text items: standard DOM elements (React components). Fine at 60fps with viewport culling. For extreme canvases (500+): items NOT being edited switch to canvas2D fillText batch rendering. 500 fillText calls = <1ms. Switch back to DOM on click-to-edit.

### Layer 8: Connection Arrows — SVG Batching

100+ connections: batch all paths into ONE SVG path element (one giant d="" string). One DOM element instead of 100. Split into individual elements only on hover (for hit detection) or selection.

### Layer 9: Pan & Zoom — GPU Compositing

The entire canvas content layer uses CSS transform with will-change: transform. Pan and zoom update CSS custom properties directly — zero React re-renders, zero DOM reflow. Pure GPU compositing operation (same technique as Google Maps). Pan uses requestAnimationFrame. Viewport visibility check debounced to every 100ms (not every frame).

### Layer 10: Memory Budget

Max 500MB for canvas assets in memory. Track every loaded asset size and last access time. When over budget, evict least recently accessed assets. Thumbnails remain (tiny), full assets reload on demand when user returns. User never notices eviction — just sees thumbnail until they zoom in again.

### Layer 11: Incremental Save

FAST PATH (most saves): Only canvas.json changed (text edits, moves, connections). Update one entry in the ZIP. ~50ms regardless of .any file size. Even a 10GB file saves in 50ms.
MEDIUM PATH (file dropped): Append new asset to ZIP without rewriting existing entries. ~1-2s for the new file.
SLOW PATH (file deleted): Must rewrite ZIP without deleted entries. Rare, only on explicit user delete.
Auto-save every 30s uses fast path. User never perceives any delay.

### Layer 12: Predictive Preloading

After initial render, background-preload assets for items just outside the viewport (user likely to pan there). Priority: images first (fast, high visual impact), then PDF first pages, then Excel first sheets. NEVER preload video or audio (too large). Preloading runs at idle priority — never blocks user interaction.

### Performance Targets

Open 5GB .any file: < 1s (target), 2s (max)
Pan (any canvas size): 60fps (target), 30fps (max)
Zoom (any canvas size): 60fps (target), 30fps (max)
Click to type: < 50ms
Drop file: < 200ms
Auto-save (layout only): < 100ms
Auto-save (new file added): < 2s
Search across 1000 items: < 200ms
/ command bar open: < 100ms
Agent response render: < 50ms
500 items on canvas: 60fps
1000+ items on canvas: 30fps
Memory usage: < 300MB (target), 500MB (max)

### Summary

The .any file can be 10GB. The canvas opens in 1 second. Only 2MB of metadata and thumbnails load upfront. Everything else loads on demand, streams from ZIP, renders at the right quality for the current zoom level, and evicts from memory when the user looks away. The user never waits. It just feels fast.

---

## 24. ADDENDUM — Organizing Intelligence (KLYPIX Organizes Itself)

### The Principle

The user drops chaos. KLYPIX creates clarity. The agent doesn't just analyze — it organizes. No user effort required. The canvas stays clean as it grows.

### A. Smart Auto-Arrange

Multiple arrange modes via / commands:

```
/organize by type     → groups PDFs, images, code, spreadsheets into containers
/organize by topic    → AI reads content, groups by subject (financial, technical, etc.)
/organize by date     → timeline layout, oldest left, newest right
/organize by connection → connected items cluster together, orphans grouped separately
/arrange as grid      → neat grid layout with consistent spacing
/arrange as tree      → hierarchical tree derived from connections
/arrange as timeline  → horizontal timeline with date-ordered items
/arrange as mindmap   → central item with branches radiating outward
```

How /organize by topic works:
1. Agent reads summary of every item (using token budget — summaries, not full content)
2. Clusters items by detected topic (financial, technical, personnel, etc.)
3. Creates a container for each topic
4. Moves items into their containers
5. Arranges containers in a clean grid with spacing
6. Draws connections between related items across containers
7. User sees organized canvas — drag to adjust if needed

### B. Stacks — Pile Related Items

Multiple items occupy the same position, tab through them. Like stacking papers.

Select multiple items → right-click → "Stack these"

Visual: card shows tab count and navigation arrows. Click ◀ ▶ or swipe to cycle. Saves space while keeping related items together. Unstack: right-click stack → "Unstack" → items spread out next to each other.

Stack also created automatically: drop a file onto an existing file card → they stack. Like dragging a file onto a folder.

### C. Auto-Tagging

Agent automatically tags items on drop based on content, filename, and type.

Drop "Q3_Financial_Report.pdf" → auto-tags: [financial] [Q3] [report] [PDF]
Drop "KSA_Building_Plan.dwg" → auto-tags: [KSA] [construction] [CAD]
Drop code file → auto-tags: [code] [python/js/ts] based on extension
Agent creates a card → auto-tags based on content: [summary] [comparison] [chart]

Tags appear as small colored pills on the card. User can add/remove/edit tags. Filter canvas by tag to instantly show only matching items. Tag colors are consistent (user defines in settings).

Auto-tagging runs via a cheap Flash call (~$0.0005 per item). Can be disabled in settings.

### D. Smart Collections

Auto-updating virtual groups based on rules. Like smart playlists.

```
Smart Collection: "All Financial Documents"
  Rule: tag contains "financial" OR extension is .xlsx
  Auto-includes every matching item. Updates as canvas changes.

Smart Collection: "Agent Outputs"  
  Rule: createdBy = "agent"

Smart Collection: "Urgent Items"
  Rule: tag contains "urgent"

Smart Collection: "This Week"
  Rule: createdAt within last 7 days

Smart Collection: "Orphans"
  Rule: has zero connections
  Helps find items that aren't connected to anything.

Smart Collection: "Large Files"
  Rule: fileSize > 10MB
```

Smart collections appear in the outline sidebar with a ⚡ icon. Click to highlight all matching items on canvas (non-matching items fade to 20% opacity). Smart collections don't move items — they filter the view. Defined in Settings → Smart Collections, or via /create collection command.

### E. Table of Contents / Index

Auto-generated from canvas structure.

/create table of contents → agent scans canvas, builds a TOC card from containers and headings.

TOC shows hierarchical structure with clickable jump links. Updates automatically as containers are added/renamed/deleted. TOC is a live canvas item — pin it to a corner for constant reference. Can be collapsed to a compact list.

### F. Favorites Bar (Pin to Top)

Quick-access bar for most important items. Always visible regardless of zoom or pan.

```
⭐ 📄 Q3 Report  📊 Budget  📋 Action Items  📧 Ahmed's Email
```

Pin any item → appears in favorites bar → click to jump instantly. Drag to reorder. Right-click → unpin. Maximum 10 favorites. Bar auto-hides when canvas is in presentation mode.

### G. Spatial Search

Beyond text search. Find items by spatial and structural properties.

```
/find orphans              → items with zero connections
/find hubs                 → most-connected items
/find near "Q3 Report"     → items spatially close to Q3 Report
/find path from A to B     → shortest connection chain between two items
/find untagged             → items with no tags
/find by status blocked    → all items with blocked status
/find largest files        → biggest embedded files
/find agent outputs        → everything the agent created
/find recent               → items created in last 24 hours
```

Results highlight on canvas. Non-matching items fade. Click result to jump.

### H. Color Coding System

Consistent, user-defined color meanings.

Default meanings (user can customize in settings):

```
🟢 Green  = Complete / Approved
🟡 Yellow = In Progress / Needs Review  
🔴 Red    = Urgent / Blocked
🔵 Blue   = Reference / Source Material
🟣 Purple = Idea / Brainstorm
⚪ White  = Default / Untagged
```

Applied to: card borders, container borders, connection arrows, tags, status badges.

Agent respects color meanings:
- /color completed items green → batch applies
- /highlight urgent items → adds red border to items tagged urgent
- When agent creates status-related items, uses the correct color

Visual scanning: a canvas full of green borders = healthy project. Red borders = problems. User sees project health at a glance without reading anything.

### I. Stamp Templates (Region Templates)

Template SECTIONS that can be stamped anywhere on the canvas. Not full canvas templates — reusable building blocks.

```
/stamp meeting notes      → drops meeting notes template at cursor
/stamp pro con            → two-column comparison template
/stamp decision matrix    → grid template
/stamp swot               → 2x2 SWOT analysis
/stamp project brief      → title, scope, timeline, resources, risks
/stamp bug report         → steps to reproduce, expected, actual
/stamp weekly review      → wins, challenges, next week plan
/stamp comparison         → side-by-side comparison template (N columns)
```

Each stamp is a pre-built container with placeholder text. User fills in the blanks. Agent can fill them: /stamp meeting notes and fill from today's calendar.

Users can create custom stamps: right-click any container → "Save as stamp template." Saved in %APPDATA%/klypix/stamps/. Share stamps by sharing the stamp file.

### J. Hierarchy View Toggle

Switch between spatial view and hierarchical view of the same data. Both views edit the same underlying items.

Spatial view (default): items positioned freely on infinite canvas. Connections visible as arrows. Good for creative work, visual thinking, spatial organization.

Hierarchy view (Ctrl+H toggle): same items shown as indented tree in a sidebar or full panel. Structure derived from containers (parent-child) and connections. Drag items in hierarchy → reorder on canvas. Add items in either view → appears in both. Collapse/expand branches. Good for seeing structure, finding items, understanding depth.

The two views are always in sync. Not a separate mode — just a different lens on the same data.

### K. Status Tracking on Any Item

Any item can have a status badge. Not just tasks — documents, analyses, files, agent outputs.

```
Right-click → Set Status:
  ⬜ Not Started
  🟡 In Progress
  🔵 In Review  
  ✅ Complete
  ❌ Blocked
  ⏳ Waiting
```

Status shows as a small colored badge on the item corner. Agent can set statuses: after completing analysis, agent marks the source document as ✅ and the output as 🔵 (in review).

/show progress → agent counts all statuses and creates a progress card with visual bars and percentages. Tracks project health across the entire canvas.

/update status: mark all agent outputs as complete → batch status change.

### L. Relationship Types

Connections have typed meanings, not just generic arrows.

```
Connection types (pick on creation or agent assigns):

  ──→  "leads to"        (process flow)
  ──◇  "depends on"      (dependency)  
  ──○  "relates to"      (association)
  ──!  "conflicts with"  (problem)
  ──✓  "supports"        (evidence)
  ──?  "questions"       (uncertainty)
  ──$  "costs"           (financial link)
  ──⏱  "blocks"          (blocker)
```

Each type has its own visual: different arrow style, color, and optional icon at midpoint.

Agent commands:
```
/show dependencies     → highlights all dependency chains
/show conflicts        → highlights all conflicting items
/show blockers         → highlights all blocking relationships
/critical path         → shows longest dependency chain
/what depends on this? → traces all downstream items from selected
/what does this need?  → traces all upstream dependencies
```

These relationship types turn the canvas from a whiteboard into a knowledge graph. The connections carry meaning, and the agent can reason about the structure.

### M. Auto-Cleanup

Canvas hygiene features that prevent rot.

```
/cleanup → agent performs:
  1. Finds orphaned items (no connections, far from other items) → suggests grouping or deleting
  2. Finds duplicate content → highlights pairs, offers to merge
  3. Finds items with no text/content → suggests removing empty cards
  4. Realigns items that are almost-but-not-quite aligned → snaps to grid
  5. Suggests containers for ungrouped clusters of related items
  6. Reports: "Canvas health: 85% organized. 3 orphans, 2 duplicates found."
```

Auto-cleanup can run on schedule: Settings → "Auto-cleanup on save" → agent tidies up every time you save. Non-destructive: suggests changes, doesn't force them. User approves or dismisses each suggestion.

### Updated Positioning

```
Obsidian Canvas: manual organization. User does all the work.
KLYPIX Canvas: intelligent organization. Agent does the organizing.

Drop 50 files. Type /organize. Canvas is clean.
Drop 50 more. Type /organize. Still clean.
The canvas scales because the AI scales.

"Drop everything on one surface.
 KLYPIX organizes it, analyzes it, and builds from it.
 One file. Everything inside."
```
