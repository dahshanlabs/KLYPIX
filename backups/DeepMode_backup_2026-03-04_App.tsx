import React, { useState, useEffect, useRef, useCallback } from 'react';
import { Send, Loader2, Image as ImageIcon, ImageOff, X, Maximize, Square, Mic, Settings, Volume2, Copy, Check, Square as StopIcon, MicOff, VolumeX, Keyboard, ChevronLeft, Minus, FileSearch, MessageSquare, Lock } from 'lucide-react';
import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';
import { askGeminiStreaming } from './api/gemini';
import { routeToModel } from './core/aiRouter';
import { AVAILABLE_MODELS } from './core/aiModels';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { marked } from 'marked';

const DECISION_PROMPT = `You are a strategic advisor. Analyze the content on screen 
and deliver a structured decision brief.

RULES:
- No preamble
- State the recommendation with confidence
- No hedging language
- Maximum 5 lines per section

OUTPUT FORMAT:
Core Insight:
[What this situation actually is, in one sentence.]

Trade-Off:
[What is gained vs. what is sacrificed.]

Recommended Move:
[Exactly what to do. Imperative tone.]

Confidence: [X]%
[One sentence explaining this confidence level.]`;

const RISK_PROMPT = `You are a risk analyst. Analyze the content on screen 
and deliver a structured risk assessment.

RULES:
- No preamble
- Focus exclusively on potential downsides and vulnerabilities
- Be direct and objective
- Maximum 5 lines per section

OUTPUT FORMAT:
Primary Threat:
[What is the single biggest risk here, in one sentence.]

Vulnerabilities:
[List key weaknesses or blind spots.]

Mitigation:
[Immediate steps to protect against these risks. Imperative tone.]

Severity: [1-10]
[One sentence explaining this severity rating.]`;

const ACTIONS_PROMPT = `You are a project manager. Analyze the content on screen 
and turn it into a clear, actionable to-do list.

RULES:
- No preamble
- Extract only concrete, actionable items
- Start each item with a verb
- Group by priority if applicable

OUTPUT FORMAT:
Goal:
[What is the overarching objective here, in one sentence.]

Immediate Next Steps:
- [Action 1]
- [Action 2]
- [Action 3]

Follow-up Items:
- [Item 1]
- [Item 2]`;

const CLARIFY_PROMPT = `You are an expert communicator and teacher. Analyze the content on screen 
and explain it simply and clearly.

RULES:
- No preamble
- Avoid jargon or define it simply
- Use analogies if helpful
- Keep it concise and accessible

OUTPUT FORMAT:
The Core Concept:
[Explain this as if I am a beginner, in 1-2 sentences.]

Key Components:
- [Component 1 explained simply]
- [Component 2 explained simply]

Why It Matters:
[The real-world implication or practical use case of this concept.]`;

function cn(...inputs: ClassValue[]) {
    return twMerge(clsx(inputs));
}

declare global {
    interface Window {
        electron: {
            captureScreen: () => Promise<string | null>;
            captureScreenRaw: () => Promise<string | null>;
            hideWindow: () => void;
            showWindow: () => void;
            minimizeWindow: () => void;
            toggleMaximize: () => void;
            resizeWindow: (height: number, width?: number) => void;
            setIgnoreMouseEvents: (ignore: boolean, options?: any) => void;
            getCursorPosition: () => Promise<{ x: number, y: number }>;
            getPrimaryDisplaySize: () => Promise<{ width: number, height: number }>;
            launchNativeSnipping: () => Promise<string | null>;
            copyToClipboard: (data: { text: string, html: string }) => void;
            getShortcut: () => Promise<string>;
            setShortcut: (shortcut: string) => Promise<{ success: boolean, shortcut?: string, error?: string }>;
            readActiveFile: () => Promise<{ fileName?: string; pageCount?: number; content?: string; truncated?: boolean; error?: string; windowTitle?: string }>;
        };
    }
}

interface Message {
    role: 'user' | 'assistant';
    content: string;
}

