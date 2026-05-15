# ⚠️ SUPERSEDED — see CLAUDE.md

# KLYPIX Knowledge Base — Mixed Content File Handling

## The Real Problem

Users don't have "text files" and "image files." They have:
- A PDF report with 30 pages of text, 12 charts, 5 photos, 8 tables, and 2 CAD drawings embedded
- A DOCX proposal with Excel charts pasted in, screenshots, and OLE-embedded spreadsheets
- A PPTX deck with video clips, audio narration, data tables, and SmartArt diagrams
- An email with a PDF attachment that itself contains scanned images of hand-signed contracts

Every file needs a **content decomposition pipeline** — break it into its parts, handle each part with the right tool.

---

## MIXED CONTENT MAP: What's Actually Inside Each File

### 📄 PDF — The Worst Offender
A single PDF can contain ALL of these simultaneously:

| Content Type | How It's Stored | Local Extraction | API Needed? |
|---|---|---|---|
| Body text | Text layer with positions | ✅ pdf-parse | No |
| Headers/footers | Text at page margins | ✅ pdf-parse (but mixed with body text, no separation flag) | No |
| Tables | Text positioned in grid pattern — NO table structure metadata | ⚠️ Text comes out as jumbled lines. Need heuristics to reconstruct grid | For complex tables, yes |
| Charts/graphs | Embedded as vector paths OR raster images | ❌ Paths are raw coordinates, meaningless without rendering | Yes — lazy vision |
| Photos | Embedded raster images (JPEG/PNG inside PDF) | ✅ Can extract raw image bytes with pdfjs-dist | Understanding needs API |
| Scanned pages | Full-page raster image, NO text layer | ❌ Looks like text but is pixels | Yes — OCR or vision |
| Form fields | AcroForm or XFA data | ✅ pdf-lib reads field names + values | No |
| Annotations | Sticky notes, highlights, stamps | ✅ pdfjs-dist extracts annotation data | No |
| Digital signatures | Certificate + signature field | ✅ Can detect presence and signer name | No |
| Embedded files | Attachments inside the PDF | ✅ Extractable with pdfjs-dist | Depends on attached file type |
| Bookmarks/TOC | Outline tree | ✅ pdfjs-dist reads outline | No |
| Watermarks | Usually text or image behind content | ⚠️ Comes out mixed with regular text | No but noisy |
| CAD drawings | Sometimes embedded as vector or image | ❌ Vector paths are meaningless numbers | Yes — vision |
| Hyperlinks | URL annotations on text | ✅ Extractable | No |

**The critical detection problem:** A PDF page might be:
- 100% digital text (easy)
- 100% scanned image (needs OCR)
- MIXED — some text is digital, some is a scanned stamp or signature image overlaid

**Detection strategy for KLYPIX:**
```
For each page in PDF:
  1. Extract text with pdf-parse
  2. Render page as image with pdfjs-dist
  3. Calculate text_density = text_chars / page_area
  
  If text_density > threshold:
    → Text-rich page. Index extracted text.
    → Still tag embedded images for lazy vision later.
  
  If text_density < threshold AND page has content:
    → Likely scanned or image-heavy page.
    → Run local OCR (tesseract.js) for basic text.
    → Tag for lazy vision if user queries this page.
  
  If text_density == 0:
    → Pure image page. Must use OCR or vision.
```

**Handling PDF tables specifically:**
- `pdf-parse` gives text in reading order but table cells come out scrambled
- Strategy: detect table regions by looking for aligned text coordinates
- `pdf-table-extractor` npm attempts this — works ~60% of the time
- For critical table extraction: render page as image → Gemini Vision → structured output
- BEST approach: if the PDF was generated from Excel/Word, the original file has better table data. KLYPIX should prompt: "I found tables that are hard to read from this PDF. Do you have the original Excel/Word file?"

---

### 📝 DOCX — Hidden Complexity

A Word document can contain:

