import type { CanvasItem } from '../items/types';

// Determines which canvas items the agent should "see" for a given command.
// See docs/CLAUDE-KLYPIX-CANVAS.md §4.

export type ScopeKind = 'selected' | 'container' | 'full_canvas' | 'empty';

export interface CommandScope {
    kind: ScopeKind;
    itemIds: string[];
    description: string;
    // For kind='container': the container's own id (itemIds holds its
    // CHILDREN). Agents use this to anchor a single summary connection
    // to the group instead of fanning one arrow per child.
    anchorId?: string;
}

/**
 * Walk all items, respecting scope-locked containers. Items inside a locked
 * container are EXCLUDED from full-canvas scope (the agent outside can't see
 * into the container). Callers can override by selecting explicitly.
 */
function visibleToOutside(items: Record<string, CanvasItem>, allOrder: string[]): string[] {
    const locked = new Set<string>();
    for (const it of Object.values(items)) {
        if (it.type === 'container' && it.scopeLocked) locked.add(it.id);
    }
    if (locked.size === 0) return allOrder;
    return allOrder.filter(id => {
        const it = items[id];
        return !it?.parentId || !locked.has(it.parentId);
    });
}

export function resolveScope(
    command: string,
    selectedIds: string[],
    allOrder: string[],
    items: Record<string, CanvasItem> = {},
    commandPosition?: { x: number; y: number } | null,
): CommandScope {
    // If a single container is selected, treat as "inside this container".
    // Scope-locked containers still show their own children when explicitly
    // selected (bidirectional lock only applies to OUTSIDE queries).
    if (selectedIds.length === 1) {
        const sole = items[selectedIds[0]];
        if (sole?.type === 'container') {
            const kids = allOrder.filter(id => items[id]?.parentId === sole.id);
            return {
                kind: 'container',
                itemIds: kids,
                description: `inside "${sole.title}" (${kids.length} items)${sole.scopeLocked ? ' · locked' : ''}`,
                anchorId: sole.id,
            };
        }
    }

    if (selectedIds.length > 0) {
        // Selection may span items from inside a locked container. That's OK —
        // explicit selection bypasses scope-lock from the user's point of view.
        return {
            kind: 'selected',
            itemIds: selectedIds,
            description: `${selectedIds.length} ${selectedIds.length === 1 ? 'item' : 'items'} selected`,
        };
    }

    // Nearby: if the command was invoked at a canvas position (not from chat
    // bar), consider items within a radius of that point. Falls back to full
    // canvas if no position is provided.
    if (commandPosition) {
        const RADIUS = 600;
        const nearby: string[] = [];
        const visible = new Set(visibleToOutside(items, allOrder));
        for (const id of allOrder) {
            if (!visible.has(id)) continue;
            const it = items[id];
            if (!it) continue;
            const cx = it.x + it.w / 2;
            const cy = it.y + it.h / 2;
            if (Math.hypot(cx - commandPosition.x, cy - commandPosition.y) <= RADIUS) {
                nearby.push(id);
            }
        }
        if (nearby.length > 0) {
            return {
                kind: 'selected',  // treat nearby like selection-style scope
                itemIds: nearby,
                description: `${nearby.length} nearby items`,
            };
        }
    }

    const visible = visibleToOutside(items, allOrder);
    if (visible.length === 0) {
        return { kind: 'empty', itemIds: [], description: 'empty canvas' };
    }
    return {
        kind: 'full_canvas',
        itemIds: visible,
        description: `full canvas (${visible.length} items)`,
    };
}

/** Serialize items into a text block for the LLM prompt. */
export function renderItemsForPrompt(items: CanvasItem[]): string {
    if (items.length === 0) return '(no items)';
    return items
        .map((it, i) => {
            const tag = `[${i + 1}]`;
            switch (it.type) {
                case 'text':
                    return `${tag} text [id=${it.id}]: ${it.content.trim() || '(empty)'}`;
                case 'box':
                    return `${tag} box [id=${it.id}] (visual frame, no content)`;
                case 'image':
                    return `${tag} image [id=${it.id}]: ${it.fileName} (${it.originalWidth}x${it.originalHeight}px)`;
                case 'file':
                    return `${tag} file [id=${it.id}]: ${it.fileName} (${it.extension.toUpperCase()}, ${Math.round(it.fileSize / 1024)} KB)`;
                case 'video':
                    return `${tag} video [id=${it.id}]: ${it.fileName} (${it.extension.toUpperCase()}, ${it.durationSec ? Math.round(it.durationSec) + 's' : '?'})`;
                case 'audio':
                    return `${tag} audio [id=${it.id}]: ${it.fileName} (${it.extension.toUpperCase()}, ${it.durationSec ? Math.round(it.durationSec) + 's' : '?'})`;
                case 'code':
                    return `${tag} code [id=${it.id}]: ${it.fileName || `(${it.language})`} — ${it.code.slice(0, 120).replace(/\s+/g, ' ')}…`;
                case 'container':
                    return `${tag} container [id=${it.id}]: "${it.title}" (${it.collapsed ? 'collapsed' : 'expanded'}${it.scopeLocked ? ', locked' : ''})`;
                default:
                    return `${tag} unknown`;
            }
        })
        .join('\n');
}
