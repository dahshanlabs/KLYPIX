// Phase 23 — Provider registration entry point.
//
// Called once from AppMain on mount. Imports + registers every provider
// the palette should know about. New providers (Day 3 Clipboard, Day 4
// Apps, Day 5 Files / Web / AI) extend this single file.
//
// Why a separate registration module rather than each provider
// self-registering: the palette must work even when consumed in isolation
// (e.g. a future embedded preview build), and providers should be
// composable without import-order side effects. Explicit registration
// from one place keeps the surface area auditable.

import { register, refresh } from './paletteStore';
import { calculatorProvider, resetCalcScope } from './providers/calculatorProvider';
import { klypixSearchProvider } from './providers/klypixSearchProvider';
import { canvasProvider } from './providers/canvasProvider';
import { clipboardProvider } from './providers/clipboardProvider';
import { snippetProvider } from './providers/snippetProvider';
import { appsProvider } from './providers/appsProvider';
import { filesProvider } from './providers/filesProvider';
import { webProvider } from './providers/webProvider';
import { aiProvider } from './providers/aiProvider';
import { installSnippetWatcher } from './snippets';

let registered = false;
let activeDisposers: Array<() => void> = [];

export function registerAllProviders(): () => void {
    if (registered) return () => {};
    registered = true;
    activeDisposers = [
        register(calculatorProvider),
        register(klypixSearchProvider),
        register(canvasProvider),
        register(clipboardProvider),
        register(snippetProvider),
        register(appsProvider),
        register(filesProvider),
        register(webProvider),
        register(aiProvider),
        // Snippet keystroke watcher — installs ONCE here so it's tied to
        // palette providers lifecycle. Returns its own teardown which the
        // dispose loop calls on unmount.
        installSnippetWatcher(),
    ];
    // Re-run query so any provider that was just registered gets a chance
    // to populate the visible list without the user retyping.
    refresh();
    return () => {
        for (const d of activeDisposers) d();
        activeDisposers = [];
        resetCalcScope();
        registered = false;
    };
}

// Vite HMR: when ANY provider file hot-reloads, this module re-evaluates.
// We dispose the old providers and re-register the new ones so the
// updated objects (with new keepOpen flags, new icons, etc.) take effect
// without requiring a full Ctrl+R reload. The hot.accept hooks below
// invalidate THIS module whenever a downstream provider changes.
// Vite HMR types live behind `vite/client`; cast to any so we don't
// have to thread the reference comment + tsconfig change.
const hot = (import.meta as any).hot;
if (hot) {
    hot.dispose(() => {
        for (const d of activeDisposers) d();
        activeDisposers = [];
        registered = false;
    });
    // Accept hot-reloads from each provider file so a change there
    // bubbles back here and re-runs registerAllProviders next.
    hot.accept([
        './providers/calculatorProvider',
        './providers/klypixSearchProvider',
        './providers/canvasProvider',
        './providers/clipboardProvider',
        './providers/snippetProvider',
        './providers/appsProvider',
        './providers/filesProvider',
        './providers/webProvider',
        './providers/aiProvider',
    ], () => {
        // Dispose stale registrations, then re-register fresh ones.
        for (const d of activeDisposers) d();
        activeDisposers = [];
        registered = false;
        registerAllProviders();
    });
}
