import type { EvalPrompt } from './types';

/**
 * Initial KLYPIX agent eval set — 7 prompts covering the main task surfaces.
 * Keep this small and meaningful; bigger != better. If you add prompts, make
 * sure each one tests something the existing prompts don't already cover.
 *
 * Artifact paths use placeholder ${desktop} that the runner replaces with the
 * actual desktop path at runtime — so this file is portable across machines.
 */
export const EVAL_PROMPTS: EvalPrompt[] = [
  {
    id: 'light-list',
    category: 'light',
    prompt: 'List the files in my Downloads folder. Just the names and sizes — no analysis.',
    expectedArtifacts: [],
    expectedMaxTurns: 4,
    expectedMaxCostUSD: 0.05,
    notes: 'Sanity check. Single tool call (list_directory). Should never fail.',
  },
  {
    id: 'knowledge-summarize',
    category: 'knowledge',
    prompt: 'Read the abilify-summary-for-sally.txt file on my desktop and summarize it in 2 short bullets.',
    expectedArtifacts: [],
    expectedMaxTurns: 5,
    expectedMaxCostUSD: 0.05,
    notes: 'Tests read_file on a small text file + summarization. Skipped if the file does not exist.',
  },
  {
    id: 'code-generate-xlsx',
    category: 'code',
    prompt: 'Create a small Excel file at ${desktop}/eval-test-spreadsheet.xlsx with three columns (Date, Item, Cost) and 5 rows of dummy data. Just create the file, no commentary.',
    expectedArtifacts: ['${desktop}/eval-test-spreadsheet.xlsx'],
    expectedMaxTurns: 4,
    expectedMaxCostUSD: 0.20,
    notes: 'Tests document generation pipeline. Strict artifact check. $0.20 budget — Claude legitimately spends that on doc-gen when the spec needs interpretation.',
  },
  {
    id: 'code-write-text',
    category: 'code',
    prompt: 'Write a file at ${desktop}/eval-hello.txt containing exactly the text "hello from klypix eval". Nothing else.',
    expectedArtifacts: ['${desktop}/eval-hello.txt'],
    expectedMaxTurns: 3,
    expectedMaxCostUSD: 0.03,
    notes: 'Smallest possible write_file test. Pass or fail is binary.',
  },
  {
    id: 'reasoning-pdf-summary',
    category: 'reasoning',
    prompt: 'Find any PDF on my desktop. Read it. Tell me in 3 sentences what it is about. Do not write any files.',
    expectedArtifacts: [],
    expectedMaxTurns: 8,
    expectedMaxCostUSD: 0.20,
    notes: 'The hard one — list, pick, read, synthesize. Catches over-thoroughness.',
  },
  {
    id: 'resilience-missing-file',
    category: 'resilience',
    prompt: 'Read the file at C:/this-file-definitely-does-not-exist-eval.xyz and tell me what it says.',
    expectedArtifacts: [],
    expectedMaxTurns: 3,
    expectedMaxCostUSD: 0.02,
    notes: 'Should fail GRACEFULLY — agent says "file does not exist" within 3 turns. If it loops, that is a regression.',
  },
  {
    id: 'knowledge-count',
    category: 'knowledge',
    prompt: 'How many files do I have on my desktop? Just the number.',
    expectedArtifacts: [],
    expectedMaxTurns: 3,
    expectedMaxCostUSD: 0.03,
    notes: 'Tests list_directory + simple counting. Should be 1-2 turns.',
  },
  {
    id: 'knowledge-summarize-ar',
    category: 'knowledge',
    // Prompt in Arabic; expected response in Arabic. Tests RTL roundtrip end-to-end:
    // Arabic prompt parsing → Arabic filename listing/handling → Arabic PDF text extraction
    // → Arabic output generation. If the model silently switches to English, that's a fail
    // signal we want surfaced — it decides whether the model can serve Saudi/Arabic users.
    prompt: 'ابحث عن أي ملف PDF بالعربية على سطح المكتب، اقرأه، ولخصه في 3 جمل بالعربية. لا تنشئ أي ملفات.',
    expectedArtifacts: [],
    expectedMaxTurns: 6,
    expectedMaxCostUSD: 0.10,
    notes: 'Arabic round-trip test. EN: "Find any Arabic PDF on the desktop, read it, summarize in 3 Arabic sentences. Do not write any files." Marks the bar for Arabic support — if the model loses RTL or replies in English, fail it.',
  },
];

/** Resolve ${desktop} placeholder. Used by the runner before passing prompts to the agent. */
export function resolveDesktopPath(template: string, desktop: string): string {
  return template.replace(/\$\{desktop\}/g, desktop.replace(/\\/g, '/').replace(/\/$/, ''));
}
