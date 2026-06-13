import type { CanvasState } from '../state/canvasStore';
import type { CanvasItem, Connection, DrawnLine, FreehandStroke, ViewState } from '../items/types';
import {
    COLLAPSED_W_SEED_VERSION_CURRENT,
    PATHOLOGICAL_CAPSULE_SCALE,
    computeCompactCollapsedW,
    computeNaturalTabScreenW,
} from '../items/ContainerItem';
import { runMigrations } from './migrations';

// On-disk format for the .any file's canvas.json. Kept as its own shape (not
// CanvasState directly) so we can version it and migrate future changes without
// breaking older files. Schema-shape changes go through migrations.ts;
// within-version backfills go through normalizeV1 below.

// v1 shape kept around for the migration registry's reference.
export interface CanvasDocumentV1 {
    version: 1;
    createdAt: string;
    updatedAt: string;
    title: string;
    view: ViewState;
    items: CanvasItem[];
    order: string[];
    connections?: Connection[];
    lines?: DrawnLine[];
    strokes?: FreehandStroke[];
    nextGroupNumber?: number;
}

// v2 added fractional `zKey` on every item as the source-of-truth z-order.
// Same top-level shape as v1; the change is per-item (BaseItem.zKey) and
// the v1→v2 migration backfills keys from the existing order array.
export interface CanvasDocumentV2 extends Omit<CanvasDocumentV1, 'version'> {
    version: 2;
}

// v3 added zKey on DrawnLine and FreehandStroke too, unifying their z-order
// with items so the Arrange menu can send a stroke behind a box. Same
// top-level shape; the change is per-drawing. v2→v3 backfills keys above
// the topmost item per parent.
export interface CanvasDocumentV3 extends Omit<CanvasDocumentV1, 'version'> {
    version: 3;
}

export const CURRENT_VERSION = 3 as const;

export function serialize(state: CanvasState, title: string): CanvasDocumentV3 {
    const now = new Date().toISOString();
    return {
        version: CURRENT_VERSION,
        createdAt: now,         // Callers that preserve original createdAt should overwrite.
        updatedAt: now,
        title,
        view: state.view,
        // Containers: dual-write `collapsed` (legacy) AND `userCollapsed`
        // (current) for one release cycle so older builds opening files
        // saved by newer builds still read the right collapse state.
        // Remove the `collapsed` write after the migration window.
        items: state.order.map(id => {
            const it = state.items[id];
            if (!it) return null;
            if (it.type === 'container') {
                const anyIt: any = it;
                const user = anyIt.userCollapsed ?? anyIt.collapsed ?? false;
                return { ...anyIt, collapsed: user, userCollapsed: user };
            }
            return it;
        }).filter(Boolean) as CanvasItem[],
        order: [...state.order],
        connections: Object.values(state.connections),
        lines: Object.values(state.lines),
        strokes: Object.values(state.strokes),
        nextGroupNumber: state.nextGroupNumber,
    };
}

export function deserialize(json: string): CanvasDocumentV3 {
    const parsed = JSON.parse(json);
    if (!parsed || typeof parsed !== 'object') throw new Error('Invalid canvas.json');

    const fileVersion = typeof parsed.version === 'number' ? parsed.version : NaN;
    if (!Number.isFinite(fileVersion)) {
        throw new Error('Invalid canvas.json: missing or non-numeric version');
    }

    // Walk the registered migration chain to bring the doc up to CURRENT_VERSION.
    // Throws on newer-than-supported files and on missing intermediate migrations.
    const migrated = runMigrations(parsed, fileVersion, CURRENT_VERSION);

    if (!Array.isArray(migrated.items) || !Array.isArray(migrated.order)) {
        throw new Error('Invalid canvas.json: missing items/order');
    }

    return normalizeV3(migrated as CanvasDocumentV3);
}

