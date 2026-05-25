// Phase 23 — Keyboard model for the command palette.
//
// Centralized so the same key bindings work whether the user activates the
// palette from chat or canvas, and so the footer-hint strip can label the
// shortcuts uniformly. Returns intent enums; the caller maps intents to
// actual side-effects (state changes, selection moves, action dispatches).
//
// Key map:
//   Esc            → close
//   ArrowDown / ↓  → move selection down
//   ArrowUp   / ↑  → move selection up
//   Home           → first
//   End            → last
//   PageDown       → +5
//   PageUp         → -5
//   Enter          → primary action on the highlighted row
//   Tab            → cycle to next secondary action label
//   Shift+Tab      → cycle to previous secondary action label
//   Shift+Enter    → run first secondary action (Open in new way)
//   Ctrl+Enter     → "send to chat" semantic — second secondary slot
//   Ctrl+Shift+Enter → "send to canvas" semantic — third secondary slot
//   Ctrl+1..9      → jump to nth result and run its primary

export type PaletteIntent =
    | { kind: 'close' }
    | { kind: 'move'; delta: number }
    | { kind: 'jump'; to: 'top' | 'bottom' | number }
    | { kind: 'primary' }
    | { kind: 'secondary'; index: number }
    | { kind: 'cycle-secondary'; delta: 1 | -1 }
    | { kind: 'send-to-chat' }
    | { kind: 'send-to-canvas' };

/** Parse a keyboard event into a palette intent. Returns null for keys we
 *  don't intercept (so they bubble — letters into the search input, etc.). */
export function intentFromKey(e: KeyboardEvent | React.KeyboardEvent): PaletteIntent | null {
    const k = e.key;
    const ctrl = e.ctrlKey || e.metaKey;  // accept either modifier
    const shift = e.shiftKey;

    if (k === 'Escape') return { kind: 'close' };

    // Ctrl+1..9 → jump
    if (ctrl && /^[1-9]$/.test(k)) {
        return { kind: 'jump', to: parseInt(k, 10) - 1 };
    }

    if (k === 'ArrowDown') return { kind: 'move', delta: 1 };
    if (k === 'ArrowUp') return { kind: 'move', delta: -1 };
    if (k === 'PageDown') return { kind: 'move', delta: 5 };
    if (k === 'PageUp') return { kind: 'move', delta: -5 };
    if (k === 'Home') return { kind: 'jump', to: 'top' };
    if (k === 'End') return { kind: 'jump', to: 'bottom' };

    if (k === 'Enter') {
        if (ctrl && shift) return { kind: 'send-to-canvas' };
        if (ctrl) return { kind: 'send-to-chat' };
        if (shift) return { kind: 'secondary', index: 0 };
        return { kind: 'primary' };
    }

    if (k === 'Tab') {
        return { kind: 'cycle-secondary', delta: shift ? -1 : 1 };
    }

    return null;
}

/** Should the global Ctrl+K open the palette FROM this target? Returns
 *  false when focus is inside a contenteditable that explicitly opts out
 *  via data-palette-ignore="1" (used for surfaces where Ctrl+K already has
 *  a meaning — e.g. a code editor binding). For normal text inputs we
 *  still open: matches Raycast/Alfred conventions where Cmd+K wins. */
export function shouldHotkeyFire(target: EventTarget | null): boolean {
    if (!target || !(target instanceof HTMLElement)) return true;
    if (target.closest('[data-palette-ignore="1"]')) return false;
    return true;
}
