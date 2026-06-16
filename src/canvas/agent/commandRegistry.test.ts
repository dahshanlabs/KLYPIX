import { describe, it, expect } from 'vitest';
import { parseCommand, commandSpecFor, CANVAS_COMMAND_NAMES } from './commandRegistry';
import { resolveScope } from './canvasScopeResolver';
import type { CanvasItem } from '../items/types';

// These tests encode the FIX's guarantees as executable assertions: a
// pure-language command can never be handed a code-execution tool, so it can't
// route a translation through python again. (The bug: /translate wrote a
// googletrans script that errored, then a script that hardcoded the answer.)

const CODE_EXECUTION_TOOLS = ['canvas_run_code', 'canvas_pin_chart', 'canvas_compile'];

describe('command registry — parsing', () => {
    it('splits a command into base verb + args and resolves the spec', () => {
        const { spec, base, args } = parseCommand('/translate to French');
        expect(base).toBe('/translate');
        expect(args).toBe('to French');
        expect(spec?.name).toBe('/translate');
        expect(spec?.lane).toBe('language');
    });

    it('is case-insensitive on the verb and tolerates extra whitespace', () => {
        expect(parseCommand('  /TRANSLATE  مرحبا  ').spec?.name).toBe('/translate');
    });

    it('returns spec=null for natural-language (non-slash) input → legacy all-tools loop', () => {
        expect(commandSpecFor('translate this please')).toBeNull();
        expect(commandSpecFor('')).toBeNull();
    });

    it('returns spec=null for an unknown slash command (e.g. /garden, /foo)', () => {
        expect(commandSpecFor('/garden')).toBeNull();
        expect(commandSpecFor('/foo bar')).toBeNull();
    });
});

describe('command registry — routing contract', () => {
    it('chips exclude /garden (maintenance lives on the Brain Health pill)', () => {
        expect(CANVAS_COMMAND_NAMES).not.toContain('/garden');
        expect(CANVAS_COMMAND_NAMES).toContain('/translate');
        expect(CANVAS_COMMAND_NAMES.length).toBe(9);
    });

    it('every language-lane command can answer in-model: has a cardTitle + instruction', () => {
        for (const name of CANVAS_COMMAND_NAMES) {
            const spec = commandSpecFor(name)!;
            if (spec.lane !== 'language') continue;
            expect(spec.cardTitle, `${name} cardTitle`).toBeTruthy();
            expect(spec.instruction, `${name} instruction`).toBeTruthy();
        }
    });

    it('NO language-lane command may EVER see a code-execution tool (the bug-kill)', () => {
        const language = CANVAS_COMMAND_NAMES
            .map(n => commandSpecFor(n)!)
            .filter(s => s.lane === 'language');
        expect(language.length).toBeGreaterThan(0);
        for (const spec of language) {
            expect(spec.allowedTools, `${spec.name} must gate its tools`).toBeDefined();
            for (const codeTool of CODE_EXECUTION_TOOLS) {
                expect(spec.allowedTools, `${spec.name} must not expose ${codeTool}`).not.toContain(codeTool);
            }
        }
    });

    it('every gated command keeps canvas_done so the loop can terminate cleanly', () => {
        for (const name of CANVAS_COMMAND_NAMES) {
            const spec = commandSpecFor(name)!;
            if (!spec.allowedTools) continue; // ungated = full belt, includes canvas_done
            expect(spec.allowedTools, `${name} needs canvas_done`).toContain('canvas_done');
        }
    });

    it('/translate, /summarize, /compare, /analyze are the language lane', () => {
        for (const n of ['/translate', '/summarize', '/compare', '/analyze']) {
            expect(commandSpecFor(n)?.lane, n).toBe('language');
        }
    });

    it('/chart, /compile, /organize, /cleanup, /research run the agent loop', () => {
        for (const n of ['/chart', '/compile', '/organize', '/cleanup', '/research']) {
            expect(commandSpecFor(n)?.lane, n).toBe('agent');
        }
    });
});

// resolveScope honours each command's scope contract: a transform with no
// selection must NOT silently ship the whole canvas.
const txt = (id: string, parentId: string | null = null) =>
    ({ id, type: 'text', parentId, content: '' }) as unknown as CanvasItem;
const ctn = (id: string, opts: { title?: string } = {}) =>
    ({ id, type: 'container', parentId: null, title: opts.title ?? 'Group', scopeLocked: false }) as unknown as CanvasItem;
function board(list: CanvasItem[]): { items: Record<string, CanvasItem>; order: string[] } {
    const items: Record<string, CanvasItem> = {};
    for (const it of list) items[it.id] = it;
    return { items, order: list.map(i => i.id) };
}

describe('resolveScope — per-command default scope', () => {
    it('/translate with NOTHING selected → needs_selection (NOT full_canvas)', () => {
        const { items, order } = board([txt('a'), txt('b')]);
        const s = resolveScope('/translate', [], order, items);
        expect(s.kind).toBe('needs_selection');
        expect(s.itemIds).toEqual([]);
    });

    it('/summarize, /compare, /analyze with nothing selected also block', () => {
        const { items, order } = board([txt('a')]);
        for (const c of ['/summarize', '/compare', '/analyze']) {
            expect(resolveScope(c, [], order, items).kind, c).toBe('needs_selection');
        }
    });

    it('/organize with nothing selected → full_canvas (the whole board)', () => {
        const { items, order } = board([txt('a'), txt('b'), txt('c')]);
        const s = resolveScope('/organize', [], order, items);
        expect(s.kind).toBe('full_canvas');
        expect(s.itemIds).toEqual(['a', 'b', 'c']);
    });

    it('/cleanup with nothing selected → full_canvas', () => {
        const { items, order } = board([txt('a')]);
        expect(resolveScope('/cleanup', [], order, items).kind).toBe('full_canvas');
    });

    it('unknown / free-text / /garden keep the legacy whole-board fallback', () => {
        const { items, order } = board([txt('a'), txt('b')]);
        expect(resolveScope('find all todos', [], order, items).kind).toBe('full_canvas');
        expect(resolveScope('/garden', [], order, items).kind).toBe('full_canvas');
    });

    it('an explicit selection always wins, even for a transform command', () => {
        const { items, order } = board([txt('a'), txt('b')]);
        const s = resolveScope('/translate', ['a'], order, items);
        expect(s.kind).toBe('selected');
        expect(s.itemIds).toEqual(['a']);
    });

    it('a single selected container → container scope w/ anchorId + children', () => {
        const { items, order } = board([ctn('g'), txt('a', 'g'), txt('b', 'g'), txt('c')]);
        const s = resolveScope('/summarize', ['g'], order, items);
        expect(s.kind).toBe('container');
        expect(s.anchorId).toBe('g');
        expect(s.itemIds).toEqual(['a', 'b']);
    });

    it('whole-canvas scope is CAPPED so a huge board cannot blow the context', () => {
        const many = Array.from({ length: 250 }, (_, i) => txt(`n${i}`));
        const { items, order } = board(many);
        const s = resolveScope('/organize', [], order, items);
        expect(s.kind).toBe('full_canvas');
        expect(s.itemIds.length).toBe(200);
    });

    it('an empty board → empty (not needs_selection), even for a transform', () => {
        expect(resolveScope('/translate', [], [], {}).kind).toBe('empty');
    });
});
