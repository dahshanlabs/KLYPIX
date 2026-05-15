import JSZip from 'jszip';
import type { CanvasItem } from '../items/types';
import { getAsset } from '../file/assetRegistry';

// Maps a set of canvas items into a single deliverable. Called by the
// `canvas_compile` tool. The tool hands us the raw items; we sort them
// spatially (row-by-row, left→right), then produce a format-specific spec
// that the main-process generators consume.
//
// Spatial sort strategy: bucket by vertical row using a tolerance equal to
// median item height, then sort by x within each row. Items near the same y
// read as "one line" on the page.

export function sortItemsSpatially(items: CanvasItem[]): CanvasItem[] {
    if (items.length === 0) return items;
    // Use a fixed-ish row height so tall images/containers don't pull in
    // unrelated items above/below them. 120px in world coords is roughly one
    // line of text-card height at default zoom.
    const ROW_TOL = 120;
    const byTop = items.slice().sort((a, b) => a.y - b.y);
    const rows: CanvasItem[][] = [];
    for (const it of byTop) {
        const last = rows[rows.length - 1];
        if (last && it.y < last[0].y + ROW_TOL) last.push(it);
        else rows.push([it]);
    }
    for (const row of rows) row.sort((a, b) => a.x - b.x);
    return rows.flat();
}

function itemPlainText(it: CanvasItem): string {
    switch (it.type) {
        case 'text': return it.content;
        case 'container': return it.title;
        case 'file': {
            const parts = [`[${it.fileName}]`];
            if (it.previewSheet) {
                parts.push(`${it.previewSheet.headers.join(' | ')}`);
                for (const r of it.previewSheet.rows) parts.push(r.join(' | '));
            } else if (it.previewHtml) {
                parts.push(it.previewHtml.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 4000));
            }
            return parts.join('\n');
        }
        case 'image': return `(image: ${it.fileName})`;
        case 'video': return `(video: ${it.fileName}, ${Math.round(it.durationSec || 0)}s)`;
        case 'audio': return `(audio: ${it.fileName}, ${Math.round(it.durationSec || 0)}s)`;
        case 'code': return `\`\`\`${it.language}\n${it.code}\n\`\`\``;
        case 'link': return it.url;
        case 'canvas-link': return `[canvas] ${it.title || it.filePath}`;
        case 'approval': return `(approval: ${it.question} → ${it.decision || 'pending'})`;
        case 'box': return '';
    }
}

// --- DOCX ------------------------------------------------------------------

export interface DOCXSpec {
    filename?: string;
    metadata?: { title?: string; author?: string; subject?: string; date?: string };
    sections: Array<
        | { type: 'heading1'; text: string }
        | { type: 'heading2'; text: string }
        | { type: 'heading3'; text: string }
        | { type: 'paragraph'; text: string }
        | { type: 'bullet_list'; items: string[] }
        | { type: 'numbered_list'; items: string[] }
        | { type: 'table'; headers: string[]; rows: string[][] }
        | { type: 'blockquote'; text: string }
        | { type: 'page_break' }
    >;
}

export function compileToDOCX(items: CanvasItem[], title: string): DOCXSpec {
    const sorted = sortItemsSpatially(items);
    const sections: DOCXSpec['sections'] = [{ type: 'heading1', text: title }];
    let seenAnyContainer = false;

    for (const it of sorted) {
        if (it.type === 'container') {
            if (seenAnyContainer) sections.push({ type: 'page_break' });
            seenAnyContainer = true;
            sections.push({ type: 'heading2', text: it.title || '(container)' });
            continue;
        }
        if (it.type === 'text') {
            if (it.heading) sections.push({ type: 'heading3', text: it.content });
            else sections.push({ type: 'paragraph', text: it.content });
            continue;
        }
        if (it.type === 'file' && it.previewSheet) {
            sections.push({ type: 'heading3', text: it.fileName });
            sections.push({
                type: 'table',
                headers: it.previewSheet.headers.slice(0, 8),
                rows: it.previewSheet.rows.map((r) => r.slice(0, 8)),
            });
            continue;
        }
        if (it.type === 'file' && it.previewHtml) {
            sections.push({ type: 'heading3', text: it.fileName });
            const plain = it.previewHtml.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
            if (plain) sections.push({ type: 'paragraph', text: plain.slice(0, 10_000) });
            continue;
        }
        if (it.type === 'code') {
            sections.push({ type: 'heading3', text: it.fileName || `${it.language} snippet` });
            // Represent code as a blockquote so it visually separates without
            // depending on a real code-block style in the DOCX generator.
            sections.push({ type: 'blockquote', text: it.code });
            continue;
        }
        const text = itemPlainText(it).trim();
        if (text) sections.push({ type: 'paragraph', text });
    }
    return {
        filename: `${title || 'canvas'}.docx`,
        metadata: { title, date: new Date().toISOString().slice(0, 10) },
        sections,
    };
}

