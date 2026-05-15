import type { CanvasItem, Connection } from '../items/types';
import { BUILTIN_TEMPLATES } from './builtinTemplates';

// Minimal template library stored in localStorage so presets survive app
// restart. Each template snapshots a selection of items + any connections
// whose endpoints are both inside the snapshot, normalized so the top-left
// of the bounding box is at (0, 0). Stamping pastes a clone at the user's
// chosen world-coord anchor with fresh ids.

const STORAGE_KEY = 'klypix_canvas_templates_v1';

export interface Template {
    id: string;
    name: string;
    createdAt: number;
    items: CanvasItem[];
    connections: Connection[];
    // Built-in starter templates ship with the app so first-time users see
    // what templates look like instead of an empty panel. They live in code
    // (not localStorage) and can be stamped but not deleted/renamed.
    isBuiltin?: boolean;
}

export function isBuiltinTemplateId(id: string): boolean {
    return id.startsWith('builtin_');
}

export function listTemplates(): Template[] {
    const user = readUserTemplates();
    // Built-ins always come first so the panel has visible content out of
    // the box. User templates appear below in save order (most recent first).
    return [...BUILTIN_TEMPLATES, ...user];
}

function readUserTemplates(): Template[] {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (!raw) return [];
        const parsed = JSON.parse(raw);
        if (!Array.isArray(parsed)) return [];
        return parsed.filter((t: Template) => !isBuiltinTemplateId(t.id));
    } catch { return []; }
}

function writeTemplates(list: Template[]): void {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(list)); } catch { /* storage full */ }
}

export function saveTemplate(name: string, items: CanvasItem[], connections: Connection[]): Template {
    if (items.length === 0) throw new Error('No items selected');
    // Translate so the bounding box starts at (0, 0) — stamping will then
    // add the target anchor position.
    let minX = Infinity, minY = Infinity;
    for (const it of items) { if (it.x < minX) minX = it.x; if (it.y < minY) minY = it.y; }
    const normalizedItems = items.map(it => ({ ...it, x: it.x - minX, y: it.y - minY }));
    const tpl: Template = {
        id: `tpl_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
        name: name.trim() || `Template ${Date.now()}`,
        createdAt: Date.now(),
        items: normalizedItems,
        connections,
    };
    writeTemplates([tpl, ...readUserTemplates()].slice(0, 100));
    return tpl;
}

export function deleteTemplate(id: string): void {
    if (isBuiltinTemplateId(id)) return;  // built-ins are protected
    writeTemplates(readUserTemplates().filter(t => t.id !== id));
}

// Return a cloned set of items + connections with fresh ids, shifted so the
// template's top-left sits at (anchorX, anchorY). Caller dispatches the
// results into the canvas state.
export function stampTemplate(tpl: Template, anchorX: number, anchorY: number): { items: CanvasItem[]; connections: Connection[] } {
    const idMap = new Map<string, string>();
    const now = Date.now();
    // First pass: allocate fresh ids so children can resolve their new parentId
    // in the second pass even if they appear before the container in the list.
    for (let i = 0; i < tpl.items.length; i++) {
        const newId = `stamp_${now.toString(36)}_${i}_${Math.random().toString(36).slice(2, 5)}`;
        idMap.set(tpl.items[i].id, newId);
    }
    const items = tpl.items.map(it => ({
        ...it,
        id: idMap.get(it.id)!,
        // Templates with containers were losing child-parent links because
        // parentId still pointed at the original (now non-existent) container.
        parentId: it.parentId && idMap.has(it.parentId) ? idMap.get(it.parentId)! : null,
        x: it.x + anchorX,
        y: it.y + anchorY,
        createdAt: now,
        // Reset transient fields so the stamp doesn't inherit edit state.
        ...(it.type === 'text' ? { thread: undefined } : {}),
    }) as CanvasItem);
    const connections = tpl.connections
        .filter(c => idMap.has(c.fromId) && idMap.has(c.toId))
        .map((c, i) => ({
            ...c,
            id: `stampc_${now.toString(36)}_${i}`,
            fromId: idMap.get(c.fromId)!,
            toId: idMap.get(c.toId)!,
        }));
    return { items, connections };
}
