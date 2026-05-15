/**
 * Rule-based task decomposition engine + intent classifier.
 * Provides reliable plan generation when the model can't produce valid JSON plans.
 * Critical fallback for Gemini Flash and GLM-4.x models.
 *
 * Two-layer approach:
 *   Layer 1 (Option B): Cheap LLM call to classify intent into a category
 *   Layer 2 (Option A): 20 pattern templates matched against raw + classified prompt
 *
 * Template ordering is CRITICAL — specific patterns MUST come before greedy ones.
 * The old ordering had Template 4 (create/make) catching everything before
 * Template 7 (cross-app) could match. Now specific multi-part patterns run first.
 *
 * Categories (20 templates + generic fallback):
 *  1.  Cross-app: extract from X → create Y         (SPECIFIC — must be before create)
 *  2.  Find/search N items → create Y                (SPECIFIC — multi-part)
 *  3.  Read/analyze X → do Y                         (SPECIFIC — multi-part)
 *  4.  Compare/diff X and Y                          (SPECIFIC — multi-part)
 *  5.  Download/save from URL                        (SPECIFIC — multi-part)
 *  6.  Merge/combine/consolidate files               (NEW)
 *  7.  Move/copy/put files somewhere                 (NEW)
 *  8.  Rename files                                  (NEW)
 *  9.  Delete/remove/cleanup files                   (NEW)
 *  10. Archive: zip/unzip/compress/backup            (NEW)
 *  11. Organize/sort/clean up files                  (EXISTING — widened keywords)
 *  12. Convert file to format                        (EXISTING)
 *  13. Transform single file (summarize/translate)   (NEW)
 *  14. Resize/crop/edit image                        (NEW)
 *  15. Query/list/inspect folder                     (NEW)
 *  16. Find/search files (no creation)               (NEW)
 *  17. Open/launch/run something                     (NEW)
 *  18. Send/share/email something                    (NEW)
 *  19. Create/make/write something                   (EXISTING — now LAST among action templates)
 *  20. Simple question (should not be agent task)    (NEW — returns minimal plan)
 *  Generic fallback                                   (improved — always assigns tools)
 */

import type { ExecutionPlan, PlanStep, SuccessCriterion } from './types';

// ── Intent categories for the classifier (Option B) ─────────────────

export type IntentCategory =
  | 'merge_files'      // consolidate, merge, combine, join PDFs/docs
  | 'move_files'       // move, copy, put, relocate files
  | 'rename_files'     // rename, batch rename
  | 'delete_files'     // delete, remove, clean old files
  | 'archive_files'    // zip, unzip, compress, backup
  | 'organize_files'   // sort, categorize, declutter
  | 'create_doc'       // write, create, draft, compose
  | 'convert_file'     // convert, transform, export format
  | 'search_files'     // find files matching criteria
  | 'search_and_create' // research + create output
  | 'read_and_act'     // read/analyze then do something
  | 'compare'          // diff, compare two things
  | 'download'         // download, save from URL
  | 'cross_app'        // extract from app X → create in format Y
  | 'transform_file'   // summarize, translate, fix grammar (single file)
  | 'edit_image'       // resize, crop, compress image
  | 'query_folder'     // list, count, show, what's in folder
  | 'open_launch'      // open, launch, run app/file
  | 'send_share'       // send, email, share
  | 'question'         // just asking a question, not an action
  | 'unknown';         // classifier unsure → try regex then generic

/**
 * Build the tiny classifier prompt for Option B.
 * ~30 tokens in, ~5 tokens out. Costs essentially nothing.
 */
export function buildClassifierPrompt(userPrompt: string): string {
  return `Classify this user request into exactly ONE category. Reply with ONLY the category name, nothing else.

Categories: merge_files, move_files, rename_files, delete_files, archive_files, organize_files, create_doc, convert_file, search_files, search_and_create, read_and_act, compare, download, cross_app, transform_file, edit_image, query_folder, open_launch, send_share, question

Input: "${userPrompt}"
Category:`;
}

/**
 * Parse the classifier response into a valid IntentCategory.
 */
