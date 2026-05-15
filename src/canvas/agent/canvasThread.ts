import { GoogleGenerativeAI, type Content } from '@google/generative-ai';
import { getApiKeySync } from '../../api/gemini';
import type { CanvasItem, ThreadMessage } from '../items/types';
import { getAsset } from '../file/assetRegistry';

// Per-item chat thread. Separate from the main canvas agent because:
//   - No tool calls — pure Q&A scoped to ONE item.
//   - System prompt is different: no tool workflow, just "answer about this thing".
//   - Streams into a specific ThreadMessage (assistant, status='streaming')
//     that the store patches via UPDATE_THREAD_MESSAGE as chunks arrive.

const MODEL_ID = 'gemini-2.5-flash';

const SYSTEM_PROMPT = `You are KLYPIX, a conversational assistant answering multi-turn follow-up questions about ONE specific item on the user's canvas.
You only see this one item — plus, if it's a container, its direct children — not the rest of the canvas. Keep answers focused on the anchor item and what it contains.
Be concise (2-4 sentences by default, longer only when asked). No preamble. Plain text — light markdown is fine but no headers.`;

const MAX_EMBEDDED_TEXT = 20_000;
// Cap on how many direct children we inline into a container's context.
// Large containers would otherwise blow the model's input budget — the
// overflow message tells the model + the user that there's more.
const MAX_CONTAINER_CHILDREN = 50;

// Best-effort text snippet for context. Uses preview fields first (cheap,
// already in the doc), falls back to the asset bytes for text-like files.
// `items` is passed so that a container anchor can include its children's
// content — previously only the title was included, which made the model
// say "I don't know what's inside" for any container question.
function buildItemContext(item: CanvasItem, items: Record<string, CanvasItem>): string {
    const base: string[] = [];
    base.push(`ITEM TYPE: ${item.type}`);
    if ((item as any).fileName) base.push(`FILENAME: ${(item as any).fileName}`);
    if ((item as any).extension) base.push(`EXTENSION: ${(item as any).extension}`);
    if (item.tags?.length) base.push(`TAGS: ${item.tags.join(', ')}`);

    switch (item.type) {
        case 'text':
            base.push('CONTENT:');
            base.push(item.content || '(empty)');
            break;
        case 'file': {
            if (item.previewSheet) {
                const ps = item.previewSheet;
                base.push(`SPREADSHEET: ${ps.sheetName} (${ps.totalRows} rows, ${ps.sheetCount} sheets)`);
                base.push(`HEADERS: ${ps.headers.join(' | ')}`);
                for (const r of ps.rows.slice(0, 20)) base.push(r.join(' | '));
            } else if (item.previewHtml) {
                // Mammoth HTML → plain text, capped.
                const plain = item.previewHtml.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
                base.push('DOCUMENT TEXT:');
                base.push(plain.slice(0, MAX_EMBEDDED_TEXT));
            } else if (item.assetId) {
                // Text-ish files: pull directly from the asset registry.
                const asset = getAsset(item.assetId);
                const ext = (item.extension || '').toLowerCase();
                if (asset && (['txt', 'md', 'markdown', 'csv', 'tsv', 'json', 'js', 'ts', 'py', 'log'].includes(ext))) {
                    try {
                        const txt = new TextDecoder('utf-8', { fatal: false }).decode(asset.bytes);
                        base.push('FILE CONTENT:');
                        base.push(txt.slice(0, MAX_EMBEDDED_TEXT));
                    } catch { /* ignored */ }
                } else {
                    base.push(`(binary file, ${item.fileSize} bytes — not inlined)`);
                }
            } else {
                base.push(`(file metadata only; ${item.fileSize} bytes)`);
            }
            break;
        }
        case 'image':
            base.push(`(image, ${item.originalWidth}x${item.originalHeight})`);
            break;
        case 'video':
            base.push(`(video, ${item.fileSize} bytes, duration ~${Math.round(item.durationSec || 0)}s)`);
            break;
        case 'audio':
            base.push(`(audio, ${item.fileSize} bytes, duration ~${Math.round(item.durationSec || 0)}s)`);
            break;
        case 'code':
            base.push(`LANGUAGE: ${item.language}`);
            base.push('CODE:');
            base.push(item.code.slice(0, MAX_EMBEDDED_TEXT));
            if (item.lastRun) {
                base.push('');
                base.push(`LAST RUN (exit ${item.lastRun.exitCode}):`);
                base.push((item.lastRun.stdout || item.lastRun.stderr).slice(0, 4000));
            }
            break;
        case 'box':
            base.push('(shape, no text content)');
            break;
        case 'container': {
            base.push(`CONTAINER TITLE: ${item.title}`);
            // Direct children only — nested containers show title + child
            // count rather than recursing, so context stays bounded and
            // the user can open a thread on the nested group if they need
            // its internals. Capped at MAX_CONTAINER_CHILDREN; overflow
            // announced so the model doesn't claim there's nothing more.
            const directChildren = Object.values(items).filter(
                c => c && c.parentId === item.id,
            );
            if (directChildren.length === 0) {
                base.push('(container is empty)');
            } else {
                base.push(`CONTAINS ${directChildren.length} DIRECT CHILD(REN):`);
                const shown = directChildren.slice(0, MAX_CONTAINER_CHILDREN);
                for (let i = 0; i < shown.length; i++) {
                    const child = shown[i];
                    base.push(`--- child ${i + 1} (${child.type}) ---`);
                    if (child.type === 'text') {
                        base.push(child.content || '(empty)');
                    } else if (child.type === 'container') {
                        const grandChildCount = Object.values(items).filter(
                            c => c && c.parentId === child.id,
                        ).length;
                        base.push(`Nested container titled "${child.title}" with ${grandChildCount} child(ren). Open a thread on it for details.`);
                    } else if (child.type === 'file') {
                        base.push(`File: ${(child as any).fileName || '(unnamed)'}`);
                    } else if (child.type === 'image') {
                        base.push(`(image, ${(child as any).originalWidth}x${(child as any).originalHeight})`);
                    } else if (child.type === 'code') {
                        const snippet = (child.code || '').slice(0, 500);
                        base.push(`Code (${child.language || 'unknown'}): ${snippet}${child.code && child.code.length > 500 ? '…' : ''}`);
                    } else {
                        base.push(`(${child.type})`);
                    }
                }
                if (directChildren.length > MAX_CONTAINER_CHILDREN) {
                    base.push(`… and ${directChildren.length - MAX_CONTAINER_CHILDREN} more not shown (truncated for context).`);
                }
            }
            break;
        }
    }
    return base.join('\n');
}