| Content Type | How It's Stored | Local Extraction | API Needed? |
|---|---|---|---|
| Body text | XML `<w:t>` elements | ✅ mammoth or unzip + parse | No |
| Tables | XML `<w:tbl>` with rows/cells | ✅ mammoth outputs HTML tables, fully structured | No |
| Inline images | Files in `word/media/` folder, referenced by XML | ✅ Extract image files. Understanding needs API | Understanding only |
| Embedded Excel chart | OLE object or drawingML chart with data in `word/charts/chart*.xml` | ✅ Chart SOURCE DATA is in XML — actual numbers! | No for data, yes for visual |
| SmartArt | Complex XML in `word/diagrams/` | ⚠️ Text extractable from `data*.xml`, but layout/meaning is lost | Yes for visual understanding |
| Equations | OMML (Office Math Markup Language) in XML | ✅ Parseable — can convert to LaTeX or text representation | No |
| Text boxes | DrawingML or VML shapes with text | ⚠️ mammoth may miss these. Need direct XML parsing of `<wps:txbx>` | No but requires careful parsing |
| Tracked changes | `<w:ins>` and `<w:del>` elements | ✅ Full history: who changed what, when | No |
| Comments | `word/comments.xml` linked to text ranges | ✅ Comment text, author, date, and which text they refer to | No |
| Headers/footers | Separate XML files `header*.xml`, `footer*.xml` | ✅ Fully parseable | No |
| Footnotes/endnotes | `word/footnotes.xml`, `word/endnotes.xml` | ✅ Fully parseable | No |
| Hyperlinks | Relationship references in XML | ✅ URL + display text | No |
| Embedded OLE objects | Binary blobs in `word/embeddings/` | ⚠️ Can detect type (Excel, Visio, etc.) but extraction is format-specific | Depends on embedded format |
| Macros (.docm) | VBA code in `word/vbaProject.bin` | ⚠️ Can detect presence. Reading VBA from binary is complex | No for detection |
| Drawing canvas | Shapes, lines, arrows in VML or DrawingML | ⚠️ Position/shape data extractable, meaning is not | Yes for understanding |

**The OLE embed problem:**
A DOCX can have an Excel spreadsheet embedded inside it. When you unzip the DOCX, you'll find a file like `word/embeddings/oleObject1.bin` or `Microsoft_Excel_Worksheet1.xlsx`. If it's .xlsx, you can process it with SheetJS. If it's an OLE binary, it's harder — need `ole-doc` npm to crack it open.

**KLYPIX strategy for DOCX:**
```
1. mammoth → get main text + HTML tables (covers 80%)
2. Unzip the .docx
3. Check word/charts/ → parse chart XML for source data
4. Check word/media/ → catalog all images, tag for lazy vision
5. Check word/embeddings/ → identify embedded file types
   - If .xlsx → process with SheetJS
   - If .pptx → process with PPTX parser  
   - If OLE binary → extract what we can, tag rest for API
6. Check word/comments.xml → index all comments
7. Check word/diagrams/ → extract SmartArt text
8. Parse headers/footers for document identification info
```

---

### 📊 XLSX — Surprisingly Complex

An Excel file can contain:

| Content Type | How It's Stored | Local Extraction | API Needed? |
|---|---|---|---|
| Cell data (text/numbers) | XML in `xl/worksheets/sheet*.xml` | ✅ SheetJS — complete extraction | No |
| Formulas | Formula strings in cell XML | ✅ SheetJS reads formula text | No |
| Charts | XML in `xl/charts/chart*.xml` with cell range references | ✅ Parse chart XML to get: chart type, data range, axis labels, series names, actual values | No for data! |
| Pivot tables | XML in `xl/pivotTables/` with cache in `xl/pivotCache/` | ✅ SheetJS can read pivot cache (the raw data). Source data fully accessible | No |
| Images | Files in `xl/media/` | ✅ Extract files. Understanding needs API | Understanding only |
| Comments/notes | XML in `xl/comments*.xml` | ✅ SheetJS reads comments with cell reference | No |
| Conditional formatting | Rules in sheet XML | ⚠️ Rules parseable but visual result requires rendering | No for rules, yes for visual |
| Data validation (dropdowns) | XML in sheet | ✅ SheetJS reads validation rules, allowed values | No |
| Named ranges | XML in `xl/workbook.xml` | ✅ SheetJS reads named ranges | No |
| Sparklines | XML in sheet | ⚠️ Cell ranges extractable, visual needs rendering | Visual only |
| Slicers | XML with pivot/table connections | ⚠️ Connection data readable | No for data |
| Power Query | Binary blob in `xl/customData/` | ❌ Proprietary binary M language | Yes or manual |
| VBA macros (.xlsm) | Binary in `xl/vbaProject.bin` | ⚠️ Can detect. Reading VBA binary is complex | Extraction is hard |
| External data connections | XML in `xl/connections.xml` | ✅ Connection strings, query text readable | No |
| Threaded comments | XML in `xl/threadedComments/` | ✅ Full conversation threads | No |

