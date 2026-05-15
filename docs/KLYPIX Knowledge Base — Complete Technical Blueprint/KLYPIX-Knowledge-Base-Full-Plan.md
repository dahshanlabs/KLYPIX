# ⚠️ SUPERSEDED — see CLAUDE.md

# KLYPIX Knowledge Base — Full Implementation Plan

## PRODUCT VISION

KLYPIX becomes the first Windows desktop AI assistant with local-first document intelligence. Users point KLYPIX at their folders, and their AI assistant instantly knows everything in their files — without uploading anything to the cloud. Chat answers become grounded in the user's own data with source citations.

---

## ARCHITECTURE OVERVIEW

```
┌─────────────────────────────────────────────────────────┐
│                    KLYPIX ELECTRON APP                   │
│                                                         │
│  ┌──────────────┐   ┌──────────────┐   ┌─────────────┐ │
│  │   Chat UI    │   │  KB Settings │   │  KB Status   │ │
│  │  (React 19)  │   │   Panel      │   │  Indicator   │ │
│  └──────┬───────┘   └──────┬───────┘   └──────┬──────┘ │
│         │                  │                   │        │
│  ───────┴──────────────────┴───────────────────┴─────── │
│                    IPC BRIDGE                            │
│  ────────────────────────────────────────────────────── │
│                                                         │
│  ┌─────────────────── MAIN PROCESS ──────────────────┐  │
│  │                                                   │  │
│  │  ┌─────────┐  ┌──────────┐  ┌─────────────────┐  │  │
│  │  │  File   │  │ Content  │  │   Embedding &   │  │  │
│  │  │ Watcher │→ │ Extract  │→ │   Indexing      │  │  │
│  │  │chokidar │  │ Pipeline │  │   Engine        │  │  │
│  │  └─────────┘  └──────────┘  └────────┬────────┘  │  │
│  │                                      │           │  │
│  │  ┌──────────────┐  ┌────────────────┴────────┐   │  │
│  │  │   Context    │  │      LanceDB            │   │  │
│  │  │ Intelligence │← │   (local vector store)  │   │  │
│  │  │  (existing)  │  │   ~/AppData/KLYPIX/kb/  │   │  │
│  │  └──────┬───────┘  └─────────────────────────┘   │  │
│  │         │                                        │  │
│  │         ↓                                        │  │
│  │  ┌──────────────┐                                │  │
│  │  │  Gemini API  │  (existing connection)         │  │
│  │  │  + KB chunks │                                │  │
│  │  └──────────────┘                                │  │
│  └───────────────────────────────────────────────────┘  │
│                                                         │
│  ┌───────────────── ON DISK ─────────────────────────┐  │
│  │  ~/AppData/KLYPIX/kb/                             │  │
│  │    ├── index.lance/        (vector database)      │  │
│  │    ├── metadata.json       (file registry)        │  │
│  │    ├── config.json         (watched folders)      │  │
│  │    └── cache/              (extracted content)    │  │
│  └───────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────┘
```

---

## DATA FLOW — STEP BY STEP

### Indexing Flow (background, user doesn't wait)

```
1. FILE DETECTED
   chokidar detects new/modified file in watched folder
   OR user drags file into KLYPIX window
   OR user right-clicks → "Add to KLYPIX"
        │
2. FILE VALIDATION
   ├─ Check magic bytes (confirm actual format, not just extension)
   ├─ Check file size (set max: 100MB per file for free, 500MB for Pro)
   ├─ Check if already indexed (compare hash)
   │  └─ If same hash → skip
   │  └─ If different hash → re-index (file was modified)
   └─ Add to processing queue
        │
3. CONTENT EXTRACTION (recursive)
   ├─ Identify content types inside the file
   ├─ Extract text content
   ├─ Extract structured data (tables, chart data, form fields)
   ├─ Extract metadata (author, dates, version)
   ├─ Catalog visual content (images, charts without source data)
   ├─ Detect embedded files → recurse for each
   └─ Generate content richness profile
        │
4. CHUNKING
   ├─ Split text into chunks (~512 tokens each)
   ├─ Use semantic boundaries (paragraphs, sections, page breaks)
   ├─ Preserve context: each chunk stores parent section title
   ├─ Structured data (tables, chart data) = separate chunks with type tag
   └─ Keep chunk-to-source mapping (file, page, cell range, slide number)
        │
5. EMBEDDING
   ├─ Load all-MiniLM-L6-v2 model (~80MB, runs on CPU)
   ├─ Generate 384-dimension vector for each chunk
   ├─ Speed: ~50-100 chunks/second on modern CPU
   └─ Store vectors + metadata in LanceDB
        │
6. INDEX UPDATED
   ├─ Update metadata.json (file registry with hash, date, richness score)
   ├─ Update UI status indicator
   └─ File is now searchable
```

