// Phase 23 — Global Ctrl+K (or Cmd+K) hotkey to toggle the command palette.
//
// Lives at the app root next to the palette modal. Listens at the window
// level so any focus (chat input, canvas surface, settings panel — anywhere)
// will trigger. The shouldHotkeyFire guard skips contenteditable surfaces
// that explicitly opt out via data-palette-ignore="1" (none today; future
// embedded code editors).
//
// Why a hook + window listener rather than the React onKeyDown ladder:
// React's synthetic events fire after the document-level capture phase,
// and some surfaces stopPropagation in onKeyDown (e.g. text editors).
// A window listener wins those races and gives consistent Ctrl+K behavior
// no matter where focus is.

import { useEffect } from 'react';
import { shouldHotkeyFire } from './keyboardModel';
import { toggle, openWithPrefix } from './paletteStore';

export function useGlobalHotkey(): void {
    useEffect(() => {
        const handler = (e: KeyboardEvent) => {
            if (!(e.ctrlKey || e.metaKey)) return;
            const key = e.key.toLowerCase();
            // Ctrl+K — toggle the full palette.
            if (key === 'k') {
                if (!shouldHotkeyFire(e.target)) return;
                e.preventDefault();
                e.stopPropagation();
                toggle();
                return;
            }
            // Ctrl+O — quick-switch / search canvases (VSCode-style). Opens the
            // palette pre-filtered to the canvas provider's prefix.
            if (key === 'o') {
                if (!shouldHotkeyFire(e.target)) return;
                e.preventDefault();
                e.stopPropagation();
                openWithPrefix('canvas:');
                return;
            }
        };
        // Capture phase so we beat any inner stopPropagation. Window-level
        // because Electron's renderer doesn't always fire document-level
        // events when the focus is in a frameless drag region.
        window.addEventListener('keydown', handler, true);
        return () => window.removeEventListener('keydown', handler, true);
    }, []);
}