export function parseClassifierResponse(response: string): IntentCategory {
  const cleaned = response.trim().toLowerCase().replace(/[^a-z_]/g, '');
  const valid: IntentCategory[] = [
    'merge_files', 'move_files', 'rename_files', 'delete_files', 'archive_files',
    'organize_files', 'create_doc', 'convert_file', 'search_files', 'search_and_create',
    'read_and_act', 'compare', 'download', 'cross_app', 'transform_file',
    'edit_image', 'query_folder', 'open_launch', 'send_share', 'question',
  ];
  return valid.includes(cleaned as IntentCategory) ? (cleaned as IntentCategory) : 'unknown';
}

/**
 * Generate a plan directly from a classified intent category.
 * This bypasses regex matching entirely — the classifier already did the understanding.
 * Returns null if category is 'unknown' (falls through to regex matching).
 */
export function planFromIntent(category: IntentCategory, prompt: string): ExecutionPlan | null {
  switch (category) {
    case 'merge_files':
      return CATEGORY_PLANS.merge_files(prompt);
    case 'move_files':
      return CATEGORY_PLANS.move_files(prompt);
    case 'rename_files':
      return CATEGORY_PLANS.rename_files(prompt);
    case 'delete_files':
      return CATEGORY_PLANS.delete_files(prompt);
    case 'archive_files':
      return CATEGORY_PLANS.archive_files(prompt);
    case 'organize_files':
      return CATEGORY_PLANS.organize_files(prompt);
    case 'create_doc':
      return CATEGORY_PLANS.create_doc(prompt);
    case 'convert_file':
      return CATEGORY_PLANS.convert_file(prompt);
    case 'search_files':
      return CATEGORY_PLANS.search_files(prompt);
    case 'search_and_create':
      return CATEGORY_PLANS.search_and_create(prompt);
    case 'read_and_act':
      return CATEGORY_PLANS.read_and_act(prompt);
    case 'compare':
      return CATEGORY_PLANS.compare(prompt);
    case 'download':
      return CATEGORY_PLANS.download(prompt);
    case 'cross_app':
      return CATEGORY_PLANS.cross_app(prompt);
    case 'transform_file':
      return CATEGORY_PLANS.transform_file(prompt);
    case 'edit_image':
      return CATEGORY_PLANS.edit_image(prompt);
    case 'query_folder':
      return CATEGORY_PLANS.query_folder(prompt);
    case 'open_launch':
      return CATEGORY_PLANS.open_launch(prompt);
    case 'send_share':
      return CATEGORY_PLANS.send_share(prompt);
    case 'question':
      return CATEGORY_PLANS.question(prompt);
    default:
      return null; // 'unknown' → fall through to regex
  }
}

// ── Helpers ──────────────────────────────────────────────────────────

interface PlanTemplate {
  pattern: RegExp;
  generate: (match: RegExpMatchArray, prompt: string) => ExecutionPlan;
}

function step(
  id: number,
  action: string,
  tools: string[],
  depends: number[],
  maxRetries = 1,
): PlanStep {
  return { id, action, tools, depends, status: 'pending', retries: 0, maxRetries };
}

// ── Category-based plan generators (used by classifier, Option B) ───

