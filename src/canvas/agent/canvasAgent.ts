import { GoogleGenerativeAI, type Content, type Part } from '@google/generative-ai';
import { getApiKeySync } from '../../api/gemini';
import { renderItemsForPrompt, type CommandScope } from './canvasScopeResolver';
import { newId, type CanvasItem, type Connection } from '../items/types';
import { CANVAS_TOOLS } from './canvasTools';
import { parseCommand, resolveToolBelt, type CommandSpec } from './commandRegistry';
import { NON_MUTATING_TOOLS, looksLikeRefusal, refusalTone, refusalArrowColor, pickSubstantiveReply } from './replyClassify';
import { createAgentReportCard, executeToolCall, type ToolExecContext, type ToolResult } from './canvasToolExecutor';

// Multi-turn tool-calling loop for the canvas agent. Replaces the Slice 6
// prompt→text path. The agent can call any canvas_* tool, get a result, and
// keep going until it emits canvas_done (or hits the turn limit).

const MODEL_ID = 'gemini-2.5-flash';
const MAX_TURNS = 12;

const SYSTEM_PROMPT = `You are KLYPIX, an AI assistant embedded in a visual canvas. Users drop files, write notes, and ask you questions via slash commands.
You interact with the canvas through TOOLS: read items, create text / cards, connect items with arrows, update, delete. Place new artifacts NEAR the items they reference (use world-coord x/y that avoids overlapping existing items).

Workflow:
1. Call canvas_get_items first to see what's on the canvas.
2. Call canvas_read_item for any items whose full content you need. It returns REAL content, not just metadata: text/code in full, PDF/DOCX/XLSX extracted to text, images (and scanned PDFs) attached as viewable images you can SEE, and video/audio TRANSCRIBED to text (video also gets a short visual description). A YouTube LINK card is attached as a WATCHABLE video — read it to analyze the actual video (frames + audio) and cite timestamps; never answer about a video from its title alone. Very large media may return a "too large" note instead. Always read an image/file/media/link item before answering about it — never guess from the filename.
3. Produce your answer via canvas_create_card. If you CANNOT do the task, or there's nothing to do, put that explanation in a canvas_create_card too (a short note the user keeps + can act on) — NEVER in canvas_create_toast (it auto-dismisses and the user loses it), and never as a bare "done" sign-off with no result. Reserve canvas_create_toast for trivial confirmations like "Copied".
4. If your output summarizes or builds on specific items, draw connection arrows — but pick the anchor carefully:
   • If SCOPE_ANCHOR_ID is set (the user asked about a single group/container as a whole), call canvas_connect_items ONCE with from_id = SCOPE_ANCHOR_ID → your output card. Do NOT also connect each child; one arrow from the group is the right visual.
   • Otherwise (loose selection, nearby items, full canvas), draw one arrow per source item the output actually builds on. Don't blanket-connect items you only read for context.
   • If you cite a specific child of a group distinctly (e.g. "the PDF inside SHAIMA says X"), you may add one extra arrow from that child in addition to the group arrow.
5. Call canvas_done when finished. Don't loop or repeat tool calls unnecessarily.

ASK BEFORE YOU GUESS: if the request depends on the USER's own situation or taste and you'd otherwise have to ASSUME key details — recommendations, "help me choose / pick / plan / suggest X", advice with several valid directions — your FIRST tool call MUST be canvas_ask_user to gather the deciding criteria (e.g. budget, use-case, constraints, preference) as 2-4 concrete options per question (bundle up to 4 questions), then answer using their picks. Do NOT answer from generic assumptions, and do NOT phrase the question as plain text or a card — only canvas_ask_user makes the chooser pop and waits for the reply. Skip asking only when the request is already specific or purely factual (e.g. "what is X", "summarize this").

You are a capable multilingual model. NEVER write code to translate, summarize, rewrite, compare, classify, extract, or otherwise produce an answer you can write yourself — do it directly and place it with canvas_create_card. Writing a script that hardcodes or prints an answer you already know is forbidden. canvas_run_code is a LAST RESORT, only for real computation on data, generating a file, or running code the user explicitly asked to run.

Sandbox / heavy tools (only when the task genuinely needs them):
- canvas_run_code — runs python/bash/node in a WSL2 sandbox and pins a source+output card. Use ONLY for real computation / data-processing, or files the user asked to generate — never as a wrapper around an answer you can write yourself. Write generated files under data/ so they're pinnable.
- canvas_pin_file — pin a sandbox file as a FileItem card (PDF/DOCX/XLSX get rich previews).
- canvas_pin_image — pin a sandbox image as an inline ImageItem. Use for charts you generate (e.g. matplotlib savefig → data/chart.png).
- canvas_create_approval — pin an approval card and WAIT for the user. Use before any destructive / costly / irreversible action. Returns the user's chosen option.
- canvas_ask_user — ask the user a question with 2-4 options (a focused chooser pops up; they can also type "Other") and WAIT for the answer. Use this WHENEVER you need a decision or missing info before continuing — never guess, and never ask by writing a plain text/card question. You may bundle 1-4 questions in one call. Returns the user's answers.
- canvas_compile — bundle existing canvas items into a single PDF / DOCX / PPTX / ZIP deliverable and pin it. Use when the user says "compile / combine / export these into a report / deck / archive". Prefer this over manually writing the same file via canvas_run_code.
- canvas_organize — cluster items into titled containers by type / tag / status / date / connection, then grid them out. Use for "/organize by X" commands.
- canvas_find_issues — surface orphans, untagged items, duplicates, and near-alignments (no mutations). Use for "/cleanup", "/find orphans", "/find untagged". After the report, optionally use canvas_connect_items / canvas_update_item / canvas_set_tags to act on the suggestions.

Never output raw text outside of tool calls — the user only sees what you place on the canvas. Be concise in card content. No markdown headers inside content (they don't render specially).`;

