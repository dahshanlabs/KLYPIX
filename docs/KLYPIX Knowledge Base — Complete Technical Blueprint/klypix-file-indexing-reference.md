# ⚠️ SUPERSEDED — see CLAUDE.md

# KLYPIX Knowledge Base — Complete File Indexing Reference

## What This Document Covers
Every file type a user might drop into a KLYPIX Knowledge Base folder, what data is actually inside each file, what can be extracted locally (free), what needs an API, and the honest practicality rating for each.

---

## CATEGORY 1: OFFICE DOCUMENTS

### 📄 PDF (.pdf)
**What's inside:** Text layers, embedded images, form fields, annotations, bookmarks, metadata (author, creation date, modification date).
**Extraction approach:**
- **Text:** `pdf-parse` npm package — extracts all text with page numbers. 100% local, 100% reliable for digital PDFs.
- **Scanned PDFs (image-only):** No text layer exists. Requires OCR via `tesseract.js` (local, slow, ~3-5 sec/page) or Gemini Vision API (fast, costs ~$0.003/page).
- **Form fields:** `pdf-lib` can read filled form values locally.
- **Embedded images:** `pdf-parse` doesn't extract images. Need `pdfjs-dist` (Mozilla's PDF.js) to render pages as images, then analyze.
- **Tables:** Text extraction gives raw text — table structure is lost. For structured table extraction, need API vision or specialized libraries like `tabula-js` (Java dependency).
- **Metadata:** `pdf-parse` extracts author, title, creation date, modification date. Free and instant.

**What you CAN'T get locally:** Complex table structure from text-heavy PDFs, chart data from embedded graphs, handwritten annotations.
**Practicality: 90% for text PDFs, 60% for scanned PDFs (without API)**

---

### 📝 Word Document (.docx)
**What's inside:** A .docx is literally a ZIP file containing XML. Text, styles, headers/footers, comments, tracked changes, embedded images, tables, footnotes, bookmarks, metadata.
**Extraction approach:**
- **Text:** `mammoth` npm package — extracts clean text/HTML. 100% local, very reliable.
- **Tracked changes:** Unzip the .docx → read `word/document.xml` → parse `<w:ins>` and `<w:del>` elements. 100% local. You get WHO changed WHAT and WHEN.
- **Comments:** Parse `word/comments.xml` from the unzipped archive. 100% local.
- **Embedded images:** Unzip → `word/media/` folder contains all images as separate files. 100% local.
- **Tables:** `mammoth` can output HTML tables. Parse the HTML for structured data. 100% local.
- **Metadata:** Unzip → `docProps/core.xml` has author, dates, revision count. 100% local.
- **Headers/Footers:** Separate XML files in the archive. Parseable locally.

**What you CAN'T get locally:** Nothing — .docx is fully transparent. This is the best file format for local extraction.
**Practicality: 100%**

---

### 📝 Legacy Word (.doc)
**What's inside:** Binary format, same content as .docx but in proprietary binary encoding.
**Extraction approach:**
- **Text:** `antiword` (CLI tool, can run in Electron via child_process) or convert to .docx first using LibreOffice.
- **Convert to .docx:** LibreOffice headless mode: `soffice --convert-to docx file.doc`. Then parse as .docx.

**What you CAN'T get locally:** Direct parsing is unreliable. Always convert first.
**Practicality: 75% (conversion step adds complexity)**

---

### 📊 Excel (.xlsx / .xls / .csv / .tsv)
**What's inside:** Sheets with cell data, formulas, **chart source data**, pivot tables, named ranges, conditional formatting, comments, metadata.
**Extraction approach:**
- **Cell data:** `SheetJS (xlsx)` npm package — reads ALL cell values, formulas, sheet names. 100% local, battle-tested.
- **CSV/TSV:** Native Node.js `fs` + simple parsing, or `papaparse`. 100% local, trivial.
- **Chart source data:** THIS IS THE GOLD. Charts in Excel are stored as XML referencing cell ranges. SheetJS can read the source cells. You get the ACTUAL NUMBERS behind every chart — no vision needed. 100% local.
- **Formulas:** SheetJS reads formula strings. You know what calculations exist.
- **Multiple sheets:** Full access to all sheet names and data. 100% local.
- **Metadata:** Author, dates, company name. 100% local via SheetJS.
- **Pivot tables:** SheetJS can read pivot cache data. 100% local.

