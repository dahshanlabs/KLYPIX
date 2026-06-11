import { useCallback, useRef, useState } from 'react';
import { runCanvasAgent, type AgentProgress } from './canvasAgent';
import type { CommandScope } from './canvasScopeResolver';
import type { CanvasItem } from '../items/types';
import { t } from '../../i18n/strings';

// Registry for CONCURRENT canvas-agent runs (Stage 1 of parallel agents). Each
// run is independent: its own AbortController, progress, and pill in the AI
// Activity tray. Replaces the single busy/abort state the CommandBar used to
// own, so launching a second command no longer blocks on the first.
//
// NOTE (Stage 2): runs share one canvasStore. Each run takes ONE undo snapshot
// at start; a multi-step read-modify-write tool (e.g. canvas_organize) could in
// theory read stale positions if another run mutates mid-flight. For the common
// case (each run ADDs cards) this is safe; serialized/per-run-snapshot hardening
// is the next stage.

export interface AgentRun {
    id: string;
    label: string;                 // the command text, shown on the pill
    scopeDescription: string;
    progress: AgentProgress | null;
    error: string | null;
    status: 'running' | 'error';
}

export interface AgentRunDeps {
    getState: () => any;
    dispatch: (action: any) => void;
    pushSnapshot: () => void;
    onToast: (text: string) => void;
    /** Aggregate progress sink — drives the canvas "eyes" state. */
    onProgress?: (p: AgentProgress | null) => void;
    onError?: (msg: string) => void;
}

export interface StartRunArgs {
    command: string;
    scope: CommandScope;
    scopeItems: CanvasItem[];
}

export function useAgentRuns(deps: AgentRunDeps) {
    const [runs, setRuns] = useState<AgentRun[]>([]);
    const controllers = useRef<Map<string, AbortController>>(new Map());
    const counter = useRef(0);
    // Latest deps without re-creating the stable callbacks below.
    const depsRef = useRef(deps);
    depsRef.current = deps;

    const dismiss = useCallback((id: string) => {
        setRuns(prev => prev.filter(r => r.id !== id));
        controllers.current.delete(id);
    }, []);

    const start = useCallback((args: StartRunArgs) => {
        const command = args.command.trim();
        if (!command) return;
        const d = depsRef.current;
        const id = `run_${counter.current++}`;
        const controller = new AbortController();
        controllers.current.set(id, controller);
        setRuns(prev => [...prev, {
            id,
            label: command,
            scopeDescription: args.scope.description,
            progress: null,
            error: null,
            status: 'running',
        }]);
        // One undo snapshot per run — Ctrl+Z reverts that run's work in one shot.
        d.pushSnapshot();
        (async () => {
            try {
                const { error: runErr } = await runCanvasAgent({
                    command,
                    scope: args.scope,
                    scopeItems: args.scopeItems,
                    getState: d.getState,
                    dispatch: d.dispatch,
                    onToast: d.onToast,
                    signal: controller.signal,
                    onProgress: (p) => {
                        d.onProgress?.(p);
                        setRuns(prev => prev.map(r => (r.id === id ? { ...r, progress: p } : r)));
                    },
                });
                if (runErr === 'aborted') {
                    d.onToast(t('canvas.command_bar.stopped'));
                    setRuns(prev => prev.filter(r => r.id !== id));
                    return;
                }
                if (runErr) {
                    // Keep the pill so the user sees the error + can dismiss it.
                    setRuns(prev => prev.map(r => (r.id === id ? { ...r, status: 'error', error: runErr } : r)));
                    d.onError?.(runErr);
                    return;
                }
                setRuns(prev => prev.filter(r => r.id !== id));
            } catch (err: any) {
                const msg = err?.message || 'Agent call failed';
                setRuns(prev => prev.map(r => (r.id === id ? { ...r, status: 'error', error: msg } : r)));
                d.onError?.(msg);
            } finally {
                controllers.current.delete(id);
                d.onProgress?.(null);
            }
        })();
    }, []);

    const stop = useCallback((id: string) => {
        controllers.current.get(id)?.abort();
    }, []);

    return { runs, start, stop, dismiss };
}
