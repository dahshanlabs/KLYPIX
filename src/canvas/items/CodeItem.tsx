import React, { useMemo } from 'react';
import { Play, Copy, Check, Pencil, ExternalLink } from 'lucide-react';
import type { CodeItem as CodeItemType, CodeLanguage } from './types';
import { ResizeHandle } from '../interaction/ResizeHandle';
import { useCanvasStore } from '../state/canvasStore';

interface Props {
    item: CodeItemType;
    selected: boolean;
    editing: boolean;
}

// Runnable languages map to the sandbox's `canvas_run_code` languages.
// Others show the Run button disabled.
const RUNNABLE: Record<CodeLanguage, 'python' | 'bash' | 'node' | null> = {
    python: 'python',
    bash: 'bash',
    javascript: 'node',
    typescript: null,  // sandbox runs node raw; TS would need transpile — defer
    json: null, html: null, css: null, sql: null, go: null, rust: null,
    java: null, c: null, cpp: null, markdown: null, yaml: null, text: null,
};

export const CodeItemView = React.memo(CodeItemViewImpl, (prev, next) => {
    return prev.item === next.item && prev.selected === next.selected && prev.editing === next.editing;
});

function CodeItemViewImpl({ item, selected, editing }: Props) {
    const { dispatch } = useCanvasStore();
    const [copied, setCopied] = React.useState(false);
    const [running, setRunning] = React.useState(false);

    const highlighted = useMemo(() => highlight(item.code, item.language), [item.code, item.language]);

    const onCopy = async (e: React.MouseEvent) => {
        e.stopPropagation();
        try {
            await navigator.clipboard.writeText(item.code);
            setCopied(true);
            setTimeout(() => setCopied(false), 1200);
        } catch { /* ignore */ }
    };

    const onEditToggle = (e: React.MouseEvent) => {
        e.stopPropagation();
        dispatch({ type: 'SET_EDITING', id: editing ? null : item.id });
    };

    const runTarget = RUNNABLE[item.language];
    const onRun = async (e: React.MouseEvent) => {
        e.stopPropagation();
        if (!runTarget || running) return;
        const api: any = (window as any).electron?.sandbox;
        if (!api?.execute) {
            dispatch({
                type: 'UPDATE_ITEM',
                id: item.id,
                patch: { lastRun: { stdout: '', stderr: 'sandbox unavailable', exitCode: 1, ranAt: Date.now() } } as any,
            });
            return;
        }
        setRunning(true);
        try {
            const command = buildRunCommand(runTarget, item.code);
            const res = await api.execute({ command, timeout_ms: 30_000 });
            dispatch({
                type: 'UPDATE_ITEM',
                id: item.id,
                patch: {
                    lastRun: {
                        stdout: String(res?.stdout || ''),
                        stderr: String(res?.stderr || ''),
                        exitCode: Number(res?.exitCode ?? 0),
                        ranAt: Date.now(),
                    },
                } as any,
            });
        } catch (err: any) {
            dispatch({
                type: 'UPDATE_ITEM',
                id: item.id,
                patch: { lastRun: { stdout: '', stderr: String(err?.message || err), exitCode: 1, ranAt: Date.now() } } as any,
            });
        } finally {
            setRunning(false);
        }
    };

    const style: React.CSSProperties = {
        position: 'absolute',
        left: item.x,
        top: item.y,
        width: item.w,
        height: item.h,
        borderRadius: 10,
        background: '#0d0d15',
        border: `1px solid ${selected ? 'rgba(16,185,129,0.7)' : 'rgba(255,255,255,0.08)'}`,
        boxShadow: selected ? '0 0 0 3px rgba(16,185,129,0.2)' : '0 4px 16px rgba(0,0,0,0.3)',
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
        fontFamily: 'JetBrains Mono, ui-monospace, monospace',
        pointerEvents: 'auto',
        WebkitAppRegion: 'no-drag',
    } as React.CSSProperties & { WebkitAppRegion?: string };

    return (
        <>
            <div data-canvas-item={item.id} style={style} className="no-drag">
                {/* Header bar */}
                <div
                    onPointerDown={(e) => {
                        // Swallow only on the buttons themselves so clicks don't
                        // start a drag. Empty header area must bubble so the
                        // surface can pick up the drag and move the item.
                        if ((e.target as HTMLElement).closest('button, input, textarea, select, a')) {
                            e.stopPropagation();
                        }
                    }}
                    style={{
                        padding: '6px 10px',
                        display: 'flex',
                        alignItems: 'center',
                        gap: 8,
                        borderBottom: '1px solid rgba(255,255,255,0.05)',
                        background: '#111119',
                        fontFamily: 'Outfit, system-ui, sans-serif',
                    }}
                >
                    <span style={{ fontSize: 9.5, color: '#10b981', letterSpacing: '0.07em', textTransform: 'uppercase' }}>
                        {item.language}
                    </span>
                    {item.fileName && (
                        <span style={{ fontSize: 10.5, color: 'rgba(255,255,255,0.4)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                            {item.fileName}
                        </span>
                    )}
                    <div style={{ flex: 1 }} />
                    <button onClick={onCopy} title={copied ? 'Copied' : 'Copy'} style={iconBtnStyle}>
                        {copied ? <Check size={12} /> : <Copy size={12} />}
                    </button>
                    <button onClick={onEditToggle} title={editing ? 'Done editing' : 'Edit'} style={iconBtnStyle}>
                        <Pencil size={12} />
                    </button>
                    <button
                        onClick={onRun}
                        disabled={!runTarget || running}
                        title={runTarget ? 'Run in sandbox' : 'Run not supported for this language'}
                        style={{
                            ...iconBtnStyle,
                            background: runTarget ? 'rgba(16,185,129,0.15)' : 'transparent',
                            color: runTarget ? '#10b981' : 'rgba(255,255,255,0.25)',
                            cursor: runTarget ? 'pointer' : 'not-allowed',
                        }}
                    >
                        <Play size={12} />
                    </button>
                </div>
                {/* Body: editable textarea or highlighted view */}
                <div
                    onWheel={(e) => e.stopPropagation()}
                    style={{ flex: 1, overflow: 'auto', background: '#0d0d15' }}
                >
                    {editing ? (
                        <textarea
                            onPointerDown={(e) => e.stopPropagation()}
                            value={item.code}
                            onChange={(e) => dispatch({ type: 'UPDATE_ITEM', id: item.id, patch: { code: e.target.value } as any })}
                            spellCheck={false}
                            style={{
                                width: '100%',
                                height: '100%',
                                minHeight: 80,
                                padding: '10px 12px',
                                background: 'transparent',
                                color: '#e8e8ed',
                                border: 'none',
                                outline: 'none',
                                resize: 'none',
                                fontFamily: 'JetBrains Mono, ui-monospace, monospace',
                                fontSize: 12,
                                lineHeight: 1.55,
                                whiteSpace: item.wrap ? 'pre-wrap' : 'pre',
                                tabSize: 2,
                            }}
                        />
                    ) : (
                        <pre
                            style={{
                                margin: 0,
                                padding: '10px 12px',
                                fontSize: 12,
                                lineHeight: 1.55,
                                color: '#e8e8ed',
                                whiteSpace: item.wrap ? 'pre-wrap' : 'pre',
                                wordBreak: item.wrap ? 'break-word' : 'normal',
                                tabSize: 2,
                            }}
                            dangerouslySetInnerHTML={{ __html: highlighted }}
                        />
                    )}
                </div>
                {/* Run output strip */}
                {item.lastRun && (
                    <div
                        onPointerDown={(e) => e.stopPropagation()}
                        onWheel={(e) => e.stopPropagation()}
                        style={{
                            borderTop: '1px solid rgba(255,255,255,0.05)',
                            padding: '6px 10px',
                            maxHeight: 120,
                            overflow: 'auto',
                            background: '#0a0a0f',
                            fontSize: 11,
                            lineHeight: 1.45,
                            color: item.lastRun.exitCode === 0 ? 'rgba(255,255,255,0.75)' : '#fca5a5',
                            whiteSpace: 'pre-wrap',
                        }}
                    >
                        <div style={{ fontSize: 9, color: 'rgba(255,255,255,0.35)', letterSpacing: '0.08em', marginBottom: 3, fontFamily: 'Outfit, system-ui, sans-serif' }}>
                            {item.lastRun.exitCode === 0 ? 'STDOUT' : `EXIT ${item.lastRun.exitCode} · STDERR`}
                        </div>
                        {(item.lastRun.exitCode === 0 ? item.lastRun.stdout : (item.lastRun.stderr || item.lastRun.stdout)).trim() || '(no output)'}
                    </div>
                )}
                {running && (
                    <div style={{
                        padding: '4px 10px',
                        fontSize: 10,
                        color: '#10b981',
                        fontFamily: 'Outfit, system-ui, sans-serif',
                        borderTop: '1px solid rgba(16,185,129,0.2)',
                        background: 'rgba(16,185,129,0.05)',
                    }}>
                        Running…
                    </div>
                )}
            </div>
            {selected && (
                <ResizeHandle
                    itemId={item.id}
                    x={item.x} y={item.y} w={item.w} h={item.h}
                    minW={220} minH={120}
                />
            )}
        </>
    );
}

const iconBtnStyle: React.CSSProperties = {
    padding: 4,
    borderRadius: 5,
    background: 'transparent',
    color: 'rgba(255,255,255,0.55)',
    cursor: 'pointer',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
};

// Keep this in sync with canvasToolExecutor.ts's buildRunCommand. Kept local
// to avoid importing across the agent boundary for a tiny helper.
function buildRunCommand(lang: 'python' | 'bash' | 'node', code: string): string {
    // Base64-encode and pipe into the interpreter's stdin-equivalent so the
    // inline code doesn't require shell escaping.
    const b64 = typeof btoa === 'function' ? btoa(unescape(encodeURIComponent(code))) : Buffer.from(code).toString('base64');
    if (lang === 'python') return `echo ${b64} | base64 -d | python3`;
    if (lang === 'bash') return `echo ${b64} | base64 -d | bash`;
    return `echo ${b64} | base64 -d | node`;
}

// --- Tiny regex highlighter -------------------------------------------------
// Intentionally light. Swappable for Prism later if we ship grammars.
// Colors kept consistent with the app's emerald-accent dark theme.

const KEYWORDS: Record<string, string[]> = {
    javascript: ['const', 'let', 'var', 'function', 'return', 'if', 'else', 'for', 'while', 'class', 'import', 'export', 'from', 'as', 'async', 'await', 'new', 'this', 'null', 'undefined', 'true', 'false', 'try', 'catch', 'finally', 'throw', 'typeof', 'instanceof', 'in', 'of', 'switch', 'case', 'break', 'continue', 'default'],
    typescript: ['const', 'let', 'var', 'function', 'return', 'if', 'else', 'for', 'while', 'class', 'import', 'export', 'from', 'as', 'async', 'await', 'new', 'this', 'null', 'undefined', 'true', 'false', 'try', 'catch', 'finally', 'throw', 'typeof', 'instanceof', 'in', 'of', 'switch', 'case', 'break', 'continue', 'default', 'interface', 'type', 'enum', 'public', 'private', 'protected', 'readonly', 'extends', 'implements'],
    python: ['def', 'class', 'return', 'if', 'elif', 'else', 'for', 'while', 'import', 'from', 'as', 'with', 'try', 'except', 'finally', 'raise', 'lambda', 'pass', 'break', 'continue', 'in', 'is', 'not', 'and', 'or', 'None', 'True', 'False', 'self', 'yield', 'global', 'nonlocal', 'async', 'await'],
    bash: ['if', 'then', 'else', 'elif', 'fi', 'for', 'in', 'do', 'done', 'while', 'case', 'esac', 'function', 'return', 'export', 'source', 'echo'],
    sql: ['SELECT', 'FROM', 'WHERE', 'JOIN', 'LEFT', 'RIGHT', 'INNER', 'OUTER', 'ON', 'AS', 'AND', 'OR', 'NOT', 'NULL', 'IS', 'IN', 'GROUP', 'BY', 'ORDER', 'HAVING', 'LIMIT', 'OFFSET', 'INSERT', 'INTO', 'VALUES', 'UPDATE', 'SET', 'DELETE', 'CREATE', 'TABLE', 'INDEX', 'DROP', 'ALTER', 'WITH', 'UNION', 'DISTINCT', 'COUNT', 'SUM', 'AVG', 'MIN', 'MAX'],
    go: ['func', 'package', 'import', 'return', 'if', 'else', 'for', 'range', 'var', 'const', 'type', 'struct', 'interface', 'map', 'chan', 'go', 'defer', 'select', 'switch', 'case', 'default', 'break', 'continue', 'nil', 'true', 'false'],
    rust: ['fn', 'let', 'mut', 'const', 'static', 'struct', 'enum', 'trait', 'impl', 'pub', 'use', 'mod', 'crate', 'self', 'Self', 'return', 'if', 'else', 'match', 'for', 'while', 'loop', 'break', 'continue', 'true', 'false', 'None', 'Some', 'Ok', 'Err', 'async', 'await'],
};

function escapeHtml(s: string): string {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function highlight(code: string, lang: CodeLanguage): string {
    if (!code) return '';
    const safe = escapeHtml(code);
    if (lang === 'json') return highlightJson(safe);
    if (lang === 'html' || lang === 'markdown' || lang === 'css' || lang === 'yaml' || lang === 'text') {
        // Minimal: just comments + strings for these.
        return highlightGeneric(safe, KEYWORDS.javascript, /#.*$/gm, /\/\/.*$/gm);
    }
    const keywords = KEYWORDS[lang] || KEYWORDS.javascript;
    // Language-specific line-comment tokens (yaml is handled in the branch above).
    const lineComment = (lang === 'python' || lang === 'bash') ? /#.*$/gm : /\/\/.*$/gm;
    const blockComment = /\/\*[\s\S]*?\*\//g;
    return highlightGeneric(safe, keywords, lineComment, blockComment);
}

function highlightGeneric(safe: string, keywords: string[], lineComment: RegExp, blockComment: RegExp): string {
    // Strategy: do cheap passes in order — strings, numbers, comments, keywords.
    // Wrap each in a sentinel so later passes don't reprocess already-colored
    // segments. Sentinels use a private-use character unlikely to appear in code.
    const SENT = '\uE000';
    const stash: string[] = [];
    const save = (html: string) => { stash.push(html); return `${SENT}${stash.length - 1}${SENT}`; };

    let out = safe;
    // Comments first (so they don't get tokenized by string/keyword passes).
    out = out.replace(blockComment, (m) => save(`<span style="color:#6b7280">${m}</span>`));
    out = out.replace(lineComment, (m) => save(`<span style="color:#6b7280">${m}</span>`));
    // Strings (single, double, backtick).
    out = out.replace(/("(?:[^"\\\n]|\\.)*")|('(?:[^'\\\n]|\\.)*')|(`(?:[^`\\]|\\.)*`)/g,
        (m) => save(`<span style="color:#a78bfa">${m}</span>`));
    // Numbers. Lookarounds prevent re-matching the digit-encoded stash
    // index inside sentinels saved by earlier passes (e.g. `<idx>`),
    // which otherwise leaks bare `` glyphs into the rendered output.
    out = out.replace(/(?<!)\b(\d+(?:\.\d+)?|0x[0-9a-fA-F]+)\b(?!)/g,
        (m) => save(`<span style="color:#fbbf24">${m}</span>`));
    // Keywords.
    if (keywords.length > 0) {
        const kwRegex = new RegExp(`\\b(${keywords.map((k) => k.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\$&')).join('|')})\\b`, 'g');
        out = out.replace(kwRegex, (m) => save(`<span style="color:#10b981">${m}</span>`));
    }
    // Restore sentinels.
    out = out.replace(new RegExp(`${SENT}(\\d+)${SENT}`, 'g'), (_m, i) => stash[Number(i)]);
    return out;
}

function highlightJson(safe: string): string {
    const SENT = '\uE000';
    const stash: string[] = [];
    const save = (html: string) => { stash.push(html); return `${SENT}${stash.length - 1}${SENT}`; };
    let out = safe;
    // Property keys (quoted followed by colon).
    out = out.replace(/"([^"\\]|\\.)*"(?=\s*:)/g, (m) => save(`<span style="color:#60a5fa">${m}</span>`));
    // Regular strings.
    out = out.replace(/"([^"\\]|\\.)*"/g, (m) => save(`<span style="color:#a78bfa">${m}</span>`));
    // Numbers. Lookarounds prevent re-matching saved sentinel indices.
    out = out.replace(/(?<!)\b-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\b(?!)/g, (m) => save(`<span style="color:#fbbf24">${m}</span>`));
    // Booleans + null.
    out = out.replace(/\b(true|false|null)\b/g, (m) => save(`<span style="color:#10b981">${m}</span>`));
    out = out.replace(new RegExp(`${SENT}(\\d+)${SENT}`, 'g'), (_m, i) => stash[Number(i)]);
    return out;
}