// --- PPTX ------------------------------------------------------------------

// Matches electron/generators/pptxGenerator.ts PPTXSpec. Kept in sync here
// so we don't have a cross-boundary import.
export interface PPTXSpec {
    filename?: string;
    metadata?: { title?: string; author?: string; date?: string };
    slides: Array<
        | { layout: 'title'; title: string; subtitle?: string; notes?: string }
        | { layout: 'section'; title: string; subtitle?: string; notes?: string }
        | { layout: 'content'; title: string; bullets: string[]; notes?: string }
        | { layout: 'two-column'; title: string; left: { header: string; bullets: string[] }; right: { header: string; bullets: string[] }; notes?: string }
        | { layout: 'table'; title: string; headers: string[]; rows: string[][]; notes?: string }
        | { layout: 'closing'; title: string; subtitle?: string; notes?: string }
    >;
}

// Split long text into shortish bullets. PPTX bullets wrap badly above ~120
// chars, so we break on sentences / newlines.
function textToBullets(text: string, max = 6): string[] {
    const blocks = text.split(/\n+/).map((b) => b.trim()).filter(Boolean);
    if (blocks.length >= max) return blocks.slice(0, max);
    // Otherwise, sentence-split long paragraphs.
    const out: string[] = [];
    for (const b of blocks) {
        if (b.length <= 140) { out.push(b); continue; }
        const sentences = b.split(/(?<=[.!?])\s+/);
        for (const s of sentences) {
            if (out.length >= max) break;
            out.push(s.trim());
        }
    }
    return out.slice(0, max);
}