**The chart data extraction in detail:**
This is KLYPIX's secret weapon. Here's what's actually in the chart XML:
```xml
<!-- Inside xl/charts/chart1.xml -->
<c:ser>
  <c:tx><c:strRef><c:f>Sheet1!$B$1</c:f></c:strRef></c:tx>  <!-- Series name: "Revenue" -->
  <c:cat>  <!-- Category axis: Q1, Q2, Q3, Q4 -->
    <c:strRef><c:f>Sheet1!$A$2:$A$5</c:f></c:strRef>
  </c:cat>
  <c:val>  <!-- Actual values: 100, 150, 120, 200 -->
    <c:numRef><c:f>Sheet1!$B$2:$B$5</c:f></c:numRef>
  </c:val>
</c:ser>
```
You don't need to SEE the chart. You can read: "Bar chart showing Revenue by quarter: Q1=100, Q2=150, Q3=120, Q4=200." 100% local. 100% accurate. Better than any vision model.

---

### 📽️ PPTX — The Media Monster

A PowerPoint file can contain:

| Content Type | How It's Stored | Local Extraction | API Needed? |
|---|---|---|---|
| Slide text | XML `<a:t>` in `ppt/slides/slide*.xml` | ✅ Parse XML | No |
| Speaker notes | XML in `ppt/notesSlides/notesSlide*.xml` | ✅ Parse XML — often MORE valuable than slide text | No |
| Tables | XML `<a:tbl>` in slide XML | ✅ Rows and cells fully structured | No |
| Charts | XML in `ppt/charts/chart*.xml` with embedded data | ✅ Same as Excel charts — full source data in XML! | No for data |
| Images | Files in `ppt/media/` | ✅ Extract files | Understanding needs API |
| Embedded videos | Files in `ppt/media/` (mp4, wmv) | ✅ Can extract video files. Metadata with ffprobe | Transcription needs API |
| Embedded audio | Files in `ppt/media/` (mp3, wav) | ✅ Extract + metadata | Transcription needs API |
| SmartArt | Complex XML in `ppt/diagrams/` | ⚠️ Text extractable from data XML, layout lost | Visual understanding needs API |
| Animations/transitions | XML attributes on elements | ⚠️ Can detect presence, not visually meaningful for indexing | Not useful for indexing |
| Hyperlinks | Relationship references | ✅ URL + target slide | No |
| Embedded Excel | OLE objects in `ppt/embeddings/` | ✅ If .xlsx format, process with SheetJS | No |
| Comments | XML in `ppt/comments/` | ✅ Author, date, text, slide reference | No |
| Slide masters/layouts | XML templates | ⚠️ Contain placeholder text and branding | No |
| Grouped shapes | Nested shape containers | ⚠️ Text extractable but grouping logic complex | No for text |
| 3D models | GLB/OBJ in media folder | ⚠️ Can detect presence, extraction is specialized | Yes |

**PPTX mixed content strategy:**
```
For each slide:
  1. Extract all text elements (titles, body, text boxes)
  2. Extract speaker notes (often the real content)
  3. Check for charts → parse chart XML for data
  4. Check for tables → parse table XML for structured data
  5. Catalog images → tag for lazy vision
  6. Check for embedded objects → process by type
  7. Index with slide number for precise retrieval
```

---

### 📧 EML — The Recursive Problem

An email can contain:

| Content Type | How It's Stored | Local Extraction | API Needed? |
|---|---|---|---|
| Headers | RFC 822 text headers | ✅ mailparser | No |
| Plain text body | text/plain MIME part | ✅ mailparser | No |
| HTML body | text/html MIME part | ✅ mailparser + strip HTML tags for text | No |
| Inline images | Content-ID referenced images in multipart/related | ✅ Extract as files | Understanding needs API |
| File attachments | MIME parts with Content-Disposition: attachment | ✅ Extract as files → THEN process each by its type | Depends on attachment type |
| Embedded emails (.eml) | message/rfc822 MIME part (forwarded messages) | ✅ Recursive: parse the inner .eml with mailparser again | No |
| Calendar invites | text/calendar (ICS) part | ✅ Parse with `ical.js` npm — event details, attendees, time | No |
| vCard contacts | text/vcard part | ✅ Parse for name, email, phone | No |
| Digital signatures (S/MIME) | application/pkcs7-signature | ⚠️ Can detect signed status. Verification needs crypto libs | No for detection |
| Encrypted body (S/MIME) | application/pkcs7-mime | ❌ Cannot read without private key | Impossible without key |