const CATEGORY_PLANS = {
  merge_files: (prompt: string): ExecutionPlan => ({
    goal: prompt,
    steps: [
      step(1, 'Get the active window to find the current folder', ['get_active_window'], []),
      step(2, 'List files in the folder to find all matching files', ['list_directory', 'run_shell'], [1]),
      step(3, `Merge/combine the files as requested: ${prompt}`, ['run_shell', 'write_file', 'read_file', 'generate_document'], [2], 2),
      step(4, 'Verify the merged output file exists and has content', ['list_directory', 'read_file'], [3], 1),
    ],
    successCriteria: [
      { type: 'file_exists', description: 'Merged output file was created', check: {}, met: false },
    ],
    estimatedTurns: 8,
  }),

  move_files: (prompt: string): ExecutionPlan => ({
    goal: prompt,
    steps: [
      step(1, 'List the source directory to find files to move', ['list_directory', 'get_active_window'], []),
      step(2, 'Create destination folder if needed', ['run_shell'], [1]),
      step(3, `Move/copy files as requested: ${prompt}`, ['file_move', 'run_shell'], [2], 2),
      step(4, 'Verify files are in the destination', ['list_directory'], [3], 1),
    ],
    successCriteria: [
      { type: 'custom', description: 'Files moved to destination', check: {}, met: false },
    ],
    estimatedTurns: 8,
  }),

  rename_files: (prompt: string): ExecutionPlan => ({
    goal: prompt,
    steps: [
      step(1, 'List files to be renamed', ['list_directory', 'get_active_window'], []),
      step(2, `Rename files as requested: ${prompt}`, ['run_shell', 'file_move'], [1], 2),
      step(3, 'Verify renamed files', ['list_directory'], [2], 1),
    ],
    successCriteria: [
      { type: 'custom', description: 'Files were renamed', check: {}, met: false },
    ],
    estimatedTurns: 6,
  }),

  delete_files: (prompt: string): ExecutionPlan => ({
    goal: prompt,
    steps: [
      step(1, 'List files to identify which ones to delete', ['list_directory', 'get_active_window'], []),
      step(2, `Identify files matching deletion criteria: ${prompt}`, ['run_shell'], [1]),
      step(3, 'Delete the identified files', ['file_delete', 'run_shell'], [2], 1),
      step(4, 'Verify files were deleted', ['list_directory'], [3], 1),
    ],
    successCriteria: [
      { type: 'custom', description: 'Matching files were deleted', check: {}, met: false },
    ],
    estimatedTurns: 8,
  }),

  archive_files: (prompt: string): ExecutionPlan => ({
    goal: prompt,
    steps: [
      step(1, 'Get active window to find files/folder', ['get_active_window', 'list_directory'], []),
      step(2, `Archive/compress as requested: ${prompt}`, ['run_shell'], [1], 2),
      step(3, 'Verify archive was created', ['list_directory'], [2], 1),
    ],
    successCriteria: [
      { type: 'file_exists', description: 'Archive file was created', check: {}, met: false },
    ],
    estimatedTurns: 6,
  }),

  organize_files: (prompt: string): ExecutionPlan => ({
    goal: prompt,
    steps: [
      step(1, 'List contents of the folder to organize', ['list_directory', 'get_active_window'], []),
      step(2, 'Analyze file types and plan organization structure', [], [1], 1),
      step(3, 'Create folder structure for organization', ['run_shell'], [2]),
      step(4, 'Move files to appropriate folders', ['file_move', 'run_shell'], [3], 2),
      step(5, 'Verify final organized structure', ['list_directory'], [4], 1),
    ],
    successCriteria: [
      { type: 'custom', description: 'Files were organized into folders', check: {}, met: false },
    ],
    estimatedTurns: 10,
  }),

  create_doc: (prompt: string): ExecutionPlan => ({
    goal: prompt,
    steps: [
      step(1, 'Get active window info and find any source file', ['get_active_window'], [], 1),
      step(2, 'Read the active file content if available (use read_file with path from step 1)', ['read_file', 'read_active_file', 'run_shell'], [1], 2),
      step(3, `Create the document: ${prompt}`, ['write_file', 'generate_document', 'run_shell'], [2]),
      step(4, 'Verify output file exists and has content', ['list_directory', 'read_file'], [3], 1),
    ],
    successCriteria: [
      { type: 'file_exists', description: 'Output file was created', check: {}, met: false },
    ],
    estimatedTurns: 6,
  }),

  convert_file: (prompt: string): ExecutionPlan => ({
    goal: prompt,
    steps: [
      step(1, 'Get active window to find the source file', ['get_active_window'], []),
      step(2, 'Read the source file', ['read_file', 'read_active_file'], [1]),
      step(3, `Convert the file: ${prompt}`, ['write_file', 'generate_document', 'run_shell'], [2]),
      step(4, 'Verify converted file exists', ['list_directory', 'read_file'], [3], 1),
    ],
    successCriteria: [
      { type: 'file_exists', description: 'Converted file was created', check: {}, met: false },
    ],
    estimatedTurns: 6,
  }),

  search_files: (prompt: string): ExecutionPlan => ({
    goal: prompt,
    steps: [
      step(1, 'Get active window to determine search location', ['get_active_window'], []),
      step(2, `Search for files: ${prompt}`, ['list_directory', 'run_shell'], [1], 2),
      step(3, 'Report search results', ['clipboard_write'], [2], 1),
    ],
    successCriteria: [],
    estimatedTurns: 5,
  }),

  search_and_create: (prompt: string): ExecutionPlan => {
    const steps: PlanStep[] = [];
    let id = 1;
    steps.push(step(id++, 'Search for sources on the topic', ['read_web_content', 'run_shell'], []));
    steps.push(step(id++, 'Read additional sources for more data', ['read_web_content'], [1]));
    steps.push(step(id++, 'Read one more source for completeness', ['read_web_content'], [1]));
    const researchIds = [1, 2, 3];
    steps.push(step(id++, `Create the output with collected data: ${prompt}`, ['write_file', 'generate_document'], researchIds));
    steps.push(step(id++, 'Verify output file exists and has content', ['list_directory', 'read_file'], [4], 2));
    return {
      goal: prompt,
      steps,
      successCriteria: [
        { type: 'file_exists', description: 'Output file was created', check: {}, met: false },
      ],
      estimatedTurns: 10,
    };
  },

  read_and_act: (prompt: string): ExecutionPlan => ({
    goal: prompt,
    steps: [
      step(1, 'Get active window to find the file', ['get_active_window'], []),
      step(2, 'Read the source file or content', ['read_file', 'read_active_file'], [1]),
      step(3, `Perform the requested action: ${prompt}`, ['write_file', 'generate_document', 'clipboard_write', 'run_shell'], [2]),
      step(4, 'Verify output', ['list_directory', 'read_file'], [3], 1),
    ],
    successCriteria: [],
    estimatedTurns: 6,
  }),

  compare: (prompt: string): ExecutionPlan => ({
    goal: prompt,
    steps: [
      step(1, 'Read the first item to compare', ['read_file', 'read_web_content', 'read_active_file'], []),
      step(2, 'Read the second item to compare', ['read_file', 'read_web_content'], []),
      step(3, 'Analyze and compare both items', [], [1, 2], 1),
      step(4, 'Output comparison results', ['write_file', 'clipboard_write'], [3], 1),
    ],
    successCriteria: [],
    estimatedTurns: 6,
  }),

  download: (prompt: string): ExecutionPlan => ({
    goal: prompt,
    steps: [
      step(1, 'Read content from the URL/source', ['read_web_content'], []),
      step(2, `Extract the requested content: ${prompt}`, [], [1], 1),
      step(3, 'Save extracted content to file', ['write_file'], [2]),
      step(4, 'Verify saved file', ['list_directory', 'read_file'], [3], 1),
    ],
    successCriteria: [
      { type: 'file_exists', description: 'Downloaded content was saved', check: {}, met: false },
    ],
    estimatedTurns: 6,
  }),

  cross_app: (prompt: string): ExecutionPlan => ({
    goal: prompt,
    steps: [
      step(1, 'Get the active window info to find the source file', ['get_active_window'], []),
      step(2, 'Read the full content of the source file', ['read_file', 'read_active_file', 'run_shell'], [1]),
      step(3, `Create the output using ALL the extracted data: ${prompt}`, ['generate_document', 'write_file'], [2]),
      step(4, 'Open the created file', ['system_open'], [3], 1),
      step(5, 'Verify file opened correctly', ['capture_screenshot'], [4], 1),
    ],
    successCriteria: [
      { type: 'file_exists', description: 'Output file was created', check: {}, met: false },
    ],
    estimatedTurns: 8,
  }),

  transform_file: (prompt: string): ExecutionPlan => ({
    goal: prompt,
    steps: [
      step(1, 'Get active window to find the file', ['get_active_window'], []),
      step(2, 'Read the file content', ['read_file', 'read_active_file'], [1]),
      step(3, `Transform the content: ${prompt}`, ['write_file', 'edit_file', 'clipboard_write'], [2]),
      step(4, 'Verify the output', ['read_file'], [3], 1),
    ],
    successCriteria: [],
    estimatedTurns: 6,
  }),

  edit_image: (prompt: string): ExecutionPlan => ({
    goal: prompt,
    steps: [
      step(1, 'Get active window to find the image file', ['get_active_window'], []),
      step(2, `Edit the image: ${prompt}`, ['run_shell'], [1], 2),
      step(3, 'Verify output image exists', ['list_directory'], [2], 1),
    ],
    successCriteria: [
      { type: 'file_exists', description: 'Edited image was saved', check: {}, met: false },
    ],
    estimatedTurns: 5,
  }),

  query_folder: (prompt: string): ExecutionPlan => ({
    goal: prompt,
    steps: [
      step(1, 'Get active window to find the target folder', ['get_active_window'], []),
      step(2, `List and analyze folder contents: ${prompt}`, ['list_directory', 'run_shell'], [1], 2),
      step(3, 'Report results', ['clipboard_write'], [2], 1),
    ],
    successCriteria: [],
    estimatedTurns: 5,
  }),

  open_launch: (prompt: string): ExecutionPlan => ({
    goal: prompt,
    steps: [
      step(1, `Open/launch as requested: ${prompt}`, ['system_open', 'run_shell'], [], 2),
      step(2, 'Verify it opened', ['capture_screenshot'], [1], 1),
    ],
    successCriteria: [],
    estimatedTurns: 3,
  }),

  send_share: (prompt: string): ExecutionPlan => ({
    goal: prompt,
    steps: [
      step(1, 'Get active window to find content to send', ['get_active_window'], []),
      step(2, 'Read the content to send', ['read_file', 'read_active_file', 'clipboard_read'], [1]),
      step(3, `Send/share as requested: ${prompt}`, ['system_open', 'clipboard_write', 'run_shell'], [2]),
      step(4, 'Verify action completed', ['capture_screenshot'], [3], 1),
    ],
    successCriteria: [],
    estimatedTurns: 6,
  }),

  question: (prompt: string): ExecutionPlan => ({
    goal: prompt,
    steps: [
      // Simple questions shouldn't really be in agent mode, but handle gracefully
      step(1, `Answer the question: ${prompt}`, ['read_file', 'read_active_file', 'read_web_content', 'capture_screenshot'], [], 2),
    ],
    successCriteria: [],
    estimatedTurns: 2,
  }),
};