**What you CAN'T get locally:** Visual formatting (colors, conditional formatting highlights). Chart visual styling (but you have the data, which is more useful).
**Practicality: 98% — one of the best file types for extraction**

---

### 📊 Legacy Excel (.xls)
**What's inside:** Same as .xlsx but binary format.
**Extraction approach:** SheetJS handles .xls format too. Same extraction capabilities.
**Practicality: 95%**

---

### 📽️ PowerPoint (.pptx)
**What's inside:** A ZIP archive. Slides with text, images, charts (with source data), speaker notes, animations, metadata.
**Extraction approach:**
- **Text from slides:** Unzip → parse `ppt/slide[N].xml` for text elements. Or use `pptx-parser` npm. 100% local.
- **Speaker notes:** `ppt/notesSlides/notesSlide[N].xml` — often contains MORE useful info than the slides. 100% local.
- **Chart source data:** Like Excel, PPTX charts store source data in XML (`ppt/charts/chart[N].xml`). You get the actual data table behind every chart. 100% local.
- **Embedded images:** `ppt/media/` folder in the ZIP. 100% local.
- **Slide order and titles:** XML parsing. 100% local.
- **Metadata:** `docProps/core.xml`. 100% local.

**What you CAN'T get locally:** Visual layout understanding (which text is a title vs. subtitle vs. annotation), SmartArt content (partially encoded), complex diagrams.
**Practicality: 85%**

---

### 📽️ Legacy PowerPoint (.ppt)
**What's inside:** Binary format.
**Extraction approach:** Convert to .pptx via LibreOffice, then parse. Or use limited text extraction tools.
**Practicality: 65%**

---

## CATEGORY 2: ENGINEERING & CAD FILES

### 📐 AutoCAD Drawing (.dwg)
**What's inside:** 2D/3D geometry (lines, arcs, circles, polylines), layers, blocks, text annotations, dimensions, attributes, title block data, xrefs (external references).
**Extraction approach:**
- **Text annotations & labels:** `libredwg-web` (WASM-based, runs in Node.js/Electron) can parse DWG files and extract text entities. 100% local.
- **Layer names:** Parseable — layers often describe WHAT things are ("Electrical", "Plumbing", "Structural"). 100% local.
- **Block attributes:** Title block data (project name, drawing number, revision, date, engineer name) is stored as block attributes. Extractable locally.
- **Dimensions:** Dimension text values are extractable. 100% local.
- **Geometry:** Line coordinates, arc parameters — extractable but raw geometric data, not human-meaningful without rendering.

**What you CAN'T get locally:** Visual understanding of the drawing (what a shape LOOKS like). For that, convert DWG → image (via LibreOffice or Aspose) → Gemini Vision.
**Practicality: 70% for metadata/text, 30% for visual understanding without API**

---

### 📐 AutoCAD Exchange (.dxf)
**What's inside:** Same as DWG but in a text-based format (ASCII). Much easier to parse.
**Extraction approach:**
- **Everything:** `dxf-parser` npm package — reads DXF into a clean JavaScript object. Entities, layers, blocks, text, dimensions. 100% local.
- **Text search:** Extract all TEXT and MTEXT entities. This gets you labels, annotations, notes.
- **Layer analysis:** Full layer listing with color, visibility, etc.

**What you CAN'T get locally:** Same as DWG — visual understanding requires rendering.
**Practicality: 80% for metadata/text, 30% for visual understanding without API**

---

### 🏗️ BIM / IFC Files (.ifc)
**What's inside:** Building Information Model — walls, doors, windows, slabs, columns, beams, MEP systems, spaces, materials, properties, relationships, quantities.
**Extraction approach:**
- **Full data model:** `web-ifc` npm package (WASM, runs in Node.js) — reads ALL IFC entities at native speed. Walls, doors, spaces, properties, material assignments, spatial hierarchies. 100% local.
- **Property sets:** Custom properties (fire rating, acoustic rating, cost, manufacturer) are fully extractable. 100% local.
- **Spatial queries:** "What's on floor 3?" "What material is wall W-2301?" — answerable from parsed IFC data. 100% local.
- **Quantities:** Areas, volumes, lengths — stored in IFC QuantitySets. 100% local.
- **Relationships:** Which wall contains which door, which space is in which storey. 100% local.

