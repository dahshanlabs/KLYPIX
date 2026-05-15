import { useState, useCallback, useRef } from 'react';
import { getSmartSuggestions } from '../api/gemini';
import type { DiscoveredFile, AttachedFile, WindowContext, Suggestion } from '../types';
import { IMAGE_EXTS } from '../types';

interface UseSuggestionsOptions {
    isDeepFileMode: boolean;
    selectedFiles: string[];
    discoveredFiles: DiscoveredFile[];
    attachedFiles: AttachedFile[];
    lightExcerpts: Map<string, string>;
    getCachedContent?: () => string;
    allSelectedLoaded?: boolean;
    fileContentCache?: Map<string, { content: string; pageCount: number; loading: boolean; error?: string }>;
    showScreenshot: boolean;
    captureMode: 'full' | 'partial';
    lastScreenshot64: string | null;
    activeWindowContext: WindowContext;
    isPrivacyMode: boolean;
    blacklistedIds: Map<string, number>;
    setBlacklistedIds: React.Dispatch<React.SetStateAction<Map<string, number>>>;
    setFailedAccessNames: React.Dispatch<React.SetStateAction<string[]>>;
    isAgentMode?: boolean;
}

export function useSuggestions(opts: UseSuggestionsOptions) {
    const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
    const [isFetchingSuggestions, setIsFetchingSuggestions] = useState(false);
    const [lastSuggestionContext, setLastSuggestionContext] = useState<string | null>(null);
    const [showSuggestionsContent, setShowSuggestionsContent] = useState(true);
    const [isUserManuallyHidden, setIsUserManuallyHidden] = useState(false);
    const suggestionsRef = useRef<HTMLDivElement>(null);
    const prevShowSuggestionsRef = useRef(true);
    const abortRef = useRef<AbortController | null>(null);
    const lastScreenshotRef = useRef<string | null>(null);
    lastScreenshotRef.current = opts.lastScreenshot64;
    const showScreenshotRef = useRef(opts.showScreenshot);
    showScreenshotRef.current = opts.showScreenshot;
    const captureModeRef = useRef(opts.captureMode);
    captureModeRef.current = opts.captureMode;

    const [wasStopped, setWasStopped] = useState(false);
    // Frozen = suggestions stay stale, only manual refresh (isRefresh=true) can unfreeze
    const [isFrozen, setIsFrozen] = useState(false);

    const freezeSuggestions = useCallback(() => {
        setIsFrozen(true);
        setShowSuggestionsContent(false);
        setIsUserManuallyHidden(true);
        // Stop any in-flight fetch
        if (abortRef.current) {
            abortRef.current.abort();
            abortRef.current = null;
        }
        setIsFetchingSuggestions(false);
    }, []);

    const stopSuggestions = useCallback(() => {
        if (abortRef.current) {
            abortRef.current.abort();
            abortRef.current = null;
        }
        setIsFetchingSuggestions(false);
        setWasStopped(true);
    }, []);

    const fetchSuggestions = useCallback(async (isRefresh = false) => {
        // When frozen (agent mode after first submit), only manual refresh can proceed
        if (isFrozen && !isRefresh) return;
        if (isFrozen && isRefresh) setIsFrozen(false);

        // Abort previous fetch if still running
        if (abortRef.current) abortRef.current.abort();
        abortRef.current = new AbortController();
        const {
            isDeepFileMode, selectedFiles, discoveredFiles, attachedFiles,
            lightExcerpts, showScreenshot, captureMode, lastScreenshot64,
            activeWindowContext, isPrivacyMode, blacklistedIds,
            setBlacklistedIds, setFailedAccessNames,
        } = opts;

        if (isFetchingSuggestions && !isRefresh) return;

        // Don't auto-expand here — App.tsx handles collapse/expand via useEffect
        setIsFetchingSuggestions(true);
        setSuggestions([]);
        if (isRefresh) {
            setBlacklistedIds(new Map());
            setLastSuggestionContext('');
        }
        try {
            let imageBase64: string | string[] | null = null;
            let textContent: string | null = null;

            if (isDeepFileMode) {
                if (selectedFiles.length === 0 && attachedFiles.length === 0) {
                    setSuggestions([]);
                    setIsFetchingSuggestions(false);
                    setFailedAccessNames([]);
                    return;
                }

                const selectedItems = discoveredFiles.filter(f => selectedFiles.includes(f.id));
                const bgItems = discoveredFiles.filter(f => !selectedFiles.includes(f.id));

                const itemsToFetch = isRefresh ? selectedItems : selectedItems.filter(f => !blacklistedIds.has(f.id));
                const blacklistedItems = selectedItems.filter(f => blacklistedIds.has(f.id) && !isRefresh);

                const attachItems = attachedFiles.map(f => ({
                    id: `attached:${f.path}`, name: f.name,
                    type: IMAGE_EXTS.includes(f.ext) ? 'image' : 'file',
                    source: 'Attached', localPath: f.path,
                }));
                if (attachItems.length > 0) {
                    itemsToFetch.push(...attachItems as any);
                }

                let combinedResults: any[] = [];
                // Use pre-loaded cache if available (much faster than re-reading files)
                const cachedContent = opts.getCachedContent?.();
                if (cachedContent && cachedContent.length > 50 && opts.allSelectedLoaded) {
                    // Build results from cache — no IPC call needed
                    for (const item of selectedItems) {
                        const cached = (opts as any).fileContentCache?.get(item.id);
                        if (cached?.content) {
                            combinedResults.push({ ...item, content: cached.content, pageCount: cached.pageCount });
                        }
                    }
                    // Still need to fetch attachments (not cached)
                    if (attachItems.length > 0) {
                        const attachResult = await window.electron.readMultipleFiles(attachItems);
                        if (attachResult.results) combinedResults.push(...attachResult.results);
                    }
                } else if (itemsToFetch.length > 0) {
                    const result = await window.electron.readMultipleFiles(itemsToFetch);
                    if (result.results) {
                        combinedResults = [...result.results];
                    }
                }

                blacklistedItems.forEach(item => {
                    combinedResults.push({ ...item, skipped: true, error: 'Previously failed access' });
                });

                if (combinedResults.length > 0) {
                    const failedNames: string[] = [];
                    const newBlacklist = new Map(blacklistedIds);

                    textContent = '=== PRIMARY DOCUMENTS (SELECTED BY USER) ===\n' +
                        combinedResults.map((f: any) => {
                            if (f.error && !f.skipped) {
                                failedNames.push(f.name);
                                newBlacklist.set(f.id, Date.now());
                            } else if (f.error && f.skipped) {
                                failedNames.push(f.name);
                            }
                            const label = f.type === 'web' ? 'Web Tab' : 'File';
                            const sourceInfo = f.url ? ` (URL: ${f.url})` : '';
                            const content = f.content || (f.error ? `[ERROR: ${f.error}]` : '[No content could be extracted]');
                            return `[${label}: ${f.name}${sourceInfo}]\n${content}`;
                        }).join('\n\n');

                    setFailedAccessNames(failedNames);
                    setBlacklistedIds(newBlacklist);
                } else {
                    setFailedAccessNames([]);
                }

                if (!textContent) {
                    const result = await window.electron.readActiveFile();
                    if (result.content) textContent = result.content;
                }

                if (!textContent && selectedFiles.length > 0) {
                    textContent = `The user has selected the following documents but content extraction failed: ${selectedItems.map(i => i.name).join(', ')}. Please suggest general analysis actions based on these filenames.`;
                }
            } else if (showScreenshot || showScreenshotRef.current || lastScreenshotRef.current) {
                const effectiveCaptureMode = captureModeRef.current || captureMode;
                // Use ALL stack images for richer suggestions (both full and partial modes)
                const stackImages = (opts as any).screenshotStack;
                if (stackImages && stackImages.length > 0) {
                    const allSnips = stackImages.map((s: any) => typeof s === 'string' ? s : s?.base64).filter(Boolean);
                    if (allSnips.length > 0) {
                        imageBase64 = allSnips.length === 1 ? allSnips[0] : allSnips;
                    }
                }
                // Fallback: use latest screenshot ref or capture fresh
                if (!imageBase64) {
                    if (effectiveCaptureMode === 'partial') {
                        const snipImage = lastScreenshotRef.current || lastScreenshot64;
                        if (snipImage) {
                            imageBase64 = snipImage;
                        } else {
                            setIsFetchingSuggestions(false);
                            return;
                        }
                    } else {
                        imageBase64 = await window.electron.captureScreenRaw();
                    }
                }
            }

            if (attachedFiles.length > 0 && !textContent) {
                const attachItems = attachedFiles.map(f => ({
                    id: f.path, name: f.name, type: IMAGE_EXTS.includes(f.ext) ? 'image' : 'file',
                    source: 'Attached', localPath: f.path,
                }));
                const attachResult = await window.electron.readMultipleFiles(attachItems);
                if (attachResult.results) {
                    textContent = '=== ATTACHED FILES ===\n' + attachResult.results
                        .filter((f: any) => f.content)
                        .map((f: any) => `[File: ${f.name}]\n${f.content}`)
                        .join('\n\n');
                }
            }

            const currentContext = textContent || (imageBase64 ? `screenshot_${Date.now()}` : 'none');
            if (!isRefresh && currentContext === lastSuggestionContext) {
                setIsFetchingSuggestions(false);
                return;
            }

            const isMultiFile = isDeepFileMode && selectedFiles.length > 1;
            const newSuggestions = await getSmartSuggestions(imageBase64, textContent, isMultiFile, activeWindowContext, isPrivacyMode, opts.isAgentMode || false);

            // Inject screen actions as the first suggestions when screenshot + agent mode
            if (opts.isAgentMode && showScreenshot && imageBase64) {
                const proc = (activeWindowContext?.process || '').toLowerCase();
                const title = (activeWindowContext?.title || '').toLowerCase();
                const screenSuggestions: typeof newSuggestions = [];

                if (title.includes('error') || title.includes('exception') || title.includes('failed')) {
                    screenSuggestions.push({ label: '🔍 Search this error', prompt: 'Read the error message in this screenshot and provide: what causes it, the most likely fix, and if it\'s a common issue.', type: 'chat' });
                }
                if (['chrome', 'msedge', 'firefox', 'brave', 'excel'].includes(proc) || proc.includes('sheets')) {
                    screenSuggestions.push({ label: '📊 Extract table to Excel', prompt: 'Extract all data from the table visible in this screenshot and save as an Excel spreadsheet.', type: 'document' });
                }
                if (proc.includes('code') || proc.includes('devenv') || proc.includes('notepad')) {
                    screenSuggestions.push({ label: '💡 Explain this code', prompt: 'Read and explain the code visible in this screenshot. Identify any bugs or issues.', type: 'chat' });
                }

                // Prepend screen actions, cap total at 5
                const combined = [...screenSuggestions, ...newSuggestions].slice(0, 5);
                setSuggestions(combined);
            } else {
                setSuggestions(newSuggestions);
            }
            setWasStopped(false); // Clear stopped state on successful fetch
            setLastSuggestionContext(currentContext);
        } catch (error) {
            console.error('Error fetching suggestions:', error);
            setWasStopped(true); // Keep section visible so user can retry
        } finally {
            setIsFetchingSuggestions(false);
        }
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [
        opts.isDeepFileMode, opts.selectedFiles, opts.discoveredFiles,
        opts.attachedFiles, opts.lightExcerpts, opts.showScreenshot,
        opts.captureMode, opts.lastScreenshot64, opts.activeWindowContext,
        opts.isPrivacyMode, opts.blacklistedIds, isFetchingSuggestions,
        lastSuggestionContext, isUserManuallyHidden, isFrozen,
    ]);

    // Immediately set refs (bypasses React state batching)
    const setLastScreenshotImmediate = useCallback((b64: string) => {
        lastScreenshotRef.current = b64;
        showScreenshotRef.current = true;
    }, []);

    return {
        suggestions, setSuggestions,
        isFetchingSuggestions,
        lastSuggestionContext, setLastSuggestionContext,
        showSuggestionsContent, setShowSuggestionsContent,
        isUserManuallyHidden, setIsUserManuallyHidden,
        suggestionsRef,
        prevShowSuggestionsRef,
        fetchSuggestions,
        stopSuggestions,
        setLastScreenshotImmediate,
        wasStopped,
        isFrozen, freezeSuggestions,
    };
}
