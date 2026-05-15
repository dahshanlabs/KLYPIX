import { useState, useRef } from 'react';
import { routeToModel } from '../core/aiRouter';
import { saveMemoryEvent, getMemoryHistory } from '../api/memoryStore';
import { updateLivingPersona } from '../api/gemini';
import { marked } from 'marked';
import type { Message, DiscoveredFile, AttachedFile, WindowContext } from '../types';
import { IMAGE_EXTS } from '../types';

interface UseChatOptions {
    selectedModel: string;
    activeWindowContext: WindowContext;
    isPrivacyMode: boolean;
    isTTSEnabled: boolean;
    isDeepFileMode: boolean;
    showScreenshot: boolean;
    discoveredFiles: DiscoveredFile[];
    selectedFiles: string[];
    attachedFiles: AttachedFile[];
    setAttachedFiles: React.Dispatch<React.SetStateAction<AttachedFile[]>>;
    setIsReadingFile: (v: boolean) => void;
    setDeepFileError: (v: string | null) => void;
    setActiveFileInfo: (v: { fileName: string; pageCount: number } | null) => void;
    onPasswordNeeded?: (info: { fileName: string; filePath: string }) => void;
    getCachedContent?: () => string;
    allSelectedLoaded?: boolean;
    fileContentCache?: Map<string, { content: string; pageCount: number; loading: boolean; error?: string }>;
    captureMode: 'full' | 'partial';
    lastScreenshot64: string | null;
    setLastScreenshot64: (v: string | null) => void;
    useLastScreenshot: boolean;
    setUseLastScreenshot: (v: boolean) => void;
    captureFullScreen: () => Promise<string | null>;
    launchSnipping: () => Promise<string | null>;
    setShowSuggestionsContent: (v: boolean) => void;
    setCurrentChatId: (v: string | null) => void;
    onResponseComplete?: (fullResponse: string) => void;
    screenshotStack?: string[]; // base64 array for multi-screenshot mode
    sessionContextSummary?: string; // from session context bus
    // Auto-return callbacks (workflow redesign)
    setShowScreenshot?: (v: boolean) => void;
    setIsDeepFileMode?: (v: boolean) => void;
    clearStack?: () => void;
}