**What you CAN'T get locally:** Visual rendering (but data is complete without it). Clash detection requires geometry processing.
**Practicality: 90% for data extraction — IFC is the BEST engineering format for AI indexing**

---

### 📐 Revit Files (.rvt)
**What's inside:** Proprietary Autodesk format. Similar data to IFC but locked down.
**Extraction approach:**
- **Direct parsing:** NOT possible without Revit API or Autodesk Forge/APS (cloud API, paid).
- **Workaround:** Export from Revit to IFC → then use web-ifc. But this requires user action.
- **Another workaround:** Autodesk Platform Services (APS) can extract data via cloud API.

**What you CAN'T get locally:** Everything. This format is completely proprietary.
**Practicality: 10% without Autodesk API, 85% if user exports to IFC first**

---

### 📐 SolidWorks (.sldprt, .sldasm), STEP (.stp/.step), IGES (.igs/.iges)
**What's inside:** 3D mechanical models, parts, assemblies, material properties, dimensions.
**Extraction approach:**
- **STEP/IGES:** These are open formats. Libraries exist (OpenCASCADE via WASM) but they're heavy and complex. Text metadata can be extracted with string parsing.
- **SolidWorks:** Proprietary. Cannot parse locally.
- **STL (.stl):** Very simple format — just triangles. `three.js` can load it. But no metadata, just geometry.

**Practicality: 40% for STEP/IGES metadata, 5% for SolidWorks native**

---

## CATEGORY 3: IMAGES & VISUAL FILES

### 🖼️ Images (.png, .jpg, .jpeg, .gif, .bmp, .tiff, .webp)
**What's inside:** Pixel data, EXIF metadata (camera, GPS, date), text if it's a screenshot or scanned document.
**Extraction approach:**
- **EXIF metadata:** `exif-parser` or `sharp` npm — date, camera model, GPS coordinates, dimensions. 100% local.
- **OCR text:** `tesseract.js` — extracts printed text. 100% local but slow (3-5 sec/image) and accuracy varies (90% for clean printed text, 60% for handwriting).
- **Image description:** Requires Gemini Vision API. No practical local alternative for KLYPIX's target hardware.
- **Diagram/chart understanding:** API only. Vision models needed.

**What you CAN'T get locally:** Understanding what the image MEANS. Local OCR gets the text; understanding the content requires API.
**Practicality: 50% local (metadata + OCR), 95% with API**

---

### 📸 RAW Photos (.cr2, .nef, .arw, .raw)
**What's inside:** Unprocessed sensor data, rich EXIF metadata.
**Extraction approach:**
- **EXIF:** `exifr` npm handles RAW formats. 100% local.
- **Preview thumbnail:** Most RAW files embed a JPEG preview. Extractable locally.

**What you CAN'T get locally:** Visual understanding of the actual image content.
**Practicality: 40% — metadata only, visual content requires conversion + API**

---

### 📐 SVG (.svg)
**What's inside:** XML-based vector graphics. Text, paths, shapes, embedded images, metadata.
**Extraction approach:**
- **Text:** Parse XML → extract `<text>` elements. 100% local, trivial.
- **Structure:** SVG elements describe shapes — parseable for layout analysis.
- **Embedded images:** Base64-encoded images may be inside SVGs.

**Practicality: 85% — XML format makes it very parseable**

---

## CATEGORY 4: PLAIN TEXT & CODE

### 📝 Plain Text (.txt)
**What's inside:** Raw text.
**Extraction:** Direct `fs.readFile`. 100% local, zero cost.
**Practicality: 100%**

---

### 📝 Markdown (.md)
**What's inside:** Structured text with headers, lists, links, code blocks, tables.
**Extraction:** Parse with `marked` or `remark` npm — get structured sections, headers, links. 100% local.
**Practicality: 100% — actually better than plain text because structure is explicit**

---

### 📝 Rich Text (.rtf)
**What's inside:** Formatted text, images, tables.
**Extraction:** `rtf-parser` npm or convert via LibreOffice. 100% local.
**Practicality: 80%**

---

