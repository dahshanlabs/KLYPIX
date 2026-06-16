// Pure classifiers for routing an agent run's final message to the right HOME —
// the "durability matches meaning, not delivery mechanism" rule that fixes the
// inverted bug (the meaningful refusal vanished as a toast while a content-free
// "completed." sign-off was pinned as a durable card). Kept dependency-free so
// it unit-tests in the node runner.
//
//   real answer        → green artifact card (it worked, keep it)
//   refusal / no-op     → dashed amber/slate "Note" card (needs you / FYI)
//   content-free sign-off → NOTHING (the canvas is the record; or a failure report)

// Tools that do NOT mutate the canvas — lets the run-end logic tell a genuinely
// empty run (pin a failure report) from one that did real work but only signed
// off (the canvas itself IS the record — pin nothing extra).
export const NON_MUTATING_TOOLS = new Set([
    'canvas_get_items', 'canvas_read_item', 'canvas_search', 'canvas_get_connections',
    'canvas_read_file', 'canvas_find_issues', 'canvas_create_toast', 'canvas_done', 'canvas_ask_user',
]);

// A content-free sign-off ("Done.", "Translation request completed.", "Task
// completed successfully.") — NOT an answer; must never be pinned as a durable
// card (the original bug). Subtractive test: strip the subject + completion +
// filler words; if nothing substantive remains, it's a bare sign-off.
const SIGNOFF_WORDS = /\b(ok|okay|all|the|your|i|i've|now|here|there|task|request|command|operation|translation|summary|comparison|analysis|chart|document|report|file|it|is|are|been|has|have|was|successfully|successful|success|done|complete|completed|completing|finished|finish|created|added|generated|made|placed|pinned|ready)\b/gi;
export function isGenericSignoff(s: string): boolean {
    const t = (s || '').trim();
    if (!t) return true;
    if (t.length > 72) return false;
    const left = t.replace(/[.!?,;:…—–-]/g, ' ').replace(SIGNOFF_WORDS, ' ').replace(/\s+/g, ' ').trim();
    return left.length === 0;
}

// A refusal / "can't do" / "nothing here" reply — the highest-value message the
// agent can produce (the user must ACT). Earns a durable but visually-distinct
// "Note" card (dashed, amber/slate) — never a green success card, never a toast.
const REFUSAL_RE = /\b(can('|no| )?t|cannot|could ?n'?t|unable|not able|isn'?t|does(n'?t| not) (appear|seem|look|contain|exist)|no (meaningful|valid|translatable|usable|real|discernible|recognizable)|nothing (to|here|found)|not (translatable|valid|possible|meaningful|recognizable|enough)|please provide|provide (meaningful|valid|real|more)|no (text|content|items?|input|data) (to|found|provided|selected))\b/i;
export function looksLikeRefusal(s: string): boolean {
    const t = (s || '').trim();
    if (!t || t.length > 280) return false;   // refusals are short; a long answer that merely contains "cannot" is not one
    return REFUSAL_RE.test(t.slice(0, 180));
}

// Actionable refusal ("…provide meaningful text") → amber (needs you); a pure
// no-op ("nothing to summarize") → slate (FYI).
export function refusalTone(s: string): 'amber' | 'slate' {
    return /\b(provide|please|try|add|select|give|enter|supply|need|use)\b/i.test(s || '') ? 'amber' : 'slate';
}

// Hue for a note/refusal arrow, matched to its card tone.
export function refusalArrowColor(tone: 'amber' | 'slate'): string {
    return tone === 'amber' ? '#f59e0b' : '#9ca3af';
}

// From everything the agent "said" (plain-text answer, toasts, the done message),
// pick the most substantive reply, dropping content-free sign-offs.
export function pickSubstantiveReply(candidates: string[]): string {
    const subs = candidates.map(c => (c || '').trim()).filter(c => c && !isGenericSignoff(c));
    if (!subs.length) return '';
    return subs.sort((a, b) => b.length - a.length)[0];
}