// ══════════════════════════════════════════════════════════════════════
// OPTION A: Pattern Templates (regex-based fallback)
// ══════════════════════════════════════════════════════════════════════
//
// ORDERING RULE: Specific multi-part patterns FIRST, greedy single-part LAST.
// Template 4 (create/make) is deliberately near the end because it matches
// almost anything with "make" or "create" in it.

const PLAN_TEMPLATES: PlanTemplate[] = [
  // ── 1. Cross-app: "Take/get/extract data from X and make/create Y" ──
  // MUST be before Template 19 (create) — both match "make/create"
  {
    pattern: /(?:take|get|grab|extract|pull)\s+(?:the\s+)?(?:data|content|info|information|text|everything)\s+(?:from|in)\s+(?:this\s+|the\s+)?(.+?)\s+(?:and|then)\s+(?:make|create|generate|build|put\s+(?:it\s+)?(?:in|into))\s+(?:an?\s+)?(.+)/i,
    generate: (match, prompt) => CATEGORY_PLANS.cross_app(prompt),
  },

  // ── 2. Find/search N items and create Y ──
  {
    pattern: /(?:find|search|get|collect|gather|look\s+up|fetch|research)\s+(\d+)?\s*(.+?)\s+(?:and|then)\s+(?:create|make|build|generate|write|save|put\s+(?:them?\s+)?(?:in|into))\s+(?:an?\s+)?(.+)/i,
    generate: (match, prompt) => {
      const targetCount = parseInt(match[1]) || 5;
      const researchStepCount = Math.max(3, Math.min(6, Math.ceil(targetCount / 2)));
      const steps: PlanStep[] = [];
      let id = 1;
      steps.push(step(id++, `Search for sources about ${match[2]}`, ['read_web_content', 'run_shell'], []));
      for (let i = 1; i < researchStepCount; i++) {
        steps.push(step(id++, `Read source ${i + 1} for more ${match[2]} (target: ${targetCount} items)`, ['read_web_content'], [1]));
      }
      const creationId = id++;
      const researchIds = Array.from({ length: researchStepCount }, (_, i) => i + 1);
      steps.push(step(creationId, `Create ${match[3]} with collected data`, ['write_file', 'generate_document'], researchIds));
      steps.push(step(id++, 'Verify output file exists and has content', ['list_directory', 'read_file'], [creationId], 2));
      return {
        goal: prompt,
        steps,
        successCriteria: [
          { type: 'file_exists' as const, description: 'Output file was created', check: {}, met: false },
          ...(match[1] ? [{
            type: 'data_count' as const,
            description: `At least ${match[1]} items collected`,
            check: { minCount: parseInt(match[1]) },
            met: false,
          }] : []),
        ],
        estimatedTurns: researchStepCount * 2 + 4,
      };
    },
  },

  // ── 3. Read/analyze X and do Y ──
  {
    pattern: /(?:read|analyze|look\s+at|check|review|open|examine|inspect|scan)\s+(?:the\s+|this\s+|my\s+)?(.+?)\s+(?:and|then)\s+(.+)/i,
    generate: (match, prompt) => CATEGORY_PLANS.read_and_act(prompt),
  },

  // ── 4. Compare/diff X and Y ──
  {
    pattern: /(?:compare|diff|contrast|difference\s+between)\s+(.+?)\s+(?:and|with|vs\.?|versus)\s+(.+)/i,
    generate: (match, prompt) => CATEGORY_PLANS.compare(prompt),
  },

  // ── 5. Download/save from URL ──
  {
    pattern: /(?:download|scrape)\s+(.+?)\s+(?:from|at|on)\s+(.+)/i,
    generate: (match, prompt) => CATEGORY_PLANS.download(prompt),
  },

  // ── 6. Merge/combine/consolidate files ── (NEW)
  {
    pattern: /(?:merge|combine|consolidate|join|unify|put\s+(?:all\s+)?(?:.*?\s+)?together|concat)/i,
    generate: (match, prompt) => CATEGORY_PLANS.merge_files(prompt),
  },

  // ── 7. Move/copy/put files somewhere ── (NEW)
  {
    pattern: /(?:move|copy|relocate|transfer|put)\s+(?:all\s+)?(?:the\s+|my\s+)?(.+?)\s+(?:to|into|in|onto|under)\s+(.+)/i,
    generate: (match, prompt) => CATEGORY_PLANS.move_files(prompt),
  },

  // ── 8. Rename files ── (NEW)
  {
    pattern: /(?:rename|batch[\s-]?rename)\s+(.+)/i,
    generate: (match, prompt) => CATEGORY_PLANS.rename_files(prompt),
  },

  // ── 9. Delete/remove/cleanup files ── (NEW)
  {
    pattern: /(?:delete|remove|trash|erase|wipe|clean\s*out|get\s+rid\s+of|purge)\s+(?:all\s+)?(?:the\s+|my\s+)?(?:duplicate|old|temp|temporary|unused)?\s*(.+)/i,
    generate: (match, prompt) => CATEGORY_PLANS.delete_files(prompt),
  },

  // ── 10. Archive: zip/unzip/compress/backup ── (NEW)
  {
    pattern: /(?:zip|unzip|compress|decompress|extract|archive|backup|back\s*up|tar|rar|7z)\s+(.+)/i,
    generate: (match, prompt) => CATEGORY_PLANS.archive_files(prompt),
  },

  // ── 11. Organize/sort/clean up files ── (widened keywords)
  {
    pattern: /(?:organize|sort|clean\s*up|tidy|arrange|categorize|declutter|group|separate|split\s+(?:up|by))\s+(?:my\s+|the\s+)?(.+)/i,
    generate: (match, prompt) => CATEGORY_PLANS.organize_files(prompt),
  },

  // ── 12. Convert file to format ──
  {
    pattern: /(?:convert|transform|export|turn)\s+(?:the\s+|this\s+)?(.+?)\s+(?:to|into|as)\s+(?:a\s+)?(.+)/i,
    generate: (match, prompt) => CATEGORY_PLANS.convert_file(prompt),
  },

  // ── 13. Transform single file: summarize/translate/fix/rewrite ── (NEW)
  {
    pattern: /(?:summarize|summarise|translate|proofread|fix\s+(?:the\s+)?grammar|rewrite|paraphrase|simplify|shorten|expand|improve)\s+(?:this|the|my)?\s*(.+)?/i,
    generate: (match, prompt) => CATEGORY_PLANS.transform_file(prompt),
  },

  // ── 14. Resize/crop/edit image ── (NEW)
  {
    pattern: /(?:resize|crop|rotate|flip|compress|shrink|scale|trim|watermark)\s+(?:this\s+|the\s+|my\s+)?(?:image|photo|picture|screenshot|png|jpg|jpeg|gif|img)\s*(.+)?/i,
    generate: (match, prompt) => CATEGORY_PLANS.edit_image(prompt),
  },

  // ── 15. Query/list/inspect folder ── (NEW)
  {
    pattern: /(?:what(?:'s| is)\s+in|list\s+(?:everything|all|files|contents)|count\s+(?:the\s+)?(?:files|items)|show\s+(?:me\s+)?(?:the\s+)?(?:files|contents|biggest|largest|smallest|newest|oldest)|how\s+many\s+files)\s*(?:in\s+|on\s+|of\s+)?(.+)?/i,
    generate: (match, prompt) => CATEGORY_PLANS.query_folder(prompt),
  },

  // ── 16. Find/search files (no creation) ── (NEW)
  {
    pattern: /(?:find|search\s+for|locate|look\s+for|where\s+is|where\s+are)\s+(?:all\s+)?(?:the\s+|my\s+)?(.+?)(?:\s+(?:on|in|under|from)\s+(.+))?$/i,
    generate: (match, prompt) => CATEGORY_PLANS.search_files(prompt),
  },

  // ── 17. Open/launch/run something ── (NEW)
  {
    pattern: /(?:open|launch|run|start|execute)\s+(?:the\s+|my\s+)?(.+)/i,
    generate: (match, prompt) => CATEGORY_PLANS.open_launch(prompt),
  },

  // ── 18. Send/share/email ── (NEW)
  {
    pattern: /(?:send|email|mail|share|forward|post)\s+(?:this|the|my)?\s*(.+)/i,
    generate: (match, prompt) => CATEGORY_PLANS.send_share(prompt),
  },

  // ── 19. Create/make/write (GREEDY — must be LAST among action templates) ──
  {
    pattern: /(?:create|make|write|build|generate|draft|compose|design|prepare)\s+(?:me\s+)?(?:an?\s+)?(.+)/i,
    generate: (match, prompt) => CATEGORY_PLANS.create_doc(prompt),
  },

  // ── 20. Simple question (should not be agent task) ── (NEW)
  {
    pattern: /^(?:what|how|why|when|where|who|which|can\s+you|do\s+you|is\s+(?:it|there|this)|are\s+there|tell\s+me|explain)\s+/i,
    generate: (match, prompt) => CATEGORY_PLANS.question(prompt),
  },
];

/**
 * Generic fallback: treats the entire prompt as a single step.
 * IMPROVED: Always assigns common tools so forceToolUse can work.
 * The old version used tools: [] which made shouldForce always false.
 */
function genericPlan(prompt: string): ExecutionPlan {
  return {
    goal: prompt,
    steps: [
      step(1, prompt, [
        'get_active_window', 'list_directory', 'read_file', 'read_active_file',
        'write_file', 'run_shell', 'clipboard_write',
      ], [], 3),
      step(2, 'Verify results', ['list_directory', 'read_file', 'capture_screenshot'], [1], 1),
    ],
    successCriteria: [],
    estimatedTurns: 6,
  };
}

// ══════════════════════════════════════════════════════════════════════
// PUBLIC API
// ══════════════════════════════════════════════════════════════════════

/**
 * Generate a plan using the intent classifier result (Option B).
 * If the classifier returned a category, use the category-based plan directly.
 * If unknown/unavailable, fall through to regex matching (Option A).
 */
export function classifiedPlan(category: IntentCategory | null, prompt: string): ExecutionPlan {
  // Option B: Use classifier result if available
  if (category && category !== 'unknown') {
    const plan = planFromIntent(category, prompt);
    if (plan) {
      console.log('[Planner] Used classifier category:', category);
      return plan;
    }
  }

  // Option A: Fall through to regex matching
  return ruleBasedPlan(prompt);
}

/**
 * Generate a plan using rule-based pattern matching (Option A).
 * Tries each template in order; first match wins.
 * Falls back to generic plan if no template matches.
 *
 * ORDERING: Specific multi-part patterns run FIRST.
 * Greedy patterns (create/make, questions) run LAST.
 */
export function ruleBasedPlan(prompt: string): ExecutionPlan {
  for (const template of PLAN_TEMPLATES) {
    const match = prompt.match(template.pattern);
    if (match) {
      console.log('[Planner] Matched template:', template.pattern.source.substring(0, 50));
      return template.generate(match, prompt);
    }
  }
  console.log('[Planner] No template matched, using generic plan (with tools)');
  return genericPlan(prompt);
}

/**
 * Try to parse a model-generated plan from raw text.
 * Attempts: raw JSON parse → extract from markdown fences → regex extraction.
 * Returns null if all attempts fail.
 */
export function parseModelPlan(rawText: string): ExecutionPlan | null {
  // Attempt 1: Direct JSON parse
  try {
    const plan = JSON.parse(rawText);
    if (isValidPlan(plan)) return normalizePlan(plan);
  } catch { /* not valid JSON */ }

  // Attempt 2: Extract from markdown code fences
  const fenceMatch = rawText.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
  if (fenceMatch) {
    try {
      const plan = JSON.parse(fenceMatch[1]);
      if (isValidPlan(plan)) return normalizePlan(plan);
    } catch { /* invalid JSON in fence */ }
  }

  // Attempt 3: Regex extraction — find first { to last }
  const jsonMatch = rawText.match(/\{[\s\S]*\}/);
  if (jsonMatch) {
    try {
      const plan = JSON.parse(jsonMatch[0]);
      if (isValidPlan(plan)) return normalizePlan(plan);
    } catch { /* still not valid */ }
  }

  console.log('[Planner] Failed to parse model-generated plan');
  return null;
}

/**
 * Validate that a parsed object looks like an ExecutionPlan.
 */
function isValidPlan(obj: any): boolean {
  if (!obj || typeof obj !== 'object') return false;
  if (!Array.isArray(obj.steps) || obj.steps.length === 0) return false;
  return obj.steps.every((s: any) =>
    (typeof s.action === 'string' || typeof s.description === 'string') &&
    (s.action?.length > 0 || s.description?.length > 0)
  );
}

/**
 * Normalize a model-generated plan into our ExecutionPlan format.
 * Handles variations in field names (action/description, tools/tool, etc.)
 */
function normalizePlan(raw: any): ExecutionPlan {
  const steps: PlanStep[] = raw.steps.map((s: any, i: number) => ({
    id: s.id || i + 1,
    action: s.action || s.description || s.task || '',
    tools: Array.isArray(s.tools) ? s.tools :
           typeof s.tool === 'string' ? [s.tool] : [],
    depends: Array.isArray(s.depends) ? s.depends :
             Array.isArray(s.dependencies) ? s.dependencies : [],
    status: 'pending' as const,
    retries: 0,
    maxRetries: s.maxRetries || s.max_retries || 3,
  }));

  const successCriteria: SuccessCriterion[] = (raw.success_criteria || raw.successCriteria || [])
    .map((c: any) => ({
      type: (c.type || 'custom') as SuccessCriterion['type'],
      description: c.description || c.check || '',
      check: {
        tool: c.verification_tool || c.tool,
        toolInput: c.toolInput || c.tool_input,
        expectedPattern: c.expectedPattern || c.expected_pattern,
        minCount: c.minCount || c.min_count,
      },
      met: false,
    }));

  return {
    goal: raw.goal || raw.intent?.primary_goal || '',
    steps,
    successCriteria,
    estimatedTurns: raw.estimated_turns || raw.estimatedTurns || steps.length * 2,
  };
}
