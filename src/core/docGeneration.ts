// ── Document & Image Generation — Intent Detection + Prompts ─────────────────
//
// Detects when a user is asking for document/image generation (not just a question),
// selects the right output format, and provides format-specific system prompts
// that instruct the AI to output structured JSON for file writers.

export type GenerationFormat = 'xlsx' | 'docx' | 'pptx' | 'pdf' | 'image' | 'md' | 'txt' | 'csv' | 'json' | 'code';

export interface GenerationIntent {
    isGeneration: boolean;
    format: GenerationFormat;
    ambiguous: boolean;          // True if format is unclear — show format picker
    possibleFormats: GenerationFormat[];
    confidence: number;          // 0-1 rough heuristic score
}

// ── Intent Detection (keyword heuristics, no API call) ───────────────────────

const FORMAT_SIGNALS: Record<string, { formats: GenerationFormat[]; weight: number }> = {
    // Strong signals — specific format mentioned
    'spreadsheet':   { formats: ['xlsx'], weight: 1.0 },
    'excel':         { formats: ['xlsx'], weight: 1.0 },
    'xlsx':          { formats: ['xlsx'], weight: 1.0 },
    'workbook':      { formats: ['xlsx'], weight: 1.0 },
    'presentation':  { formats: ['pptx'], weight: 1.0 },
    'powerpoint':    { formats: ['pptx'], weight: 1.0 },
    'pptx':          { formats: ['pptx'], weight: 1.0 },
    'slides':        { formats: ['pptx'], weight: 1.0 },
    'slide deck':    { formats: ['pptx'], weight: 1.0 },
    'word document':  { formats: ['docx'], weight: 1.0 },
    'word doc':      { formats: ['docx'], weight: 1.0 },
    'docx':          { formats: ['docx'], weight: 1.0 },
    'pdf':           { formats: ['pdf'], weight: 1.0 },
    'csv':           { formats: ['csv'], weight: 1.0 },
    'markdown':      { formats: ['md'], weight: 1.0 },
    'readme':        { formats: ['md'], weight: 0.9 },
    'json':          { formats: ['json'], weight: 0.9 },
    'diagram':       { formats: ['image'], weight: 0.9 },
    'chart':         { formats: ['image'], weight: 0.8 },
    'illustration':  { formats: ['image'], weight: 0.9 },
    'infographic':   { formats: ['image'], weight: 0.9 },
    'wireframe':     { formats: ['image'], weight: 0.8 },
    'mockup':        { formats: ['image'], weight: 0.8 },

    // Medium signals — action verbs that imply generation
    'create':        { formats: ['docx', 'xlsx', 'pptx', 'pdf'], weight: 0.6 },
    'generate':      { formats: ['docx', 'xlsx', 'pptx', 'pdf', 'image'], weight: 0.7 },
    'make':          { formats: ['docx', 'xlsx', 'pptx', 'image'], weight: 0.5 },
    'build':         { formats: ['xlsx', 'code'], weight: 0.5 },
    'draw':          { formats: ['image'], weight: 0.9 },
    'design':        { formats: ['image', 'pptx'], weight: 0.6 },
    'write':         { formats: ['docx', 'md', 'txt'], weight: 0.4 },
    'draft':         { formats: ['docx', 'md'], weight: 0.5 },

    // Content type signals
    'report':        { formats: ['docx', 'pdf'], weight: 0.6 },
    'letter':        { formats: ['docx', 'pdf'], weight: 0.7 },
    'resume':        { formats: ['docx', 'pdf'], weight: 0.8 },
    'cv':            { formats: ['docx', 'pdf'], weight: 0.8 },
    'invoice':       { formats: ['xlsx', 'pdf'], weight: 0.8 },
    'proposal':      { formats: ['docx', 'pdf'], weight: 0.6 },
    'contract':      { formats: ['docx', 'pdf'], weight: 0.6 },
    'table':         { formats: ['xlsx'], weight: 0.5 },
    'budget':        { formats: ['xlsx'], weight: 0.8 },
    'schedule':      { formats: ['xlsx'], weight: 0.6 },
    'timeline':      { formats: ['xlsx', 'pptx'], weight: 0.5 },
    'memo':          { formats: ['docx'], weight: 0.7 },
    'script':        { formats: ['code'], weight: 0.5 },
    'function':      { formats: ['code'], weight: 0.4 },
};

