import { GoogleGenerativeAI, type Content, type Part } from '@google/generative-ai';
import { getApiKeySync } from '../../api/gemini';
import { renderItemsForPrompt, type CommandScope } from './canvasScopeResolver';
import type { CanvasItem } from '../items/types';
import { CANVAS_TOOLS } from './canvasTools';
import { executeToolCall, type ToolExecContext, type ToolResult } from './canvasToolExecutor';

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
3. Produce your answer via canvas_create_card (for substantive output) or canvas_create_toast (for a one-liner).
4. If your output summarizes or builds on specific items, draw connection arrows — but pick the anchor carefully:
   • If SCOPE_ANCHOR_ID is set (the user asked about a single group/container as a whole), call canvas_connect_items ONCE with from_id = SCOPE_ANCHOR_ID → your output card. Do NOT also connect each child; one arrow from the group is the right visual.
   • Otherwise (loose selection, nearby items, full canvas), draw one arrow per source item the output actually builds on. Don't blanket-connect items you only read for context.
   • If you cite a specific child of a group distinctly (e.g. "the PDF inside SHAIMA says X"), you may add one extra arrow from that child in addition to the group arrow.
5. Call canvas_done when finished. Don't loop or repeat tool calls unnecessarily.

Sandbox tools (use when the task needs code execution, data analysis, or a generated file):
- canvas_run_code — runs python/bash/node in a WSL2 sandbox and pins a source+output card. Write generated files under data/ so they're pinnable.
- canvas_pin_file — pin a sandbox file as a FileItem card (PDF/DOCX/XLSX get rich previews).
- canvas_pin_image — pin a sandbox image as an inline ImageItem. Use for charts you generate (e.g. matplotlib savefig → data/chart.png).
- canvas_create_approval — pin an approval card and WAIT for the user. Use before any destructive / costly / irreversible action. Returns the user's chosen option.
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

export async function runCanvasAgent(opts: AgentRunOptions): Promise<AgentRunResult> {
    const { command, scope, scopeItems, getState, dispatch, onToast, onProgress, signal } = opts;

    const genAI = new GoogleGenerativeAI(getApiKeySync());
    const model = genAI.getGenerativeModel({
        model: MODEL_ID,
        systemInstruction: SYSTEM_PROMPT,
        tools: [{ functionDeclarations: CANVAS_TOOLS }],
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

    while (turns < MAX_TURNS) {
        if (signal?.aborted) return { finalMessage, toolCalls, error: 'aborted' };
        turns++;
        onProgress?.({ turn: turns, activity: 'thinking' });

        let response;
        try {
            response = await model.generateContent({ contents });
        } catch (err: any) {
            return { finalMessage: '', toolCalls, error: err?.message || 'Gemini call failed' };
        }

        const candidate = response.response.candidates?.[0];
        if (!candidate) {
            return { finalMessage, toolCalls, error: 'empty_response' };
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
            break;
        }

        // Execute each tool call and feed results back.
        const responseParts: Part[] = [];
        let shouldStop = false;
        for (const call of calls) {
            if (signal?.aborted) return { finalMessage, toolCalls, error: 'aborted' };
            onProgress?.({ turn: turns, activity: `running ${call.name}`, tool: call.name });

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

            if (result.done) {
                shouldStop = true;
                if (result.doneMessage) finalMessage = result.doneMessage;
            }
        }

        contents.push({ role: 'user', parts: responseParts });

        if (shouldStop) break;
    }

    if (turns >= MAX_TURNS) {
        return { finalMessage: finalMessage || '(turn limit reached)', toolCalls, error: 'max_turns' };
    }

    return { finalMessage, toolCalls };
}
