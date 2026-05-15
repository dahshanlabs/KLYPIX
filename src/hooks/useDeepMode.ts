import { useState, useRef, useCallback, useEffect } from 'react';
import type { DiscoveredFile, AttachedFile } from '../types';

export function useDeepMode(attachedFiles: AttachedFile[]) {
    const [isDeepFileMode, setIsDeepFileMode] = useState(false);
    const [deepFileError, setDeepFileError] = useState<string | null>(null);
    const [discoveredFiles, setDiscoveredFiles] = useState<DiscoveredFile[]>([]);
    const [selectedFiles, setSelectedFiles] = useState<string[]>([]);
    const [isScanningFiles, setIsScanningFiles] = useState(false);
    const [lightExcerpts, setLightExcerpts] = useState<Map<string, string>>(new Map());
    const [isFilesDropdownOpen, setIsFilesDropdownOpen] = useState(false);
    const [activeFileInfo, setActiveFileInfo] = useState<{ fileName: string; pageCount: number } | null>(null);
    const [isReadingFile, setIsReadingFile] = useState(false);
    const [blacklistedIds, setBlacklistedIds] = useState<Map<string, number>>(new Map());
    const [failedAccessNames, setFailedAccessNames] = useState<string[]>([]);

    // Pre-loaded content cache: fileId → { content, loading, error }
    const [fileContentCache, setFileContentCache] = useState<Map<string, { content: string; pageCount: number; loading: boolean; error?: string }>>(new Map());
    const cancelledIdsRef = useRef<Set<string>>(new Set());

    // Pre-load a file's content when selected
    const preloadFileContent = useCallback(async (fileId: string) => {
        // Skip if already cached or loading
        const existing = fileContentCache.get(fileId);
        if (existing && (existing.content || existing.loading)) return;

        // Find the file object
        const file = discoveredFiles.find(f => f.id === fileId);
        if (!file) return;

        // Clear cancelled flag if re-selecting
        cancelledIdsRef.current.delete(fileId);

        // Mark as loading
        setFileContentCache(prev => {
            const next = new Map(prev);
            next.set(fileId, { content: '', pageCount: 0, loading: true });
            return next;
        });

        try {
            const result = await (window as any).electron.readMultipleFiles([file]);

            // If cancelled while loading, ignore result and clean up
            if (cancelledIdsRef.current.has(fileId)) {
                cancelledIdsRef.current.delete(fileId);
                return;
            }

            const fileResult = result?.results?.[0];

            if (fileResult?.content) {
                setFileContentCache(prev => {
                    const next = new Map(prev);
                    next.set(fileId, { content: fileResult.content, pageCount: fileResult.pageCount || 0, loading: false });
                    return next;
                });
            } else {
                setFileContentCache(prev => {
                    const next = new Map(prev);
                    next.set(fileId, { content: '', pageCount: 0, loading: false, error: fileResult?.error || 'Could not read file' });
                    return next;
                });
            }
        } catch (err: any) {
            if (cancelledIdsRef.current.has(fileId)) {
                cancelledIdsRef.current.delete(fileId);
                return;
            }
            setFileContentCache(prev => {
                const next = new Map(prev);
                next.set(fileId, { content: '', pageCount: 0, loading: false, error: err.message });
                return next;
            });
        }
    }, [discoveredFiles, fileContentCache]);

    // Cancel a file preload — keep selected but mark as cancelled (retryable)
    const cancelPreload = useCallback((fileId: string) => {
        cancelledIdsRef.current.add(fileId);
        setFileContentCache(prev => {
            const next = new Map(prev);
            next.set(fileId, { content: '', pageCount: 0, loading: false, error: 'Cancelled' });
            return next;
        });
    }, []);

    // Retry a cancelled/failed file preload
    const retryPreload = useCallback((fileId: string) => {
        cancelledIdsRef.current.delete(fileId);
        setFileContentCache(prev => {
            const next = new Map(prev);
            next.delete(fileId); // Clear so preloadFileContent doesn't skip it
            return next;
        });
        // Trigger preload on next tick (after state updates)
        setTimeout(() => preloadFileContent(fileId), 50);
    }, [preloadFileContent]);

    // Remove from cache when deselected
    const removeFromCache = useCallback((fileId: string) => {
        setFileContentCache(prev => {
            const next = new Map(prev);
            next.delete(fileId);
            return next;
        });
    }, []);

    // Check if all selected files are loaded
    const allSelectedLoaded = selectedFiles.every(id => {
        const cached = fileContentCache.get(id);
        return cached && !cached.loading && cached.content;
    });

    // Get cached content for all selected files
    const getCachedContent = useCallback((): string => {
        const sections: string[] = [];
        for (const id of selectedFiles) {
            const cached = fileContentCache.get(id);
            const file = discoveredFiles.find(f => f.id === id);
            if (cached?.content && file) {
                sections.push(`--- ${file.name || file.originalTitle} ---\n${cached.content}`);
            }
        }
        return sections.join('\n\n');
    }, [selectedFiles, fileContentCache, discoveredFiles]);

    const lastDiscoveredIdsRef = useRef<string>('');
    const userSelectionRef = useRef(false);
    const filesDropdownRef = useRef<HTMLDivElement>(null);

    const refreshDiscoveredItems = useCallback(async (silent = false) => {
        if (!silent) setIsScanningFiles(true);
        try {
            const res = await window.electron.getAllOpenFiles();
            if (res.files) {
                setDiscoveredFiles(res.files as DiscoveredFile[]);
                const currentValidIds = res.files.map((f: any) => f.id);
                setSelectedFiles(prev => prev.filter(id => currentValidIds.includes(id)));

                const idsFingerprint = JSON.stringify(currentValidIds.sort());
                if (idsFingerprint !== lastDiscoveredIdsRef.current) {
                    lastDiscoveredIdsRef.current = idsFingerprint;
                    (window as any).electron.lightFetchAll(res.files).then((fetchRes: any) => {
                        if (fetchRes?.excerpts) {
                            const map = new Map<string, string>();
                            for (const e of fetchRes.excerpts) {
                                map.set(e.id, e.excerpt);
                            }
                            setLightExcerpts(map);
                        }
                    }).catch(() => { /* silent */ });
                }
            }
        } finally {
            if (!silent) setIsScanningFiles(false);
        }
    }, []);

    useEffect(() => {
        if (!isDeepFileMode) return;
        refreshDiscoveredItems(true);
        const interval = setInterval(() => refreshDiscoveredItems(true), 4000);
        return () => clearInterval(interval);
    }, [isDeepFileMode, refreshDiscoveredItems]);

    useEffect(() => {
        const handleClickOutside = (event: MouseEvent) => {
            if (isFilesDropdownOpen && filesDropdownRef.current && !filesDropdownRef.current.contains(event.target as Node)) {
                const toggleButton = document.getElementById('files-toggle-button');
                if (toggleButton && toggleButton.contains(event.target as Node)) return;
                setIsFilesDropdownOpen(false);
            }
        };
        document.addEventListener('mousedown', handleClickOutside);
        return () => document.removeEventListener('mousedown', handleClickOutside);
    }, [isFilesDropdownOpen]);

    const activateDeepMode = () => {
        setIsDeepFileMode(true);
        setActiveFileInfo(null);
        setDeepFileError(null);
        setFailedAccessNames([]);
        setBlacklistedIds(new Map());
    };

    return {
        isDeepFileMode, setIsDeepFileMode,
        deepFileError, setDeepFileError,
        discoveredFiles, setDiscoveredFiles,
        selectedFiles, setSelectedFiles,
        isScanningFiles,
        lightExcerpts,
        isFilesDropdownOpen, setIsFilesDropdownOpen,
        activeFileInfo, setActiveFileInfo,
        isReadingFile, setIsReadingFile,
        blacklistedIds, setBlacklistedIds,
        failedAccessNames, setFailedAccessNames,
        lastDiscoveredIdsRef,
        userSelectionRef,
        filesDropdownRef,
        refreshDiscoveredItems,
        activateDeepMode,
        fileContentCache,
        preloadFileContent,
        cancelPreload,
        retryPreload,
        removeFromCache,
        allSelectedLoaded,
        getCachedContent,
    };
}