### Chat Flow (real-time, user is waiting)

```
1. USER SENDS MESSAGE
   "What was our Q4 revenue?"
        │
2. CONTEXT INTELLIGENCE DECISION (existing system)
   ├─ Is this a general question? → skip KB, normal Gemini call
   ├─ Is this about user's data? → query KB
   └─ Signals: mentions specific docs, uses "our/my", asks about
      internal data, references dates/names from indexed files
        │
3. KB RETRIEVAL (if triggered)
   ├─ Embed the user's question (same model, ~10ms)
   ├─ Vector search in LanceDB (top 10 results, ~5-20ms)
   ├─ Score and filter results (relevance threshold)
   ├─ Check if any results are tagged "needs_vision"
   │  └─ If yes AND Pro user → send that specific page to Gemini Vision
   │  └─ If yes AND free user → note "some visual content not analyzed"
   ├─ Deduplicate overlapping chunks
   └─ Select top 3-5 most relevant chunks (~500-1500 tokens total)
        │
4. PROMPT ASSEMBLY
   ├─ System prompt (existing)
   ├─ Screen context (existing, if active)
   ├─ KB context: "The following information is from the user's files:
   │   [Source: Q4_Report.xlsx, Sheet 'Revenue', cells A1:D12]
   │   Revenue data: Q1=2.1M, Q2=2.3M, Q3=1.9M, Q4=2.5M
   │   
   │   [Source: Board_Presentation.pptx, Slide 8, speaker notes]
   │   Q4 revenue reached $2.5M, a 31% increase over Q3..."
   └─ User message
        │
5. GEMINI RESPONSE
   ├─ Gemini answers using KB context
   ├─ KLYPIX adds source citation below the response:
   │   "📎 Sources: Q4_Report.xlsx (Revenue sheet), Board_Presentation.pptx (Slide 8)"
   └─ User can click source to open original file
```

---

## UX DESIGN

### Entry Points for Adding Files

**1. Settings Panel → Knowledge Base tab**
```
┌─────────────────────────────────────────┐
│  Knowledge Base                    ⚙️   │
│─────────────────────────────────────────│
│                                         │
│  Watched Folders:                       │
│  ┌─────────────────────────────┬──────┐ │
│  │ 📁 D:\Projects\Client_A     │  ✕  │ │
│  │ 📁 C:\Users\Me\Documents    │  ✕  │ │
│  └─────────────────────────────┴──────┘ │
│  [+ Add Folder]                         │
│                                         │
│  Status:                                │
│  ● 247 files indexed                    │
│  ● 12,340 searchable chunks            │
│  ● 3 files processing...               │
│  ● Storage: 45 MB                       │
│                                         │
│  Index Health:                          │
│  ██████████░░ 85% coverage              │
│  15% visual content needs Pro           │
│                                         │
│  [View Indexed Files]  [Rebuild Index]  │
│  [Clear All]                            │
│                                         │
│  Settings:                              │
│  ☑ Auto-index new files                │
│  ☑ Include subfolders                  │
│  ☐ Index hidden files                  │
│  Max file size: [100 MB ▼]             │
│  Exclude patterns: [node_modules, .git]│
│                                         │
└─────────────────────────────────────────┘
```

**2. Quick Drop Zone in Chat**
When user drags a file over the KLYPIX window:
```
┌─────────────────────────────────────────┐
│          ┌─────────────────────┐        │
│          │   📄 Drop to add    │        │
│          │   to Knowledge Base │        │
│          └─────────────────────┘        │
│                                         │
│  Chat messages...                       │
│                                         │
└─────────────────────────────────────────┘
```

After drop:
```
"✅ Q4_Report.pdf added to Knowledge Base. 
 42 pages indexed (38 text, 4 charts pending Pro analysis).
 You can now ask me about it."
```

**3. Windows Context Menu (Phase 3)**
Right-click any file in Explorer → "Add to KLYPIX Knowledge Base"

### Chat Experience with KB

**User asks about their files:**
```
┌─────────────────────────────────────────┐
│ 👤 What was our Q4 revenue and how      │
│    does it compare to Q3?               │
│─────────────────────────────────────────│
│ 🤖 Q4 revenue was $2.5M, up 31% from   │
│    Q3's $1.9M. The main driver was the  │
│    new enterprise contract signed in    │
│    November, which contributed $400K.   │
│                                         │
│    📎 Sources:                          │
│    ├ Q4_Report.xlsx → Revenue sheet     │
│    ├ Board_Deck.pptx → Slide 8 notes   │
│    └ Nov_Meeting.docx → Section 3       │
│                                         │
│    [Open Q4_Report.xlsx]                │
│                                         │
└─────────────────────────────────────────┘
```