export function detectGenerationIntent(query: string): GenerationIntent {
    const lower = query.toLowerCase().trim();

    // Questions are NEVER generation requests — skip detection entirely
    // Layer 1: Expanded question word detection at start of sentence
    if (/^(what|where|who|when|why|how|is|are|was|were|will|would|can|could|should|shall|does|do|did|have|has|had|which|tell|explain|describe|show|find|check|list|identify|any)\b/.test(lower)) {
        return { isGeneration: false, format: 'txt', ambiguous: false, possibleFormats: [], confidence: 0 };
    }
    // Layer 2: Question mark at end → likely a question, not a generation command
    if (lower.endsWith('?')) {
        return { isGeneration: false, format: 'txt', ambiguous: false, possibleFormats: [], confidence: 0 };
    }
    // Layer 3: Content inquiry verbs → asking about content, not generating it
    if (/\b(mentioned|mentioned in|found in|included|included in|listed|contains|appear|exist|reference)\b/.test(lower)) {
        return { isGeneration: false, format: 'txt', ambiguous: false, possibleFormats: [], confidence: 0 };
    }

    const matched: { format: GenerationFormat; weight: number }[] = [];

    // Check each signal against the query
    for (const [keyword, { formats, weight }] of Object.entries(FORMAT_SIGNALS)) {
        if (lower.includes(keyword)) {
            for (const fmt of formats) {
                const existing = matched.find(m => m.format === fmt);
                if (existing) {
                    existing.weight = Math.max(existing.weight, weight);
                } else {
                    matched.push({ format: fmt, weight });
                }
            }
        }
    }

    if (matched.length === 0) {
        return { isGeneration: false, format: 'txt', ambiguous: false, possibleFormats: [], confidence: 0 };
    }

    // Sort by weight
    matched.sort((a, b) => b.weight - a.weight);
    const topWeight = matched[0].weight;

    // If the top match is strong (>= 0.8), we're confident
    if (topWeight >= 0.8) {
        return {
            isGeneration: true,
            format: matched[0].format,
            ambiguous: false,
            possibleFormats: matched.map(m => m.format),
            confidence: topWeight,
        };
    }

    // If multiple formats with similar weight, it's ambiguous — show picker
    const topFormats = matched.filter(m => m.weight >= topWeight - 0.2).map(m => m.format);
    const uniqueFormats = [...new Set(topFormats)];

    if (uniqueFormats.length > 1) {
        return {
            isGeneration: true,
            format: uniqueFormats[0],
            ambiguous: true,
            possibleFormats: uniqueFormats,
            confidence: topWeight,
        };
    }

    return {
        isGeneration: true,
        format: matched[0].format,
        ambiguous: false,
        possibleFormats: [matched[0].format],
        confidence: topWeight,
    };
}

// ── Format-Specific Generation Prompts ───────────────────────────────────────
// These instruct the AI to output structured JSON that file writers can parse.