### 💻 Source Code (.js, .ts, .py, .java, .cpp, .cs, .go, .rs, etc.)
**What's inside:** Code with comments, function signatures, class definitions, imports, TODOs.
**Extraction approach:**
- **Raw text:** Direct file read. 100% local.
- **AST parsing:** `@babel/parser` (JS/TS), `tree-sitter` (multi-language) — extract function names, classes, imports, exports structurally. 100% local.
- **Comment extraction:** Regex or AST-based comment extraction. 100% local.
- **TODO/FIXME/HACK:** Simple regex search. 100% local.

**Practicality: 100%**

---

### 📋 JSON (.json)
**What's inside:** Structured data.
**Extraction:** `JSON.parse()`. 100% local, instant.
**Practicality: 100%**

---

### 📋 XML (.xml)
**What's inside:** Structured data with schemas.
**Extraction:** `fast-xml-parser` npm. 100% local.
**Practicality: 100%**

---

### 📋 YAML (.yml, .yaml)
**What's inside:** Configuration, structured data.
**Extraction:** `js-yaml` npm. 100% local.
**Practicality: 100%**

---

### 📋 TOML (.toml)
**What's inside:** Configuration data.
**Extraction:** `@iarna/toml` npm. 100% local.
**Practicality: 100%**

---

## CATEGORY 5: EMAIL & COMMUNICATION

### 📧 Email (.eml)
**What's inside:** Headers (from, to, date, subject), body (text + HTML), attachments (any file type).
**Extraction approach:**
- **Headers:** `mailparser` npm — from, to, cc, date, subject, message-id. 100% local.
- **Body text:** Plain text and HTML body, both extractable. 100% local.
- **Attachments:** Extracted as buffers — can then run through appropriate file handler. 100% local.
- **Thread references:** In-Reply-To and References headers for conversation threading. 100% local.

**Practicality: 95%**

---

### 📧 Outlook Email (.msg)
**What's inside:** Same as .eml but Microsoft proprietary binary format.
**Extraction:** `msg-parser` npm — extracts headers, body, attachments. 100% local.
**Practicality: 85%**

---

### 📧 Mailbox (.mbox)
**What's inside:** Multiple emails concatenated in a single file.
**Extraction:** `mbox-parser` or custom parser splitting on "From " line markers. 100% local.
**Practicality: 80%**

---

## CATEGORY 6: ARCHIVE & COMPRESSED

### 📦 ZIP (.zip)
**What's inside:** Compressed files of any type.
**Extraction:** `adm-zip` or `jszip` npm — list contents, extract files, then process each file by type. 100% local.
**Practicality: 100% (for the archive itself; contained files depend on their types)**

---

### 📦 Other Archives (.tar, .gz, .7z, .rar)
**What's inside:** Compressed files.
**Extraction:** `tar` (Node built-in for .tar.gz), `node-7z` for .7z, `node-unrar-js` for .rar. 100% local.
**Practicality: 85%**

---

## CATEGORY 7: DATABASE & STRUCTURED DATA

### 🗄️ SQLite (.sqlite, .db)
**What's inside:** Full relational database — tables, rows, columns, indexes, views.
**Extraction:** `better-sqlite3` npm — query tables, list schemas, extract all data. 100% local, very fast.
**Practicality: 100% — extremely useful for indexing structured data**

---

### 📋 CSV/TSV (.csv, .tsv)
**What's inside:** Tabular data with headers.
**Extraction:** `papaparse` npm. 100% local. Handles malformed CSVs well.
**Practicality: 100%**

---

### 📋 Parquet (.parquet)
**What's inside:** Columnar data format used in data engineering.
**Extraction:** `parquetjs` npm. 100% local.
**Practicality: 75%**

---

## CATEGORY 8: EBOOK & PUBLISHING

### 📚 EPUB (.epub)
**What's inside:** A ZIP containing HTML chapters, CSS, images, metadata (title, author, ISBN, TOC).
**Extraction approach:**
- **Text:** Unzip → parse HTML files for chapter text. 100% local.
- **Table of Contents:** Parse `toc.ncx` or `nav.xhtml`. 100% local.
- **Metadata:** Parse `content.opf` for title, author, publisher, ISBN. 100% local.
- **Images:** Extract from archive. 100% local.

**Practicality: 95%**

---

### 📚 MOBI/AZW (.mobi, .azw, .azw3)
**What's inside:** Amazon Kindle format. Text, metadata, images.
**Extraction:** Convert to EPUB first using `calibre` CLI tool (ebook-convert). Then parse as EPUB.
**Practicality: 70% (conversion dependency)**

---