**User asks about visual content (free tier):**
```
┌─────────────────────────────────────────┐
│ 👤 What does the trend chart on page 5  │
│    of the report show?                  │
│─────────────────────────────────────────│
│ 🤖 I found the chart on page 5 of      │
│    Q4_Report.pdf but it's a visual      │
│    chart that I haven't analyzed yet.   │
│                                         │
│    [🔍 Analyze Now (Pro)] [Open File]   │
│                                         │
└─────────────────────────────────────────┘
```

**User asks about visual content (Pro tier):**
```
┌─────────────────────────────────────────┐
│ 🤖 The trend chart on page 5 shows     │
│    monthly revenue from Jan-Dec 2025.   │
│    There's a clear upward trend in Q4   │
│    with Nov and Dec being the highest   │
│    months at ~$850K and $920K.          │
│                                         │
│    📎 Source: Q4_Report.pdf, page 5     │
│    🔍 Analyzed with visual AI           │
│                                         │
└─────────────────────────────────────────┘
```

### Status Indicator (always visible)

Small icon in KLYPIX toolbar:
```
Normal:     📚 247 files
Indexing:   📚 247 files ⟳ 3 processing...
Error:      📚 247 files ⚠️ 1 failed
Disabled:   📚 Off
```

---

## FILE PROCESSING SPECIFICATIONS

### Supported File Types — Phase 1

| Format | Parser | npm Package | Size in node_modules |
|--------|--------|-------------|---------------------|
| PDF (digital) | Text + metadata | pdf-parse | ~2 MB |
| DOCX | Text + tables + comments + tracked changes | mammoth + adm-zip | ~1 MB |
| XLSX / CSV | All cell data + chart source data + formulas | sheetjs (xlsx) | ~2 MB |
| PPTX | Slide text + notes + chart data + tables | adm-zip + fast-xml-parser | ~0.5 MB |
| TXT / MD | Direct read | built-in fs | 0 |
| JSON / XML / YAML | Parse to structured data | built-in + fast-xml-parser + js-yaml | ~0.3 MB |
| EML | Headers + body + attachments | mailparser | ~3 MB |
| Code files | Direct read + comment extraction | built-in fs | 0 |
| RTF | Text extraction | rtf-parser | ~0.1 MB |

### Supported File Types — Phase 2

| Format | Parser | npm Package | Size in node_modules |
|--------|--------|-------------|---------------------|
| DXF | Text + layers + blocks + dimensions | dxf-parser | ~0.2 MB |
| DWG | Text + layers + blocks | libredwg-web (WASM) | ~5 MB |
| IFC (BIM) | Full model data + properties | web-ifc (WASM) | ~8 MB |
| ZIP / archives | Recursive extraction | adm-zip (already installed) | 0 |
| EPUB | Chapters + TOC + metadata | adm-zip (already installed) | 0 |
| SQLite | Full table data | better-sqlite3 | ~3 MB |
| MSG (Outlook) | Headers + body + attachments | msg-parser | ~0.5 MB |
| SVG | Text elements + structure | fast-xml-parser (already installed) | 0 |
| VSDX (Visio) | Shape text + connections | adm-zip + fast-xml-parser | 0 |

### Supported File Types — Phase 3 (Pro)

| Format | Method | Cost |
|--------|--------|------|
| Scanned PDF | tesseract.js (local) OR Gemini Vision (API) | Free local / $0.003/page API |
| Images with text | tesseract.js (local) OR Gemini Vision (API) | Free local / $0.003/image API |
| Charts/diagrams | Lazy vision → Gemini when user asks | $0.003-0.005 per analysis |
| Audio metadata | music-metadata npm | Free |
| Video subtitles | fluent-ffmpeg subtitle extraction | Free |

### Excluded (with reason)

| Format | Why |
|--------|-----|
| .rvt (Revit) | Proprietary binary, no parser exists. Show message: "Export as IFC from Revit to index" |
| .one (OneNote) | Proprietary. Show message: "Export as PDF from OneNote to index" |
| .psd (Photoshop) | Layers are visual, no meaningful text to index |
| .exe / .dll / binaries | Not documents, security risk |
| .mpp (MS Project) | No Node.js parser. Show message: "Export as XML or CSV to index" |

---

## CONTENT EXTRACTION PIPELINE — DETAILED

### The Recursive Extractor

