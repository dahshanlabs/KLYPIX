// Canvas slash-command registry — the CONTRACT for each command.
//
// Before this, the nine slash-commands were contract-less strings: each was
// handed verbatim to Gemini Flash with the full 28-tool belt, and the MODEL
// decided how to run it. For a pure-language ask like /translate it would
// often reach for canvas_run_code (python googletrans → "unexpected EOF", then
// a second script that hardcodes the English and prints it = fake work that
// exits 0 and pins). The clean "TRANSLATION" card the user liked was the same
// model, a coin-flip away, just happening to pick canvas_create_card instead.
//
// The registry turns each command into a declared intent:
//   • lane         — 'language' runs a deterministic tool-free fast path;
//                    'agent' runs the multi-turn tool loop.
//   • allowedTools — the ONLY tools the command may see in the loop, so a
//                    language command literally cannot reach canvas_run_code.
//   • cardTitle / instruction — the fast-lane output contract.
//   • guidance / argHint — loop nudges + command-bar affordances.
//
// Unknown verbs (natural-language asks, power-user commands) resolve to
// spec=null → the legacy all-tools loop, unchanged.

export type CommandLane = 'language' | 'agent';

export interface CommandSpec {
    /** Canonical name including the leading slash, e.g. '/translate'. */
    name: string;
    lane: CommandLane;
    /** Fast-lane result-card heading (rendered UPPERCASE, e.g. 'TRANSLATION'). */
    cardTitle?: string;
    /** Task instruction injected into the fast-lane (and loop-fallback) prompt. */
    instruction?: string;
    /** Tool names this command may use in the agent loop. undefined = all tools.
     *  Language-lane commands list their FALLBACK tools — used only when the fast
     *  lane can't run (selection needs PDF/image/media extraction). They never
     *  include code-execution tools. */
    allowedTools?: string[];
    /** Extra system-prompt guidance appended when this command runs the loop. */
    guidance?: string;
    /** Hint shown in the command bar once the user has typed the command. */
    argHint?: string;
    /** Default scope when NOTHING is selected (default 'selection'):
     *  'selection' — a transform that needs explicit targets. An empty selection
     *     BLOCKS the run with a "select items first" hint instead of silently
     *     shipping the whole board to the model (slow, costly, noisy).
     *  'canvas' — legitimately whole-board (/organize, /cleanup): an empty
     *     selection means the whole canvas (capped to bound token load). */
    scope?: 'selection' | 'canvas';
}

// Tool groups (names mirror canvasTools.ts). READ = inspect the canvas;
// OUTPUT = write the answer + wire it up + stop. A gated command always gets
// OUTPUT (so it can finish via canvas_done) plus whatever its job needs.
const READ_TOOLS = [
    'canvas_get_items', 'canvas_read_item', 'canvas_search',
    'canvas_get_connections', 'canvas_read_file',
];
const OUTPUT_TOOLS = [
    'canvas_create_text', 'canvas_create_card', 'canvas_write_batch',
    'canvas_connect_items', 'canvas_create_toast', 'canvas_add_border',
    'canvas_update_item', 'canvas_ask_user', 'canvas_done',
];

