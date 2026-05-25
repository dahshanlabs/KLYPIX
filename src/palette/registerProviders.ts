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
import { clipboardProvider } from './providers/clipboardProvider';

let registered = false;

export function registerAllProviders(): () => void {
    if (registered) return () => {};
    registered = true;
    const disposers = [
        register(calculatorProvider),
        register(klypixSearchProvider),
        register(clipboardProvider),
    ];
    // Re-run query so any provider that was just registered gets a chance
    // to populate the visible list without the user retyping.
    refresh();
    return () => {
        for (const d of disposers) d();
        resetCalcScope();
        registered = false;
    };
}