export interface AgentProgress {
    turn: number;
    activity: string;
    tool?: string;
}

export interface AgentRunOptions {
    command: string;
    scope: CommandScope;
    scopeItems: CanvasItem[];
    /** Captures latest state after each dispatch. */
    getState: ToolExecContext['getState'];
    dispatch: ToolExecContext['dispatch'];
    onToast: ToolExecContext['onToast'];
    onProgress?: (p: AgentProgress) => void;
    /** Abort the run cooperatively — checked before each turn + each tool call.
     *  When aborted, the loop returns early with error: 'aborted' (the caller
     *  treats that as a user stop, not a failure). */
    signal?: AbortSignal;
}

export interface AgentRunResult {
    finalMessage: string;
    toolCalls: number;
    error?: string;
}

// Serialize tool EXECUTION across all concurrent runs (parallel-agents Stage 2).
// Model thinking (generateContent) still runs in parallel — the slow part — but
// canvas mutations go one-at-a-time through this shared lock, so two runs'
// read-modify-write tools (organize, compile, layout) can't interleave on the
// single canvasStore. Fast tools (add a card) hold it only momentarily.
let toolLock: Promise<unknown> = Promise.resolve();
function withToolLock<T>(fn: () => Promise<T>): Promise<T> {
    const run = toolLock.then(fn, fn);
    // Keep the chain alive but isolate failures so one rejected tool doesn't
    // poison the lock for every other run.
    toolLock = run.then(() => undefined, () => undefined);
    return run;
}

// Tools that CREATE a canvas item — their result JSON carries the new id(s),
// which we collect to deterministically connect the agent's output back to its
// source (Gemini Flash forgets to call canvas_connect_items inconsistently).
const CREATE_TOOLS = new Set(['canvas_create_card', 'canvas_write_batch', 'canvas_pin_chart', 'canvas_pin_file', 'canvas_pin_image']);

// Human-readable failure text — shown on the tray pill AND pinned to the
// canvas as a red report card so a failed run never vanishes silently.
function describeRunError(code: string): string {
    switch (code) {
        case 'empty_response': return 'The model returned an empty response.';
        case 'max_turns': return `Stopped after ${MAX_TURNS} turns without finishing.`;
        case 'no_output': return 'The run finished without leaving anything on the canvas.';
        default: return code;
    }
}