const MessageItem = React.memo(({ msg, idx, copiedIndex, copyToClipboard }: {
    msg: Message;
    idx: number;
    copiedIndex: number | null;
    copyToClipboard: (text: string, index: number) => void;
}) => {
    return (
        <div className={cn(
            "flex flex-col gap-2 animate-in slide-in-from-bottom-2 duration-300 items-start"
        )}>
            {msg.role === 'user' ? (
                <div className="bg-white/10 border border-white/20 px-4 py-2 rounded-2xl max-w-[90%] text-sm text-white font-medium shadow-sm">
                    {msg.content}
                </div>
            ) : (
                <div className="group relative w-full flex flex-col gap-1.5">
                    <div className="flex items-center gap-1.5 mb-0.5 opacity-80">
                        <img src="/logo.png" className="w-3.5 h-3.5" alt="logo" />
                        <span className="text-[10px] font-bold tracking-tight text-white/50 uppercase font-poppins">ALT+Space</span>
                    </div>
                    <div className="markdown-content text-sm leading-relaxed text-slate-200 pr-8">
                        <ReactMarkdown remarkPlugins={[remarkGfm]}>
                            {msg.content}
                        </ReactMarkdown>
                    </div>
                    <button
                        onClick={() => copyToClipboard(msg.content, idx)}
                        className="absolute top-0 right-0 p-1.5 text-white/20 hover:text-white/60 hover:bg-white/5 rounded-lg transition-all opacity-0 group-hover:opacity-100"
                        title="Copy Response"
                    >
                        {copiedIndex === idx ? <Check size={14} className="text-green-400" /> : <Copy size={14} />}
                    </button>
                </div>
            )}
        </div>
    );
});