## CATEGORY 9: AUDIO & VIDEO (Metadata Only)

### 🎵 Audio (.mp3, .wav, .flac, .m4a, .ogg)
**What's inside:** Audio data, ID3 tags (title, artist, album, year, genre, lyrics), embedded album art.
**Extraction approach:**
- **Metadata/tags:** `music-metadata` npm — all ID3 tags, duration, bitrate, sample rate. 100% local.
- **Embedded lyrics:** Stored in ID3 USLT frame. 100% local.
- **Transcription:** Requires Whisper API or local Whisper model (~1.5GB VRAM for tiny model). Local is possible but slow.

**What you CAN'T get locally (practically):** High-quality real-time transcription.
**Practicality: 60% for metadata, 30% for transcription without API**

---

### 🎬 Video (.mp4, .mkv, .avi, .mov, .webm)
**What's inside:** Video/audio streams, subtitles, metadata (title, creation date, GPS for phone videos).
**Extraction approach:**
- **Metadata:** `ffprobe` via `fluent-ffmpeg` npm — duration, resolution, codec, creation date, GPS. 100% local.
- **Embedded subtitles:** Extract with ffmpeg. 100% local. These are fully indexable text.
- **External subtitles (.srt, .vtt):** Plain text files. 100% local, trivial to parse.
- **Keyframe extraction:** ffmpeg can extract frames at intervals. 100% local.
- **Frame analysis:** Extracted frames → Gemini Vision. API cost ~$0.003/frame.

**Practicality: 50% for metadata + subtitles, 20% for content understanding without API**

---

## CATEGORY 10: SPECIALIZED FORMATS

### 📊 Visio (.vsdx)
**What's inside:** Diagrams, flowcharts, org charts — stored as ZIP with XML (like Office).
**Extraction approach:**
- **Text:** Unzip → parse page XML for shape text. 100% local.
- **Shape types:** Shape master names tell you what kind of shape (process box, decision diamond, etc.). 100% local.
- **Connections:** Relationship data between shapes. 100% local.

**Practicality: 75%**

---

### 📊 Microsoft Project (.mpp)
**What's inside:** Tasks, durations, dependencies, resources, Gantt chart data.
**Extraction:** `mpxj` (Java library) or convert to XML/CSV. No native Node.js parser.
**Workaround:** Export to .xml or .csv from MS Project, then parse.
**Practicality: 40% without user export, 90% if exported to XML/CSV**

---

### 📝 OneNote (.one)
**What's inside:** Notes, drawings, embedded files.
**Extraction:** Proprietary binary format. No reliable local parser.
**Workaround:** Export to PDF or HTML from OneNote.
**Practicality: 10% without export**

---

### 🗺️ GIS Files (.shp, .geojson, .kml, .kmz)
**What's inside:** Geographic data — shapes, coordinates, attributes.
**Extraction approach:**
- **GeoJSON:** `JSON.parse()`. 100% local. Contains coordinates + properties.
- **KML/KMZ:** XML-based (KMZ is zipped KML). Parse XML. 100% local.
- **Shapefile:** `shapefile` npm package. 100% local.

**Practicality: 90% for GeoJSON/KML, 80% for Shapefile**

---

### 🔐 Encrypted/Password-Protected Files
**What's inside:** Unknown until decrypted.
**Extraction:** Cannot process without the password. KLYPIX should detect encryption and prompt user for password.
- **PDF encryption:** `pdf-lib` can attempt with password.
- **Office encryption:** LibreOffice can open with password parameter.
- **ZIP encryption:** `adm-zip` supports password parameter.

**Practicality: 0% without password, 80% with password**

---

## SUMMARY TABLE