// Draw source→target arrows for pairs not already linked. Targets are ids this
// run just created — deliberately NOT checked against state, because getState()
// reads a ref that only refreshes on re-render, so a card dispatched moments
// ago isn't visible yet (the old per-card existence check silently dropped
// arrows to final-turn cards). ADD_CONNECTION tolerates not-yet-rendered ids;
// the connections layer skips endpoints that never materialize.
function addMissingConnections(
    getState: ToolExecContext['getState'],
    dispatch: ToolExecContext['dispatch'],
    sources: string[],
    targets: string[],
    color: string,
    style: 'solid' | 'dashed' = 'solid',
) {
    const st = getState();
    const conns = Object.values(st.connections) as Connection[];
    for (const src of sources) {
        if (!st.items[src]) continue;
        for (const cardId of targets) {
            if (cardId === src) continue;
            const linked = conns.some(c => (c.fromId === src && c.toId === cardId) || (c.fromId === cardId && c.toId === src));
            if (linked) continue;
            dispatch({
                type: 'ADD_CONNECTION',
                connection: { id: newId('conn'), fromId: src, toId: cardId, label: '', color, width: 2, arrowHead: true, style, createdBy: 'agent' },
            });
        }
    }
}

// Per-canvas agent instructions — the canvas BRIEFS its own agent (the spatial
// sibling of 📌 Focus): every text card inside a container titled "Instructions"
// (any decoration: "🤖 Instructions", "Agent instructions") is prepended to the
// system prompt of every run on this canvas. No settings UI, no format change —
// the author drops instruction cards on the board and any agent obeys them.
function canvasInstructionsOf(state: { items: Record<string, CanvasItem & { title?: string; content?: string }>; order: string[] }): string {
    const isInstr = (t?: string) => /(^|\s)(agent\s+)?instructions\b/i.test(t || '');
    const ctnIds = new Set(state.order.filter(id => {
        const it = state.items[id];
        return it?.type === 'container' && isInstr((it as { title?: string }).title);
    }));
    if (!ctnIds.size) return '';
    const texts: string[] = [];
    for (const id of state.order) {
        const it = state.items[id];
        if (it?.type === 'text' && it.parentId && ctnIds.has(it.parentId) && (it.content || '').trim()) {
            texts.push(it.content.trim());
        }
    }
    return texts.join('\n');
}

// FAST LANE for pure-language commands. One tool-free model call → one result
// card, wired back to the source with the same green provenance arrow the loop
// draws. Returns null to DEFER to the agent loop (selection needs extraction,
// nothing readable, oversized, or the call failed) so a run is never lost.
const LANGUAGE_LANE_MAX_CHARS = 50_000;