```typescript
// Pseudocode for the recursive content extraction engine

interface ExtractionResult {
  chunks: ContentChunk[];
  media: MediaItem[];        // images, videos cataloged for lazy vision
  richness: RichnessProfile;
  childFiles: FileRef[];     // embedded files found
}

async function extractContent(
  filePath: string, 
  mimeType: string, 
  depth: number = 0
): Promise<ExtractionResult> {
  
  if (depth > 5) return empty; // prevent infinite recursion
  
  switch (detectType(filePath, mimeType)) {
    
    case 'pdf':
      const pdfText = await pdfParse(filePath);
      const pages = analyzePageDensity(pdfText);
      // Separate text-rich pages from image-heavy pages
      // Extract form fields if present
      // Extract annotations/comments
      // Catalog embedded images → tag for lazy vision
      return { chunks, media, richness };
    
    case 'docx':
      const docText = await mammoth.extractRawText(filePath);
      const docZip = await unzip(filePath);
      // Parse word/charts/*.xml → extract chart source data
      // Parse word/comments.xml → index comments
      // Parse word/media/ → catalog images
      // Check word/embeddings/ → recurse for each embedded file
      for (const embed of docZip.getEmbeddings()) {
        const childResult = await extractContent(embed, embed.type, depth + 1);
        mergeResults(result, childResult);
      }
      return result;
    
    case 'xlsx':
      const workbook = XLSX.readFile(filePath);
      // Extract all sheet data
      // Parse xl/charts/*.xml → chart source data (THE GOLD)
      // Extract comments, named ranges, data validations
      return result;
    
    case 'pptx':
      const pptZip = await unzip(filePath);
      // For each slide: extract text + tables
      // For each notesSlide: extract speaker notes
      // Parse ppt/charts/*.xml → chart source data
      // Catalog ppt/media/ → images, videos
      // Check ppt/embeddings/ → recurse
      return result;
    
    case 'eml':
      const email = await mailparser.parse(filePath);
      // Extract headers, body
      // For each attachment → recurse
      for (const att of email.attachments) {
        const childResult = await extractContent(att.path, att.contentType, depth + 1);
        mergeResults(result, childResult);
      }
      return result;
    
    case 'zip':
      const entries = await unzip(filePath);
      for (const entry of entries) {
        const childResult = await extractContent(entry.path, entry.type, depth + 1);
        mergeResults(result, childResult);
      }
      return result;
    
    case 'dxf':
      const dxf = dxfParser.parse(filePath);
      // Extract all TEXT and MTEXT entities
      // Extract layer names
      // Extract block attributes (title block data)
      // Extract dimension values
      return result;
    
    case 'ifc':
      const ifcApi = new WebIFC.IfcAPI();
      await ifcApi.Init();
      const model = ifcApi.OpenModel(fileBuffer);
      // Extract all property sets (materials, specs, ratings)
      // Extract spatial structure (building → storey → space)
      // Extract element types and quantities
      ifcApi.CloseModel(model);
      return result;
    
    case 'text': case 'markdown': case 'code':
      // Direct read, split by sections/paragraphs
      return result;
    
    case 'json': case 'xml': case 'yaml':
      // Parse structure, flatten to searchable text
      return result;
    
    default:
      // Unknown type → store filename + metadata only
      return { chunks: [filenameChunk], media: [], richness: minimal };
  }
}
```

### Chunking Strategy

```
DOCUMENT STRUCTURE:
┌─────────────────────────────┐
│ Document Title              │ → Document-level summary chunk
├─────────────────────────────┤
│ Section 1: Introduction     │ → Section header chunk
│   Paragraph 1 (400 tokens)  │ → Text chunk (under 512, keep whole)
│   Paragraph 2 (800 tokens)  │ → Split into 2 chunks with overlap
│   Table (revenue data)      │ → Structured data chunk (special type)
│   Chart (from Excel)        │ → Chart data chunk (extracted numbers)
│   Image (photo)             │ → Media reference (lazy vision tag)
├─────────────────────────────┤
│ Section 2: Analysis         │ → Section header chunk
│   ...                       │
└─────────────────────────────┘

CHUNKING RULES:
- Target chunk size: 512 tokens (sweet spot for embedding quality)
- Never break mid-sentence
- Overlap: 50 tokens between consecutive chunks (prevents losing context at boundaries)
- Tables: keep whole if under 1024 tokens, split by rows if larger
- Chart data: always one chunk per chart (usually small)
- Headers: prepend parent section title to every chunk for context
  e.g., "Section: Q4 Financial Results > Revenue by Region > ..."
- Metadata per chunk: source file, page/slide/sheet, section hierarchy
```

### Embedding Model

```
Model: all-MiniLM-L6-v2
- Dimensions: 384
- Size: ~80 MB
- Speed: 50-100 chunks/second on CPU (no GPU needed)
- Quality: excellent for English, good for multilingual
- License: Apache 2.0 (free for commercial use)

Library: @xenova/transformers (runs ONNX model in Node.js)

Loading: load once at KLYPIX startup, keep in memory
- Memory footprint: ~150 MB when loaded
- First-load time: 2-3 seconds
- Subsequent embeds: 5-10ms per chunk

ALTERNATIVE for Arabic-heavy content:
- Model: multilingual-e5-small
- Better Arabic support
- Dimensions: 384
- Size: ~120 MB
- Consider this if users work with Arabic documents
```