export default function App() {
    const [query, setQuery] = useState('');
    const [isCapturing, setIsCapturing] = useState(false);
    const [isAnalyzing, setIsAnalyzing] = useState(false);
    const [response, setResponse] = useState<string | null>(null);
    const [displayedResponse, setDisplayedResponse] = useState('');
    const [showScreenshot, setShowScreenshot] = useState(true);
    const [captureMode, setCaptureMode] = useState<'full' | 'partial'>('full');
    const [isTyping, setIsTyping] = useState(false);
    const [isMaximized, setIsMaximized] = useState(false);
    const [messages, setMessages] = useState<Message[]>([]);
    const [isTTSEnabled, setIsTTSEnabled] = useState(false);
    const [isVoiceDictationEnabled, setIsVoiceDictationEnabled] = useState(true);
    const [showSettings, setShowSettings] = useState(false);
    const [copiedIndex, setCopiedIndex] = useState<number | null>(null);
    const [lastScreenshot64, setLastScreenshot64] = useState<string | null>(null);
    const [useLastScreenshot, setUseLastScreenshot] = useState(false);
    const [currentShortcut, setCurrentShortcut] = useState('Alt+Space');
    const [isRecording, setIsRecording] = useState(false);
    const [isDeepFileMode, setIsDeepFileMode] = useState(false);
    const [deepFileError, setDeepFileError] = useState<string | null>(null);
    const [isReadingFile, setIsReadingFile] = useState(false);
    const [keepConversation, setKeepConversation] = useState(true);
    const [activeFileInfo, setActiveFileInfo] = useState<{ fileName: string; pageCount: number } | null>(null);
    const [selectedModel, setSelectedModel] = useState(localStorage.getItem('selected_model') || 'gemini-1.5-flash');
    const [showModelDropdown, setShowModelDropdown] = useState(false);

    useEffect(() => { localStorage.setItem('selected_model', selectedModel); }, [selectedModel]);

    const inputRef = useRef<HTMLInputElement>(null);
    const typingIntervalRef = useRef<NodeJS.Timeout | null>(null);
    const scrollRef = useRef<HTMLDivElement>(null);
    const isAtBottomRef = useRef(true);

    useEffect(() => {
        // Focus input when window is shown
        inputRef.current?.focus();

        // Initial shortcut load
        window.electron.getShortcut().then(setCurrentShortcut);
    }, []);

    // Also handle resizing when showSettings changes
    useEffect(() => {
        if (showSettings) {
            window.electron.resizeWindow(600);
        } else {
            // Revert to appropriate height (380 to fit dropdown, 500 when full)
            window.electron.resizeWindow(messages.length > 0 ? 500 : 380);
        }
    }, [showSettings, messages.length]);

    // Shortcut recording effect
    useEffect(() => {
        if (!isRecording) return;

        const handleGlobalKeyDown = async (e: KeyboardEvent) => {
            e.preventDefault();
            e.stopPropagation();

            const modifiers = [];
            if (e.ctrlKey) modifiers.push('Ctrl');
            if (e.shiftKey) modifiers.push('Shift');
            if (e.altKey) modifiers.push('Alt');
            if (e.metaKey) modifiers.push('Command');

            const key = e.key === ' ' ? 'Space' : e.key;

            // Basic validation: must have at least one modifier and a main key
            // (Exclude standalone modifiers)
            const isModifierOnly = ['Control', 'Shift', 'Alt', 'Meta'].includes(e.key);

            if (!isModifierOnly) {
                // Validation: Must have at least one modifier AND a key (2+ items)
                if (modifiers.length === 0) {
                    alert('Shortcut must include at least one modifier key (Alt, Ctrl, or Shift)');
                    setIsRecording(false);
                    return;
                }

                const newShortcut = [...modifiers, key].join('+');
                const result = await window.electron.setShortcut(newShortcut);
                if (result.success) {
                    setCurrentShortcut(newShortcut);
                    setIsRecording(false);
                } else {
                    alert(result.error || 'Failed to set shortcut');
                    setIsRecording(false);
                }
            }
        };

        window.addEventListener('keydown', handleGlobalKeyDown, true);
        return () => window.removeEventListener('keydown', handleGlobalKeyDown, true);
    }, [isRecording]);

    useEffect(() => {
        // Scroll to bottom on new messages, but only if user was already at the bottom
        if (scrollRef.current && isAtBottomRef.current) {
            // Use smooth scroll for user messages, but instant for typing to keep up
            const isTypingMessage = !messages.length || messages[messages.length - 1].role === 'assistant';
            scrollRef.current.scrollTo({
                top: scrollRef.current.scrollHeight,
                behavior: isTypingMessage ? 'auto' : 'smooth'
            });
        }
    }, [messages, displayedResponse]);

    const handleScroll = () => {
        if (scrollRef.current) {
            const { scrollTop, scrollHeight, clientHeight } = scrollRef.current;
            // If we are within 50px of the bottom, consider it "at bottom"
            const atBottom = scrollHeight - scrollTop - clientHeight < 50;
            isAtBottomRef.current = atBottom;
        }
    };

    const handleSubmit = async (e?: React.FormEvent, manualQuery?: string, isVoiceInput = false, displayQuery?: string) => {
        e?.preventDefault();
        let currentQuery = manualQuery !== undefined ? manualQuery : query;
        if (!currentQuery.trim() && !showScreenshot && !isDeepFileMode) return;

        // Add "AI Whisper" hint if from voice
        let promptForAI = isVoiceInput ? `(Voice Input - Correct transcription errors if any): ${currentQuery}` : currentQuery;

        setQuery('');
        setIsAnalyzing(true);
        setResponse(null);
        setDisplayedResponse('');
        setActiveFileInfo(null);
        setDeepFileError(null);
        isAtBottomRef.current = true; // Force follow for new question
        window.electron.resizeWindow(500);

        // If Keep Conversation is OFF, start fresh each time
        if (!keepConversation) setMessages([]);

        // Add user message to history (use original text for history)
        setMessages(prev => [...prev, { role: 'user', content: displayQuery || currentQuery || (showScreenshot ? "[Screenshots Analysis]" : "") }]);

        // ── Deep File Mode: read active file and inject into prompt ──────────
        if (isDeepFileMode) {
            setIsReadingFile(true);
            const result = await window.electron.readActiveFile();
            setIsReadingFile(false);
            if (result.error) {
                setDeepFileError(result.error);
                setIsAnalyzing(false);
                return;
            }
            if (result.fileName && result.content) {
                setActiveFileInfo({ fileName: result.fileName, pageCount: result.pageCount || 0 });
                const fileContext = `\n\n--- DOCUMENT CONTEXT ---\nFile: ${result.fileName} (${result.pageCount} pages/sheets)\n\n${result.content}\n--- END OF DOCUMENT ---`;
                promptForAI = promptForAI + fileContext;
            }
        }

        let screenshotBase64 = null;
        if (showScreenshot && !isDeepFileMode) {
            if (useLastScreenshot && lastScreenshot64) {
                screenshotBase64 = lastScreenshot64;
                console.log("Using existing screenshot for analysis");
            } else if (captureMode === 'partial') {
                // Launch native Windows snipping tool
                const snipBase64 = await window.electron.launchNativeSnipping();
                if (snipBase64) {
                    setLastScreenshot64(snipBase64);
                    await finishSubmit(promptForAI, snipBase64, keepConversation ? messages : []);
                } else {
                    setIsAnalyzing(false);
                }
                return;
            } else {
                setIsCapturing(true);
                screenshotBase64 = await window.electron.captureScreen();
                setIsCapturing(false);
                if (screenshotBase64) {
                    setLastScreenshot64(screenshotBase64);
                }
            }
        }

        const currentHistory = keepConversation ? messages : [];
        finishSubmit(promptForAI, screenshotBase64, currentHistory);
    };

    const finishSubmit = async (text: string, image: string | null, history: Message[]) => {
        setUseLastScreenshot(false);
        try {
            const streamResult = await routeToModel(text, image, history, selectedModel);
            setIsAnalyzing(false);
            setIsTyping(true);

            let fullResponse = "";
            for await (const chunk of streamResult.stream) {
                const chunkText = chunk.text();
                fullResponse += chunkText;
                setDisplayedResponse(fullResponse);
            }

            // Finalize
            setIsTyping(false);
            setMessages(prev => [...prev, { role: 'assistant', content: fullResponse }]);

            // Text-to-Speech (after full response for better coherence)
            if (isTTSEnabled) {
                const utterance = new SpeechSynthesisUtterance(fullResponse);
                utterance.rate = 1.1;
                window.speechSynthesis.cancel();
                window.speechSynthesis.speak(utterance);
            }

            setResponse(null);
            setDisplayedResponse('');
        } catch (error: any) {
            console.error("Streaming error:", error);
            setIsAnalyzing(false);
            setIsTyping(false);
            setMessages(prev => [...prev, { role: 'assistant', content: `Sorry, I encountered an error: ${error.message || 'Unknown error'}. This might be due to model availability or image processing.` }]);
        }
    };

    const stopGeneration = () => {
        if (typingIntervalRef.current) clearInterval(typingIntervalRef.current);
        setIsTyping(false);
        window.speechSynthesis.cancel();
        if (response) {
            setMessages(prev => [...prev, { role: 'assistant', content: displayedResponse + " [Stopped]" }]);
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

    const handleMinimize = () => {
        window.electron.minimizeWindow();
    };

    const handleMaximize = () => {
        setIsMaximized(!isMaximized);
        window.electron.toggleMaximize();
    };

    const startListening = () => {
        // Disabled per user request until OpenAI Whisper integration
        alert("Voice dictation is temporarily disabled. We will be integrating OpenAI Whisper soon!");
    };

    const clear = () => {
        setQuery('');
        setResponse(null);
        setDisplayedResponse('');
        setMessages([]);
        setLastScreenshot64(null);
        window.speechSynthesis.cancel();
        window.electron.resizeWindow(180);
        window.electron.hideWindow();
    };


    return (
        <div className="flex items-center justify-center h-screen w-screen p-0 animate-in overflow-hidden">
            <div className="glass w-full h-full rounded-2xl overflow-hidden flex flex-col drag relative">
                {/* Decorative Corner Glows */}
                <div className="absolute -top-24 -left-24 w-64 h-64 bg-emerald-500/10 blur-[100px] pointer-events-none z-0" />
                <div className="absolute -bottom-24 -right-24 w-64 h-64 bg-emerald-500/10 blur-[100px] pointer-events-none z-0" />

                {/* Full Settings Overlay */}
                {showSettings && (
                    <div className="absolute inset-0 z-50 bg-black/90 backdrop-blur-2xl flex flex-col no-drag animate-in fade-in zoom-in-95 duration-200">
                        <div className="p-4 border-b border-white/5 flex items-center justify-between">
                            <div className="flex items-center gap-2">
                                <button onClick={() => setShowSettings(false)} className="p-1 hover:bg-white/10 rounded-lg transition-all text-white/60">
                                    <ChevronLeft size={18} />
                                </button>
                                <span className="text-xs font-bold uppercase tracking-widest text-white/80">Settings & Accessibility</span>
                            </div>
                            <X size={16} className="text-white/20 cursor-pointer hover:text-white transition-all" onClick={() => setShowSettings(false)} />
                        </div>

                        <div className="flex-1 overflow-y-auto p-6 space-y-8">
                            {/* Shortcut Info */}
                            <div className="space-y-3">
                                <div className="flex items-center gap-2 text-white/40">
                                    <Keyboard size={14} />
                                    <div className="flex flex-col">
                                        <span className="text-[10px] uppercase font-bold tracking-tighter">Global Shortcut</span>
                                        <span className="text-[8px] text-white/30 uppercase tracking-widest font-medium">Use at least 2 keys (Modifier + Key)</span>
                                    </div>
                                </div>
                                <div className="bg-white/5 border border-white/10 p-3 rounded-xl flex items-center justify-between group">
                                    <span className="text-xs text-white/60">Activate Assistant</span>
                                    <button
                                        onClick={() => setIsRecording(!isRecording)}
                                        className={cn(
                                            "flex gap-1 px-2 py-1.5 rounded-lg border transition-all animate-in fade-in",
                                            isRecording
                                                ? "bg-emerald-500/20 border-emerald-500/50 text-emerald-400 ring-2 ring-emerald-500/20"
                                                : "bg-white/5 border-white/10 text-white/80 hover:bg-white/10 hover:border-white/20"
                                        )}
                                    >
                                        {isRecording ? (
                                            <span className="text-[10px] font-bold animate-pulse uppercase tracking-widest">Press Keys Now...</span>
                                        ) : (
                                            currentShortcut.split('+').map((part, i) => (
                                                <React.Fragment key={i}>
                                                    <kbd className="px-1.5 py-0.5 bg-white/10 border border-white/20 rounded text-[10px] font-mono shadow-sm">{part}</kbd>
                                                    {i < currentShortcut.split('+').length - 1 && <span className="text-white/20">+</span>}
                                                </React.Fragment>
                                            ))
                                        )}
                                    </button>
                                </div>
                            </div>

                            {/* Voice Section */}
                            <div className="space-y-4">
                                <div className="flex items-center gap-2 text-white/40">
                                    <Volume2 size={14} />
                                    <span className="text-[10px] uppercase font-bold tracking-tighter">Accessibility & Voice</span>
                                </div>

                                <div className="grid grid-cols-2 gap-3">
                                    <button
                                        onClick={() => setIsVoiceDictationEnabled(!isVoiceDictationEnabled)}
                                        className={cn(
                                            "p-4 rounded-2xl border transition-all flex flex-col items-start gap-3",
                                            isVoiceDictationEnabled ? "bg-white/10 border-white/20" : "bg-white/5 border-white/5 grayscale"
                                        )}
                                    >
                                        {isVoiceDictationEnabled ? <Mic size={20} className="text-white" /> : <MicOff size={20} className="text-white/40" />}
                                        <div className="text-left">
                                            <div className="text-[11px] font-bold text-white mb-0.5">Voice Dictation</div>
                                            <div className="text-[9px] text-white/40 leading-tight">Speak instead of typing</div>
                                        </div>
                                    </button>

                                    <button
                                        onClick={() => setIsTTSEnabled(!isTTSEnabled)}
                                        className={cn(
                                            "p-4 rounded-2xl border transition-all flex flex-col items-start gap-3",
                                            isTTSEnabled ? "bg-white/10 border-white/20" : "bg-white/5 border-white/5 grayscale"
                                        )}
                                    >
                                        {isTTSEnabled ? <Volume2 size={20} className="text-white" /> : <VolumeX size={20} className="text-white/40" />}
                                        <div className="text-left">
                                            <div className="text-[11px] font-bold text-white mb-0.5">Speak Responses</div>
                                            <div className="text-[9px] text-white/40 leading-tight">AI reads answers aloud</div>
                                        </div>
                                    </button>
                                </div>
                            </div>
                        </div>

                        <div className="p-4 border-t border-white/5 flex justify-center">
                            <button
                                onClick={() => setShowSettings(false)}
                                className="bg-white/10 hover:bg-white/20 text-white text-[10px] font-bold uppercase tracking-widest px-8 py-2.5 rounded-xl transition-all"
                            >
                                Back to Chat
                            </button>
                        </div>
                    </div>
                )}

                {/* Title Bar */}
                <div className="title-bar">
                    <div className="flex items-center gap-2 opacity-60">
                        <img src="/logo.png" className="w-4 h-4" alt="logo" />
                        <span className="text-[11px] font-medium tracking-tight text-white font-poppins">ALT+Space</span>
                    </div>
                    <div className="window-controls">
                        <button onClick={handleMinimize} className="p-1 hover:bg-white/10 rounded transition-all text-white/40 hover:text-white" title="Minimize to Tray">
                            <Minus size={14} />
                        </button>
                        <button onClick={clear} className="p-1 hover:bg-red-500/20 rounded transition-all text-white/40 hover:text-red-400" title="Dismiss">
                            <X size={14} />
                        </button>
                    </div>
                </div>

                {/* Header/Input area */}
                <div className="p-4 flex items-center gap-3 border-b border-white/5 relative">
                    <div className="relative flex-1 no-drag">
                        <input
                            ref={inputRef}
                            type="text"
                            value={query}
                            onChange={(e) => setQuery(e.target.value)}
                            onKeyDown={(e) => e.key === 'Enter' && handleSubmit()}
                            placeholder="Ask about this screen"
                            className="w-full bg-white/5 border border-white/10 rounded-xl py-2 px-4 focus:outline-none focus:ring-2 focus:ring-emerald-500/50 transition-all placeholder:text-slate-500 outline-none"
                        />
                    </div>

                    <div className="flex items-center gap-1.5 no-drag bg-white/5 p-1 rounded-xl border border-white/10">
                        <button
                            onClick={() => {
                                setShowScreenshot(true);
                                setCaptureMode('full');
                                setIsDeepFileMode(false);
                            }}
                            className={cn(
                                "p-1.5 rounded-lg transition-all",
                                showScreenshot && captureMode === 'full' && !isDeepFileMode
                                    ? "bg-white/20 text-white shadow-sm"
                                    : "text-white/40 hover:bg-white/10"
                            )}
                            title="Analyze Full Screen"
                        >
                            <Maximize size={16} />
                        </button>
                        <button
                            onClick={() => {
                                setShowScreenshot(true);
                                setCaptureMode('partial');
                                setIsDeepFileMode(false);
                            }}
                            className={cn(
                                "p-1.5 rounded-lg transition-all",
                                showScreenshot && captureMode === 'partial' && !isDeepFileMode
                                    ? "bg-white/20 text-white shadow-sm"
                                    : "text-white/40 hover:bg-white/10"
                            )}
                            title="Analyze Part of Screen"
                        >
                            <Square size={16} />
                        </button>
                        <button
                            onClick={() => { setShowScreenshot(false); setIsDeepFileMode(false); }}
                            className={cn(
                                "p-1.5 rounded-lg transition-all",
                                !showScreenshot && !isDeepFileMode
                                    ? "bg-red-500/20 text-red-500 shadow-sm"
                                    : "text-white/40 hover:bg-white/10"
                            )}
                            title="Disable Screenshot Analysis"
                        >
                            <ImageOff size={16} />
                        </button>
                        <button
                            onClick={() => { setIsDeepFileMode(true); setShowScreenshot(false); setActiveFileInfo(null); setDeepFileError(null); }}
                            className={cn(
                                "p-1.5 rounded-lg transition-all",
                                isDeepFileMode
                                    ? "bg-emerald-500/20 text-emerald-400 shadow-sm"
                                    : "text-white/40 hover:bg-white/10"
                            )}
                            title="Deep File Mode: Read active open document"
                        >
                            <FileSearch size={16} />
                        </button>
                    </div>
                    <div className="flex items-center gap-1 no-drag">
                        {isVoiceDictationEnabled && (
                            <button
                                onClick={startListening}
                                className="p-2 rounded-xl transition-all bg-white/5 text-white/40 hover:bg-white/10 ml-1"
                                title="AI Whisper (Coming Soon)"
                            >
                                <Mic size={18} />
                            </button>
                        )}


                        {isTyping || isAnalyzing ? (
                            <button
                                onClick={stopGeneration}
                                className="p-2 bg-white/10 hover:bg-white/20 text-white rounded-xl transition-all no-drag ml-1"
                                title="Stop Generation"
                            >
                                <StopIcon size={18} className="fill-current" />
                            </button>
                        ) : (
                            <button
                                onClick={() => handleSubmit()}
                                disabled={isAnalyzing || (!query.trim() && !showScreenshot && !isDeepFileMode)}
                                className="p-2 bg-white/10 hover:bg-white/20 disabled:opacity-30 text-white rounded-xl transition-all no-drag ml-1"
                            >
                                <Send size={18} />
                            </button>
                        )}
                    </div>
                </div>

                {/* Quick Actions & Tools */}
                <div className="px-4 py-2 flex items-center justify-between border-b border-white/5 no-drag bg-black/20">
                    <div className="flex items-center gap-2 overflow-x-auto">
                        <button
                            onClick={(e) => {
                                e.preventDefault();
                                if (!isAnalyzing) {
                                    handleSubmit(undefined, RISK_PROMPT, false, "Risk Analysis");
                                }
                            }}
                            disabled={isAnalyzing}
                            className="px-2.5 py-1.5 text-[10px] font-medium text-white/70 bg-white/5 border border-white/10 rounded-md hover:border-emerald-500/50 hover:text-emerald-400 hover:bg-emerald-500/10 transition-all disabled:opacity-50"
                        >
                            Risk
                        </button>
                        <button
                            onClick={(e) => {
                                e.preventDefault();
                                if (!isAnalyzing) {
                                    handleSubmit(undefined, DECISION_PROMPT, false, "Decision Mode");
                                }
                            }}
                            disabled={isAnalyzing}
                            className="px-2.5 py-1.5 text-[10px] font-medium text-white/70 bg-white/5 border border-white/10 rounded-md hover:border-emerald-500/50 hover:text-emerald-400 hover:bg-emerald-500/10 transition-all disabled:opacity-50"
                        >
                            Decision
                        </button>
                        <button
                            onClick={(e) => {
                                e.preventDefault();
                                if (!isAnalyzing) {
                                    handleSubmit(undefined, ACTIONS_PROMPT, false, "Action Plan");
                                }
                            }}
                            disabled={isAnalyzing}
                            className="px-2.5 py-1.5 text-[10px] font-medium text-white/70 bg-white/5 border border-white/10 rounded-md hover:border-emerald-500/50 hover:text-emerald-400 hover:bg-emerald-500/10 transition-all disabled:opacity-50"
                        >
                            Actions
                        </button>
                        <button
                            onClick={(e) => {
                                e.preventDefault();
                                if (!isAnalyzing) {
                                    handleSubmit(undefined, CLARIFY_PROMPT, false, "Clarify Concept");
                                }
                            }}
                            disabled={isAnalyzing}
                            className="px-2.5 py-1.5 text-[10px] font-medium text-white/70 bg-white/5 border border-white/10 rounded-md hover:border-emerald-500/50 hover:text-emerald-400 hover:bg-emerald-500/10 transition-all disabled:opacity-50"
                        >
                            Clarify
                        </button>
                    </div>

                    <div className="flex items-center gap-3">
                        {!showSettings && messages.length > 0 && (
                            <button
                                onClick={() => setKeepConversation(!keepConversation)}
                                className={cn(
                                    "flex items-center gap-1.5 px-2.5 py-1 rounded-md border cursor-pointer whitespace-nowrap transition-all flex-shrink-0",
                                    keepConversation
                                        ? "bg-emerald-500/30 text-emerald-300 border-emerald-500/40 shadow-[0_0_10px_rgba(16,185,129,0.1)]"
                                        : "text-white/50 border-white/20 hover:border-white/40 hover:text-white/80"
                                )}
                                title={keepConversation ? "Keep Chat: ON (Conversation history is maintained)" : "Keep Chat: OFF (Start fresh on next message)"}
                            >
                                <MessageSquare size={10} />
                                <span className="text-[9px] uppercase font-bold tracking-wider">
                                    {keepConversation ? "Keep Chat" : "Keep Chat"}
                                </span>
                            </button>
                        )}

                        {!showSettings && showScreenshot && captureMode === 'partial' && (
                            <div className="text-[10px] font-medium text-emerald-400/80 animate-in fade-in slide-in-from-left-2 duration-500 whitespace-nowrap hidden sm:block">
                                💡 Write prompt & send to start snipping
                            </div>
                        )}
                    </div>
                </div>

                {/* Response Area / Chat History */}
                <div className="flex-1 overflow-hidden flex flex-col pt-4 no-drag">
                    <div
                        ref={scrollRef}
                        onScroll={handleScroll}
                        className="flex-1 overflow-y-auto space-y-6 p-6"
                    >
                        {messages.map((msg, idx) => (
                            <MessageItem
                                key={idx}
                                msg={msg}
                                idx={idx}
                                copiedIndex={copiedIndex}
                                copyToClipboard={copyToClipboard}
                            />
                        ))}

                        {(response || isAnalyzing) && (
                            <div className="flex flex-col items-start gap-1.5">
                                <div className="flex items-center gap-1.5 mb-0.5">
                                    <img src="/logo.png" className="w-3.5 h-3.5 opacity-80" alt="logo" />
                                    <span className="text-[10px] font-bold tracking-tight text-white/50 uppercase font-poppins">ALT+Space</span>
                                    {activeFileInfo && (
                                        <span className="flex items-center gap-1 ml-1 px-1.5 py-0.5 rounded-md bg-emerald-500/15 border border-emerald-500/25 text-emerald-400 text-[10px] font-medium">
                                            <FileSearch size={10} />
                                            {activeFileInfo.fileName}{activeFileInfo.pageCount > 0 ? ` (${activeFileInfo.pageCount} ${activeFileInfo.pageCount === 1 ? 'page' : 'pages'})` : ''}
                                        </span>
                                    )}
                                    {isReadingFile && (
                                        <span className="flex items-center gap-1 ml-1 px-1.5 py-0.5 rounded-md bg-emerald-500/15 border border-emerald-500/25 text-emerald-400 text-[10px] font-medium animate-pulse">
                                            <Loader2 size={10} className="animate-spin" />
                                            Reading...
                                        </span>
                                    )}
                                </div>
                                {isAnalyzing ? (
                                    <div className="flex items-center gap-3 py-2 text-white/40 animate-pulse">
                                        <Loader2 size={18} className="animate-spin text-white/60" />
                                        <span className="text-xs font-medium tracking-tight">
                                            {isDeepFileMode ? "Analyzing document..." : showScreenshot ? "Analyzing screen..." : "Responding..."}
                                        </span>
                                    </div>
                                ) : (
                                    <div className="markdown-content text-sm leading-relaxed text-slate-200">
                                        <ReactMarkdown remarkPlugins={[remarkGfm]}>
                                            {displayedResponse}
                                        </ReactMarkdown>
                                        {isTyping && <span className="inline-block w-2 h-4 bg-white/20 animate-pulse ml-1 align-middle" />}
                                    </div>
                                )}
                            </div>
                        )}
                    </div>
                </div>

                {/* Footer */}
                <div className="px-4 py-2 flex items-center justify-between text-[10px] text-slate-500 border-t border-white/10 bg-black/40 relative">
                    <div className="flex items-center gap-2">
                        <span className="bg-white/10 px-2 py-0.5 rounded uppercase font-medium tracking-tight text-[11px] font-poppins">{currentShortcut}</span>
                        <span>to toggle</span>
                    </div>

                    <div className="flex items-center gap-4 no-drag relative">
                        <div className="flex items-center gap-1 opacity-40">
                            <span>by</span>
                            <span className="font-bold tracking-tight text-white/60">Dahshan Labs</span>
                        </div>

                        {/* Dropdown Container */}
                        <div className="relative">
                            <button
                                onClick={() => setShowModelDropdown(!showModelDropdown)}
                                className={cn(
                                    "flex items-center gap-1.5 px-2 py-1 rounded-full border transition-all text-[10px] font-medium tracking-tight h-[22px]",
                                    showModelDropdown
                                        ? "bg-white/20 border-white/20 text-white"
                                        : "bg-white/5 border-white/10 hover:border-white/20 hover:bg-white/10 text-white/70"
                                )}
                                title="Change AI Model"
                            >
                                <span className="truncate max-w-[100px]">
                                    {AVAILABLE_MODELS.find(m => m.id === selectedModel)?.name || "Gemini 1.5 Flash"}
                                </span>
                                <ChevronLeft size={10} className={cn("transition-transform", showModelDropdown ? "rotate-90" : "-rotate-90")} />
                            </button>

                            {/* Dropdown List */}
                            {showModelDropdown && (
                                <div className="absolute bottom-[100%] right-0 mb-2 w-[300px] bg-[#1c1c1c]/95 backdrop-blur-3xl border border-white/10 rounded-xl shadow-[0_-10px_40px_rgba(0,0,0,0.8)] p-2 z-50 animate-in slide-in-from-bottom-2 fade-in duration-200">
                                    <div className="text-[9px] uppercase font-bold text-white/40 px-2 pb-2 mb-2 tracking-widest border-b border-white/5">Select AI Engine</div>
                                    <div className="grid grid-cols-2 gap-1">
                                        {AVAILABLE_MODELS.map((model) => {
                                            const isActive = model.id === selectedModel;
                                            const isComingSoon = model.status === 'coming_soon';
                                            return (
                                                <button
                                                    key={model.id}
                                                    onClick={() => {
                                                        if (!isComingSoon) {
                                                            setSelectedModel(model.id);
                                                            setShowModelDropdown(false);
                                                        }
                                                    }}
                                                    className={cn(
                                                        "w-full flex items-center justify-between px-2 py-1.5 rounded-lg text-[10px] transition-all text-left group",
                                                        isActive ? "bg-emerald-500/20 text-emerald-400 ring-1 ring-emerald-500/30" :
                                                            isComingSoon ? "opacity-40 cursor-not-allowed hover:bg-white/5" : "text-white/70 hover:bg-white/10",
                                                    )}
                                                    title={isComingSoon ? "Model integration pending." : `Use ${model.name}`}
                                                >
                                                    <span className="font-medium truncate max-w-[100px]">{model.name}</span>
                                                    {isActive && <Check size={10} className="text-emerald-400 flex-shrink-0" />}
                                                    {isComingSoon && <Lock size={9} className="text-white/30 flex-shrink-0 group-hover:text-white/50" />}
                                                </button>
                                            )
                                        })}
                                    </div>
                                </div>
                            )}
                        </div>

                        <button
                            onClick={() => setShowSettings(!showSettings)}
                            className={cn(
                                "p-1.5 rounded-lg transition-all",
                                showSettings ? "bg-white/20 text-white" : "text-white/40 hover:bg-white/10"
                            )}
                            title="Settings"
                        >
                            <Settings size={14} />
                        </button>
                    </div>

                    {/* Lower Green Bar */}
                    <div className="absolute bottom-0 left-0 w-full h-[2px] bg-emerald-500/40 shadow-[0_0_10px_rgba(16,185,129,0.3)]" />
                </div>
            </div>

        </div>
    );
}