export const GENERATION_PROMPTS: Record<string, string> = {

xlsx: `You are a spreadsheet generation assistant. The user wants an Excel file.

OUTPUT FORMAT (strict JSON, no markdown wrapping, no code fences):
{
  "filename": "suggested_filename.xlsx",
  "sheets": [
    {
      "name": "Sheet1",
      "columns": [
        { "header": "Column Name", "width": 15 }
      ],
      "rows": [
        ["value1", "value2", 123, "=SUM(B2:B10)"]
      ]
    }
  ]
}

RULES:
- Use real Excel formulas (=SUM, =AVERAGE, =IF, =VLOOKUP, etc.)
- Include column widths appropriate to the content
- Use multiple sheets if the data is logically separable
- Include a Totals/Summary row where appropriate
- Currency values should be numbers, not strings with $ signs
- Respond ONLY with the JSON object, nothing else`,

docx: `You are a document generation assistant. The user wants a Word document.

OUTPUT FORMAT (strict JSON, no markdown wrapping, no code fences):
{
  "filename": "suggested_filename.docx",
  "metadata": {
    "title": "Document Title",
    "author": "Klypix"
  },
  "sections": [
    { "type": "heading1", "text": "Main Heading" },
    { "type": "paragraph", "text": "Body text here. Use **bold** and *italic* markers." },
    { "type": "heading2", "text": "Sub Heading" },
    { "type": "bullet_list", "items": ["Point one", "Point two"] },
    { "type": "numbered_list", "items": ["Step one", "Step two"] },
    { "type": "table", "headers": ["Col A", "Col B"], "rows": [["val1", "val2"]] },
    { "type": "page_break" }
  ]
}

RULES:
- Use heading1 for main sections, heading2 for subsections
- Tables must have headers
- Keep paragraphs focused — one idea per paragraph
- Include page breaks between major sections for documents > 2 pages
- Use professional tone unless the user specifies otherwise
- Respond ONLY with the JSON object, nothing else`,

pptx: `You are a presentation generation assistant. The user wants a PowerPoint file.

OUTPUT FORMAT (strict JSON, no markdown wrapping, no code fences):
{
  "filename": "suggested_filename.pptx",
  "slides": [
    {
      "layout": "title",
      "title": "Presentation Title",
      "subtitle": "Author or date"
    },
    {
      "layout": "content",
      "title": "Slide Title",
      "bullets": ["Key point one", "Key point two"],
      "notes": "Speaker notes — full sentences with details"
    },
    {
      "layout": "two-column",
      "title": "Comparison",
      "left": { "header": "Option A", "bullets": ["Point 1"] },
      "right": { "header": "Option B", "bullets": ["Point 1"] }
    },
    {
      "layout": "table",
      "title": "Data Overview",
      "headers": ["Metric", "Q1", "Q2"],
      "rows": [["Revenue", "1.2M", "1.5M"]]
    },
    {
      "layout": "closing",
      "title": "Thank You",
      "subtitle": "Contact info or next steps"
    }
  ]
}

RULES:
- Maximum 6 bullets per slide
- Maximum 7 words per bullet
- Every slide must have speaker notes
- Include a title slide and closing slide
- 8-15 slides for a standard presentation
- Respond ONLY with the JSON object, nothing else`,

pdf: `You are a document assistant. The user wants a PDF document.

Generate the content in clean markdown. The app will render it into a styled PDF.

Use:
- # for main headings (become PDF section headers)
- ## for subheadings
- ### for sub-subheadings
- Tables in markdown format
- **Bold** for emphasis
- Bullet lists and numbered lists
- No HTML tags
- No code fences wrapping the entire output

Start with a # title, then the content. Write professional, well-structured content.`,

image: `You are an image generation assistant. Generate the image the user is describing.

Produce a high-quality, detailed image based on the user's description. If the user asks for a diagram, chart, or technical illustration, make it clear and readable.`,

md: `Generate the content in clean markdown format. Start immediately with the content — no code fences, no "here is the file" preamble. The output will be saved directly as a .md file.`,

txt: `Generate the content as plain text. No markdown formatting. Start immediately with the content. The output will be saved directly as a .txt file.`,

csv: `Generate the content as CSV (comma-separated values). First row is the header. No markdown, no code fences, no explanation. Start immediately with the CSV data. The output will be saved directly as a .csv file.`,

json: `Generate the content as valid JSON. No markdown, no code fences, no explanation. Start immediately with the JSON. The output will be saved directly as a .json file.`,

code: `Generate the code file the user is requesting. No markdown, no code fences, no explanation. Start immediately with the code content. The output will be saved directly as a source file.`,

};