export interface ThreadRunOptions {
    item: CanvasItem;
    items: Record<string, CanvasItem>;   // full map — needed so containers can include children in context
    history: ThreadMessage[];     // prior messages, oldest-first, excluding the in-flight assistant stub
    userMessage: string;          // the fresh user turn being sent
    onChunk: (textSoFar: string) => void;
    signal?: AbortSignal;
}

export interface ThreadRunResult {
    text: string;
    error?: string;
}

export async function runCanvasThread(opts: ThreadRunOptions): Promise<ThreadRunResult> {
    const { item, items, history, userMessage, onChunk, signal } = opts;
    const genAI = new GoogleGenerativeAI(getApiKeySync());
    const model = genAI.getGenerativeModel({
        model: MODEL_ID,
        systemInstruction: SYSTEM_PROMPT,
    });

    // Seed with item context as the first user turn so it's visible to the
    // model but not echoed back as a chat bubble.
    const contents: Content[] = [
        { role: 'user', parts: [{ text: buildItemContext(item, items) }] },
        { role: 'model', parts: [{ text: 'Understood. Ready for questions.' }] },
    ];
    for (const m of history) {
        contents.push({ role: m.role === 'user' ? 'user' : 'model', parts: [{ text: m.content }] });
    }
    contents.push({ role: 'user', parts: [{ text: userMessage }] });

    try {
        const res = await model.generateContentStream({ contents });
        let accumulated = '';
        for await (const chunk of res.stream) {
            if (signal?.aborted) break;
            const t = chunk.text();
            if (!t) continue;
            accumulated += t;
            onChunk(accumulated);
        }
        return { text: accumulated };
    } catch (err: any) {
        return { text: '', error: err?.message || String(err) };
    }
}