### Vector Database

```
Database: LanceDB
- Storage: local files in ~/AppData/KLYPIX/kb/index.lance/
- No server process, no Docker, no configuration
- Read/write directly from Electron main process
- npm: vectordb (or @lancedb/lancedb)

Performance:
- Insert: ~1000 vectors/second
- Query (10K vectors): ~5ms
- Query (100K vectors): ~15ms  
- Query (1M vectors): ~50ms

Storage:
- Per chunk: ~1.5 KB (384 floats + metadata)
- 10,000 chunks ≈ 15 MB on disk
- 100,000 chunks ≈ 150 MB on disk

Index:
- Auto-builds IVF index when data grows past 10K chunks
- No manual index management needed
```

---

## INTEGRATION WITH EXISTING KLYPIX CODE

### Changes to electron/main.ts

```
ADD:
- KnowledgeBaseService class
  - init(): load LanceDB, load embedding model, start file watcher
  - addFolder(path): add to watched folders list
  - removeFolder(path): remove and clean up index entries
  - indexFile(path): run extraction pipeline
  - removeFile(path): remove from index
  - query(text, topK): embed query → search → return ranked chunks
  - getStatus(): return { filesIndexed, chunksTotal, processing, storage }
  - destroy(): cleanup watchers, close DB

- IPC handlers:
  - 'kb:add-folder' → addFolder
  - 'kb:remove-folder' → removeFolder
  - 'kb:add-file' → indexFile (for drag-and-drop)
  - 'kb:query' → query
  - 'kb:status' → getStatus
  - 'kb:get-config' → return watched folders, settings
  - 'kb:update-config' → save settings
  - 'kb:open-source' → shell.openPath(filePath)
  - 'kb:rebuild' → clear and re-index all
  - 'kb:clear' → clear everything
```

### Changes to contextIntelligence.ts

```
MODIFY:
- Add new context category: 'knowledge_base'
- In the context routing logic, add KB detection:
  
  Signals that should trigger KB search:
  - User mentions specific file names
  - User uses possessive language ("my report", "our budget")
  - User asks about internal data ("what did we decide", "what's the spec")
  - User references dates/events that match indexed content
  - User explicitly says "from my files" or "in my documents"
  
  Signals that should NOT trigger KB search:
  - General knowledge questions ("what is Python?")
  - Current events/news
  - Coding help (unless referencing their own codebase in KB)
  - Screen-context questions (existing flow handles these)

- When KB is triggered:
  1. Call kb.query(userMessage, topK=10)
  2. Filter by relevance score (threshold: 0.5)
  3. Select top 3-5 chunks
  4. Format as context block with source citations
  5. Inject into Gemini prompt alongside other context
```

### Changes to useChat.ts

```
MINIMAL CHANGES:
- Accept KB context from contextIntelligence (already handles multiple context types)
- Pass source citations to UI for display
- Handle "analyze visual" button click → trigger lazy vision → update response
```

### Changes to App.tsx

```
ADD:
- KnowledgeBase settings panel component
- Drag-and-drop handler on main window
- Status indicator in toolbar
- Source citation display in chat messages
- "Open source file" click handler
- "Analyze Now (Pro)" button for visual content
```

---

## CONFIG FILE STRUCTURE

```json
// ~/AppData/KLYPIX/kb/config.json
{
  "enabled": true,
  "watchedFolders": [
    {
      "path": "D:\\Projects\\Client_A",
      "includeSubfolders": true,
      "addedAt": "2026-04-06T12:00:00Z"
    },
    {
      "path": "C:\\Users\\Abdullah\\Documents",
      "includeSubfolders": false,
      "addedAt": "2026-04-06T14:30:00Z"
    }
  ],
  "settings": {
    "maxFileSizeMB": 100,
    "excludePatterns": ["node_modules", ".git", "__pycache__", "*.tmp"],
    "autoIndex": true,
    "indexHiddenFiles": false,
    "embeddingModel": "all-MiniLM-L6-v2",
    "chunkSize": 512,
    "chunkOverlap": 50,
    "maxTotalStorageMB": 500
  },
  "pro": {
    "enabled": false,
    "lazyVisionEnabled": false,
    "ocrEngine": "tesseract_local"
  }
}
```

```json
// ~/AppData/KLYPIX/kb/metadata.json
{
  "files": {
    "abc123hash": {
      "path": "D:\\Projects\\Client_A\\Q4_Report.pdf",
      "filename": "Q4_Report.pdf",
      "hash": "abc123...",
      "size": 2456000,
      "type": "pdf",
      "indexedAt": "2026-04-06T12:05:00Z",
      "modifiedAt": "2026-03-15T09:30:00Z",
      "chunkCount": 89,
      "richness": {
        "textPages": 38,
        "chartPages": 4,
        "tablePages": 8,
        "imagePages": 3,
        "scannedPages": 0,
        "coveragePercent": 85,
        "needsVision": 7
      },
      "extractedMetadata": {
        "author": "Ahmed Ali",
        "title": "Q4 2025 Financial Report",
        "created": "2026-01-10T08:00:00Z"
      }
    }
  },
  "stats": {
    "totalFiles": 247,
    "totalChunks": 12340,
    "totalStorageMB": 45,
    "lastFullIndex": "2026-04-06T12:00:00Z"
  }
}
```