const COMMANDS: CommandSpec[] = [
    {
        name: '/summarize', lane: 'language', cardTitle: 'Summary',
        instruction: 'Summarize the source content concisely, capturing the key points and leaving out filler. The summary must be clearly shorter than the source.',
        allowedTools: [...READ_TOOLS, ...OUTPUT_TOOLS],
        argHint: 'as bullets | as a paragraph (optional)',
    },
    {
        name: '/compare', lane: 'language', cardTitle: 'Comparison',
        instruction: 'Compare the source items against each other: surface the meaningful similarities, the differences, and the trade-offs. Be specific, concrete, and balanced — do not just describe each in isolation.',
        allowedTools: [...READ_TOOLS, ...OUTPUT_TOOLS],
    },
    {
        name: '/translate', lane: 'language', cardTitle: 'Translation',
        instruction: 'Translate the source content. If the user named a target language, translate into it. Otherwise default to English — unless the source is already English, in which case translate to Arabic. Preserve meaning, tone, names, numbers, and line structure; render greetings and idioms naturally rather than word-for-word.',
        allowedTools: [...READ_TOOLS, ...OUTPUT_TOOLS],
        argHint: 'to <language> · default English ⇄ Arabic',
    },
    {
        name: '/research', lane: 'agent',
        // Full toolset: /research may legitimately need to compute or fetch.
        // Guidance steers it to synthesize from on-canvas items first.
        guidance: 'For /research: first synthesize an answer from the items already on the canvas (read them). Only run code if you genuinely need to compute or fetch something that is not present. Never use code to write prose you can write yourself.',
        argHint: '<topic / question> (optional)',
    },
    {
        name: '/chart', lane: 'agent',
        allowedTools: [...READ_TOOLS, ...OUTPUT_TOOLS, 'canvas_pin_chart', 'canvas_run_code', 'canvas_pin_image'],
        guidance: 'For /chart: if you already have the numbers, call canvas_pin_chart directly with labels + values. Use canvas_run_code only to DERIVE numbers from data on the canvas, then pin the chart.',
        argHint: 'bar | line | pie of <data>',
    },
    {
        name: '/analyze', lane: 'language', cardTitle: 'Analysis',
        instruction: 'Analyze the source content qualitatively: what it is, what stands out, the implications, and anything notable or worth acting on. Reasoning only — do not run code or fabricate numbers.',
        allowedTools: [...READ_TOOLS, ...OUTPUT_TOOLS],
    },
    {
        name: '/compile', lane: 'agent',
        allowedTools: [...READ_TOOLS, ...OUTPUT_TOOLS, 'canvas_compile'],
        guidance: 'For /compile: use canvas_compile to bundle the scoped items into the requested format (pdf/docx/pptx/zip). Do not re-author the document by hand via code.',
        argHint: 'pdf | docx | pptx | zip',
    },
    {
        name: '/organize', lane: 'agent', scope: 'canvas',
        allowedTools: [
            ...READ_TOOLS, ...OUTPUT_TOOLS,
            'canvas_organize', 'canvas_arrange_items', 'canvas_create_container',
            'canvas_group_into_container', 'canvas_set_tags', 'canvas_set_status',
        ],
        guidance: 'For /organize: use canvas_organize to cluster items (by type / tag / status / date / connection) into titled containers. Preserve every item and connection — just move and group them.',
        argHint: 'by type | tag | status | date | connection',
    },
    {
        name: '/cleanup', lane: 'agent', scope: 'canvas',
        allowedTools: [
            ...READ_TOOLS, ...OUTPUT_TOOLS,
            'canvas_find_issues', 'canvas_set_tags', 'canvas_set_relationship', 'canvas_delete_item',
        ],
        guidance: 'For /cleanup: use canvas_find_issues to surface orphans / untagged / duplicates / near-aligned items, report them in one card, and only mutate when the fix is clearly safe.',
    },
];

/** Display order for the command-bar chips (excludes /garden by design — the
 *  brain offers tidying via the proactive Brain Health pill instead). */
export const CANVAS_COMMAND_NAMES = COMMANDS.map(c => c.name);

const BY_NAME = new Map(COMMANDS.map(c => [c.name, c]));

/** Split a raw command into its base verb + remaining args, and resolve the
 *  spec. `/translate to French` → { spec: <translate>, base: '/translate',
 *  args: 'to French' }. Non-slash input (natural language) → spec: null. */
export function parseCommand(raw: string): { spec: CommandSpec | null; base: string; args: string } {
    const trimmed = (raw || '').trim();
    const m = trimmed.match(/^(\/[a-z]+)\b\s*([\s\S]*)$/i);
    if (!m) return { spec: null, base: '', args: trimmed };
    const base = m[1].toLowerCase();
    return { spec: BY_NAME.get(base) ?? null, base, args: (m[2] || '').trim() };
}

/** Resolve just the spec for a (possibly partial) command-bar input. */
export function commandSpecFor(raw: string): CommandSpec | null {
    return parseCommand(raw).spec;
}

/** Resolve the EXACT tool belt a command's agent loop is handed, given the full
 *  tool registry. This is the SINGLE source of truth for per-command gating —
 *  canvasAgent calls it for the live run, and the eval harness calls it with the
 *  real CANVAS_TOOLS to assert the contract (e.g. a language command's belt
 *  provably contains no code-execution tool). Ungated commands (spec=null or no
 *  allowedTools) get the full belt back unchanged. A tool name listed in
 *  allowedTools that is absent from `allTools` simply drops out here — the eval
 *  guards against that (a typo'd gate silently removes a tool). */
export function resolveToolBelt<T extends { name: string }>(command: string, allTools: T[]): T[] {
    const spec = commandSpecFor(command);
    if (!spec?.allowedTools) return allTools;
    const allowed = new Set(spec.allowedTools);
    return allTools.filter(t => allowed.has(t.name));
}
