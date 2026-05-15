import type { CanvasItem } from '../items/types';
import type { Template } from './templates';

// Starter templates that ship with the app so the Templates panel has
// visible content out of the box. Without these, first-time users see only
// an empty-state hint and never learn what a template is. They live in code
// (not localStorage), are stamped with fresh ids like any other template,
// and cannot be deleted from the UI.
//
// Coordinates are authored top-left at (0, 0); saveTemplate() normalizes
// user templates the same way, and stampTemplate() re-anchors at the
// viewport center on insert, so we can just pick natural positions here.

const NOW = 0;  // createdAt — anything stable; gets overwritten on stamp

function txt(over: Partial<CanvasItem> & { id: string; x: number; y: number; w: number; h: number; content: string }): CanvasItem {
    return {
        type: 'text',
        zIndex: 0,
        locked: false,
        parentId: null,
        createdAt: NOW,
        createdBy: 'user',
        fontSize: 16,
        color: '#e8e8ed',
        border: false,
        borderColor: '#10b981',
        heading: false,
        ...over,
    } as CanvasItem;
}

// 1) Sticky note — a single warm-yellow bordered card. Demonstrates the
// bordered-text + custom fill combo.
const stickyNote: Template = {
    id: 'builtin_sticky_note',
    name: 'Sticky note',
    createdAt: NOW,
    isBuiltin: true,
    items: [
        txt({
            id: 'tpl_sticky_1',
            x: 0, y: 0, w: 240, h: 140,
            content: 'Note title\n\nWrite your thought here…',
            fontSize: 15,
            color: '#1c1917',
            border: true,
            borderColor: '#f59e0b',
            borderWidth: 2,
            fillColor: '#fef3c7',
        } as any),
    ],
    connections: [],
};

// 2) Pros & Cons — two side-by-side bordered cards in green / red. Shows
// how a template can capture more than one item with consistent styling.
const prosAndCons: Template = {
    id: 'builtin_pros_cons',
    name: 'Pros & Cons',
    createdAt: NOW,
    isBuiltin: true,
    items: [
        txt({
            id: 'tpl_pros_1',
            x: 0, y: 0, w: 220, h: 180,
            content: '✓ Pros\n\n• Point one\n• Point two\n• Point three',
            fontSize: 14,
            border: true,
            borderColor: '#10b981',
            borderWidth: 2,
            fillColor: 'rgba(16,185,129,0.08)',
        } as any),
        txt({
            id: 'tpl_cons_1',
            x: 240, y: 0, w: 220, h: 180,
            content: '✗ Cons\n\n• Point one\n• Point two\n• Point three',
            fontSize: 14,
            border: true,
            borderColor: '#ef4444',
            borderWidth: 2,
            fillColor: 'rgba(239,68,68,0.08)',
        } as any),
    ],
    connections: [],
};

// 3) Kanban board — 3 containers with one sample card each. Shows that
// templates preserve grouping (parentId is remapped on stamp).
const kanbanBoard: Template = (() => {
    const colW = 200;
    const colH = 280;
    const gap = 20;
    const cardX = 16;
    const cardY = 56;       // below the container title bar
    const cardW = colW - 32;
    const cardH = 60;

    type Col = { id: string; cardId: string; title: string; cardText: string; color: string; x: number };
    const cols: Col[] = [
        { id: 'tpl_k_todo',       cardId: 'tpl_k_card_todo',     title: 'To Do',         cardText: 'First task',   color: '#6b6b80', x: 0 },
        { id: 'tpl_k_inprogress', cardId: 'tpl_k_card_progress', title: 'In Progress',   cardText: 'Working on…',  color: '#f5a623', x: colW + gap },
        { id: 'tpl_k_done',       cardId: 'tpl_k_card_done',     title: 'Done',          cardText: 'Shipped',      color: '#2dd4a0', x: (colW + gap) * 2 },
    ];

    const items: CanvasItem[] = [];
    for (const c of cols) {
        items.push({
            id: c.id,
            type: 'container',
            x: c.x,
            y: 0,
            w: colW,
            h: colH,
            zIndex: 0,
            locked: false,
            parentId: null,
            createdAt: NOW,
            createdBy: 'user',
            title: c.title,
            collapsed: false,
            scopeLocked: false,
            borderColor: c.color,
        } as CanvasItem);
        items.push(txt({
            id: c.cardId,
            x: c.x + cardX,
            y: cardY,
            w: cardW,
            h: cardH,
            parentId: c.id,
            content: c.cardText,
            fontSize: 14,
            border: true,
            borderColor: c.color,
            borderWidth: 1,
            fillColor: 'rgba(255,255,255,0.04)',
        } as any));
    }

    return {
        id: 'builtin_kanban',
        name: 'Kanban board',
        createdAt: NOW,
        isBuiltin: true,
        items,
        connections: [],
    };
})();

export const BUILTIN_TEMPLATES: Template[] = [stickyNote, prosAndCons, kanbanBoard];