---

## PHASED DELIVERY PLAN

### PHASE 1 — Core Pipeline (Week 1-2)
**Goal: Text files work. User can chat with their documents.**

Week 1:
- [ ] Set up LanceDB in Electron main process
- [ ] Load all-MiniLM-L6-v2 embedding model via @xenova/transformers
- [ ] Build text extraction for: TXT, MD, JSON, XML, YAML, CSV
- [ ] Build PDF text extraction (pdf-parse)
- [ ] Build DOCX text extraction (mammoth)
- [ ] Build XLSX cell data extraction (SheetJS)
- [ ] Implement chunking engine (512 tokens, semantic boundaries, overlap)
- [ ] Implement embedding pipeline (extract → chunk → embed → store)
- [ ] Build vector search query function

Week 2:
- [ ] Set up chokidar file watcher with config
- [ ] Build IPC bridge (add folder, remove folder, query, status)
- [ ] Integrate KB query into contextIntelligence.ts
- [ ] Inject KB chunks into Gemini prompt
- [ ] Build basic KB settings panel (add/remove folders, status)
- [ ] Build drag-and-drop handler
- [ ] Add source citations to chat responses
- [ ] Add "Open source file" click handler
- [ ] Test with 50+ real documents

**Deliverable: KLYPIX can index text-based documents and answer questions from them with source citations.**

### PHASE 2 — Rich Content (Week 3-4)
**Goal: Charts, tables, mixed content, engineering files.**

Week 3:
- [ ] PPTX extraction (slide text + speaker notes + tables)
- [ ] Office chart data extraction (DOCX/XLSX/PPTX chart XML parsing)
- [ ] Embedded OLE object detection and extraction
- [ ] Recursive content extraction (ZIP, nested embeds)
- [ ] EML email parsing with attachment recursion
- [ ] DOCX comments and tracked changes extraction
- [ ] XLSX formulas and named ranges
- [ ] Content type detection (magic bytes, text density analysis)
- [ ] Content richness profile generation

Week 4:
- [ ] DXF parsing (text, layers, blocks, dimensions)
- [ ] DWG parsing (libredwg-web WASM)
- [ ] IFC/BIM parsing (web-ifc — properties, spatial structure)
- [ ] EPUB parsing
- [ ] SQLite database indexing
- [ ] SVG text extraction
- [ ] File hash tracking for change detection
- [ ] Re-indexing on file modification
- [ ] Exclude patterns support

**Deliverable: KLYPIX handles all common file types including engineering files. Chart data extracted from Office files without vision AI.**

### PHASE 3 — Intelligence Layer (Week 5-6)
**Goal: Pro features, visual content, structural intelligence.**

Week 5:
- [ ] Lazy vision pipeline (page image → Gemini Vision on demand)
- [ ] PDF page rendering to image (pdfjs-dist)
- [ ] "Analyze Now" button in chat UI for visual content
- [ ] Local OCR with tesseract.js for scanned PDFs
- [ ] Text density auto-detection (digital vs scanned pages)
- [ ] Content richness indicator in UI
- [ ] Pro tier gating logic

Week 6:
- [ ] Version detection (same doc, different dates → track versions)
- [ ] Basic contradiction detection (same entity, different numbers)
- [ ] Date/expiry extraction and alerting
- [ ] Cross-document entity matching
- [ ] "Indexed Files" browser panel (view all files, richness, status)
- [ ] Index rebuild and clear functions
- [ ] Error handling and recovery for corrupted files
- [ ] Performance optimization (batch indexing, background worker)

**Deliverable: Full Knowledge Base with Pro features, visual content analysis, and basic structural intelligence.**

### PHASE 4 — Polish & Advanced (Week 7-8)
**Goal: Production quality, advanced features.**

- [ ] Windows context menu integration ("Add to KLYPIX")
- [ ] Keyboard shortcut to search KB (e.g., Ctrl+K)
- [ ] Network/shared drive support
- [ ] Multi-language embedding model option (Arabic support)
- [ ] Index backup and restore
- [ ] Storage management (auto-cleanup old entries when folder removed)
- [ ] Analytics (most queried files, least used files)
- [ ] Onboarding tutorial for KB feature
- [ ] Edge case handling (very large files, password-protected, corrupted)
- [ ] Batch import progress UI (for first-time setup with 500+ files)