// ── Context enforcement prefix — prepended when documents are provided ──────
export const CONTEXT_ENFORCEMENT_PREFIX = `
=== ABSOLUTE REQUIREMENT — READ THIS BEFORE GENERATING ANYTHING ===

You have been given SPECIFIC DOCUMENTS with real content. Your ENTIRE output must be derived FROM and ABOUT those specific documents.

FAILURE CONDITIONS (if ANY of these are true, your output is WRONG):
❌ Output contains generic categories not mentioned in the documents (e.g., "Operational Risks", "Financial Risks" when the document is a certificate)
❌ Output could apply to ANY document (i.e., it's a template)
❌ Output does not mention specific names, dates, or facts from the provided documents
❌ Output title is generic (e.g., "Risk Assessment Report" instead of "Risk Assessment — [specific document subject]")
❌ Any section lacks a direct reference to content in the provided documents

SUCCESS CONDITIONS (ALL must be true):
✅ The document title includes the specific subject from the provided documents
✅ Every paragraph references specific facts, names, dates, or numbers from the documents
✅ The analysis is ONLY about what is in these documents — nothing else
✅ A reader who knows the document would recognize that this output is specifically about THEIR document
✅ The filename includes the document subject (e.g., "Risk_Assessment_Shaima_Khader_SCFHS.pdf")

EXAMPLE OF WHAT TO DO:
If the user provides an SCFHS registration certificate for "Shaima Khader, Pharmacist, expiring 26/06/2026" and asks for a risk assessment, you MUST produce:
- Title: "Risk Assessment — Shaima Khader SCFHS Registration"
- Risks specific to THIS certificate: registration expiry date, qualification scope, practicing status
- NOT generic risk categories like "Operational Risks" or "Financial Risks"

IF THE PROVIDED CONTENT IS TOO SHORT OR UNCLEAR TO GENERATE A MEANINGFUL DOCUMENT:
Respond with ONLY: "# Insufficient Content\\n\\nThe provided document does not contain enough information to generate a meaningful [document type]. Please provide more detailed source material."

DO NOT FALL BACK TO GENERIC TEMPLATES. EVER.

=== END ABSOLUTE REQUIREMENT ===

`;

// Build the final doc generation prompt with context enforcement
const NO_HALLUCINATION_GUARD = `
CRITICAL: Only include data that is EXPLICITLY VISIBLE in the provided content.
- Do NOT invent, assume, or fill in data based on filenames, titles, or guesses.
- If you can see a filename like "CV.pdf" but NOT the actual CV content, you must NOT generate fake CV details.
- NEVER fabricate names, dates, roles, organizations, or any factual data.
- If there is not enough visible data to generate the requested document, say so instead of hallucinating.

`;

const SCREENSHOT_HALLUCINATION_GUARD = `SCREENSHOT MODE: Include ONLY items you can literally see in the image. Do NOT add items from common knowledge. Count visible items first, output exactly that many. Fewer correct rows is better than extra hallucinated ones. Output the required format immediately — no explanation.

`;

export function buildDocGenPrompt(formatPrompt: string, hasContext: boolean, isScreenshot = false): string {
    if (hasContext) {
        return CONTEXT_ENFORCEMENT_PREFIX + formatPrompt;
    }
    if (isScreenshot) {
        return SCREENSHOT_HALLUCINATION_GUARD + formatPrompt;
    }
    return NO_HALLUCINATION_GUARD + formatPrompt;
}

// ── Format Display Names ─────────────────────────────────────────────────────

export const FORMAT_LABELS: Record<GenerationFormat, string> = {
    xlsx: 'Excel (.xlsx)',
    docx: 'Word (.docx)',
    pptx: 'PowerPoint (.pptx)',
    pdf: 'PDF',
    image: 'Image',
    md: 'Markdown (.md)',
    txt: 'Text (.txt)',
    csv: 'CSV (.csv)',
    json: 'JSON (.json)',
    code: 'Code File',
};

export const FORMAT_EXTENSIONS: Record<GenerationFormat, string> = {
    xlsx: 'xlsx',
    docx: 'docx',
    pptx: 'pptx',
    pdf: 'pdf',
    image: 'png',
    md: 'md',
    txt: 'txt',
    csv: 'csv',
    json: 'json',
    code: 'txt',
};

// ── Check if a format needs structured JSON parsing vs raw text ──────────────

export function isStructuredFormat(format: GenerationFormat): boolean {
    return ['xlsx', 'docx', 'pptx'].includes(format);
}