// Within-version normalization: applied every load regardless of version.
// Handles legacy field aliases (collapsed → userCollapsed) and idempotent
// fixups (collapsedW seed re-seed for files that pre-date the compact
// natural formula). Schema-shape changes belong in migrations.ts, not here.
function normalizeV3(doc: CanvasDocumentV3): CanvasDocumentV3 {
    // Pre-compute which containers have sub-groups — needed for the
    // collapsed-tab natural-width measure below. Single pass across items
    // keeps the normalization O(n) rather than O(n²).
    const hasSubGroupsByParent = new Map<string, boolean>();
    for (const it of doc.items) {
        if (it && it.type === 'container' && it.parentId) {
            hasSubGroupsByParent.set(it.parentId, true);
        }
    }
    for (const it of doc.items) {
        if (it && it.type === 'container') {
            const anyIt: any = it;
            // Older files stored only `collapsed` on containers. Read
            // that as the source of truth for `userCollapsed` if the
            // new field is absent. Keep both fields in memory so
            // serialize's dual-write round-trips without losing either.
            if (anyIt.userCollapsed == null) {
                anyIt.userCollapsed = anyIt.collapsed ?? false;
            }
            // Spec: chevron only exists at depth 0, so a nested group
            // can't be "user-collapsed" by definition. Legacy files
            // with collapsed=true on a nested container get cleared.
            if (it.parentId != null) {
                anyIt.userCollapsed = false;
                anyIt.collapsed = false;
            }
            // Collapsed-tab seed audit. Pre-fix files seeded collapsedW
            // to item.w, which at high zoom × wide group produced
            // capsules ~10× their natural size. If the stored seed
            // version is older than CURRENT and capsuleScale-at-zoom-1
            // exceeds the pathological threshold, re-seed via the
            // compact formula the runtime now uses on first collapse.
            // The version marker keeps this idempotent across loads
            // and is bumped whether or not we re-seeded. Strict `<`
            // (not `!==`) so a file saved by a future build isn't
            // silently downgraded.
            const seedVersion = anyIt.collapsedWSeedVersion ?? 0;
            if (anyIt.userCollapsed && seedVersion < COLLAPSED_W_SEED_VERSION_CURRENT) {
                const hasSubGroups = hasSubGroupsByParent.get(it.id) === true;
                const natural = computeNaturalTabScreenW(it, { hasSubGroups, isFocused: false });
                const storedW = typeof anyIt.collapsedW === 'number' ? anyIt.collapsedW : (it as any).w;
                const scaleAtZoom1 = storedW / Math.max(1, natural);
                if (scaleAtZoom1 > PATHOLOGICAL_CAPSULE_SCALE) {
                    anyIt.collapsedW = computeCompactCollapsedW(it, 1, { hasSubGroups, isFocused: false });
                }
                anyIt.collapsedWSeedVersion = COLLAPSED_W_SEED_VERSION_CURRENT;
            }
        }
    }

    // Heal archived cards that a past group-shrink baked microscopic. The
    // Archive is readable STORAGE, not a designed (proportionally vector-scaled)
    // layout, so an archived text card whose font was scaled below readability
    // is restored to its authored size — the frozen baseline (authoredInParent)
    // is intact — and that baseline is dropped so it re-seeds full-size in the
    // Archive. Idempotent: once font ≥ floor it never re-triggers. (Root-caused
    // from a superseded card rendering at fontSize 3.2 vs the authored 12.)
    const ARCHIVE_FONT_FLOOR = 6;
    const archiveIds = new Set(
        doc.items.filter(it => it && it.type === 'container' && /^archive$/i.test((it as { title?: string }).title || '')).map(it => it.id),
    );
    if (archiveIds.size) {
        for (const it of doc.items) {
            if (!it || it.type !== 'text' || !it.parentId || !archiveIds.has(it.parentId)) continue;
            const t = it as { fontSize?: number; w?: number; authoredWidth?: number; authoredInParent?: { fontSize?: number; w?: number; authoredWidth?: number } };
            const a = t.authoredInParent;
            if (a && a.fontSize && (t.fontSize ?? 0) < ARCHIVE_FONT_FLOOR) {
                t.fontSize = a.fontSize;
                if (a.w) t.w = a.w;
                if (a.authoredWidth != null) t.authoredWidth = a.authoredWidth;
                t.authoredInParent = undefined;
            }
        }
    }
    return doc;
}

/** Filename stem → title (strips .klypix or legacy .any, replaces _- with spaces). */
export function titleFromPath(filePath: string): string {
    const segs = filePath.split(/[\\/]/).filter(Boolean);
    const name = segs.pop() || 'untitled.klypix';
    const stem = name.replace(/\.(klypix|any)$/i, '').replace(/[_-]+/g, ' ').trim();
    // Every project brain is literally "brain.klypix" (the global convention),
    // so the bare stem is useless in any list — qualify with the project
    // folder: E:\…\AgentLit\brain.klypix → "AgentLit brain".
    if (/^brain$/i.test(stem) && segs.length) return `${segs[segs.length - 1]} brain`;
    return stem || 'Untitled';
}

/** A stored title wins only when it's MEANINGFUL — empty or the literal
 *  "Untitled" falls back to a name derived from the file path. Keeps a
 *  brain.klypix saved from an untitled canvas from listing as "Untitled"
 *  everywhere (tabs, recents, recently-closed). */
export function preferTitle(title: string | undefined | null, filePath: string): string {
    const t = (title || '').trim();
    return t && !/^untitled$/i.test(t) ? t : titleFromPath(filePath);
}
