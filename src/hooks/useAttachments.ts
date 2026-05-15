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
        handleAttachClick,
        removeAttachedFile,
        clearAttachments,
        IMAGE_EXTS,
        MAX_ATTACHED,
    };
}
