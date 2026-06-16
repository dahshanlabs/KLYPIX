// Bridge between the canvas agent's tool executor (which runs OUTSIDE React) and
// the AgentQuestionDialog overlay (inside React) for structured "ask the user"
// questions — the Claude-Code-style chooser (header + options w/ descriptions +
// an auto "Other" free-text, 1-4 questions, single- or multi-select).
//
// One ask is pending at a time: canvas-agent tool execution is serialized by a
// shared lock, so a single `current` slot suffices. A rare overlapping ask
// supersedes the prior one (resolved null). Mirrors approvalRegistry's
// promise-resolver pattern; kept separate so the simple approve/deny card path
// (canvas_create_approval) is untouched.

export interface AskOption {
    label: string;
    description?: string;
}

export interface AskQuestion {
    /** Short chip/tag above the question (≤ ~24 chars). */
    header?: string;
    question: string;
    /** true = checkboxes (pick several); false/undefined = radio (pick one). */
    multiSelect?: boolean;
    options: AskOption[];
}

export interface AskAnswer {
    question: string;
    /** Chosen option labels; an "Other" pick contributes the user's free text. */
    selected: string[];
}

interface PendingAsk {
    id: string;
    questions: AskQuestion[];
    resolve: (answers: AskAnswer[] | null) => void;
}

let current: PendingAsk | null = null;
// Stable snapshot for useSyncExternalStore — recomputed ONLY when `current`
// changes, so getCurrentAsk returns the same reference across renders (a fresh
// object each call would trip React's "getSnapshot should be cached" loop).
let snapshot: { id: string; questions: AskQuestion[] } | null = null;
const listeners = new Set<() => void>();

function setCurrent(next: PendingAsk | null): void {
    current = next;
    snapshot = next ? { id: next.id, questions: next.questions } : null;
    for (const l of listeners) l();
}

/** Subscribe to current-ask changes (used by the overlay). Returns unsubscribe. */
export function subscribeAsk(listener: () => void): () => void {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
}

/** Stable snapshot of the pending ask (null when nothing is being asked). */
export function getCurrentAsk(): { id: string; questions: AskQuestion[] } | null {
    return snapshot;
}

/**
 * Open a question popup and wait for the user. Resolves with the answers, or
 * null if cancelled, superseded, or timed out.
 */
export function askUser(id: string, questions: AskQuestion[], timeoutMs?: number): Promise<AskAnswer[] | null> {
    // Supersede any prior pending ask (shouldn't happen — runs are serialized).
    if (current) { const prev = current; setCurrent(null); prev.resolve(null); }
    return new Promise<AskAnswer[] | null>((resolve) => {
        let settled = false;
        const done = (a: AskAnswer[] | null) => { if (settled) return; settled = true; resolve(a); };
        setCurrent({ id, questions, resolve: done });
        if (timeoutMs && timeoutMs > 0) {
            setTimeout(() => {
                if (current && current.id === id) { setCurrent(null); done(null); }
            }, timeoutMs);
        }
    });
}

/** Resolve the pending ask with the user's answers (called by the overlay). */
export function submitAsk(answers: AskAnswer[]): void {
    const c = current;
    if (!c) return;
    setCurrent(null);
    c.resolve(answers);
}

/** Cancel the pending ask (Esc / dismiss). Resolves with null. */
export function cancelAsk(): void {
    const c = current;
    if (!c) return;
    setCurrent(null);
    c.resolve(null);
}