async function runLanguageLane(
    spec: CommandSpec,
    opts: AgentRunOptions,
    instructions: string,
): Promise<AgentRunResult | null> {
    const { command, scope, scopeItems, getState, dispatch, onToast, onProgress, signal } = opts;
    if (signal?.aborted) return { finalMessage: '', toolCalls: 0, error: 'aborted' };

    // Gather only text we can read directly. Any item needing real extraction
    // (PDF/image/video/audio/link) defers the whole run to the loop, which has
    // canvas_read_item for that. Containers/boxes are structural — skip them.
    const blocks: string[] = [];
    let total = 0;
    for (const it of scopeItems) {
        let text = '';
        if (it.type === 'text') text = it.content || '';
        else if (it.type === 'code') text = it.code || '';
        else if (it.type === 'container' || it.type === 'box') continue;
        else return null;
        text = text.trim();
        if (!text) continue;
        total += text.length;
        blocks.push(`[${blocks.length + 1}] ${text}`);
    }
    if (blocks.length === 0 || total > LANGUAGE_LANE_MAX_CHARS) return null;

    onProgress?.({ turn: 1, activity: spec.name.replace(/^\//, '') });

    const sys = `You are KLYPIX, a capable multilingual assistant. ${spec.instruction || ''}
Operate ONLY on the SOURCE CONTENT below. Reply with ONLY the resulting text — no preamble, no explanation, no code, no markdown headers, and do not echo the original unless the task asks for it. If the user gave options (e.g. a target language or a format), honor them.${instructions ? `\n\nCANVAS INSTRUCTIONS (from this canvas's author):\n${instructions}` : ''}`;
    const userText = `SOURCE CONTENT:\n${blocks.join('\n\n')}\n\nUSER COMMAND:\n${command}`;

    let answer = '';
    try {
        const genAI = new GoogleGenerativeAI(getApiKeySync());
        const model = genAI.getGenerativeModel({ model: MODEL_ID, systemInstruction: sys });
        const resp = await model.generateContent({ contents: [{ role: 'user', parts: [{ text: userText }] }] });
        const parts: Part[] = resp.response.candidates?.[0]?.content?.parts || [];
        answer = parts
            .filter(p => 'text' in p && typeof p.text === 'string')
            .map(p => p.text as string)
            .join('')
            .trim();
    } catch {
        return null; // any failure → let the agent loop try
    }
    if (signal?.aborted) return { finalMessage: '', toolCalls: 0, error: 'aborted' };
    if (!answer) return null;

    const ctx: ToolExecContext = { getState, dispatch, onToast };
    // A real result → green artifact card. A refusal ("can't translate this") →
    // a dashed amber/slate "Note" card, so declining gibberish never pins a
    // fake-success card with a green arrow.
    const refusal = looksLikeRefusal(answer);
    const tone = refusalTone(answer);
    const heading = refusal ? 'NOTE' : (spec.cardTitle || 'Result').toUpperCase();
    const cardId = await withToolLock(async () => createAgentReportCard(ctx, {
        content: `${heading}\n\n${answer}`,
        kind: refusal ? 'note' : 'artifact',
        tone,
    }));

    // Provenance: solid green for a real artifact; dashed amber/grey for a
    // note/refusal so the arrow never falsely asserts a successful result.
    const sources = scope.anchorId ? [scope.anchorId] : scope.itemIds;
    if (sources.length >= 1 && sources.length <= 3) {
        await withToolLock(async () => {
            addMissingConnections(getState, dispatch, sources, [cardId],
                refusal ? refusalArrowColor(tone) : '#10b981',
                refusal ? 'dashed' : 'solid');
            return null;
        });
    }
    return { finalMessage: answer, toolCalls: 0 };
}

export async function runCanvasAgent(opts: AgentRunOptions): Promise<AgentRunResult> {
    const { command, scope, scopeItems, getState, dispatch, onToast, onProgress, signal } = opts;

    // Defensive: a transform command launched with nothing selected resolves to
    // 'needs_selection' and is blocked by the command bar — but never burn a
    // model call (or ship the board) if it somehow reaches the loop.
    if (scope.kind === 'needs_selection') {
        return { finalMessage: '', toolCalls: 0, error: 'Select items first, then run this command.' };
    }

    const instructions = canvasInstructionsOf(getState());

    // Resolve the command's contract (lane + allowed tools + guidance). Unknown
    // verbs (natural-language asks, power-user commands) get spec=null → the
    // legacy all-tools loop, unchanged.
    const { spec } = parseCommand(command);

    // FAST LANE — pure-language commands (/translate, /summarize, /compare,
    // /analyze) answer in ONE tool-free model call and pin the result, so a
    // tool-happy weak model can never route a translation through python. Bails
    // to the (tool-gated) loop below when the selection needs real extraction
    // (PDF/image/media), there's nothing to read, it's oversized, or the call
    // fails — so we never lose a run.
    if (spec?.lane === 'language') {
        const fast = await runLanguageLane(spec, opts, instructions);
        if (fast) return fast;
    }

    // Per-command tool gating: each command only ever SEES the tools it's
    // allowed to use — e.g. /translate's fallback can't reach canvas_run_code at
    // all. Unknown commands keep the full belt.
    const toolSubset = resolveToolBelt(command, CANVAS_TOOLS);

    let systemInstruction = instructions
        ? `${SYSTEM_PROMPT}\n\nCANVAS INSTRUCTIONS — written by this canvas's author for you; follow them in every answer:\n${instructions}`
        : SYSTEM_PROMPT;
    if (spec?.guidance) systemInstruction += `\n\nCOMMAND GUIDANCE:\n${spec.guidance}`;

    const genAI = new GoogleGenerativeAI(getApiKeySync());
    const model = genAI.getGenerativeModel({
        model: MODEL_ID,
        systemInstruction,
        tools: [{ functionDeclarations: toolSubset }],
    });

    // Seed the conversation with the user command + scope context.
    // SCOPE_ANCHOR_ID is present only when the user's scope is a single
    // container — it tells the agent to connect the group itself (one
    // arrow) rather than fan connections out to each child.
    const anchorLine = scope.anchorId ? `SCOPE_ANCHOR_ID: ${scope.anchorId}\n` : '';
    const initialUserText = `SCOPE: ${scope.description}
${anchorLine}ITEMS ON CANVAS (summary only — call canvas_read_item for full content):
${renderItemsForPrompt(scopeItems)}

USER COMMAND:
${command}`;

    const contents: Content[] = [
        { role: 'user', parts: [{ text: initialUserText }] },
    ];

    const ctx: ToolExecContext = { getState, dispatch, onToast };

    let turns = 0;
    let toolCalls = 0;
    let finalMessage = '';
    let runError: string | null = null;
    let completed = false;
    const createdIds: string[] = [];
    // What the agent "said" (toast messages) + whether it mutated the canvas —
    // used at run-end to pin the real reply (not a content-free sign-off) and to
    // tell a genuinely empty run from one that did silent work.
    const agentSaid: string[] = [];
    let didMutate = false;

    while (turns < MAX_TURNS) {
        if (signal?.aborted) return { finalMessage, toolCalls, error: 'aborted' };
        turns++;
        onProgress?.({ turn: turns, activity: 'thinking' });

        let response;
        try {
            response = await model.generateContent({ contents });
        } catch (err: any) {
            runError = err?.message || 'Gemini call failed';
            break;
        }

        const candidate = response.response.candidates?.[0];
        if (!candidate) {
            runError = 'empty_response';
            break;
        }

        const parts: Part[] = candidate.content?.parts || [];
        // Collect function calls from this turn. Gemini may return one or many.
        const calls = parts.filter(p => 'functionCall' in p && p.functionCall).map(p => p.functionCall!);
        const textChunk = parts
            .filter(p => 'text' in p && typeof p.text === 'string')
            .map(p => p.text as string)
            .join('')
            .trim();

        // Record assistant turn (mirror back to contents so Gemini sees what it said).
        contents.push({
            role: 'model',
            parts,
        });

        if (calls.length === 0) {
            // No tool call → model produced plain text. Treat as final message.
            finalMessage = textChunk || finalMessage;
            completed = true;
            break;
        }

        // Execute each tool call and feed results back.
        const responseParts: Part[] = [];
        let shouldStop = false;
        for (const call of calls) {
            if (signal?.aborted) return { finalMessage, toolCalls, error: 'aborted' };
            onProgress?.({ turn: turns, activity: `running ${call.name}`, tool: call.name });

            // Capture what the agent said (toasts) + whether it mutated the canvas.
            if (call.name === 'canvas_create_toast') {
                const said = String((call.args as Record<string, any> | undefined)?.message || '').trim();
                if (said) agentSaid.push(said);
            }
            if (!NON_MUTATING_TOOLS.has(call.name)) didMutate = true;

            // Serialize the canvas mutation across concurrent runs; re-check
            // abort once we actually hold the lock (a Stop while queued behind
            // another run's slow tool shouldn't then mutate the canvas).
            const result = await withToolLock<ToolResult | null>(() =>
                signal?.aborted
                    ? Promise.resolve(null)
                    : executeToolCall({ name: call.name, args: (call.args || {}) as Record<string, any> }, ctx),
            );
            if (!result) return { finalMessage, toolCalls, error: 'aborted' };
            toolCalls++;

            responseParts.push({
                functionResponse: {
                    name: call.name,
                    response: { result: result.result },
                },
            });

            // Vision attachments (e.g. canvas_read_item on an image / scanned
            // PDF): feed the actual pixels to the model as inlineData parts in
            // the same turn so it can SEE the item, not just its filename.
            if (result.images?.length) {
                for (const img of result.images) {
                    responseParts.push({ inlineData: { mimeType: img.mimeType, data: img.data } });
                }
            }

            // Video URL attachments (e.g. a YouTube link via canvas_read_item):
            // feed as fileData so Gemini WATCHES the actual video — frames +
            // audio — on the next turn, not just its title. Public videos only.
            if (result.videoUrls?.length) {
                for (const url of result.videoUrls) {
                    responseParts.push({ fileData: { fileUri: url, mimeType: 'video/*' } } as Part);
                }
            }

            // Collect ids of items this run created, to wire them to the source.
            if (CREATE_TOOLS.has(call.name)) {
                try {
                    const parsed = JSON.parse(result.result);
                    if (typeof parsed.id === 'string') createdIds.push(parsed.id);
                    if (Array.isArray(parsed.created)) {
                        for (const cid of parsed.created) if (typeof cid === 'string') createdIds.push(cid);
                    }
                } catch { /* non-JSON result — nothing to collect */ }
            }

            if (result.done) {
                shouldStop = true;
                if (result.doneMessage) finalMessage = result.doneMessage;
            }
        }

        contents.push({ role: 'user', parts: responseParts });

        if (shouldStop) { completed = true; break; }
    }

    if (!runError && !completed) runError = 'max_turns';

    const sources = scope.anchorId ? [scope.anchorId] : scope.itemIds;
    const created = Array.from(new Set(createdIds));

    // No artifact card was created (Gemini Flash sometimes answers in plain text
    // without calling canvas_create_card — common after watching a video). Route
    // what the agent actually SAID by meaning (best-in-class durability): a real
    // answer → green artifact card; a refusal / "can't / nothing here" → a dashed
    // amber/slate Note card (the high-value message that used to vanish as a
    // toast); a content-free sign-off → NOTHING (the canvas is the record if real
    // work happened, else the failure report below covers a truly empty run).
    if (!runError && created.length === 0) {
        const reply = pickSubstantiveReply([...agentSaid, finalMessage]);
        if (reply) {
            const refusal = looksLikeRefusal(reply);
            const tone = refusalTone(reply);
            const noteId = await withToolLock(async () => createAgentReportCard(ctx, {
                content: refusal ? `NOTE\n\n${reply}` : reply,
                kind: refusal ? 'note' : 'artifact',
                tone,
            }));
            // Self-wire with the right style (the generic pass below only handles
            // CREATE_TOOLS artifacts): dashed amber/grey for a note/refusal so the
            // arrow never asserts a success; solid green for a real answer.
            if (sources.length >= 1 && sources.length <= 3) {
                await withToolLock(async () => {
                    addMissingConnections(getState, dispatch, sources, [noteId],
                        refusal ? refusalArrowColor(tone) : '#10b981',
                        refusal ? 'dashed' : 'solid');
                    return null;
                });
            }
        } else if (!didMutate) {
            // Nothing substantive said AND nothing changed → genuinely empty run;
            // the failure report below covers it.
            runError = 'no_output';
        }
        // else: real work happened (organize / tags / etc.) and only a generic
        // sign-off remains — the canvas itself is the record; pin nothing extra.
    }

    // Deterministically tie the agent's output to its source — Gemini Flash
    // forgets to call canvas_connect_items inconsistently. Connect each scope
    // source to each created card (skip pairs already linked). Scoped to a
    // focused selection (1-3 sources) + a few outputs so /organize and
    // whole-canvas runs don't fan out a mess of arrows. Runs even when the run
    // errored late (e.g. turn limit) — work that landed stays wired.
    if (sources.length >= 1 && sources.length <= 3 && created.length >= 1 && created.length <= 3) {
        await withToolLock(async () => {
            addMissingConnections(getState, dispatch, sources, created, '#10b981');
            return null;
        });
    }

    // Failed run → pin a red report card wired to the source item(s). The tray
    // pill alone is dismissible/missable; the canvas report keeps the failure
    // attached to what the user asked about. User aborts returned earlier and
    // are exempt — stopping a run shouldn't litter the canvas.
    if (runError) {
        const message = describeRunError(runError);
        const shortCmd = command.length > 90 ? `${command.slice(0, 90)}…` : command;
        await withToolLock(async () => {
            const errorId = createAgentReportCard(ctx, {
                content: `⚠️ AGENT RUN FAILED\n\n"${shortCmd}"\n\n${message}`,
                isError: true,
            });
            if (sources.length >= 1 && sources.length <= 3) {
                addMissingConnections(getState, dispatch, sources, [errorId], '#ef4444');
            }
            return null;
        });
        return { finalMessage, toolCalls, error: message };
    }

    return { finalMessage, toolCalls };
}