export function useChat(opts: UseChatOptions) {
    const [messages, setMessages] = useState<Message[]>(() => {
        try {
            const saved = localStorage.getItem('active_messages');
            if (saved) return JSON.parse(saved);
        } catch (e) { console.error('Could not load active messages', e); }
        return [];
    });
    const [isAnalyzing, setIsAnalyzing] = useState(false);
    const [isTyping, setIsTyping] = useState(false);
    const [response, setResponse] = useState<string | null>(null);
    const [displayedResponse, setDisplayedResponse] = useState('');
    const [keepConversation, setKeepConversation] = useState(true);
    const [copiedIndex, setCopiedIndex] = useState<number | null>(null);
    const [isCopyFullActive, setIsCopyFullActive] = useState(false);

    const [isSearchOpen, setIsSearchOpen] = useState(false);
    const [searchQuery, setSearchQuery] = useState('');
    const [searchResultIndices, setSearchResultIndices] = useState<number[]>([]);
    const [currentSearchIndex, setCurrentSearchIndex] = useState(-1);
    const activeResultRef = useRef<HTMLDivElement>(null);
    const searchInputRef = useRef<HTMLInputElement>(null);

    const scrollRef = useRef<HTMLDivElement>(null);
    const isAtBottomRef = useRef(true);
    const typingIntervalRef = useRef<NodeJS.Timeout | null>(null);
    const cancelledRef = useRef(false);
    // Persistent conversation context — single source of truth for follow-ups
    const conversationContextRef = useRef<{
        activeImage: string | string[] | null;
        activeDocContent: string | null;
        imageDescription: string | null;
        turnsWithImage: number;
    }>({ activeImage: null, activeDocContent: null, imageDescription: null, turnsWithImage: 0 });

    const saveMessages = (msgs: Message[]) => {
        try {
            if (msgs.length > 0) {
                localStorage.setItem('active_messages', JSON.stringify(msgs));
            } else {
                localStorage.removeItem('active_messages');
            }
        } catch (e) { console.error('Could not save active messages', e); }
    };

    const finishSubmit = async (text: string, image: string | string[] | null, history: Message[]) => {
        const { selectedModel, activeWindowContext, isPrivacyMode, isTTSEnabled } = opts;
        opts.setUseLastScreenshot(false);
        cancelledRef.current = false;
        try {
            const streamResult = await routeToModel(text, image, history, selectedModel, activeWindowContext, isPrivacyMode, opts.sessionContextSummary);
            setIsAnalyzing(false);
            setIsTyping(true);

            let fullResponse = '';
            for await (const chunk of streamResult.stream) {
                if (cancelledRef.current) break;
                const chunkText = chunk.text();
                fullResponse += chunkText;
                setDisplayedResponse(fullResponse);
            }

            setIsTyping(false);
            setMessages(prev => {
                const next = [...prev, { role: 'assistant' as const, content: fullResponse }];
                saveMessages(next);
                return next;
            });

            // Track turns with image context
            if (conversationContextRef.current.activeImage) {
                conversationContextRef.current.turnsWithImage++;
            }

            // Notify App.tsx for screen action interception
            opts.onResponseComplete?.(fullResponse);

            const eventType = opts.isDeepFileMode ? 'file-analysis' as const
                : opts.showScreenshot ? 'screenshot-analysis' as const
                : 'chat' as const;
            saveMemoryEvent({
                timestamp: Date.now(),
                app: activeWindowContext.process,
                title: activeWindowContext.title,
                query: text,
                responsePreview: fullResponse.substring(0, 300),
                type: eventType,
            });

            if (getMemoryHistory().length % 5 === 0) {
                updateLivingPersona(isPrivacyMode);
            }

            if (isTTSEnabled) {
                const utterance = new SpeechSynthesisUtterance(fullResponse);
                utterance.rate = 1.1;
                window.speechSynthesis.cancel();
                window.speechSynthesis.speak(utterance);
            }

            setResponse(null);
            setDisplayedResponse('');
        } catch (error: any) {
            console.error('Streaming error:', error);
            setIsAnalyzing(false);
            setIsTyping(false);
            setMessages(prev => {
                const next = [...prev, {
                    role: 'assistant' as const,
                    content: `Sorry, I encountered an error: ${error.message || 'Unknown error'}. This might be due to model availability or image processing.`,
                }];
                saveMessages(next);
                return next;
            });
        }
    };

    const handleSubmit = async (
        e?: React.FormEvent,
        manualQuery?: string,
        isVoiceInput = false,
        displayQuery?: string,
        query = '',
        inputRef?: React.RefObject<HTMLTextAreaElement | null>,
        setQuery?: (v: string) => void,
        setTextareaHeight?: (v: number) => void,
    ) => {
        e?.preventDefault();
        const {
            isDeepFileMode, showScreenshot,
            discoveredFiles, selectedFiles, attachedFiles, setAttachedFiles,
            setIsReadingFile, setDeepFileError, setActiveFileInfo,
            captureMode, lastScreenshot64, setLastScreenshot64,
            useLastScreenshot, captureFullScreen, launchSnipping,
            setShowSuggestionsContent, setCurrentChatId,
        } = opts;

        let currentQuery = manualQuery !== undefined ? manualQuery : query;
        if (!currentQuery.trim() && !showScreenshot && !isDeepFileMode && attachedFiles.length === 0) return;

        let promptForAI = isVoiceInput ? `(Voice Input - Correct transcription errors if any): ${currentQuery}` : currentQuery;

        if (setQuery) setQuery('');
        if (inputRef?.current) {
            inputRef.current.value = '';
            inputRef.current.style.height = 'auto';
            inputRef.current.style.height = '38px';
            inputRef.current.style.overflowY = 'hidden';
            if (setTextareaHeight) setTextareaHeight(38);
        }

        setShowSuggestionsContent(false);
        setIsAnalyzing(true);
        setResponse(null);
        setDisplayedResponse('');
        setActiveFileInfo(null);
        setDeepFileError(null);
        isAtBottomRef.current = true;

        // Get current messages before any async state changes
        let currentMessages: Message[] = [];
        setMessages(prev => { currentMessages = prev; return prev; });

        if (!keepConversation) {
            setMessages([]);
            saveMessages([]);
            setCurrentChatId(null);
            conversationContextRef.current = { activeImage: null, activeDocContent: null, imageDescription: null, turnsWithImage: 0 };
        }

        const sourceMode = isDeepFileMode ? 'deep-file' as const
            : showScreenshot && captureMode === 'partial' ? 'partial-screenshot' as const
            : showScreenshot ? 'full-screenshot' as const
            : 'chat' as const;
        const newUserMsg: Message = {
            role: 'user',
            content: displayQuery || currentQuery || (showScreenshot ? '[Screenshots Analysis]' : ''),
            sourceMode,
        };
        setMessages(prev => {
            const next = [...prev, newUserMsg];
            saveMessages(next);
            return next;
        });

        // Deep file mode
        if (isDeepFileMode) {
            if (selectedFiles.length === 0 && attachedFiles.length === 0) {
                setDeepFileError('Please select at least one file or attach a document before submitting.');
                setIsAnalyzing(false);
                return;
            }

            setIsReadingFile(true);
            const filesToRead = discoveredFiles.filter(f => selectedFiles.includes(f.id));
            attachedFiles.forEach(f => {
                (filesToRead as any[]).push({
                    id: `attached:${f.path}`, name: f.name,
                    type: IMAGE_EXTS.includes(f.ext) ? 'image' : 'file',
                    source: 'Attached', localPath: f.path, url: '',
                });
            });

            // Use pre-loaded cache if all selected files are loaded
            let result: any;
            if (opts.allSelectedLoaded && opts.fileContentCache) {
                const cachedResults = filesToRead.map((f: any) => {
                    const cached = opts.fileContentCache!.get(f.id);
                    if (cached?.content) {
                        return { ...f, content: cached.content, pageCount: cached.pageCount };
                    }
                    return f; // uncached (attachments) — will be read below
                });
                const uncached = cachedResults.filter((r: any) => !r.content);
                if (uncached.length > 0) {
                    const uncachedResult = await window.electron.readMultipleFiles(uncached);
                    result = { results: [...cachedResults.filter((r: any) => r.content), ...(uncachedResult.results || [])] };
                } else {
                    result = { results: cachedResults };
                }
            } else {
                result = await window.electron.readMultipleFiles(filesToRead);
            }
            setIsReadingFile(false);

            if (result.error) {
                setDeepFileError(result.error);
                setIsAnalyzing(false);
                return;
            }

            if (result.results && result.results.length > 0) {
                // Check for password-protected PDFs
                const passwordFile = result.results.find((f: any) => f.needsPassword);
                if (passwordFile && opts.onPasswordNeeded) {
                    opts.onPasswordNeeded({ fileName: passwordFile.name || passwordFile.originalTitle, filePath: passwordFile.localPath || '' });
                    setIsAnalyzing(false);
                    return;
                }

                setActiveFileInfo({ fileName: `${filesToRead.length} documents attached`, pageCount: 0 });
                let combinedContext = '\n\n--- MULTIPLE DOCUMENTS CONTEXT ---\n';
                for (const f of result.results) {
                    if (f.error) {
                        combinedContext += `\n[Error reading ${f.name}: ${f.error}]\n`;
                    } else {
                        const label = f.type === 'web' ? 'Web Tab' : 'Document';
                        const sourceInfo = f.url ? ` (URL: ${f.url})` : `Source: ${f.source}`;
                        combinedContext += `\n${label}: ${f.name}${f.type !== 'web' ? ' (' + f.pageCount + ' pages)' : ''}\n${sourceInfo}\n${f.content}\n`;
                    }
                }
                combinedContext += '\n--- END OF DOCUMENTS ---';
                promptForAI = promptForAI + combinedContext;
                // Save document context for follow-up questions
                conversationContextRef.current.activeDocContent = combinedContext;

                setMessages(prev => {
                    const newArr = [...prev];
                    newArr[newArr.length - 1] = {
                        ...newArr[newArr.length - 1],
                        attachedFiles: filesToRead.map(f => f.name),
                        attachedFile: { name: filesToRead.map(f => f.name).join(', '), content: combinedContext },
                    };
                    saveMessages(newArr);
                    return newArr;
                });
            } else {
                setDeepFileError('No content could be extracted from the selected files.');
                setIsAnalyzing(false);
                return;
            }

            if (attachedFiles.length > 0) setAttachedFiles([]);
        }

        // Attached files (non-deep mode)
        if (attachedFiles.length > 0 && !isDeepFileMode) {
            setIsReadingFile(true);
            const attachItems = attachedFiles.map(f => ({
                id: f.path, name: f.name,
                type: IMAGE_EXTS.includes(f.ext) ? 'image' : 'file',
                source: 'Attached', localPath: f.path,
            }));
            const attachResult = await window.electron.readMultipleFiles(attachItems);
            setIsReadingFile(false);

            if (attachResult.results && attachResult.results.length > 0) {
                let attachContext = '\n\n--- ATTACHED FILES ---\n';
                for (const f of attachResult.results) {
                    if (f.error) {
                        attachContext += `\n[Error reading ${f.name}: ${f.error}]\n`;
                    } else {
                        attachContext += `\nDocument: ${f.name} (${f.pageCount || 0} pages)\n${f.content}\n`;
                    }
                }
                attachContext += '\n--- END OF ATTACHED FILES ---';
                promptForAI = promptForAI + attachContext;

                setMessages(prev => {
                    const newArr = [...prev];
                    const lastMsg = newArr[newArr.length - 1];
                    const existingAttached = lastMsg.attachedFiles || [];
                    newArr[newArr.length - 1] = {
                        ...lastMsg,
                        attachedFiles: [...existingAttached, ...attachedFiles.map(f => f.name)],
                    };
                    saveMessages(newArr);
                    return newArr;
                });
            }
            setAttachedFiles([]);
        }

        // Screenshot mode
        let screenshotBase64: string | null = null;
        if (showScreenshot && !isDeepFileMode) {
            if (useLastScreenshot && lastScreenshot64) {
                screenshotBase64 = lastScreenshot64;
            } else if (opts.screenshotStack && opts.screenshotStack.length > 0) {
                // Stack already has captured images — use them, don't re-capture
                screenshotBase64 = lastScreenshot64 || opts.screenshotStack[0];
            } else if (captureMode === 'partial') {
                // In partial mode with no stack: trigger snipping tool
                if (lastScreenshot64) {
                    screenshotBase64 = lastScreenshot64;
                } else {
                    const snipBase64 = await launchSnipping();
                    if (snipBase64) {
                        setLastScreenshot64(snipBase64);
                        screenshotBase64 = snipBase64;
                    } else {
                        setIsAnalyzing(false);
                        return;
                    }
                }
            } else {
                // No stack, full mode — capture fresh
                screenshotBase64 = await captureFullScreen();
            }

            // Attach screenshot(s) to the user message for display
            const hasStack = opts.screenshotStack && opts.screenshotStack.length > 1;
            if (hasStack) {
                // Multiple screenshots — store as multi: format for inline previews
                setMessages(prev => {
                    const newArr = [...prev];
                    newArr[newArr.length - 1] = { ...newArr[newArr.length - 1], attachedImage: `multi:${JSON.stringify(opts.screenshotStack)}` };
                    saveMessages(newArr);
                    return newArr;
                });
            } else if (screenshotBase64) {
                setMessages(prev => {
                    const newArr = [...prev];
                    newArr[newArr.length - 1] = { ...newArr[newArr.length - 1], attachedImage: screenshotBase64 };
                    saveMessages(newArr);
                    return newArr;
                });
            }
        }

        window.electron.resizeWindow(700);

        // Auto-return to default state on send (mode's job is done)
        if (opts.showScreenshot) opts.setShowScreenshot?.(false);
        if (opts.isDeepFileMode) opts.setIsDeepFileMode?.(false);
        opts.clearStack?.();

        const historyForSubmit = keepConversation ? currentMessages : [];
        // Use screenshot stack for multi-image mode, single screenshot otherwise
        let imageToSend: string | string[] | null = opts.screenshotStack && opts.screenshotStack.length > 1
            ? opts.screenshotStack
            : screenshotBase64;

        // Update conversation context — single source of truth
        if (imageToSend) {
            conversationContextRef.current.activeImage = imageToSend;
            conversationContextRef.current.turnsWithImage = 0;
            conversationContextRef.current.imageDescription = null; // reset on new image
        }

        // Inject active image context — but NOT when attachments/documents are present
        // (attached file text should take priority over stale On Screen screenshot)
        const hasAttachedContent = promptForAI.includes('--- ATTACHED FILES ---') || promptForAI.includes('--- MULTIPLE DOCUMENTS');
        const contextImage = imageToSend || (hasAttachedContent ? null : conversationContextRef.current.activeImage);

        // Document context for follow-ups (inject into prompt if no image)
        let finalPrompt = promptForAI;
        if (!contextImage && conversationContextRef.current.activeDocContent) {
            finalPrompt = promptForAI + '\n\n--- DOCUMENT CONTEXT (from earlier in this conversation) ---\n'
                + conversationContextRef.current.activeDocContent
                + '\n--- END CONTEXT ---';
        }

        await finishSubmit(finalPrompt, contextImage, historyForSubmit);
    };

    const stopGeneration = () => {
        cancelledRef.current = true;
        if (typingIntervalRef.current) clearInterval(typingIntervalRef.current);
        setIsAnalyzing(false);
        setIsTyping(false);
        window.speechSynthesis.cancel();
        if (response) {
            setMessages(prev => {
                const next = [...prev, { role: 'assistant' as const, content: displayedResponse + ' [Stopped]' }];
                saveMessages(next);
                return next;
            });
            setResponse(null);
            setDisplayedResponse('');
        }
    };

    const copyToClipboard = async (text: string, index: number) => {
        const html = await marked.parse(text);
        window.electron.copyToClipboard({ text, html });
        setCopiedIndex(index);
        setTimeout(() => setCopiedIndex(null), 2000);
    };

    const copyFullChat = async () => {
        if (messages.length === 0) return;
        setIsCopyFullActive(true);
        const fullText = messages.map(m => `${m.role === 'user' ? 'USER' : 'KLYPIX'}: ${m.content}`).join('\n\n---\n\n');
        const fullHtml = await marked.parse(fullText);
        window.electron.copyToClipboard({ text: fullText, html: fullHtml });
        setTimeout(() => setIsCopyFullActive(false), 2000);
    };

    const handleSearchNav = (direction: 'next' | 'prev') => {
        if (searchResultIndices.length === 0) return;
        if (direction === 'next') {
            setCurrentSearchIndex(prev => (prev + 1) % searchResultIndices.length);
        } else {
            setCurrentSearchIndex(prev => (prev - 1 + searchResultIndices.length) % searchResultIndices.length);
        }
    };

    return {
        messages, setMessages,
        isAnalyzing, setIsAnalyzing,
        isTyping,
        response,
        displayedResponse,
        keepConversation, setKeepConversation,
        copiedIndex,
        isCopyFullActive,
        isSearchOpen, setIsSearchOpen,
        searchQuery, setSearchQuery,
        searchResultIndices, setSearchResultIndices,
        currentSearchIndex, setCurrentSearchIndex,
        activeResultRef,
        searchInputRef,
        scrollRef,
        isAtBottomRef,
        typingIntervalRef,
        handleSubmit,
        finishSubmit,
        stopGeneration,
        copyToClipboard,
        copyFullChat,
        handleSearchNav,
        saveMessages,
        getActiveDocContent: () => conversationContextRef.current.activeDocContent,
        setActiveImage: (img: string | string[] | null) => { conversationContextRef.current.activeImage = img; },
        clearActiveDocContent: () => { conversationContextRef.current.activeDocContent = null; conversationContextRef.current.imageDescription = null; },
        setActiveDocContent: (content: string) => { conversationContextRef.current.activeDocContent = content; },
    };
}