**The recursive attachment problem:**
An email has a .zip attachment → inside the zip is a .docx → inside the docx is an embedded .xlsx with charts → inside the charts is the actual revenue data.

**KLYPIX strategy — recursive content extraction:**
```
function processFile(file, depth = 0):
  if depth > 5: return  // prevent infinite recursion
  
  switch file.type:
    case 'eml':
      extract headers, body text
      for each attachment:
        processFile(attachment, depth + 1)
    
    case 'zip':
      extract all files
      for each contained file:
        processFile(containedFile, depth + 1)
    
    case 'docx':
      extract text, tables, comments
      unzip and check for:
        - word/charts/ → extract chart data
        - word/media/ → catalog images
        - word/embeddings/ → processFile(embedded, depth + 1)
    
    case 'xlsx':
      extract cell data, formulas
      unzip and check for:
        - xl/charts/ → extract chart source data
        - xl/media/ → catalog images
    
    case 'pptx':
      extract slide text, notes, tables
      unzip and check for:
        - ppt/charts/ → extract chart data
        - ppt/media/ → catalog images + videos
        - ppt/embeddings/ → processFile(embedded, depth + 1)
    
    case 'pdf':
      extract text
      detect text_density per page
      catalog embedded images
      extract form field values
      extract annotations
    
    case image:
      extract EXIF metadata
      run local OCR if text likely
      tag for lazy vision
    
    case text/code/json/xml/yaml/csv:
      read directly
```

---

## CONTENT TYPE DETECTION

KLYPIX should NOT rely only on file extension. A .pdf might be a scanned image. A .xlsx might be mostly charts. Detection strategy:

### File-Level Detection
```
1. Check magic bytes (file header) to confirm actual format
   - PDF: starts with %PDF
   - ZIP-based (docx/xlsx/pptx): starts with PK
   - Plain text: no binary bytes in first 1024 chars
   
2. For ZIP-based Office files, check [Content_Types].xml to confirm type
   - word/document.xml → DOCX
   - xl/workbook.xml → XLSX
   - ppt/presentation.xml → PPTX
```

### Page-Level Detection (for PDFs)
```
For each page:
  text = extractText(page)
  image_count = countEmbeddedImages(page)
  text_density = text.length / expectedCharsPerPage
  
  Classify as:
  - TEXT_RICH: density > 0.5, few images
  - IMAGE_HEAVY: density < 0.2, images present
  - MIXED: both text and images significant
  - SCANNED: density == 0, full-page image
  - FORM: form fields detected
  - BLANK: nothing
```

### Content Richness Score
For each indexed file, KLYPIX should store a richness profile:
```json
{
  "file": "Q4_Report.pdf",
  "pages": 45,
  "content_profile": {
    "text_pages": 28,
    "chart_pages": 8,
    "table_pages": 12,
    "image_pages": 5,
    "scanned_pages": 0,
    "form_pages": 2
  },
  "extraction_coverage": {
    "text_indexed": "100%",
    "charts_data_extracted": "3 of 8 (source data found for Excel-generated charts)",
    "charts_need_vision": "5 of 8 (vector graphics, no source data)",
    "tables_extracted": "8 of 12 (clean structure)",
    "tables_need_vision": "4 of 12 (complex merged cells)",
    "images_cataloged": 15,
    "images_ocr_done": 3,
    "images_need_vision": 12
  },
  "confidence": "72% — full text indexed, some visual content pending"
}
```

This tells the user: "I've read 72% of this document. Some charts and images need Pro mode for full understanding."

---

## THE UNIFIED CONTENT INDEX

After decomposition, ALL content goes into one unified index regardless of source:

```
Content Chunk:
  - id: unique
  - source_file: "Q4_Report.pdf"
  - source_location: "page 12" or "slide 5" or "sheet 'Revenue', cells A1:D20"
  - content_type: text | table | chart_data | image_description | form_data | comment | annotation
  - text: the actual searchable content
  - embedding: vector for similarity search
  - extracted_entities: dates, numbers, names, references
  - extraction_method: local_text | local_chart_xml | local_ocr | api_vision | api_gemini
  - confidence: 0.0 to 1.0
  - needs_vision: boolean (flagged for lazy vision upgrade)
  - parent_chunks: [ids of related chunks in same document]
  - cross_references: [ids of chunks in OTHER documents that reference same entities]
```

This unified structure means a user asking "what was Q4 revenue?" will find answers whether the number is in a PDF paragraph, an Excel cell, a PowerPoint chart, a Word table, or an email body — all searched the same way.
