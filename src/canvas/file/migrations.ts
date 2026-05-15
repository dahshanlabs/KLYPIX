import { generateNKeysBetween } from 'fractional-indexing';

// Schema migration framework for the .any file format.
//
// A Migration upgrades a parsed canvas document from one schema version to
// the next. Migrations are intended for SHAPE changes (renamed fields, new
// required fields, restructured arrays) — anything where an old file simply
// cannot be loaded by new code without transformation.
//
// Within-version drift (legacy field aliases, idempotent fixups, default
// backfills) does NOT belong here. That logic stays in anyFormat.ts's
// normalize pass and runs every load regardless of version.
//
// Adding a migration:
//   1. Define a `CanvasDocumentVN` interface in anyFormat.ts for the new shape.
//   2. Bump CURRENT_VERSION in anyFormat.ts to N.
//   3. Append a Migration entry below with `from: N-1, to: N`. The migrate
//      function MUST set `doc.version = N` on the returned object.
//   4. Update anyFormat.ts's deserialize return type to CanvasDocumentVN.
//   5. Test by loading a file saved by the previous build.

export interface Migration {
    from: number;
    to: number;
    // Pure transform: must not read app state, fetch resources, or have side
    // effects. May mutate `doc` in place — the runner treats the migration
    // as taking ownership of the doc for the duration of its call.
    migrate: (doc: any) => any;
}

// Ordered list of every shipped schema migration. New entries append; do not
// reorder or remove past entries (old user files still reference them).
export const MIGRATIONS: Migration[] = [
    {
        // v1 → v2: backfill `zKey` (fractional sort key) on every item.
        // Pre-v2 files relied on `state.order` array position as the sole
        // z-order. v2 items carry a fractional string key as the source of
        // truth; the order array stays sorted by it. generateNKeysBetween
        // produces evenly-spaced keys so a future "insert between two items"
        // op can compute a new key without touching any sibling.
        from: 1, to: 2,
        migrate: (doc: any) => {
            const order: string[] = Array.isArray(doc.order) ? doc.order : [];
            const items: any[] = Array.isArray(doc.items) ? doc.items : [];
            if (order.length > 0) {
                const keys: string[] = generateNKeysBetween(null, null, order.length);
                const byId = new Map<string, any>();
                for (const it of items) {
                    if (it && typeof it.id === 'string') byId.set(it.id, it);
                }
                for (let i = 0; i < order.length; i++) {
                    const it = byId.get(order[i]);
                    if (it && !it.zKey) it.zKey = keys[i];
                }
            }
            doc.version = 2;
            return doc;
        },
    },
    {
        // v2 → v3: backfill `zKey` on every line + freehand stroke. Pre-v3
        // drawings rendered as a single layer ABOVE all items, regardless
        // of any per-drawing order. v3 unifies their z-order with items so
        // the Arrange menu can send a stroke behind a box.
        //
        // The new keys are generated above the topmost item key in each
        // parent group, preserving the visual fact that pre-v3 drawings
        // sat on top of items. Drawings within the same parent are spaced
        // evenly so a later "insert between two strokes" stays cheap.
        from: 2, to: 3,
        migrate: (doc: any) => {
            const items: any[] = Array.isArray(doc.items) ? doc.items : [];
            const lines: any[] = Array.isArray(doc.lines) ? doc.lines : [];
            const strokes: any[] = Array.isArray(doc.strokes) ? doc.strokes : [];

            // Group drawings by parentId. Top-level → null bucket.
            const drawingsByParent = new Map<string | null, any[]>();
            const bucketOf = (parentId: string | null) => {
                let arr = drawingsByParent.get(parentId);
                if (!arr) { arr = []; drawingsByParent.set(parentId, arr); }
                return arr;
            };
            for (const ln of lines) bucketOf(ln?.parentId ?? null).push(ln);
            for (const st of strokes) bucketOf(st?.parentId ?? null).push(st);

            // Top item zKey per parent — the lower bound for new drawing keys.
            const topItemKeyPerParent = new Map<string | null, string | null>();
            for (const it of items) {
                if (!it || !it.zKey) continue;
                const pid = it.parentId ?? null;
                const cur = topItemKeyPerParent.get(pid) ?? null;
                if (cur === null || it.zKey > cur) topItemKeyPerParent.set(pid, it.zKey);
            }

            for (const [parentId, drawings] of drawingsByParent) {
                if (drawings.length === 0) continue;
                // Skip any drawing that already has a zKey (idempotent).
                const needs = drawings.filter(d => !d.zKey);
                if (needs.length === 0) continue;
                const lower = topItemKeyPerParent.get(parentId) ?? null;
                const keys: string[] = generateNKeysBetween(lower, null, needs.length);
                for (let i = 0; i < needs.length; i++) needs[i].zKey = keys[i];
            }

            doc.version = 3;
            return doc;
        },
    },
];

/**
 * Walk the migration chain from `fromVersion` up to `targetVersion`. Returns
 * the same doc reference (potentially mutated) at the target version.
 *
 * Throws when:
 *   - the file is newer than the build supports (`fromVersion > targetVersion`)
 *   - no migration is registered for an intermediate step
 */
export function runMigrations(doc: any, fromVersion: number, targetVersion: number): any {
    if (fromVersion === targetVersion) return doc;
    if (fromVersion > targetVersion) {
        throw new Error(
            `Canvas file is version ${fromVersion}; this build supports up to ${targetVersion}. ` +
            `Update KLYPIX to open it.`
        );
    }
    let current = fromVersion;
    let working = doc;
    while (current < targetVersion) {
        const step = MIGRATIONS.find(m => m.from === current);
        if (!step) {
            throw new Error(
                `No migration registered from canvas version ${current} → ${current + 1}. ` +
                `File cannot be loaded.`
            );
        }
        working = step.migrate(working);
        current = step.to;
    }
    return working;
}