---

## PERFORMANCE BUDGETS

### Memory Budget
```
Embedding model loaded:          ~150 MB
LanceDB memory-mapped index:     ~20-50 MB (depends on index size)
File watcher:                    ~5 MB
Content extraction (per file):   ~20-100 MB (freed after indexing)
───────────────────────────────────────
Total KB overhead (idle):        ~200 MB
Total KB overhead (indexing):    ~300 MB

Remaining for KLYPIX core:      ~500 MB (on 8GB system)
                                ~2.5 GB (on 16GB system)
```

### Speed Targets
```
Single file index (10-page PDF):     < 3 seconds
Single file index (100-page PDF):    < 15 seconds
Single file index (DOCX):           < 1 second
Single file index (XLSX):           < 1 second
Batch index (100 files):            < 2 minutes (background)
Chat query KB retrieval:            < 50 ms
Full chat response (with KB):       < 4 seconds (includes Gemini API)
Embedding model load (startup):     < 3 seconds
```

### Storage Budget
```
10,000 chunks:    ~15 MB index + ~5 MB metadata = ~20 MB
Typical user:     100-500 files = 5,000-25,000 chunks = 10-40 MB
Power user:       2000+ files = 100,000+ chunks = 150+ MB
Max recommended:  500 MB total KB storage
```

---

## COST ANALYSIS

### Free Tier — Zero Additional Cost
```
What's included:
- Text extraction from all supported file types
- Local embeddings (all-MiniLM-L6-v2)
- Local vector search (LanceDB)
- Chart data extraction from Office files
- Unlimited files (up to storage limit)
- Basic OCR (tesseract.js, local)

Additional API cost per chat with KB: ~$0.0001-0.0003
(extra 500-1500 tokens in Gemini prompt)
This is negligible — maybe $0.01-0.05/month for active user.

The user already pays for Gemini API through existing KLYPIX usage.
KB adds tiny marginal cost.
```

### Pro Tier — Small Additional Cost
```
What's included (on top of free):
- Lazy vision analysis (Gemini Vision API)
- High-quality OCR via API
- Structural intelligence (contradiction detection, version tracking)

Estimated monthly cost per Pro user:
- Lazy vision: 5-10 analyses/day × $0.004 × 30 = $0.60-1.20/month
- API OCR (if used): 20-50 pages/month × $0.003 = $0.06-0.15/month
- Structural analysis: ~$0.50-1.00/month
──────────────────────────────────────────────────────
Total additional API cost: $1-3/month per Pro user

If Pro subscription is $15-20/month:
Gross margin on KB Pro: 80-90%
```

---

## RISK ASSESSMENT

### Technical Risks

| Risk | Impact | Probability | Mitigation |
|------|--------|-------------|------------|
| Embedding model too slow on weak CPUs | Users with old PCs get slow indexing | Medium | Batch processing in background, progress indicator, option to reduce chunk count |
| LanceDB corruption on crash | Index lost, needs rebuild | Low | Write-ahead logging, auto-rebuild on corruption detection |
| WASM parsers (libredwg, web-ifc) fail on edge cases | Some DWG/IFC files not indexed | Medium | Graceful fallback: log error, skip file, notify user |
| Memory pressure on 8GB machines | KLYPIX becomes slow | Medium | Lazy-load embedding model, unload when idle for 10 min, stream large files |
| File watcher misses events | Index out of sync | Low | Periodic full scan every 6 hours as safety net |
| Electron app bundle size bloat | Download size increases | High | WASM parsers are large (~15 MB total). Accept for Phase 2, or lazy-download on first use |

### Product Risks

| Risk | Impact | Probability | Mitigation |
|------|--------|-------------|------------|
| Users dump 10,000+ files and expect instant indexing | Bad first experience | Medium | Show progress, estimate time, prioritize recently modified files |
| Retrieval returns irrelevant chunks | User loses trust | Medium | Tunable relevance threshold, show confidence score, let user give feedback |
| Users expect 100% accuracy from KB answers | Disappointment when wrong | High | Always show sources, add disclaimer on first use, never present KB answers as absolute truth |
| Privacy concerns about API calls with file content | User hesitation | Medium | Clear messaging: "only relevant snippets sent to API, never full files" |
| Feature complexity overwhelms casual users | Low adoption | Medium | KB is OFF by default, simple onboarding flow, "just drag a file" messaging |

---

## TESTING STRATEGY

### Test Document Sets