export function compileToPPTX(items: CanvasItem[], title: string): PPTXSpec {
    const sorted = sortItemsSpatially(items);
    const slides: PPTXSpec['slides'] = [{ layout: 'title', title, subtitle: `${sorted.length} items` }];
    for (const it of sorted) {
        if (it.type === 'container') { slides.push({ layout: 'section', title: it.title || 'Section' }); continue; }
        if (it.type === 'text') {
            const body = it.content.trim();
            if (!body) continue;
            const headline = body.split('\n')[0].slice(0, 80);
            slides.push({ layout: 'content', title: headline, bullets: textToBullets(body) });
            continue;
        }
        if (it.type === 'file' && it.previewSheet) {
            slides.push({
                layout: 'table',
                title: it.fileName,
                headers: it.previewSheet.headers.slice(0, 6),
                rows: it.previewSheet.rows.slice(0, 10).map((r) => r.slice(0, 6)),
            });
            continue;
        }
        if (it.type === 'file') {
            slides.push({
                layout: 'content',
                title: it.fileName,
                bullets: [
                    `${it.extension.toUpperCase()} · ${Math.round(it.fileSize / 1024)} KB`,
                    ...(it.previewHtml
                        ? textToBullets(it.previewHtml.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim(), 4)
                        : ['(attached to .any canvas)']
                    ),
                ],
            });
            continue;
        }
        if (it.type === 'image') {
            // Generator doesn't embed images — just reference them on a slide.
            slides.push({ layout: 'content', title: it.fileName, bullets: [`(image, ${it.originalWidth}×${it.originalHeight})`] });
            continue;
        }
        if (it.type === 'code') {
            slides.push({
                layout: 'content',
                title: it.fileName || `${it.language} snippet`,
                bullets: it.code.split('\n').slice(0, 12).map((l) => l || ' '),
            });
            continue;
        }
        const text = itemPlainText(it).trim();
        if (text) slides.push({ layout: 'content', title: (it as any).fileName || it.type, bullets: textToBullets(text) });
    }
    slides.push({ layout: 'closing', title: 'End of canvas export', subtitle: `Generated from ${sorted.length} items` });
    return {
        filename: `${title || 'canvas'}.pptx`,
        metadata: { title, date: new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' }) },
        slides,
    };
}

// --- PDF (via existing markdown generator) ---------------------------------

export function compileToPdfMarkdown(items: CanvasItem[], title: string): string {
    const sorted = sortItemsSpatially(items);
    const lines: string[] = [`# ${title}`, ''];
    for (const it of sorted) {
        if (it.type === 'container') {
            lines.push('', `## ${it.title || 'Section'}`, '');
            continue;
        }
        if (it.type === 'text') {
            lines.push(it.heading ? `### ${it.content}` : it.content, '');
            continue;
        }
        if (it.type === 'file' && it.previewSheet) {
            const ps = it.previewSheet;
            lines.push(`### ${it.fileName}`, '');
            lines.push('| ' + ps.headers.slice(0, 6).join(' | ') + ' |');
            lines.push('| ' + ps.headers.slice(0, 6).map(() => '---').join(' | ') + ' |');
            for (const r of ps.rows.slice(0, 20)) lines.push('| ' + r.slice(0, 6).join(' | ') + ' |');
            lines.push('');
            continue;
        }
        if (it.type === 'code') {
            lines.push(`### ${it.fileName || `${it.language} snippet`}`, '');
            lines.push('```' + it.language, it.code, '```', '');
            continue;
        }
        const text = itemPlainText(it).trim();
        if (text) lines.push(text, '');
    }
    return lines.join('\n');
}

// --- ZIP -------------------------------------------------------------------

/**
 * Bundle items into a .zip as individual files. Text → .md, files & images →
 * original bytes, code → .ext matching the language. Returns the ZIP bytes.
 */
export async function compileToZip(items: CanvasItem[], title: string): Promise<Uint8Array> {
    const zip = new JSZip();
    const sorted = sortItemsSpatially(items);
    const used = new Set<string>();
    const safeName = (raw: string): string => {
        let base = raw.replace(/[\\/:*?"<>|]+/g, '_').trim() || 'item';
        if (!used.has(base)) { used.add(base); return base; }
        // De-dupe by suffixing a counter before the extension.
        const dot = base.lastIndexOf('.');
        const stem = dot > 0 ? base.slice(0, dot) : base;
        const ext = dot > 0 ? base.slice(dot) : '';
        for (let i = 2; i < 1000; i++) {
            const cand = `${stem}_${i}${ext}`;
            if (!used.has(cand)) { used.add(cand); return cand; }
        }
        return base;
    };

    let idx = 0;
    for (const it of sorted) {
        idx++;
        const pad = String(idx).padStart(3, '0');
        if (it.type === 'text') {
            zip.file(safeName(`${pad}_${(it.content || 'note').slice(0, 40).replace(/\s+/g, '-')}.md`), it.content || '');
        } else if (it.type === 'code') {
            const ext = codeExtForLang(it.language);
            zip.file(safeName(`${pad}_${it.fileName || 'snippet'}.${ext}`.replace(/\.\./g, '.')), it.code);
        } else if (it.type === 'container') {
            zip.folder(safeName(`${pad}_${it.title || 'container'}`));
        } else if ((it.type === 'image' || it.type === 'file' || it.type === 'video' || it.type === 'audio') && (it as any).assetId) {
            const asset = getAsset((it as any).assetId);
            if (asset) {
                const fn = (it as any).fileName || `${it.type}_${pad}.${asset.extension}`;
                zip.file(safeName(`${pad}_${fn}`), asset.bytes as any);
            }
        }
    }
    // Add a manifest index for quick reference.
    const manifest = [`# ${title}`, '', `${sorted.length} items`, '', ...sorted.map((it, i) =>
        `${String(i + 1).padStart(3, '0')} · ${it.type} · ${(it as any).fileName || (it.type === 'text' ? (it.content || '').slice(0, 60) : it.type === 'container' ? it.title : '')}`
    )].join('\n');
    zip.file('README.md', manifest);
    const blob = await zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE', compressionOptions: { level: 5 } });
    return blob;
}

function codeExtForLang(lang: string): string {
    switch (lang) {
        case 'javascript': return 'js';
        case 'typescript': return 'ts';
        case 'python': return 'py';
        case 'bash': return 'sh';
        case 'html': case 'css': case 'json': case 'sql': case 'go': case 'java':
            return lang;
        case 'rust': return 'rs';
        case 'cpp': return 'cpp';
        case 'c': return 'c';
        case 'markdown': return 'md';
        case 'yaml': return 'yml';
        default: return 'txt';
    }
}

