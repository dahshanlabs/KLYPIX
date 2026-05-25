// Phase 23 Day 4 — Text-expansion snippets.
//
// Concept: user types ';sig' followed by space/tab/enter; the trigger is
// replaced inline with a stored snippet body. Triggers live in
// localStorage; bodies are stored alongside.
//
// Storage: localStorage['klypix:palette:snippets:v1'] as
//   { triggers: Record<trigger, snippetId>, bodies: Record<snippetId, {body, name}> }
//
// Why not piggyback on clipboard-history rows: clipboard rows churn fast
// and a snippet is intentionally durable. Separate store keeps the model
// clean and makes "delete all clipboard history" not nuke snippets.
//
// The watcher uses a sliding buffer of the last MAX_TRIGGER_LEN keystrokes
// across the focused input/textarea. On the configured commit keys
// (space, tab, enter) it looks for any registered trigger as a suffix of
// the buffer; if found, replaces inline via document.execCommand('insertText')
// (works in textarea + contenteditable; falls back to selection splicing
// for inputs).

const STORAGE_KEY = 'klypix:palette:snippets:v1';
const MAX_TRIGGER_LEN = 32;
const COMMIT_KEYS = new Set([' ', 'Tab', 'Enter']);

export interface SnippetEntry {
    id: string;
    trigger: string;          // e.g. ';sig' — must NOT contain spaces
    name: string;             // human label shown in the palette
    body: string;             // text to insert when trigger fires
}

interface SnippetStore {
    triggers: Record<string, string>;   // trigger → snippetId
    bodies: Record<string, { name: string; body: string }>;
}

function load(): SnippetStore {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (raw) {
            const parsed = JSON.parse(raw);
            if (parsed && typeof parsed === 'object') return parsed as SnippetStore;
        }
    } catch { /* fall through */ }
    return { triggers: {}, bodies: {} };
}

function save(s: SnippetStore): void {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(s)); } catch { /* quota */ }
}

export function listSnippets(): SnippetEntry[] {
    const s = load();
    const out: SnippetEntry[] = [];
    for (const [trigger, id] of Object.entries(s.triggers)) {
        const body = s.bodies[id];
        if (!body) continue;
        out.push({ id, trigger, name: body.name, body: body.body });
    }
    return out.sort((a, b) => a.trigger.localeCompare(b.trigger));
}

export function upsertSnippet(entry: Omit<SnippetEntry, 'id'> & { id?: string }): SnippetEntry {
    const s = load();
    const id = entry.id ?? 'sn_' + Math.random().toString(36).slice(2) + Date.now().toString(36);
    // If trigger changed, remove old trigger mapping.
    for (const [t, sid] of Object.entries(s.triggers)) {
        if (sid === id && t !== entry.trigger) delete s.triggers[t];
    }
    s.triggers[entry.trigger] = id;
    s.bodies[id] = { name: entry.name, body: entry.body };
    save(s);
    return { id, trigger: entry.trigger, name: entry.name, body: entry.body };
}

export function deleteSnippet(id: string): void {
    const s = load();
    delete s.bodies[id];
    for (const [t, sid] of Object.entries(s.triggers)) {
        if (sid === id) delete s.triggers[t];
    }
    save(s);
}

// ── Watcher ─────────────────────────────────────────────────────────

let watcherInstalled = false;
let buffer = '';

function isEditableTarget(el: EventTarget | null): el is HTMLElement {
    if (!el || !(el instanceof HTMLElement)) return false;
    if (el.tagName === 'INPUT') {
        const t = (el as HTMLInputElement).type;
        // Don't expand inside password / hidden / file fields — accidental
        // expansion of a snippet trigger that happens to match a password
        // shouldn't be possible.
        if (t === 'password' || t === 'hidden' || t === 'file') return false;
        return true;
    }
    if (el.tagName === 'TEXTAREA') return true;
    if (el.isContentEditable) return true;
    return false;
}

function findTriggerMatch(): { trigger: string; body: string } | null {
    const s = load();
    // Match LONGEST trigger first so ';signature' beats ';sig' when both
    // are registered.
    const triggers = Object.keys(s.triggers).sort((a, b) => b.length - a.length);
    for (const t of triggers) {
        if (buffer.endsWith(t)) {
            const id = s.triggers[t];
            const body = s.bodies[id];
            if (body) return { trigger: t, body: body.body };
        }
    }
    return null;
}

function replaceInline(el: HTMLElement, trigger: string, body: string): boolean {
    // textarea / input: splice the value, place caret after the body.
    if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
        const input = el as HTMLInputElement | HTMLTextAreaElement;
        const value = input.value;
        const caret = input.selectionStart ?? value.length;
        // Trigger must appear as the chars immediately BEFORE the caret.
        const before = value.slice(0, caret);
        if (!before.endsWith(trigger)) return false;
        const next = before.slice(0, before.length - trigger.length) + body + value.slice(caret);
        input.value = next;
        const newCaret = before.length - trigger.length + body.length;
        input.setSelectionRange(newCaret, newCaret);
        // React-controlled inputs need an InputEvent to update state.
        input.dispatchEvent(new Event('input', { bubbles: true }));
        return true;
    }
    if (el.isContentEditable) {
        // contenteditable: walk back from the caret deleting `trigger`
        // chars, then insertText `body`. execCommand is deprecated but
        // remains the most portable inline-insertion path in 2026; the
        // newer Selection API equivalent requires manually firing input
        // events too.
        const sel = window.getSelection();
        if (!sel || sel.rangeCount === 0) return false;
        for (let i = 0; i < trigger.length; i++) {
            sel.modify('extend', 'backward', 'character');
        }
        try {
            document.execCommand('insertText', false, body);
            return true;
        } catch { return false; }
    }
    return false;
}

function onKeyDown(e: KeyboardEvent): void {
    if (!isEditableTarget(e.target)) {
        buffer = '';
        return;
    }
    const k = e.key;
    if (COMMIT_KEYS.has(k)) {
        const match = findTriggerMatch();
        if (match) {
            const el = e.target as HTMLElement;
            const ok = replaceInline(el, match.trigger, match.body);
            if (ok) {
                e.preventDefault();
                buffer = '';
                return;
            }
        }
        buffer = '';
        return;
    }
    if (k === 'Backspace') {
        buffer = buffer.slice(0, -1);
        return;
    }
    if (k.length === 1) {
        buffer = (buffer + k).slice(-MAX_TRIGGER_LEN);
    } else {
        // Arrow keys, function keys, modifiers — reset so partial-typed
        // triggers don't fire after a cursor jump.
        if (k.length > 1 && k !== 'Shift' && k !== 'Control' && k !== 'Alt' && k !== 'Meta') {
            buffer = '';
        }
    }
}

export function installSnippetWatcher(): () => void {
    if (watcherInstalled) return () => {};
    watcherInstalled = true;
    window.addEventListener('keydown', onKeyDown, true);
    return () => {
        window.removeEventListener('keydown', onKeyDown, true);
        watcherInstalled = false;
        buffer = '';
    };
}
