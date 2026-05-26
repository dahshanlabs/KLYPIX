import { useState, useRef } from 'react';
import type { AttachedFile } from '../types';
import { IMAGE_EXTS, MAX_ATTACHED } from '../types';

export function useAttachments() {
    const [attachedFiles, setAttachedFiles] = useState<AttachedFile[]>([]);
    const [isDragOver, setIsDragOver] = useState(false);
    const dragCounter = useRef(0);

    const processDroppedFiles = async (filePaths: string[]) => {
        if (filePaths.length === 0) return;
        const remaining = MAX_ATTACHED - attachedFiles.length;
        if (remaining <= 0) return;
        const validated = await (window as any).electron.validateDroppedFiles(filePaths.slice(0, remaining));
        const valid = validated.filter((f: any) => f.valid);
        const invalid = validated.filter((f: any) => !f.valid);
        if (invalid.length > 0) {
            console.warn('[Attach] Rejected:', invalid.map((f: any) => `${f.name}: ${f.error}`));
        }
        if (valid.length > 0) {
            setAttachedFiles(prev => {
                const existing = new Set(prev.map(f => f.path));
                const newFiles = valid.filter((f: any) => !existing.has(f.path));
                return [...prev, ...newFiles].slice(0, MAX_ATTACHED);
            });
        }
    };

    const handleDragEnter = (e: React.DragEvent) => {
        e.preventDefault();
        e.stopPropagation();
        dragCounter.current++;
        if (e.dataTransfer.types.includes('Files')) {
            setIsDragOver(true);
        }
    };

    const handleDragLeave = (e: React.DragEvent) => {
        e.preventDefault();
        e.stopPropagation();
        dragCounter.current--;
        if (dragCounter.current === 0) {
            setIsDragOver(false);
        }
    };

    const handleDragOver = (e: React.DragEvent) => {
        e.preventDefault();
        e.stopPropagation();
    };

    const handleDrop = async (e: React.DragEvent) => {
        e.preventDefault();
        e.stopPropagation();
        setIsDragOver(false);
        dragCounter.current = 0;
        const files = Array.from(e.dataTransfer.files);
        const paths = files.map(f => {
            try { return (window as any).electron.getPathForFile(f); }
            catch { return (f as any).path; }
        }).filter(Boolean);
        await processDroppedFiles(paths);
    };

    // Pasted images / files (Ctrl+V on the chat input) should behave exactly
    // like a drag-drop attach. Two sources to merge:
    //   1. In-memory image bytes — exposed by the browser via
    //      e.clipboardData.items as kind:'file' + image/* MIME. We write
    //      these to os.tmpdir() via save-pasted-image so they become a real
    //      path the existing validate pipeline can consume.
    //   2. Real files copied from File Explorer (Windows CF_HDROP) — the
    //      browser does NOT expose these on the paste event, so we fall
    //      back to read-clipboard IPC (PowerShell Get-Clipboard) when no
    //      image blob is present. Skipping that fallback when images are
    //      present avoids a needless PS roundtrip in the hot path.
    const handlePaste = async (e: React.ClipboardEvent) => {
        const items = e.clipboardData?.items;
        const imageItems: DataTransferItem[] = [];
        if (items) {
            for (let i = 0; i < items.length; i++) {
                const it = items[i];
                if (it.kind === 'file' && it.type.startsWith('image/')) {
                    imageItems.push(it);
                }
            }
        }
        const remaining = MAX_ATTACHED - attachedFiles.length;
        if (remaining <= 0 && imageItems.length > 0) {
            e.preventDefault();
            return;
        }
        // Branch 1: in-memory image bytes from the paste event.
        if (imageItems.length > 0) {
            e.preventDefault();
            const paths: string[] = [];
            for (const it of imageItems.slice(0, remaining)) {
                const file = it.getAsFile();
                if (!file) continue;
                try {
                    const buf = await file.arrayBuffer();
                    const res = await (window as any).electron.savePastedImage(buf, file.type);
                    if (res?.ok && res.path) paths.push(res.path);
                    else if (res?.error) console.warn('[Paste] Save failed:', res.error);
                } catch (err) {
                    console.warn('[Paste] Read failed:', err);
                }
            }
            if (paths.length > 0) await processDroppedFiles(paths);
            return;
        }
        // Branch 2: File Explorer file paste — only if no image bytes were
        // present. Falls back to OS clipboard inspection via main.
        if (remaining <= 0) return;
        try {
            const clip = await (window as any).electron?.readClipboard?.();
            const filePaths: string[] = Array.isArray(clip?.filePaths) ? clip.filePaths : [];
            if (filePaths.length === 0) return;
            // We have real paths — swallow the paste so the textarea
            // doesn't get the file URL/text representation too.
            e.preventDefault();
            await processDroppedFiles(filePaths.slice(0, remaining));
        } catch { /* clipboard read failed → leave default paste behavior */ }
    };

    const handleAttachClick = async () => {
        const paths = await (window as any).electron.openFileDialog();
        if (paths && paths.length > 0) {
            await processDroppedFiles(paths);
        }
    };

    const removeAttachedFile = (path: string) => {
        setAttachedFiles(prev => prev.filter(f => f.path !== path));
    };

    const clearAttachments = () => {
        setAttachedFiles([]);
    };

    return {
        attachedFiles, setAttachedFiles,
        isDragOver,
        processDroppedFiles,
        handleDragEnter,
        handleDragLeave,
        handleDragOver,
        handleDrop,
        handlePaste,
        handleAttachClick,
        removeAttachedFile,
        clearAttachments,
        IMAGE_EXTS,
        MAX_ATTACHED,
    };
}
