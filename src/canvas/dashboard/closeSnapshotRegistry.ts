// Lets each CanvasSurface register a "give me your serialized state" getter
// keyed by its tab id, so KlypixCanvas's onCloseTab can capture the state
// for the recently-closed list right before the tab unmounts.
//
// This is a module-level Map, NOT React state. Reasons:
//   - We need to read it from a stable callback (onCloseTab) without
//     causing the callback to re-create whenever any tab's state changes.
//   - The getter itself reads from a useRef inside the CanvasSurface, so
//     it always sees the latest state at call time — no stale closures.
//   - The map only lives as long as the running process; no persistence.

export interface CloseSnapshot {
    title: string;
    filePath: string | null;
    snapshotJson: string;
    itemCount: number;
}

type Getter = () => CloseSnapshot | null;

const registry = new Map<string, Getter>();

/** Register a snapshot getter for a tab. Returns an unregister function. */
export function registerCloseSnapshot(tabId: string, getter: Getter): () => void {
    registry.set(tabId, getter);
    return () => {
        if (registry.get(tabId) === getter) registry.delete(tabId);
    };
}

/** Read the current snapshot for a tab, or null if no getter is registered
 *  (e.g. the surface didn't mount) or the getter says the canvas is empty. */
export function captureCloseSnapshot(tabId: string): CloseSnapshot | null {
    const g = registry.get(tabId);
    if (!g) return null;
    try { return g(); } catch { return null; }
}
