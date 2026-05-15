// Module-level registry linking a pending approval item to the agent's
// awaiting Promise resolver. Not persisted — if the app restarts mid-ask,
// the approval card remains on the canvas (since decision is stored in
// state) but the agent run that was waiting is dead anyway.
//
// Why not React context: resolvers are looked up from inside a button click
// handler and from inside the async tool executor; both live outside the
// React render tree, so a module singleton is the natural fit.

interface PendingEntry {
    resolve: (decision: string) => void;
    timer?: ReturnType<typeof setTimeout>;
}

const pending = new Map<string, PendingEntry>();

export interface WaitOptions {
    /** If set, resolves with this value after the timeout expires. */
    timeoutMs?: number;
    /** Value used on timeout. Defaults to '__timeout__'. */
    timeoutValue?: string;
}

export function waitForApproval(itemId: string, opts: WaitOptions = {}): Promise<string> {
    return new Promise<string>((resolve) => {
        const entry: PendingEntry = { resolve };
        if (opts.timeoutMs && opts.timeoutMs > 0) {
            entry.timer = setTimeout(() => {
                if (pending.get(itemId) === entry) {
                    pending.delete(itemId);
                    resolve(opts.timeoutValue ?? '__timeout__');
                }
            }, opts.timeoutMs);
        }
        pending.set(itemId, entry);
    });
}

export function resolveApproval(itemId: string, decision: string): boolean {
    const entry = pending.get(itemId);
    if (!entry) return false;
    if (entry.timer) clearTimeout(entry.timer);
    pending.delete(itemId);
    entry.resolve(decision);
    return true;
}

/** Release any pending waits — used when a tab is closed or reset. */
export function clearApprovals(): void {
    for (const entry of pending.values()) {
        if (entry.timer) clearTimeout(entry.timer);
        entry.resolve('__cancelled__');
    }
    pending.clear();
}