| File Type | Local Text | Local Data | Local Images | Needs API For | Practicality |
|-----------|-----------|------------|-------------|---------------|-------------|
| PDF (digital) | ✅ | ✅ tables partial | ❌ understanding | Charts, diagrams | 90% |
| PDF (scanned) | ⚠️ OCR | ❌ | ❌ | Everything visual | 60% |
| DOCX | ✅ | ✅ comments/changes | ✅ extract | Nothing | 100% |
| XLSX | ✅ | ✅ chart data! | N/A | Nothing | 98% |
| PPTX | ✅ | ✅ chart data! | ✅ extract | Visual layout | 85% |
| DXF | ✅ text/labels | ✅ layers/blocks | ❌ rendering | Visual understanding | 80% |
| DWG | ✅ text/labels | ✅ via libredwg | ❌ rendering | Visual understanding | 70% |
| IFC (BIM) | ✅ | ✅ full model! | ❌ rendering | Nothing for data | 90% |
| Revit (.rvt) | ❌ | ❌ | ❌ | Everything | 10% |
| Images | ⚠️ OCR | ✅ EXIF | ✅ is the file | Content understanding | 50% |
| EML | ✅ | ✅ | ✅ attachments | Nothing | 95% |
| Code files | ✅ | ✅ AST | N/A | Nothing | 100% |
| JSON/XML/YAML | ✅ | ✅ | N/A | Nothing | 100% |
| SQLite | ✅ | ✅ | N/A | Nothing | 100% |
| EPUB | ✅ | ✅ | ✅ | Nothing | 95% |
| Video | ⚠️ subtitles | ✅ metadata | ⚠️ keyframes | Content understanding | 50% |
| Audio | ⚠️ tags only | ✅ metadata | N/A | Transcription | 60% |

---

## CAD & ENGINEERING — THE HONEST TRUTH

### What engineers ACTUALLY need from their drawings:

1. **"What's the spec for valve V-2301?"** → Answerable from DXF text extraction + block attributes. 100% local.

2. **"Show me all electrical panels on floor 2"** → If DXF/DWG: filter by layer name ("E-PANEL" or similar). If IFC: query by entity type. 100% local.

3. **"What revision is this drawing?"** → Title block attributes in DXF/DWG, or metadata. 100% local.

4. **"Does the structural drawing match the architectural?"** → Cross-reference text/dimensions between two files. Locally: compare extracted text and numbers. Full visual comparison: needs API.

5. **"What materials are specified?"** → IFC: property sets contain material specs. DXF: text search for material callouts. 100% local.

6. **"What changed between rev A and rev B?"** → Compare extracted text/entities between two versions. 90% local for data changes, needs API for visual changes.

### What you CANNOT do locally with CAD files:

- **Visual clash detection** (pipe going through a wall) — requires 3D geometry processing, very heavy
- **Reading hand-drawn markups on prints** — needs vision AI
- **Understanding P&ID flow diagrams** — symbols need vision AI to interpret, unless the file is DXF where symbols are named blocks
- **Comparing as-built photos to drawings** — full API territory

### Recommended approach for KLYPIX:

**For DXF files:** Parse directly with `dxf-parser`. Extract all text, layer names, block attributes, dimensions. Index everything. This covers 80% of what engineers ask.

**For DWG files:** Use `libredwg-web` (WASM) for direct parsing. If that fails, convert DWG → DXF via LibreOffice (limited support) or offer user the option to export as DXF from AutoCAD.

**For IFC/BIM files:** Use `web-ifc` npm. This is the jackpot — full building model with properties, materials, spatial relationships. More data than any other engineering format.

**For visual understanding:** Convert to image → lazy vision (analyze only when user asks about a specific drawing).

---

## IMPLEMENTATION PRIORITY FOR KLYPIX

### Phase 1 — Ship in 2 weeks (100% local, zero API cost)
- TXT, MD, JSON, XML, YAML, CSV
- DOCX (mammoth)
- XLSX (SheetJS) — including chart source data
- PPTX (unzip + XML parse) — including chart source data and speaker notes
- EML (mailparser)
- Code files (direct read)
- PDF digital text (pdf-parse)

### Phase 2 — Ship in 4 weeks (still mostly local)
- DXF (dxf-parser)
- DWG (libredwg-web WASM)
- IFC (web-ifc)
- EPUB (unzip + HTML parse)
- SQLite (better-sqlite3)
- ZIP/archive handling
- PDF form field extraction

### Phase 3 — Pro features (needs API for some)
- Scanned PDF OCR (tesseract.js local, Gemini upgrade)
- Image OCR and understanding
- Lazy vision for charts/diagrams
- Video subtitle extraction + metadata
- Audio metadata + tag indexing
- Structural intelligence layer (version tracking, contradiction detection)

### Phase 4 — Advanced engineering (niche market)
- IFC spatial queries and clash candidate detection
- Cross-drawing comparison (DXF vs DXF)
- P&ID symbol recognition (API-powered)
- Revit export integration guidance
