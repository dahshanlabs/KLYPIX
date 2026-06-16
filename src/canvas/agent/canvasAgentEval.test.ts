import { describe, it, expect } from 'vitest';
import { CANVAS_COMMAND_NAMES, commandSpecFor, resolveToolBelt } from './commandRegistry';
import { CANVAS_TOOLS } from './canvasTools';

// AGENT-EVAL HARNESS — "tests as the contract" (per the agentic-SDLC report:
// most agent failures are the harness, not the model; the strongest guardrail
// is an automated contract on what the harness is ALLOWED to do). The static
// commandRegistry.test.ts asserts the spec STRINGS; this file asserts the REAL
// runtime behavior by calling the same resolveToolBelt() canvasAgent uses,
// against the real CANVAS_TOOLS registry. If anyone re-wires routing, broadens
// a language command's belt, or typos a tool name, a test fails LOUDLY here
// rather than the agent silently doing fake work in production.

// Tools that let the model EXECUTE / fabricate instead of reasoning. The
// original bug: /translate routed through canvas_run_code (python googletrans
// → EOF, then a script that hard-coded the answer and exited 0).
const CODE_TOOLS = ['canvas_run_code'];
// Pure-language commands must answer in-model; their belt is read + write only.
const LANGUAGE_COMMANDS = ['/translate', '/summarize', '/compare', '/analyze'];

const ALL_TOOL_NAMES = new Set(CANVAS_TOOLS.map(t => t.name));
const beltNames = (cmd: string) => resolveToolBelt(cmd, CANVAS_TOOLS).map(t => t.name);

describe('agent-eval — every gate references a tool that actually exists', () => {
    // A typo'd / renamed tool in allowedTools silently drops out of the belt
    // (resolveToolBelt filters by name) → the command loses a capability with no
    // error. This catches that class of harness rot.
    it('no allowedTools entry is a dead name absent from CANVAS_TOOLS', () => {
        for (const name of CANVAS_COMMAND_NAMES) {
            const spec = commandSpecFor(name)!;
            for (const tool of spec.allowedTools ?? []) {
                expect(ALL_TOOL_NAMES, `${name} gates unknown tool "${tool}"`).toContain(tool);
            }
        }
    });
});

describe('agent-eval — the real belt handed to the model (resolveToolBelt)', () => {
    it('bug-kill: a language command can NEVER see a code-execution tool', () => {
        for (const cmd of LANGUAGE_COMMANDS) {
            const belt = beltNames(cmd);
            for (const code of CODE_TOOLS) {
                expect(belt, `${cmd} belt must not contain ${code}`).not.toContain(code);
            }
        }
    });

    it('every gated command still gets a NON-EMPTY belt that can terminate', () => {
        for (const name of CANVAS_COMMAND_NAMES) {
            const spec = commandSpecFor(name)!;
            if (!spec.allowedTools) continue; // ungated = full belt
            const belt = beltNames(name);
            expect(belt.length, `${name} resolved an empty belt`).toBeGreaterThan(0);
            expect(belt, `${name} can't finish without canvas_done`).toContain('canvas_done');
        }
    });

    it('a language command CAN still read + write + ask (so the loop fallback works)', () => {
        const belt = beltNames('/translate');
        expect(belt).toContain('canvas_read_item');   // read the source
        expect(belt).toContain('canvas_create_card');  // pin the answer
        expect(belt).toContain('canvas_ask_user');     // clarify if needed
    });

    it('/chart and /compile DO get their one production tool (and only the code tool they need)', () => {
        expect(beltNames('/chart')).toContain('canvas_pin_chart');
        expect(beltNames('/chart')).toContain('canvas_run_code'); // chart may derive numbers
        expect(beltNames('/compile')).toContain('canvas_compile');
        expect(beltNames('/compile')).not.toContain('canvas_run_code'); // compile never runs code
    });

    it('an unknown / natural-language command keeps the FULL belt (legacy loop)', () => {
        expect(beltNames('find all the todos').length).toBe(CANVAS_TOOLS.length);
        expect(beltNames('/garden').length).toBe(CANVAS_TOOLS.length);
        expect(resolveToolBelt('find all the todos', CANVAS_TOOLS)).toBe(CANVAS_TOOLS); // same identity, no copy
    });
});

describe('agent-eval — golden routing snapshot (loud failure if routing changes)', () => {
    // The contract, frozen. Changing a command's lane or its access to code is a
    // deliberate decision that MUST update this table — never a silent drift.
    const GOLDEN: Record<string, { lane: string; canRunCode: boolean }> = {
        '/summarize': { lane: 'language', canRunCode: false },
        '/compare':   { lane: 'language', canRunCode: false },
        '/translate': { lane: 'language', canRunCode: false },
        '/analyze':   { lane: 'language', canRunCode: false },
        '/research':  { lane: 'agent',    canRunCode: true  }, // ungated full belt
        '/chart':     { lane: 'agent',    canRunCode: true  },
        '/compile':   { lane: 'agent',    canRunCode: false },
        '/organize':  { lane: 'agent',    canRunCode: false },
        '/cleanup':   { lane: 'agent',    canRunCode: false },
    };

    it('matches the frozen lane + code-access contract for every command', () => {
        expect(Object.keys(GOLDEN).sort()).toEqual([...CANVAS_COMMAND_NAMES].sort());
        for (const [cmd, want] of Object.entries(GOLDEN)) {
            const spec = commandSpecFor(cmd)!;
            expect(spec.lane, `${cmd} lane`).toBe(want.lane);
            expect(beltNames(cmd).includes('canvas_run_code'), `${cmd} code access`).toBe(want.canRunCode);
        }
    });
});