```
Set A — Basic (Phase 1 testing):
- 10 plain text files (varying sizes)
- 10 PDFs (digital, text-heavy)
- 10 DOCX files (with tables, comments)
- 5 XLSX files (with data, formulas)
- 5 CSV files

Set B — Mixed Content (Phase 2 testing):
- 5 PPTX with charts and speaker notes
- 5 DOCX with embedded Excel charts
- 5 XLSX with chart objects
- 5 PDFs with tables and images mixed
- 3 EML emails with various attachments
- 3 ZIP files containing Office documents
- 2 DXF engineering drawings
- 1 IFC building model

Set C — Edge Cases:
- 1 scanned PDF (image-only)
- 1 password-protected PDF
- 1 corrupted DOCX
- 1 file with wrong extension (.pdf that's actually .docx)
- 1 very large file (100MB+)
- 1 file with Arabic text
- 1 file with mixed Arabic/English
- 1 empty file
- 1 file with only images, no text

Set D — Stress Test:
- 500 files of mixed types
- Simulate: add 50 files at once
- Simulate: modify file while indexing
- Simulate: delete watched folder while indexing
- Simulate: low disk space
```

### Query Test Cases

```
1. Exact match: "What is the value in cell B5 of Budget.xlsx?"
2. Semantic search: "Tell me about our financial performance"
3. Cross-document: "Do the budget numbers match the quarterly report?"
4. Temporal: "What changed between version 1 and version 2 of the policy?"
5. Negative: "What do my files say about quantum computing?" (nothing — should say so)
6. Ambiguous: "What's the latest?" (should ask for clarification or show recent files)
7. Specific file: "Summarize the meeting notes from March"
8. Engineering: "What's the wall thickness in drawing A-201?"
9. Email: "What did Ahmed say about the delivery date?"
10. Mixed: "Compare the revenue chart in the presentation with the spreadsheet data"
```

---

## NPM DEPENDENCIES SUMMARY

### Phase 1 (must-have)
```json
{
  "dependencies": {
    "@xenova/transformers": "^2.17.0",    // embedding model runtime (~15 MB)
    "vectordb": "^0.4.0",                 // LanceDB (~5 MB)
    "pdf-parse": "^1.1.1",                // PDF text extraction (~2 MB)
    "mammoth": "^1.8.0",                  // DOCX extraction (~1 MB)
    "xlsx": "^0.18.5",                    // Excel/CSV (~2 MB)
    "chokidar": "^3.6.0",                 // File watcher (~1 MB)
    "adm-zip": "^0.5.10",                 // ZIP handling (~0.3 MB)
    "fast-xml-parser": "^4.3.0",          // XML parsing (~0.3 MB)
    "js-yaml": "^4.1.0",                  // YAML parsing (~0.1 MB)
    "mailparser": "^3.7.0"                // EML parsing (~3 MB)
  }
}
// Total added: ~30 MB to node_modules
// Total added to app bundle (after packaging): ~15 MB
```

### Phase 2 (engineering)
```json
{
  "dependencies": {
    "dxf-parser": "^1.1.2",              // DXF parsing (~0.2 MB)
    "web-ifc": "^0.0.57",                // IFC/BIM parsing WASM (~8 MB)
    "libredwg-web": "^0.1.0",            // DWG parsing WASM (~5 MB)
    "better-sqlite3": "^11.0.0"          // SQLite reading (~3 MB)
  }
}
// Total added: ~16 MB
```

### Phase 3 (Pro)
```json
{
  "dependencies": {
    "tesseract.js": "^5.1.0",            // Local OCR (~15 MB with language data)
    "pdfjs-dist": "^4.0.0"               // PDF page rendering (~10 MB)
  }
}
// Total added: ~25 MB
```

### Total Impact on KLYPIX
```
Phase 1: +15 MB to installer, +150 MB RAM (embedding model)
Phase 2: +16 MB to installer (WASM files), minimal extra RAM
Phase 3: +25 MB to installer, +50 MB RAM (when OCR active)

Total worst case: +56 MB installer, +200 MB RAM
Current KLYPIX Electron base: ~200 MB installer, ~400 MB RAM
After KB: ~256 MB installer, ~600 MB RAM

Verdict: Acceptable. Still lighter than VS Code (~350 MB installer).
```

---

## SUCCESS METRICS

### Week 1-2 Launch
- User can add a folder with 100 text documents and query them in < 2 minutes setup time
- Retrieval accuracy > 80% on test query set
- Zero crashes during normal indexing
- Chat response with KB takes < 4 seconds

### Week 4 Launch
- All Phase 1+2 file types parse without error on test sets
- Chart data extraction works for 90%+ of Office charts
- Recursive extraction handles 3-level nesting (email → zip → docx)
- 500-file stress test completes without memory issues on 8GB machine

### Week 6 Launch
- Pro lazy vision answers visual content questions correctly 85%+ of time
- Version detection identifies >80% of document version relationships
- Basic contradiction detection flags number mismatches across documents
- Full test suite passes

### Week 8 Launch
- Production-ready with error handling for all edge cases
- Onboarding flow tested with 5+ non-technical users
- Documentation complete
- Ready for public release
