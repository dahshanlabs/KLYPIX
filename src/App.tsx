import React, { useState, useEffect, useRef, useMemo, useCallback, lazy, Suspense } from 'react';
import { createPortal } from 'react-dom';
import {
    Loader2, Image as ImageIcon, ImageOff, X, Maximize, Square, Mic,
    Settings, Volume2, Copy, Check, Square as StopIcon, MicOff, VolumeX,
    Keyboard, ChevronLeft, Minus, FileSearch, MessageSquare, Lock, Search,
    Archive, Bookmark, Trash2, Download, RefreshCw, Shield, ShieldOff,
    Eraser, ChevronUp, ChevronDown, Globe, FileText, Paperclip, User,
    MessageCircle, Camera, Scissors, Home, Zap, AlertTriangle, Brain,
    LayoutGrid,
} from 'lucide-react';
import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';
import { AVAILABLE_MODELS } from './core/aiModels';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { marked } from 'marked';
import logoUrl from '../public/logo.png';
import { useSettings } from './hooks/useSettings';
import { useSessionContext } from './core/sessionContext';
import { detectContext, getContextFocus, getContextActions, getContextActionsWithTranslate, getInsightCacheKey, getCachedInsight, setCachedInsight, clearInsightCache, getContextDisplayLabel, enforceActionTypes, reorderActions, isFileAccessibleContext, getContextActionsForAccess, inferContextFromFileName, type ScreenContext } from './core/contextIntelligence';
import { tryReadActiveFile, buildEscalatedPrompt, tryReadWebContent, buildWebEscalatedPrompt, type FileAccessResult, type WebAccessResult } from './core/autoEscalation';
import { useWindowContext } from './hooks/useWindowContext';
import { useScreenshot } from './hooks/useScreenshot';
import { useAgent } from './hooks/useAgent';
import { ConfirmationCard, ResultCard, SmartPasteBanner } from './components/AgentPanel';
import { WhatISeeCard, WhatISeeSkeleton } from './components/WhatISee';
import { ScreenshotStackBar } from './components/ScreenshotStack';
import { getContextInsight, getContextInsightFromText, type ContextInsight } from './api/gemini';
import { useAttachments } from './hooks/useAttachments';
import { usePinnedChats } from './hooks/usePinnedChats';
import { useDeepMode } from './hooks/useDeepMode';
import { useSuggestions } from './hooks/useSuggestions';
import { useChat } from './hooks/useChat';
import type { Message } from './types';
import { IMAGE_EXTS, MAX_ATTACHED } from './types';
import { getPersona } from './api/memoryStore';
import { useAuth } from './components/AuthProvider';
import { LoginScreen } from './components/LoginScreen';
import { OnboardingCards, isOnboardingComplete } from './components/OnboardingCards';
import { useUpdater } from './hooks/useUpdater';
import { UpdateToast } from './components/UpdateToast';
import { useDocGenerator } from './hooks/useDocGenerator';
import { FormatPicker } from './components/FormatPicker';
import { EnhancerChat } from './components/EnhancerChat';
import { GeneratedDocCard } from './components/GeneratedDocCard';
import { PdfPasswordModal } from './components/PdfPasswordModal';
import { CdpRestartBanner } from './components/CdpRestartBanner';
import { SandboxApprovalDialog } from './components/SandboxApprovalDialog';
import { SandboxSetupBanner } from './components/SandboxSetupBanner';
import { MemoryPanel } from './components/MemoryPanel';
import { ThinkingBrain } from './components/ThinkingBrain';
import { RespondingKlypix } from './components/RespondingKlypix';
import { useClaudeAgent } from './hooks/useClaudeAgent';
import { classifyFollowUp } from './core/agent/smartRouter';
import { WorkflowPanel } from './components/WorkflowPanel';
import { PermissionTabs } from './components/PermissionTabs';
import { AgentSettings } from './components/AgentSettings';
import { AgentRobot } from './components/AgentRobot';
import { KlypixMascot } from './components/KlypixMascot';
import { ModeTabs, type AppTab } from './components/ModeTabs';
import { KlypixCanvas } from './canvas/KlypixCanvas';

// ── Context-aware prompt system ──────────────────────────────────────────────
type ContextMode = 'screenshot' | 'deepfile-single' | 'deepfile-multi' | 'attachment' | 'plain';

function getContextDescriptor(mode: ContextMode): string {
    switch (mode) {
        case 'screenshot':      return 'Analyze the screenshot image provided';
        case 'deepfile-single': return 'Analyze the following document provided below';
        case 'deepfile-multi':  return 'Analyze the following documents provided below';
        case 'attachment':      return 'Analyze the attached files provided below';
        case 'plain':           return 'Based on the conversation context';
    }
}

function buildPrompt(template: string, mode: ContextMode, persona?: string): string {
    const context = getContextDescriptor(mode);
    const personaLine = persona && persona !== 'Helpful User'
        ? `\nAdapt your depth, terminology, and focus to this user profile: ${persona}\n`
        : '';
    return `${context}.\n${personaLine}\n${template}`;
}

// ── Prompt templates ─────────────────────────────────────────────────────────
const DECISION_TEMPLATE = `You are a strategic advisor. Deliver a structured decision brief.

RULES:
- No preamble, no hedging
- Imperative tone throughout
- Maximum 4 lines per section

OUTPUT FORMAT:
Core Insight:
[What this situation actually is and why it matters — one sentence.]

Trade-Off:
[What is gained vs. what is sacrificed. Name both sides explicitly.]

Recommended Move:
[Exactly what to do next. Start with a verb.]

Risk If Ignored:
[What happens if no action is taken — one sentence.]`;

const RISK_TEMPLATE = `You are a risk analyst. Deliver a structured risk assessment.

RULES:
- No preamble
- Name specific risks — never generic categories
- Every mitigation must be a concrete action, not a principle

OUTPUT FORMAT:
Primary Threat:
[The single most significant risk — name it specifically, not as a category.]

Exposure Points:
- [Specific vulnerability 1 — what exactly is unprotected or weak]
- [Specific vulnerability 2 — if applicable]

Mitigation Steps:
1. [Immediate action — can be done today]
2. [Short-term action — within one week]
3. [Structural fix — prevents recurrence]

Severity: [Critical / High / Medium / Low] — [One sentence: what triggers escalation to the next level.]`;

const ACTIONS_TEMPLATE = `You are a project manager. Convert this into a clear action plan.

RULES:
- Every action must start with a verb
- No action longer than one sentence
- If an action has a dependency, mark it with [BLOCKED BY: #N]

OUTPUT FORMAT:
Goal:
[What successful completion looks like — one sentence.]

Do Now (this session):
1. [Action — verb first]
2. [Action — verb first]

Do Next (this week):
3. [Action — verb first]
4. [Action — verb first]

Blocked / Needs Input:
- [What's waiting on someone or something else, and who/what specifically]`;

const CLARIFY_TEMPLATE = `You are an expert at making complex material immediately understandable.

Produce a plain-language explanation targeted at someone familiar with the general domain but unfamiliar with these specific details.

RULES:
- No preamble
- Define jargon inline on first use — do not assume knowledge of acronyms or specialized terms
- If the content is code: explain what it does, not how it's written

OUTPUT FORMAT:
What This Is:
[The clearest possible one-sentence description of what this content is and what it does or says.]

How It Works:
- [Key mechanism, logic, or argument — point 1]
- [Point 2]
- [Point 3 only if it adds something new]

Watch Out For:
- [Non-obvious implication or edge case that is commonly misunderstood]
- [Second one if applicable]

Bottom Line:
[One sentence — what does knowing this actually change or enable for the reader?]`;

const COMPARE_TEMPLATE = `You are an expert analyst. You have been given multiple documents. Perform a structured, objective comparison.

RULES:
- No preamble
- Identify the document type first — then compare along axes relevant to that type
- Only state differences that are material — skip cosmetic or formatting differences
- If a value, date, or number appears in one document but not another, flag it explicitly
- If documents are versions of the same thing, focus on what changed between versions
- If documents are different things, focus on how they differ in scope, position, or terms

OUTPUT FORMAT:
Documents:
- [Doc 1 name — one-sentence description of what it is]
- [Doc 2 name — one-sentence description of what it is]

Key Similarities:
- [Shared purpose, scope, or position — be specific]

Critical Differences:
| Dimension | [Doc 1] | [Doc 2] |
|-----------|---------|---------|
| [Most important axis of comparison] | ... | ... |
| [Second most important axis] | ... | ... |
| [Third axis if relevant] | ... | ... |

Bottom Line:
[One sentence: given these differences, what decision or action does this comparison inform?]`;

const EXTRACT_TEMPLATE = `You are a structured data extraction specialist.

Extract all concrete, specific information. Ignore boilerplate, filler, and generic statements. Only extract information that is specific to this document.

RULES:
- Use a table when there are 4+ items of the same type
- Bold any value that represents a deadline, obligation, or financial figure
- Do not invent categories — only use categories that actually have content
- If nothing fits a category, skip it entirely

OUTPUT FORMAT:
[Select only the relevant categories from the lists below — use the first set for business/legal content, the second set for code/technical content]

Business / Legal / General:
Parties | Dates & Deadlines | Financial Terms | Requirements | Obligations | Named Items | Key Numbers

Code / Technical:
Components | Functions & Methods | Dependencies | Entry Points | Configuration | Known Issues

[Present each selected category as a section header followed by a bulleted list or table]`;

const SUMMARIZE_TEMPLATE = `You are a professional analyst. Produce a tight summary that prioritizes signal over coverage.

RULES:
- No preamble
- Do not restate the title, filename, or document name
- Skip anything that is obvious, boilerplate, or repeated
- Every bullet must carry new information — no two bullets should say the same thing differently

OUTPUT FORMAT:
What This Is:
[One sentence — what this content is about and why it exists. Not a title, a description.]

Key Points:
- [Most important fact, finding, or argument — include numbers/names/dates if present]
- [Second most important — must add something the first point doesn't cover]
- [Third — only if it adds genuine new information]

So What:
[One sentence — the practical implication, decision, or action this content should inform.]`;

const TRADING_TEMPLATE = `You are a professional financial market and trading analyst.

If analyzing a chart or visual: describe what you see (candle pattern, indicator positions, timeframe) before interpreting it.

Base the analysis only on information present in the provided content. Do not infer data that is not visible. Do not provide financial advice.

RULES:
- Name specific price levels, not ranges
- Cite the indicator or pattern by name before interpreting it
- If the timeframe is unclear, state that explicitly

OUTPUT FORMAT:
Market Structure:
[Current trend direction + the pattern or formation that confirms it. Name the pattern.]

Key Levels:
- Support: [specific price] — [what established this level]
- Resistance: [specific price] — [what established this level]

Signals:
- [Indicator name]: [current reading] → [what it implies]
- [Indicator name]: [current reading] → [what it implies]

Risk to Thesis:
[The single most likely scenario that invalidates the above analysis. Be specific.]

Bias:
[Bullish / Bearish / Neutral] — [One sentence: the condition that would flip this bias.]`;

const REWRITE_PROFESSIONAL_TEMPLATE = `You are a senior editor. Rewrite the provided text to be polished, professional, and direct.

RULES:
- Preserve all factual content and intent exactly
- Cut filler phrases ("in order to", "it is important to note that", "please be advised")
- Replace passive voice with active where it improves clarity
- Result must be no longer than the original
- Do not add information that was not in the original

OUTPUT FORMAT:
Rewritten:
[The rewritten text — ready to copy and paste.]

Changes:
- [Most significant change and why it improves the text]
- [Second most significant, if applicable]`;

const REWRITE_SHORTER_TEMPLATE = `You are a compression specialist. Cut this text to its minimum viable length.

RULES:
- Target: 50% or less of the original length
- Kill every sentence that doesn't carry unique information
- Merge sentences that say related things into one
- Keep all numbers, names, dates, and commitments
- If the entire text can be said in one sentence, do that

OUTPUT FORMAT:
Shortened:
[The compressed text — ready to copy and paste.]

Cut from [original word count] → [new word count] ([X]% reduction)`;

const REWRITE_CLEARER_TEMPLATE = `You are a clarity editor. Rewrite this so it cannot be misunderstood.

RULES:
- One idea per sentence
- Replace every abstraction with a concrete example or specific term
- If a sentence requires re-reading to understand, it must be rewritten
- Preserve all original meaning — add zero new information
- If the text uses jargon that serves precision, keep it but add a brief inline definition on first use

OUTPUT FORMAT:
Clarified:
[The rewritten text — ready to copy and paste.]

Clarity Fixes:
- [What was ambiguous and how it was resolved — most impactful fix]
- [Second fix, if applicable]`;

// ── Utilities ─────────────────────────────────────────────────────────────────
function cn(...inputs: ClassValue[]) { return twMerge(clsx(inputs)); }

interface ActionButton {
    label: string;
    action: 'copy-text' | 'copy-html' | 'copy-markdown-checklist' | 'copy-html-table' | 'reprompt';
    prompt?: string;
}

function getActionButtons(actionType: string | null): ActionButton[] {
    if (!actionType) return [];
    const map: Record<string, ActionButton[]> = {
        'Decision':  [{ label: 'Challenge this', action: 'reprompt', prompt: 'Play devil\'s advocate against your own recommendation. What\'s the strongest counter-argument?' }],
        'Risk':      [{ label: 'Mitigation plan', action: 'reprompt', prompt: 'Expand the mitigation steps into a full action plan with owners and timelines.' }],
        'Actions':   [{ label: 'Copy as checklist', action: 'copy-markdown-checklist' }],
        'Clarify':   [{ label: 'Go deeper', action: 'reprompt', prompt: 'Expand on the most complex part of your explanation. Add a concrete example.' }],
        'Extract':   [{ label: 'Copy as table', action: 'copy-html-table' }],
        'Compare':   [{ label: 'Copy as table', action: 'copy-html-table' }, { label: 'Deep dive', action: 'reprompt', prompt: 'Expand on the single most critical difference. Explain why it matters and what the practical consequence is.' }],
        'Summarize': [{ label: 'Shorter', action: 'reprompt', prompt: 'Compress your summary to 2 sentences maximum.' }],
        'Trading':   [{ label: 'Invalidation check', action: 'reprompt', prompt: 'What specific price level or event would completely invalidate this analysis?' }],
        'Rewrite':   [{ label: 'More aggressive', action: 'reprompt', prompt: 'Cut harder. Remove another 30% while keeping all facts.' }],
    };
    return map[actionType] || [];
}

function extractMarkdownChecklist(text: string): string {
    const lines = text.split('\n');
    const items: string[] = [];
    for (const line of lines) {
        const trimmed = line.trim();
        // Match numbered items (1. Action), bullets (- Action), or checkbox items (- [ ] Action)
        const match = trimmed.match(/^(?:\d+\.\s*(?:\[[ x]?\]\s*)?|- (?:\[[ x]?\]\s*)?)(.+)/i);
        if (match) {
            items.push(`- [ ] ${match[1].trim()}`);
        }
    }
    return items.length > 0 ? items.join('\n') : text;
}

function extractMarkdownTable(text: string): string | null {
    const lines = text.split('\n');
    const tableLines: string[] = [];
    let inTable = false;
    for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed.startsWith('|') && trimmed.endsWith('|')) {
            inTable = true;
            tableLines.push(trimmed);
        } else if (inTable) {
            break; // end of table block
        }
    }
    return tableLines.length >= 2 ? tableLines.join('\n') : null;
}

// ── Global types ──────────────────────────────────────────────────────────────
declare global {
    interface Window {
        electron: {
            captureScreen: () => Promise<string | null>;
            captureScreenRaw: () => Promise<string | null>;
            hideWindow: () => void;
            showWindow: () => void;
            minimizeWindow: () => void;
            toggleMaximize: () => void;
            windowDragStart: () => void;
            windowDragEnd: () => void;
            resizeWindow: (height: number, width?: number) => void;
            setIgnoreMouseEvents: (ignore: boolean, options?: any) => void;
            getCursorPosition: () => Promise<{ x: number; y: number }>;
            getPrimaryDisplaySize: () => Promise<{ width: number; height: number }>;
            launchNativeSnipping: () => Promise<string | null>;
            copyToClipboard: (data: { text: string; html: string }) => void;
            getShortcut: () => Promise<string>;
            setShortcut: (shortcut: string) => Promise<{ success: boolean; shortcut?: string; error?: string }>;
            readActiveFile: () => Promise<{ fileName?: string; pageCount?: number; content?: string; truncated?: boolean; error?: string; windowTitle?: string }>;
            getAllOpenFiles: () => Promise<{ files?: { id: string; name: string; originalTitle: string; source: string }[]; error?: string }>;
            readMultipleFiles: (files: any[]) => Promise<{ results?: any[]; error?: string }>;
            openExternal: (url: string) => void;
            getBounds: () => Promise<{ x: number; y: number; width: number; height: number }>;
            generateFile: (opts: { format: string; spec?: any; content?: string }) => Promise<{ success: boolean; path?: string; reason?: string }>;
            // Agent mode
            executeAction: (intent: any) => Promise<any>;
            readClipboard: () => Promise<{ text: string; html: string; imageBase64?: string | null; filePaths?: string[]; lastFormat?: 'text' | 'image' | 'files' | 'none'; canvasOwnsClipboard?: boolean }>;
            getClipboardFormats: () => Promise<string[]>;
            readFileBytes: (filePath: string) => Promise<{ success: boolean; name?: string; size?: number; base64?: string; path?: string; error?: string }>;
            auth: {
                restoreSession: () => Promise<any>;
                signIn: (email: string, password: string) => Promise<any>;
                signUp: (email: string, password: string, displayName: string) => Promise<any>;
                signInWithOAuth: (provider: 'google' | 'azure') => Promise<any>;
                activateLicense: (key: string) => Promise<any>;
                signOut: () => Promise<any>;
                getUser: () => Promise<any>;
                refreshUser: () => Promise<any>;
                getTierLimits: (tier: string) => Promise<any>;
                canUseFeature: (tier: string, feature: string) => Promise<boolean>;
                isQueryAllowed: (tier: string, queriesToday: number) => Promise<boolean>;
                trackUsage: (event: any) => Promise<void>;
                resetPassword: (email: string) => Promise<any>;
                onOAuthComplete: (callback: (result: any) => void) => () => void;
            };
        };
    }
}

// ── MessageItem component ─────────────────────────────────────────────────────
const MessageItem = React.memo(({ msg, idx, copiedIndex, copyToClipboard, onViewImage, searchQuery, isActiveResult, resultRef, onSendToCanvas }: {
    msg: Message; idx: number; copiedIndex: number | null;
    copyToClipboard: (text: string, index: number) => void;
    onViewImage?: (b64: string) => void;
    searchQuery?: string; isActiveResult?: boolean; resultRef?: React.RefObject<HTMLDivElement | null>;
    onSendToCanvas?: (content: string) => void;
}) => {
    const highlightText = (text: string, query: string) => {
        if (!query.trim()) return text;
        const parts = text.split(new RegExp(`(${query})`, 'gi'));
        return <>{parts.map((part, i) => part.toLowerCase() === query.toLowerCase() ? <mark key={i} className={cn('bg-emerald-500/40 text-white rounded-sm px-0.5', isActiveResult && 'ring-2 ring-emerald-400 bg-emerald-500/60')}>{part}</mark> : part)}</>;
    };

    const highlightChildren = (children: React.ReactNode): React.ReactNode => {
        return React.Children.map(children, child => {
            if (typeof child === 'string') return highlightText(child, searchQuery || '');
            if (React.isValidElement(child)) {
                const el = child as React.ReactElement<any>;
                return React.cloneElement(el, { children: highlightChildren(el.props.children) });
            }
            return child;
        });
    };

    const mdComponents = {
        p: ({ children }: any) => <p>{highlightChildren(children)}</p>,
        li: ({ children }: any) => <li>{highlightChildren(children)}</li>,
        h1: ({ children }: any) => <h1>{highlightChildren(children)}</h1>,
        h2: ({ children }: any) => <h2>{highlightChildren(children)}</h2>,
        h3: ({ children }: any) => <h3>{highlightChildren(children)}</h3>,
        h4: ({ children }: any) => <h4>{highlightChildren(children)}</h4>,
        h5: ({ children }: any) => <h5>{highlightChildren(children)}</h5>,
        h6: ({ children }: any) => <h6>{highlightChildren(children)}</h6>,
        strong: ({ children }: any) => <strong>{highlightChildren(children)}</strong>,
        em: ({ children }: any) => <em>{highlightChildren(children)}</em>,
        code: ({ children, inline }: any) => inline ? <code>{highlightChildren(children)}</code> : <code>{children}</code>,
        td: ({ children }: any) => <td>{highlightChildren(children)}</td>,
        th: ({ children }: any) => <th>{highlightChildren(children)}</th>,
        a: ({ children }: any) => <a className="text-emerald-400 hover:underline transition-all cursor-pointer">{highlightChildren(children)}</a>,
        span: ({ children }: any) => <span>{highlightChildren(children)}</span>,
        blockquote: ({ children }: any) => <blockquote className="border-l-2 border-emerald-500/30 pl-4 my-2 italic text-white/60">{highlightChildren(children)}</blockquote>,
    };

    return (
        <div ref={isActiveResult ? resultRef : null} className={cn('flex flex-col gap-2 animate-in slide-in-from-bottom-2 duration-300 items-start rounded-xl py-0.5 px-2 transition-all', isActiveResult && 'bg-emerald-500/5 ring-1 ring-emerald-500/20 shadow-[0_0_15px_rgba(16,185,129,0.05)]')}>
            {msg.role === 'user' ? (
                <div className="flex flex-col gap-1.5 items-start w-full group/user">
                    <div className="flex items-center gap-1.5">
                        {msg.sourceMode === 'full-screenshot' && <Camera size={12} className="text-white/30" />}
                        {msg.sourceMode === 'partial-screenshot' && <Scissors size={12} className="text-white/30" />}
                        {msg.sourceMode === 'deep-file' && <FileText size={12} className="text-white/30" />}
                        {msg.sourceMode === 'agent' && (
                            <div className="flex items-center gap-1 text-purple-400/50">
                                <svg width="10" height="10" viewBox="0 0 14 14" fill="none">
                                    <path d="M2 4L6 7L2 10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                                    <line x1="7" y1="10" x2="12" y2="10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                                </svg>
                                <span className="text-[9px] font-bold uppercase tracking-wider">Agent</span>
                            </div>
                        )}
                    </div>
                    <div className="relative bg-white/10 border border-white/20 px-4 py-2 rounded-2xl max-w-[90%] text-sm text-white font-medium shadow-sm">
                        {searchQuery ? highlightText(msg.content, searchQuery) : msg.content}
                        <button onClick={() => { copyToClipboard(msg.content, idx); }} className="absolute -right-7 top-1/2 -translate-y-1/2 p-1 rounded-lg text-white/0 group-hover/user:text-white/30 hover:!text-white/70 hover:!bg-white/[0.06] transition-all duration-200" title="Copy prompt"><Copy size={11} /></button>
                    </div>
                    {(msg.attachedImage || msg.attachedFile) && (
                        <div className="flex gap-1.5 mr-1">
                            {msg.attachedImage && onViewImage && (
                                msg.attachedImage.startsWith('multi:') ? (
                                    <div className="flex gap-1.5 flex-wrap">
                                        {(() => { try { return JSON.parse(msg.attachedImage.slice(6)) as string[]; } catch { return []; } })().map((img: string, i: number) => (
                                            <button key={i} onClick={() => onViewImage(img)} className="flex items-center gap-1.5 px-2 py-1 bg-white/5 hover:bg-white/10 border border-white/10 rounded-lg text-white/50 hover:text-white/80 transition-all text-[10px] font-medium">
                                                <img src={`data:image/jpeg;base64,${img}`} className="w-8 h-5 object-cover rounded" alt={`Screen ${i + 1}`} />
                                                <span>Screen {i + 1}</span>
                                            </button>
                                        ))}
                                    </div>
                                ) : (
                                    <button onClick={() => onViewImage(msg.attachedImage!)} className="flex items-center gap-1.5 px-2 py-1 bg-white/5 hover:bg-white/10 border border-white/10 rounded-lg text-white/50 hover:text-white/80 transition-all text-[10px] font-medium"><ImageIcon size={10} /><span>View Screen</span></button>
                                )
                            )}
                            {msg.attachedFiles && msg.attachedFiles.length > 0 && (
                                <div className="flex flex-wrap gap-1.5">
                                    {msg.attachedFiles.map((fname, i) => <div key={i} className="flex items-center gap-1.5 px-2 py-1 bg-white/5 border border-white/10 rounded-lg text-white/50 text-[10px] font-medium cursor-default"><FileSearch size={10} className="text-emerald-500/50 shrink-0" /><span className="whitespace-nowrap">{fname}</span></div>)}
                                </div>
                            )}
                            {msg.attachedFile && !msg.attachedFiles && <div className="flex items-center gap-1.5 px-2 py-1 bg-white/5 border border-white/10 rounded-lg text-white/50 text-[10px] font-medium cursor-default"><FileSearch size={10} className="text-emerald-500/50" /><span className="whitespace-nowrap">{msg.attachedFile.name}</span></div>}
                        </div>
                    )}
                </div>
            ) : (
                <div className="group/asst relative w-full flex flex-col gap-1.5">
                    <div className="flex items-center gap-1.5 opacity-80">
                        <img src={logoUrl} className="w-3.5 h-3.5" alt="logo" />
                        <span className="text-[10px] font-bold tracking-tight text-white/50 uppercase font-poppins">Klypix</span>
                    </div>
                    <div className="markdown-content text-[15px] leading-relaxed text-white/90 pr-8">
                        <ReactMarkdown remarkPlugins={[remarkGfm]} components={searchQuery ? mdComponents : undefined}>{msg.content}</ReactMarkdown>
                    </div>
                    {onSendToCanvas && msg.content && (
                        <button
                            onClick={() => onSendToCanvas(msg.content)}
                            className="absolute right-0 bottom-0 p-1.5 rounded-md text-white/0 group-hover/asst:text-white/35 hover:!text-emerald-300 hover:!bg-emerald-500/10 transition-all duration-200 cursor-pointer"
                            title="Add to canvas"
                        >
                            <LayoutGrid size={11} />
                        </button>
                    )}
                    {/* Agent-produced file cards (persisted in message data) */}
                    {msg.agentFiles && msg.agentFiles.length > 0 && (
                        <div className="space-y-2 mt-3">
                            {msg.agentFiles.map((file, i) => {
                                const icons: Record<string, string> = {
                                    pdf: '\uD83D\uDCC4', docx: '\uD83D\uDCC3', xlsx: '\uD83D\uDCCA',
                                    pptx: '\uD83D\uDCBB', csv: '\uD83D\uDCCB', txt: '\uD83D\uDCC4',
                                    md: '\uD83D\uDCDD', json: '\u2699\uFE0F', html: '\uD83C\uDF10',
                                };
                                return (
                                    <div key={`${file.path}_${i}`} className="flex items-center gap-3 px-3 py-2.5 bg-purple-500/5 border border-purple-500/20 rounded-xl">
                                        <span className="text-lg">{icons[file.format] || '\uD83D\uDCC1'}</span>
                                        <div className="flex-1 min-w-0">
                                            <p className="text-sm text-white font-medium truncate">{file.name}</p>
                                            <p className="text-[10px] text-gray-500 truncate">{file.path}</p>
                                        </div>
                                        <div className="flex items-center gap-1.5">
                                            <button
                                                onClick={() => window.electron.openExternal(`file:///${file.path.replace(/\\/g, '/')}`)}
                                                className="px-2.5 py-1 bg-purple-500/20 border border-purple-500/30 rounded-lg text-[10px] text-purple-300 hover:bg-purple-500/30 transition-colors"
                                            >Open</button>
                                            <button
                                                onClick={async () => {
                                                    const dir = file.path.replace(/[/\\][^/\\]+$/, '');
                                                    await window.electron.agent?.runShell?.({ command: `explorer.exe "${dir}"` });
                                                }}
                                                className="px-2.5 py-1 bg-white/5 border border-white/10 rounded-lg text-[10px] text-gray-400 hover:bg-white/10 transition-colors"
                                            >Folder</button>
                                        </div>
                                    </div>
                                );
                            })}
                        </div>
                    )}
                    <button onClick={() => copyToClipboard(msg.content, idx)} className="absolute top-0 right-0 p-1.5 text-white/20 hover:text-white/60 hover:bg-white/5 rounded-lg transition-all opacity-0 group-hover:opacity-100" title="Copy Response">
                        {copiedIndex === idx ? <Check size={14} className="text-green-400" /> : <Copy size={14} />}
                    </button>
                </div>
            )}
        </div>
    );
});

// ── App (Auth Guard Wrapper) ──────────────────────────────────────────────────
export default function App() {
    const { isAuthenticated, isLoading: authLoading } = useAuth();
    const [trialExpired, setTrialExpired] = useState(false);
    // Manual sign-in trigger — set by `window.dispatchEvent(new Event('klypix:request-sign-in'))`.
    // Lets features like the Share modal route users to the LoginScreen on demand,
    // without waiting for trial expiry.
    const [manualSignIn, setManualSignIn] = useState(false);

    // Two ways to trigger sign-in from anywhere: window event OR direct call to
    // window.klypixShowSignIn(). The direct call bypasses any event-listener
    // timing issues (e.g. listener attached by old App instance after HMR).
    useEffect(() => {
        const handler = () => setManualSignIn(true);
        window.addEventListener('klypix:request-sign-in', handler);
        (window as any).klypixShowSignIn = () => setManualSignIn(true);
        return () => {
            window.removeEventListener('klypix:request-sign-in', handler);
            try { delete (window as any).klypixShowSignIn; } catch { /* no-op */ }
        };
    }, []);

    useEffect(() => {
        if (isAuthenticated && manualSignIn) setManualSignIn(false);
    }, [isAuthenticated, manualSignIn]);

    // 7-day free trial before requiring login
    const TRIAL_START_KEY = 'klypix_trial_start';
    const TRIAL_DAYS = 7;

    const checkTrialExpired = () => {
        if (isAuthenticated) return false;
        const start = localStorage.getItem(TRIAL_START_KEY);
        if (!start) {
            // First launch — start the timer
            localStorage.setItem(TRIAL_START_KEY, String(Date.now()));
            return false;
        }
        const elapsed = Date.now() - parseInt(start, 10);
        const daysElapsed = elapsed / (1000 * 60 * 60 * 24);
        return daysElapsed >= TRIAL_DAYS;
    };

    // Check trial on mount
    useEffect(() => {
        if (checkTrialExpired()) {
            setTrialExpired(true);
        }
    }, [isAuthenticated]);

    // Defensive scroll lock. `overflow: clip` on the outer wrappers stops
    // NEW scroll from being induced by scrollIntoView, but ANY scrollLeft
    // that leaked in before the clip fix (or from an ancestor we don't
    // own, like the HTML/body element in some packaging setups) sticks
    // around and shifts the whole UI off-screen. Listen at window level
    // and force scroll back to 0 on both the document and the body. This
    // is a belt-and-braces guard against caret-chase scrolling across
    // the entire app.
    useEffect(() => {
        const reset = () => {
            if (typeof document === 'undefined') return;
            try {
                if (document.documentElement.scrollLeft !== 0) document.documentElement.scrollLeft = 0;
                if (document.documentElement.scrollTop !== 0) document.documentElement.scrollTop = 0;
                if (document.body.scrollLeft !== 0) document.body.scrollLeft = 0;
                if (document.body.scrollTop !== 0) document.body.scrollTop = 0;
            } catch { /* no-op */ }
        };
        reset();
        window.addEventListener('scroll', reset, true); // capture = catch ancestor scrolls too
        return () => window.removeEventListener('scroll', reset, true);
    }, []);

    if (authLoading) {
        return (
            <div className="h-screen w-screen bg-[#0a0a0a] flex items-center justify-center">
                <Loader2 size={24} className="animate-spin text-emerald-500" />
            </div>
        );
    }

    // Trial expired (and not signed in) OR user explicitly asked to sign in.
    // The manualSignIn path fires REGARDLESS of isAuthenticated — the
    // renderer can think you're authenticated due to a cached session that
    // Supabase has actually rejected, and the only fix is re-authenticating.
    if (manualSignIn || (!isAuthenticated && trialExpired)) {
        return <LoginScreen trialExpired={trialExpired} />;
    }

    return <AppMain />;
}

// ── AppMain (all hooks live here, only mounts when authenticated) ─────────────
function AppMain() {
    // Onboarding state
    const [showOnboarding, setShowOnboarding] = useState(!isOnboardingComplete());

    // PDF password prompt state
    const [passwordNeeded, setPasswordNeeded] = useState<{ fileName: string; filePath: string } | null>(null);

    // CDP browser restart state
    const [showCdpBanner, setShowCdpBanner] = useState(false);
    const [cdpBrowsersNeedRestart, setCdpBrowsersNeedRestart] = useState<string[]>([]);
    // CDP banner: session-based dismiss (shows again each app restart if CDP still not set up)
    const [cdpBannerDismissed, setCdpBannerDismissed] = useState(false);
    // CDP banner auto-collapse: shows full banner for 4s then collapses to icon in title bar
    const [cdpBannerCollapsed, setCdpBannerCollapsed] = useState(false);

    // On first launch: check which browsers are running without CDP
    useEffect(() => {
        if (cdpBannerDismissed) return;
        const checkCdp = async () => {
            try {
                const result = await (window as any).electron.checkBrowsersNeedCdp?.();
                if (result?.needsRestart?.length > 0) {
                    setCdpBrowsersNeedRestart(result.needsRestart);
                    setShowCdpBanner(true);
                    // Auto-collapse to icon after 4 seconds
                    setTimeout(() => setCdpBannerCollapsed(true), 4000);
                }
            } catch (_) {}
        };
        const timer = setTimeout(checkCdp, 3000);
        return () => clearTimeout(timer);
    }, [cdpBannerDismissed]);

    // Lifted state to break circular dependency between useChat ↔ usePinnedChats
    const [currentChatId, setCurrentChatId] = useState<string | null>(null);

    // Ref-based bridge: allows useChat (initialized first) to call setShowSuggestionsContent
    // from useSuggestions (initialized later) without a circular dependency.
    const showSuggestionsSetterRef = useRef<(v: boolean) => void>(() => {});

    // ── Hooks ─────────────────────────────────────────────────────────────────
    const auth = useAuth();
    const updater = useUpdater();
    const docGen = useDocGenerator();
    const settings = useSettings();
    const sessionCtx = useSessionContext();
    const windowCtx = useWindowContext();
    const screenshot = useScreenshot();
    const attachments = useAttachments();
    const deepMode = useDeepMode(attachments.attachedFiles);
    const agent = useAgent({ activeWindowContext: windowCtx.activeWindowContext, isAgentMode: true });
    const claudeAgent = useClaudeAgent();
    const claudeAgentStateRef = useRef(claudeAgent.state);
    claudeAgentStateRef.current = claudeAgent.state;
    const [trustMode, setTrustMode] = useState(() => localStorage.getItem('klypix:trustMode') === '1');
    const handleTrustModeChange = (enabled: boolean) => {
        setTrustMode(enabled);
        claudeAgent.setTrustMode(enabled);
    };
    const [agentMode, setAgentMode] = useState(false);
    const agentModeRef = useRef(false);
    agentModeRef.current = agentMode;

    // Top-level tab: Chat (current app) vs Canvas (.any workspace)
    const [activeTab, setActiveTab] = useState<AppTab>('chat');

    // Chat→Canvas hand-off. Pushes the response content into a localStorage
    // queue keyed `klypix:pendingCanvasItems`, then flips the app tab to
    // canvas. The drain effect inside CanvasSurface picks it up once the
    // autosave restore dialog (if any) has fully settled — so we don't race
    // a half-loaded canvas. Each entry: { content, timestamp }.
    const handleSendToCanvas = useCallback((content: string) => {
        if (!content || !content.trim()) return;
        const key = 'klypix:pendingCanvasItems';
        let existing: Array<{ content: string; timestamp: number }> = [];
        try {
            const raw = localStorage.getItem(key);
            if (raw) {
                const parsed = JSON.parse(raw);
                if (Array.isArray(parsed)) existing = parsed;
            }
        } catch { /* corrupt entry → just overwrite */ }
        existing.push({ content, timestamp: Date.now() });
        try {
            localStorage.setItem(key, JSON.stringify(existing));
        } catch {
            // Quota or serialization failure — skip the queue, switch anyway
            // so the user isn't stranded staring at chat after clicking.
        }
        setActiveTab('canvas');
    }, []);
    const [canvasFullscreen, setCanvasFullscreen] = useState(false);

    // If the user expanded Canvas to fullscreen and then clicks back to Chat, the
    // window stays huge and the chat UI looks awful. Auto-shrink on switch-away.
    useEffect(() => {
        if (activeTab === 'canvas') return;
        const api = (window as any).electron?.canvas;
        api?.isFullscreen?.().then((on: boolean) => {
            if (on) {
                api.setFullscreen(false);
                setCanvasFullscreen(false);
            }
        }).catch(() => {});
    }, [activeTab]);

    // Main process force-exits canvas fullscreen on Alt+Space hide (so the window
    // returns to its overlay spot on re-show). Re-sync our local state on show,
    // otherwise the maximize icon would need a "ghost click" to match reality.
    useEffect(() => {
        const onVis = () => {
            if (document.hidden) return;
            const api = (window as any).electron?.canvas;
            api?.isFullscreen?.().then((on: boolean) => setCanvasFullscreen(!!on)).catch(() => {});
        };
        document.addEventListener('visibilitychange', onVis);
        return () => document.removeEventListener('visibilitychange', onVis);
    }, []);

    // Unified maximize handler: on Canvas tab, toggle true-fullscreen (lifts size
    // cap). On Chat tab, toggle the normal constrained maximize (750x980 cap).
    const handleTitleBarMaximize = async () => {
        if (activeTab === 'canvas') {
            const api = (window as any).electron?.canvas;
            if (!api) return;
            const next = !canvasFullscreen;
            const result = await api.setFullscreen(next);
            setCanvasFullscreen(!!result);
        } else {
            windowCtx.handleMaximize();
        }
    };
    const titleBarMaximizeIsOn = activeTab === 'canvas' ? canvasFullscreen : windowCtx.isMaximized;

    // Prompt Enhancer state
    const [showPromptEnhancer, setShowPromptEnhancer] = useState(false);
    const [showMemoryPanel, setShowMemoryPanel] = useState(false);
    const [memoryEnabled, setMemoryEnabled] = useState(false);

    // Track memory enabled state so header icon can reflect it.
    // Re-check whenever the panel closes (user may have toggled inside).
    useEffect(() => {
        let cancelled = false;
        (async () => {
            try {
                const { getMemoryManager } = await import('./services/memory');
                const s = await getMemoryManager().getSettings();
                if (!cancelled) setMemoryEnabled(s.enabled);
            } catch {}
        })();
        return () => { cancelled = true; };
    }, [showMemoryPanel]);
    const [enhancerData, setEnhancerData] = useState<{
      originalPrompt: string;
      analysis: any;
      fields: any[];
      initialValues: Record<string, any>;
      pendingAgentContext: { agentPrompt: string; screenshot: string | null; windowCtx: any; extraScreenshots?: string[] } | null;
    } | null>(null);

    const chat = useChat({
        selectedModel: settings.selectedModel,
        activeWindowContext: windowCtx.activeWindowContext,
        isPrivacyMode: settings.isPrivacyMode,
        isTTSEnabled: settings.isTTSEnabled,
        isDeepFileMode: deepMode.isDeepFileMode,
        showScreenshot: screenshot.showScreenshot,
        discoveredFiles: deepMode.discoveredFiles,
        selectedFiles: deepMode.selectedFiles,
        attachedFiles: attachments.attachedFiles,
        setAttachedFiles: attachments.setAttachedFiles,
        setIsReadingFile: deepMode.setIsReadingFile,
        setDeepFileError: deepMode.setDeepFileError,
        setActiveFileInfo: deepMode.setActiveFileInfo,
        onPasswordNeeded: (info) => setPasswordNeeded(info),
        getCachedContent: deepMode.getCachedContent,
        allSelectedLoaded: deepMode.allSelectedLoaded,
        fileContentCache: deepMode.fileContentCache,
        captureMode: screenshot.captureMode,
        lastScreenshot64: screenshot.lastScreenshot64,
        setLastScreenshot64: screenshot.setLastScreenshot64,
        useLastScreenshot: screenshot.useLastScreenshot,
        setUseLastScreenshot: screenshot.setUseLastScreenshot,
        captureFullScreen: screenshot.captureFullScreen,
        launchSnipping: screenshot.launchSnipping,
        setShowSuggestionsContent: (v: boolean) => showSuggestionsSetterRef.current(v),
        setCurrentChatId,
        onResponseComplete: async (fullResponse: string) => {
            // Screen → Data → Destination interceptor
            if (agent.screenActionPending) {
                const result = await agent.handleScreenActionResponse(fullResponse);
                if (result.handled && result.message) {
                    chat.setMessages(prev => [...prev, { role: 'assistant' as const, content: `📁 ${result.message}` }]);
                }
            }
        },
        screenshotStack: screenshot.screenshotStack.map(s => s.base64),
        sessionContextSummary: sessionCtx.getContextSummary(
            deepMode.isDeepFileMode ? 'deep-file'
            : screenshot.showScreenshot && screenshot.captureMode === 'partial' ? 'partial-screenshot'
            : screenshot.showScreenshot ? 'full-screenshot'
            : 'chat'
        ),
        setShowScreenshot: screenshot.setShowScreenshot,
        setIsDeepFileMode: deepMode.setIsDeepFileMode,
        clearStack: screenshot.clearStack,
    });

    const pinnedChats = usePinnedChats({
        messages: chat.messages,
        setMessages: chat.setMessages,
        currentChatId,
        setCurrentChatId,
    });

    const suggestions = useSuggestions({
        isDeepFileMode: deepMode.isDeepFileMode,
        selectedFiles: deepMode.selectedFiles,
        discoveredFiles: deepMode.discoveredFiles,
        attachedFiles: attachments.attachedFiles,
        lightExcerpts: deepMode.lightExcerpts,
        getCachedContent: deepMode.getCachedContent,
        allSelectedLoaded: deepMode.allSelectedLoaded,
        fileContentCache: deepMode.fileContentCache,
        showScreenshot: screenshot.showScreenshot,
        captureMode: screenshot.captureMode,
        lastScreenshot64: screenshot.lastScreenshot64,
        activeWindowContext: windowCtx.activeWindowContext,
        isPrivacyMode: settings.isPrivacyMode,
        blacklistedIds: deepMode.blacklistedIds,
        setBlacklistedIds: deepMode.setBlacklistedIds,
        setFailedAccessNames: deepMode.setFailedAccessNames,
        isAgentMode: agentMode,
        screenshotStack: screenshot.screenshotStack.map(s => s.base64),
    });

    // Wire the ref so useChat's closure calls the real setter from useSuggestions.
    showSuggestionsSetterRef.current = suggestions.setShowSuggestionsContent;

    // Auto-dismiss file access errors after 10 seconds
    useEffect(() => {
        if (deepMode.failedAccessNames.length > 0) {
            const timer = setTimeout(() => deepMode.setFailedAccessNames([]), 10000);
            return () => clearTimeout(timer);
        }
    }, [deepMode.failedAccessNames]);

    // ── Local UI state ────────────────────────────────────────────────────────
    const [query, setQuery] = useState('');
    const queryRef = useRef('');
    const [textareaHeight, setTextareaHeight] = useState(38);

    // Clear input helper — clears ref, state, and DOM
    const clearInput = useCallback(() => {
        queryRef.current = '';
        setQuery('');
        if (inputRef.current) { inputRef.current.value = ''; inputRef.current.style.height = 'auto'; }
        setTextareaHeight(38);
    }, []);
    const [showRewriteMenu, setShowRewriteMenu] = useState(false);
    const [showModelDropdown, setShowModelDropdown] = useState(false);
    const [lastActionType, setLastActionType] = useState<string | null>(null);
    const [contextInsight, setContextInsight] = useState<ContextInsight | null>(null);
    const [isLoadingInsight, setIsLoadingInsight] = useState(false);
    const [insightStopped, setInsightStopped] = useState(false);
    const [insightDismissed, setInsightDismissed] = useState(false);
    const [currentScreenContext, setCurrentScreenContext] = useState<ScreenContext>('unknown');
    const [fileAccessState, setFileAccessState] = useState<{ loading: boolean; result: FileAccessResult | null }>({ loading: false, result: null });
    const [webAccessState, setWebAccessState] = useState<{ loading: boolean; result: WebAccessResult | null }>({ loading: false, result: null });
    const [onScreenEnabled, _setOnScreenEnabled] = useState(() => localStorage.getItem('klypix_onscreen') !== 'false');
    const setOnScreenEnabled = (v: boolean | ((prev: boolean) => boolean)) => { _setOnScreenEnabled(prev => { const next = typeof v === 'function' ? v(prev) : v; localStorage.setItem('klypix_onscreen', String(next)); return next; }); };
    // onScreenContextMode removed — auto-detected: full-doc when file accessible, screen-only otherwise
    const wasHiddenRef = useRef(true); // track hide→show for dismiss reset
    const pendingFullDocContextRef = useRef<ScreenContext | null>(null); // pending full-doc action replacement
    const pendingScreenOnlyContextRef = useRef<ScreenContext | null>(null); // pending screenshot-only action replacement
    const lastInsightContextRef = useRef<string>(''); // Cache key for "What I See"
    const [isVoiceRecording, setIsVoiceRecording] = useState(false);
    const [voiceLevel, setVoiceLevel] = useState(0); // 0-1 normalized volume
    const voiceRecognitionRef = useRef<any>(null);
    const voiceAnalyzerRef = useRef<{ stream: MediaStream; ctx: AudioContext; animFrame: number } | null>(null);

    const inputRef = useRef<HTMLTextAreaElement>(null);
    const titleBarRef = useRef<HTMLDivElement>(null);
    const headerRef = useRef<HTMLDivElement>(null);
    const quickActionsRef = useRef<HTMLDivElement>(null);
    const footerRef = useRef<HTMLDivElement>(null);

    // ── Effects ───────────────────────────────────────────────────────────────
    useEffect(() => { inputRef.current?.focus(); }, []);

    const isCapturingForInsightRef = useRef(false);
    const preCaptureRef = useRef<{ screenshot: string; windowContext: { title: string; process: string }; browserUrl?: string | null; webContent?: string | null; webMethod?: string | null; fileContent?: string | null; fileName?: string | null; filePageCount?: number | null } | null>(null);
    const pendingClipboardCopyRef = useRef(false);
    const clipboardTargetIndexRef = useRef(-1);

    // Listen for pre-captured screenshot from main process (captured BEFORE window shows — no flicker)
    useEffect(() => {
        const cleanup = (window as any).electron.onPreCapture((data: any) => {
            preCaptureRef.current = data;
        });
        return () => cleanup();
    }, []);

    useEffect(() => {
        const handleVisibilityChange = () => {
            // Skip if we're mid-capture (prevents infinite loop from captureScreen hide/show)
            if (isCapturingForInsightRef.current) return;
            const visible = !document.hidden;
            windowCtx.setIsVisible(visible);
            if (!visible) {
                wasHiddenRef.current = true;
                clearInsightCache();
                setContextInsight(null);
                setCurrentScreenContext('unknown'); // Reset so stale context doesn't persist across toggles
                setWebAccessState({ loading: false, result: null }); // Reset web access state
                // Clear stale document context on every hide — prevents previous
                // PDF/Excel content from leaking into next toggle's chat answers
                chat.clearActiveDocContent?.();
            }
            if (visible) {
                (window as any).electron.getActiveWindowContext().then(windowCtx.setActiveWindowContext);

                // Skip if this was a brief hide from screenshot capture (not a real toggle)
                if (isCapturingForInsightRef.current) {
                    wasHiddenRef.current = false;
                    return;
                }

                // Genuine Alt+Space toggle
                if (wasHiddenRef.current) {
                    setInsightDismissed(false);
                    // Do NOT reset insightStopped — user's pause choice persists
                    // across toggles until they press X dismiss or restart the app
                    setFileAccessState({ loading: false, result: null });
                    wasHiddenRef.current = false;
                }

                windowCtx.setIsResizing(true);
                setTimeout(() => windowCtx.setIsResizing(false), 800);

                const isDefaultState = !screenshot.showScreenshot && !deepMode.isDeepFileMode;
                const hasScreenshots = screenshot.showScreenshot && screenshot.screenshotStack.length > 0;
                const hasDeepModeSuggestions = deepMode.isDeepFileMode && deepMode.selectedFiles.length > 0;
                // Delay slightly to allow pre-capture data to arrive from main process
                // On first toggle after launch, the pre-capture takes ~2-3s (PS startup + screenshot)
                const isFirstToggle = !preCaptureRef.current && isDefaultState && onScreenEnabled;
                const timer = setTimeout(async () => {
                    // Skip all auto-fetches when agent is actively running (use ref for fresh value)
                    const agentRunning = claudeAgentStateRef.current === 'running' || claudeAgentStateRef.current === 'waiting_permission' || claudeAgentStateRef.current === 'waiting_user_answer' || claudeAgentStateRef.current === 'done';
                    const isAgentOn = agentModeRef.current;

                    if (!agentRunning && !isAgentOn) {
                        if (hasScreenshots) {
                            suggestions.fetchSuggestions(true);
                        } else if (hasDeepModeSuggestions) {
                            deepMode.refreshDiscoveredItems();
                            suggestions.fetchSuggestions(true);
                        }
                    }
                    agent.checkClipboard();

                    // "What I See" — enhanced with context detection, caching, file access, and offline fallback
                    // Only runs when On Screen is enabled AND not paused by user AND agent is NOT running.
                    // Also gated on activeTab === 'chat': when the user is in Canvas, the whole chat-side
                    // pipeline (screenshot analysis, Gemini calls, window-context re-fetches) should be
                    // paused — otherwise it fires background work that flickers behind the canvas overlay.
                    if (activeTab === 'chat' && isDefaultState && onScreenEnabled && !insightStopped && !agentRunning) {
                        // Use pre-captured data from main process (captured BEFORE window shows — no flicker)
                        const preCapture = preCaptureRef.current;
                        preCaptureRef.current = null; // consume it

                        // Step 1: Detect context using pre-captured window context (or fresh fetch as fallback)
                        const freshWindowCtx = preCapture?.windowContext || await (window as any).electron.getActiveWindowContext().catch(() => windowCtx.activeWindowContext) || windowCtx.activeWindowContext;
                        windowCtx.setActiveWindowContext(freshWindowCtx);
                        const screenCtxDetected = detectContext(freshWindowCtx);
                        setCurrentScreenContext(screenCtxDetected);

                        // Step 2: Content reading
                        // Only use pre-fetched web content if context detection AGREES it's a browser.
                        // This prevents non-browser apps (Claude, VS Code, etc.) from picking up
                        // content from minimized browser tabs via session files/CDP.
                        const preFetchedContent = preCapture?.webContent as string | null;
                        const preFetchedUrl = preCapture?.browserUrl as string | null;
                        const isLocalFileUrl = preFetchedUrl?.startsWith('file:///') || false;
                        const contextIsBrowser = screenCtxDetected.startsWith('browser-') || screenCtxDetected === 'unknown' || screenCtxDetected === 'pdf-viewer';
                        const useWebContent = preFetchedContent && preFetchedUrl && (contextIsBrowser || isLocalFileUrl);

                        if (useWebContent) {
                            // Web content was pre-fetched AND context confirms it's a browser
                            setFileAccessState({ loading: false, result: null });
                            if (screenCtxDetected === 'unknown') {
                                setCurrentScreenContext('browser-general');
                            }
                            const ctx = screenCtxDetected.startsWith('browser-') ? screenCtxDetected : 'browser-general';
                            setWebAccessState({ loading: false, result: {
                                webContent: preFetchedContent, url: preFetchedUrl,
                                method: (preCapture?.webMethod as any) || 'fetch', accessGranted: true,
                            }});
                            pendingFullDocContextRef.current = ctx;
                            chat.setActiveDocContent?.(`--- WEBPAGE: ${preFetchedUrl} ---\n${preFetchedContent}\n--- END WEBPAGE ---`);
                            setContextInsight(prev => {
                                if (!prev) return prev;
                                return { ...prev, actions: getContextActionsForAccess(ctx, true) };
                            });
                        } else if (preFetchedUrl && !preFetchedContent && contextIsBrowser) {
                            // URL was found but fetch failed — try from renderer (only if browser context)
                            setFileAccessState({ loading: false, result: null });
                            setWebAccessState({ loading: true, result: null });
                            if (screenCtxDetected === 'unknown') {
                                setCurrentScreenContext('browser-general');
                            }
                            tryReadWebContent(preFetchedUrl, freshWindowCtx.title || '').then(result => {
                                setWebAccessState({ loading: false, result });
                                if (result.accessGranted && result.webContent) {
                                    pendingFullDocContextRef.current = 'browser-general';
                                    chat.setActiveDocContent?.(`--- WEBPAGE: ${preFetchedUrl} ---\n${result.webContent}\n--- END WEBPAGE ---`);
                                } else {
                                    pendingScreenOnlyContextRef.current = screenCtxDetected;
                                }
                            }).catch(() => setWebAccessState({ loading: false, result: null }));
                        } else {
                            // No web content — try file reading for Office apps
                            setWebAccessState({ loading: false, result: null });

                            // Use pre-captured file content if available (read BEFORE overlay showed)
                            const preFetchedFileContent = preCapture?.fileContent as string | null;
                            const preFetchedFileName = preCapture?.fileName as string | null;

                            if (preFetchedFileContent && preFetchedFileName) {
                                // File was pre-read successfully — use it directly
                                console.log(`[OnScreen] Using pre-captured file: ${preFetchedFileName} (${preFetchedFileContent.length} chars)`);
                                const result = {
                                    accessGranted: true,
                                    fileName: preFetchedFileName,
                                    fileContent: preFetchedFileContent,
                                    pageCount: preCapture?.filePageCount || 1,
                                };
                                setFileAccessState({ loading: false, result });
                                let effectiveContext = screenCtxDetected;
                                if (effectiveContext === 'unknown') {
                                    const inferred = inferContextFromFileName(preFetchedFileName);
                                    if (inferred) { effectiveContext = inferred; setCurrentScreenContext(inferred); }
                                }
                                pendingFullDocContextRef.current = effectiveContext;
                                chat.setActiveDocContent?.(`--- FILE: ${preFetchedFileName} ---\n${preFetchedFileContent}\n--- END FILE ---`);
                                setContextInsight(prev => {
                                    if (!prev) return prev;
                                    return { ...prev, actions: getContextActionsForAccess(effectiveContext, true) };
                                });
                            } else {
                                // No pre-captured file — fall back to read-active-file IPC
                                const canReadFile = isFileAccessibleContext(screenCtxDetected) || screenCtxDetected === 'unknown';
                                if (canReadFile) {
                                    setFileAccessState({ loading: true, result: null });
                                    tryReadActiveFile().then(result => {
                                        setFileAccessState({ loading: false, result });
                                        let effectiveContext = screenCtxDetected;
                                        if (result.accessGranted && result.fileName && effectiveContext === 'unknown') {
                                            const inferred = inferContextFromFileName(result.fileName);
                                            if (inferred) {
                                                effectiveContext = inferred;
                                                setCurrentScreenContext(inferred);
                                            }
                                        }
                                        pendingFullDocContextRef.current = result.accessGranted ? effectiveContext : null;
                                        if (!result.accessGranted) {
                                            pendingScreenOnlyContextRef.current = effectiveContext;
                                        }
                                        setContextInsight(prev => {
                                            if (!prev) return prev;
                                            return { ...prev, actions: getContextActionsForAccess(effectiveContext, result.accessGranted) };
                                        });
                                    }).catch(() => setFileAccessState({ loading: false, result: null }));
                                } else {
                                    setFileAccessState({ loading: false, result: null });
                                }
                            }
                        }

                        // Step 3: Check cache (30s TTL) — file read already kicked off above
                        const cacheKey = getInsightCacheKey(screenCtxDetected, freshWindowCtx.title);
                        const cached = getCachedInsight(cacheKey);
                        if (cached) {
                            setContextInsight(cached as ContextInsight);
                            // Don't reset insightDismissed — respect user's dismiss choice
                            // Don't return — let the file read complete and update actions
                            return;
                        }

                        // Step 4: Use pre-captured screenshot (no hide/show flicker) or fall back to captureScreen
                        setIsLoadingInsight(true);
                        setContextInsight(null);
                        try {
                            let screenshot64 = preCapture?.screenshot || null;
                            if (!screenshot64) {
                                // Fallback: capture with hide/show (old behavior)
                                isCapturingForInsightRef.current = true;
                                screenshot64 = await (window as any).electron.captureScreen();
                                isCapturingForInsightRef.current = false;
                            }
                            if (screenshot64) {
                                screenshot.setLastScreenshot64(screenshot64);
                                chat.setActiveImage(screenshot64);

                                // Step 4: Call Gemini with context-specific focus + Arabic detection
                                let contextFocus = getContextFocus(screenCtxDetected);
                                const hasArabic = /[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF]/.test(freshWindowCtx.title);
                                if (hasArabic) contextFocus += ' If content is in Arabic, provide insight in both Arabic and English.';
                                const insight = await getContextInsight(screenshot64, contextFocus, screenCtxDetected);
                                if (insight) {
                                    // Step 5: Enforce action types + reorder by Gemini's recommendation
                                    insight.actions = enforceActionTypes(insight.actions || [], screenCtxDetected);
                                    insight.actions = reorderActions(insight.actions, (insight as any).firstAction);
                                    // Step 5b: If file read already completed with full access, use full-doc actions instead
                                    if (pendingFullDocContextRef.current) {
                                        // Full doc/web access succeeded — swap in full-doc actions
                                        insight.actions = getContextActionsForAccess(pendingFullDocContextRef.current, true);
                                        pendingFullDocContextRef.current = null;
                                    } else if (pendingScreenOnlyContextRef.current) {
                                        // File/web access failed — KEEP Gemini's smart actions (don't replace with generic fallbacks)
                                        // Gemini already analyzed the screenshot and generated context-specific actions
                                        pendingScreenOnlyContextRef.current = null;
                                    }
                                    // Step 6: Cache the result
                                    setCachedInsight(cacheKey, insight as any, screenCtxDetected);
                                    setContextInsight(insight);
                                    sessionCtx.addScreenAnalysis({ seeing: insight.seeing, keyData: insight.key_data, timestamp: Date.now() });
                                }
                            }
                        } catch (err) {
                            isCapturingForInsightRef.current = false;
                            console.error('[WhatISee] Failed:', err);
                            // Offline fallback: use hardcoded actions
                            const fallbackActions = getContextActionsWithTranslate(screenCtxDetected, freshWindowCtx.title);
                            const displayLabel = getContextDisplayLabel(screenCtxDetected);
                            setContextInsight({
                                seeing: `${displayLabel} detected — offline mode`,
                                key_data: [],
                                actions: fallbackActions,
                            });
                        } finally {
                            setIsLoadingInsight(false);
                        }
                    }
                }, isFirstToggle ? 3000 : 300);
                return () => clearTimeout(timer);
            }
        };
        document.addEventListener('visibilitychange', handleVisibilityChange);
        return () => document.removeEventListener('visibilitychange', handleVisibilityChange);
    }, [suggestions.fetchSuggestions, deepMode.isDeepFileMode]);

    // Auto-copy to clipboard when a clipboard-type suggestion response completes
    useEffect(() => {
        if (!pendingClipboardCopyRef.current || chat.isAnalyzing || chat.isTyping) return;
        // Find the assistant message at the expected index
        const targetIdx = clipboardTargetIndexRef.current;
        const targetMsg = targetIdx >= 0 ? chat.messages[targetIdx] : null;
        if (targetMsg?.role === 'assistant' && targetMsg.content) {
            // Strip markdown formatting for clean clipboard content
            const cleanText = targetMsg.content
                .replace(/^#+\s*/gm, '')
                .replace(/\*\*/g, '')
                .replace(/`/g, '')
                .trim();
            window.electron.copyToClipboard({ text: cleanText, html: targetMsg.content });
            pendingClipboardCopyRef.current = false;
            clipboardTargetIndexRef.current = -1;
        }
    }, [chat.isAnalyzing, chat.isTyping, chat.messages]);

    // Live clipboard monitoring while overlay is visible
    useEffect(() => {
        if (!windowCtx.isVisible) return;
        const interval = setInterval(() => agent.checkClipboard(), 2000);
        return () => clearInterval(interval);
    }, [windowCtx.isVisible]);

    // Fetch suggestions when deep mode file selection changes
    // Screenshot mode fetches are handled by capture callbacks (not here)
    const pendingSuggestionFetchRef = useRef(false);
    useEffect(() => {
        if (!deepMode.isDeepFileMode) return;
        if (!deepMode.userSelectionRef.current) return;
        deepMode.userSelectionRef.current = false;
        if (chat.isAnalyzing || chat.isTyping) return;
        if (deepMode.isFilesDropdownOpen) {
            pendingSuggestionFetchRef.current = true;
            return;
        }
        if (deepMode.selectedFiles.length > 0 && !deepMode.allSelectedLoaded) {
            pendingSuggestionFetchRef.current = true;
            return;
        }
        suggestions.fetchSuggestions();
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [deepMode.isDeepFileMode, deepMode.selectedFiles, deepMode.allSelectedLoaded]);

    // Sync deep mode content to activeDocContent so follow-up questions use the correct document
    // Without this, a previously-read PDF would persist in activeDocContent and contaminate answers
    useEffect(() => {
        if (deepMode.isDeepFileMode && deepMode.allSelectedLoaded && deepMode.selectedFiles.length > 0) {
            const content = deepMode.getCachedContent();
            if (content) {
                chat.setActiveDocContent?.(content);
            }
        }
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [deepMode.isDeepFileMode, deepMode.allSelectedLoaded, deepMode.selectedFiles]);

    // When files dropdown closes AND all files loaded, fetch pending suggestions
    useEffect(() => {
        if (!deepMode.isFilesDropdownOpen && pendingSuggestionFetchRef.current) {
            // Only fetch if files are actually selected and loaded
            if (deepMode.selectedFiles.length > 0 && deepMode.allSelectedLoaded) {
                pendingSuggestionFetchRef.current = false;
                suggestions.fetchSuggestions();
            } else if (deepMode.selectedFiles.length === 0) {
                // No files selected — clear pending flag, skip fetch
                pendingSuggestionFetchRef.current = false;
            }
        }
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [deepMode.isFilesDropdownOpen, deepMode.allSelectedLoaded]);

    // Auto-collapse when NEW fetch starts (edge-triggered, not level-triggered)
    const prevFetchingRef = useRef(false);
    useEffect(() => {
        // Only collapse on the rising edge: was NOT fetching → now IS fetching
        // Skip when frozen — suggestions are locked down
        if (suggestions.isFetchingSuggestions && !prevFetchingRef.current && !suggestions.isFrozen) {
            suggestions.setIsUserManuallyHidden(false);
            suggestions.setShowSuggestionsContent(false);
        }
        prevFetchingRef.current = suggestions.isFetchingSuggestions;
    }, [suggestions.isFetchingSuggestions]);
    // Auto-expand when results arrive (not when frozen by agent mode)
    useEffect(() => {
        if (suggestions.suggestions.length > 0 && !suggestions.isUserManuallyHidden && !suggestions.isFrozen) {
            suggestions.setShowSuggestionsContent(true);
        }
    }, [suggestions.suggestions]);

    // Unfreeze suggestions when Agent mode turns off
    useEffect(() => {
        if (!agentMode && suggestions.isFrozen) {
            suggestions.fetchSuggestions(true);
        }
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [agentMode]);

    useEffect(() => {
        if (attachments.attachedFiles.length > 0) suggestions.fetchSuggestions(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [attachments.attachedFiles.length]);


    useEffect(() => {
        if (!chat.searchQuery.trim()) { chat.setSearchResultIndices([]); chat.setCurrentSearchIndex(-1); return; }
        const indices: number[] = [];
        const query = chat.searchQuery.toLowerCase();
        chat.messages.forEach((msg, idx) => {
            const content = msg.content.toLowerCase();
            let pos = 0;
            while ((pos = content.indexOf(query, pos)) !== -1) {
                indices.push(idx);
                pos += query.length;
            }
        });
        chat.setSearchResultIndices(indices);
        chat.setCurrentSearchIndex(indices.length > 0 ? 0 : -1);
    }, [chat.searchQuery, chat.messages]);

    useEffect(() => {
        if (chat.currentSearchIndex !== -1 && chat.activeResultRef.current && chat.scrollRef.current) {
            const container = chat.scrollRef.current;
            const target = chat.activeResultRef.current;
            const cRect = container.getBoundingClientRect();
            const tRect = target.getBoundingClientRect();
            container.scrollTo({ top: Math.max(0, tRect.top - cRect.top + container.scrollTop - cRect.height / 2 + tRect.height / 2), behavior: 'smooth' });
        }
    }, [chat.currentSearchIndex]);

    useEffect(() => {
        if (chat.scrollRef.current && chat.isAnalyzing && chat.messages.length > 0) {
            const container = chat.scrollRef.current;
            const last = container.children[container.children.length - 1] as HTMLElement;
            if (last) container.scrollTo({ top: last.offsetTop - 10, behavior: 'smooth' });
        }
    }, [chat.isAnalyzing]);

    // Auto-scroll for Claude Agent updates — scroll to keep WorkflowPanel visible (not bottom)
    const agentCardRef = useRef<HTMLDivElement>(null);
    useEffect(() => {
        if (agentCardRef.current && chat.scrollRef.current && claudeAgent.state !== 'idle') {
            const container = chat.scrollRef.current;
            const card = agentCardRef.current;
            // Scroll so the agent card top is visible near the top of the viewport
            const cardTop = card.offsetTop - container.offsetTop;
            const scrollTarget = cardTop - 12; // 12px padding from top
            if (container.scrollTop < scrollTarget - 50 || container.scrollTop > scrollTarget + container.clientHeight) {
                container.scrollTo({ top: scrollTarget, behavior: 'smooth' });
            }
        }
    }, [claudeAgent.steps, claudeAgent.permissionRequest, claudeAgent.state]);

    // Return to Home mode when agent completes (screenshots/files were just input context)
    const prevAgentStateRef = useRef(claudeAgent.state);
    useEffect(() => {
        if (prevAgentStateRef.current === 'running' && (claudeAgent.state === 'done' || claudeAgent.state === 'error')) {
            if (screenshot.showScreenshot || deepMode.isDeepFileMode) {
                screenshot.setShowScreenshot(false);
                deepMode.setIsDeepFileMode(false);
                screenshot.clearStack();
            }
        }
        prevAgentStateRef.current = claudeAgent.state;
    }, [claudeAgent.state]);

    // Agent card persists after completion — no auto-reset.
    // Reset happens when user submits a new prompt (in the submit function).

    useEffect(() => {
        const onVis = () => { if (document.hidden) setShowRewriteMenu(false); };
        document.addEventListener('visibilitychange', onVis);
        return () => document.removeEventListener('visibilitychange', onVis);
    }, []);

    useEffect(() => {
        if (windowCtx.isResizing) return;
        const hasSuggestions = suggestions.suggestions.length > 0 || suggestions.isFetchingSuggestions || suggestions.wasStopped;
        const currentHeight = window.innerHeight;
        if (currentHeight < 800) {
            const timer = setTimeout(async () => {
                const tH = titleBarRef.current?.offsetHeight || 0;
                const hH = headerRef.current?.offsetHeight || 0;
                const qH = quickActionsRef.current?.offsetHeight || 0;
                const sH = (hasSuggestions && suggestions.suggestionsRef.current && suggestions.showSuggestionsContent) ? suggestions.suggestionsRef.current.offsetHeight : 0;
                const fH = footerRef.current?.offsetHeight || 0;
                const cH = (chat.messages.length > 0 || chat.isAnalyzing || chat.response) ? (chat.scrollRef.current?.scrollHeight || 0) : 0;
                let target = Math.min(tH + hH + qH + sH + cH + fH, 500);
                if (suggestions.prevShowSuggestionsRef.current && !suggestions.showSuggestionsContent) target = Math.min(target, currentHeight);
                suggestions.prevShowSuggestionsRef.current = suggestions.showSuggestionsContent;
                const workArea = await (window as any).electron.getWorkAreaSize();
                if (target > workArea.height) target = workArea.height;
                if ((window as any)._lastResizeTime && Date.now() - (window as any)._lastResizeTime < 50) return;
                (window as any)._lastResizeTime = Date.now();
                (window as any).electron.resizeWindow(target, 700);
            }, 30);
            return () => clearTimeout(timer);
        }
    }, [suggestions.suggestions.length, suggestions.isFetchingSuggestions, textareaHeight, suggestions.showSuggestionsContent, chat.isAnalyzing, chat.messages.length, chat.response, windowCtx.isVisible, windowCtx.isResizing]);

    // ── Helpers ───────────────────────────────────────────────────────────────
    const detectContextMode = (): ContextMode => {
        if (deepMode.isDeepFileMode) {
            const totalFiles = deepMode.selectedFiles.length + attachments.attachedFiles.length;
            return totalFiles > 1 ? 'deepfile-multi' : 'deepfile-single';
        }
        if (screenshot.showScreenshot) return 'screenshot';
        if (attachments.attachedFiles.length > 0) return 'attachment';
        return 'plain';
    };

    const submit = async (e?: React.FormEvent, manualQuery?: string, isVoice = false, displayQuery?: string, actionType?: string) => {
        const queryText = manualQuery || queryRef.current || query;

        // ── Memory NL commands — only check when memory has been enabled at least once ──
        // Sync localStorage flag avoids loading sql.js for users who never turned memory on.
        if (queryText && !actionType) {
            try {
                const { isMemoryEnabled } = await import('./services/memory');
                if (isMemoryEnabled()) {
                    const { getMemoryManager } = await import('./services/memory');
                    const mgr = getMemoryManager();
                    const cmd = mgr.parseCommand(queryText);
                    if (cmd.kind) {
                        e?.preventDefault();
                        const response = await mgr.executeCommand(cmd as { kind: 'remember' | 'forget' | 'query'; content?: string });
                        chat.setMessages(prev => [
                            ...prev,
                            { role: 'user' as const, content: queryText },
                            { role: 'assistant' as const, content: response },
                        ]);
                        clearInput();
                        if (inputRef.current) { inputRef.current.style.height = '38px'; setTextareaHeight(38); }
                        return;
                    }
                }
            } catch (err) { console.warn('[Memory] NL command parsing failed:', err); }
        }

        // ── Agent Mode — takes priority over everything ──────────────────────
        // Follow-up routing: when agent mode is on AND there's prior conversation,
        // a referential question ("what is the llm used?", "explain that") should
        // go through chat (which already has history + on-screen context) instead
        // of spawning a fresh agent loop that has no idea what "that" means and
        // burns tokens re-discovering context. Only escalate to the agent for
        // clearly actionable follow-ups — classifyFollowUp() returns gemini_chat
        // for pure questions and falls through to the smartRouter Flash classifier
        // for ambiguous cases.
        let agentModeRouting = agentMode && !!queryText && !actionType;
        const isAgentFollowUp = agentModeRouting && chat.messages.length > 0;
        if (isAgentFollowUp) {
            try {
                const decision = await classifyFollowUp(queryText!);
                if (decision.route === 'gemini_chat') {
                    agentModeRouting = false;
                    console.log('[Agent] Follow-up routed to chat:', decision.reason);
                }
            } catch (err) {
                console.warn('[Agent] follow-up classification failed; keeping agent:', err);
            }
        }
        if (agentModeRouting) {
            e?.preventDefault();
            // Commit previous agent session to chat history before starting new one
            if (claudeAgent.state !== 'idle') {
                if (claudeAgent.streamingText) {
                    const files = claudeAgent.producedFiles.map(f => ({ path: f.path, name: f.name, format: f.format, size: f.size }));
                    chat.setMessages(prev => [...prev, {
                        role: 'assistant' as const,
                        content: claudeAgent.streamingText,
                        ...(files.length > 0 ? { agentFiles: files } : {}),
                    }]);
                }
                claudeAgent.reset();
            }
            const userRawText = manualQuery || queryRef.current || query;
            chat.setMessages(prev => [...prev, { role: 'user' as const, content: userRawText, sourceMode: 'agent' as any }]);
            clearInput();
            if (inputRef.current) { inputRef.current.style.height = '38px'; setTextareaHeight(38); }
            // Freeze suggestions — stay stale until user manually refreshes
            suggestions.freezeSuggestions();
            // Pass all stack images if available, otherwise the last single screenshot
            const agentScreenshot = screenshot.screenshotStack.length > 0
                ? screenshot.screenshotStack[screenshot.screenshotStack.length - 1].base64
                : (screenshot.lastScreenshot64 || null);
            // Additional stack images beyond the primary one
            const extraScreenshots = screenshot.screenshotStack.length > 1
                ? screenshot.screenshotStack.slice(0, -1).map(s => s.base64)
                : [];

            // Build context from attachments + deep mode files
            let agentPrompt = queryText;
            if (attachments.attachedFiles.length > 0) {
                try {
                    // Actually read the file contents via IPC
                    const attachItems = attachments.attachedFiles.map((f: any) => ({
                        id: f.path, name: f.name, type: 'file', source: 'Attached', localPath: f.path,
                    }));
                    const result = await window.electron.readMultipleFiles(attachItems);
                    if (result?.results?.length > 0) {
                        const sections = result.results
                            .filter((r: any) => r.content && typeof r.content === 'string' && r.content.length > 10 && !r.error)
                            .map((r: any) => `--- FILE: ${r.name || 'Document'} (${r.pageCount || 0} pages) ---\n${r.content}`)
                            .join('\n\n');
                        if (sections.length > 50) {
                            agentPrompt = `${queryText}\n\n--- ATTACHED FILES (read from disk) ---\n${sections}\n--- END ATTACHED FILES ---`;
                        }
                    }
                } catch (err) {
                    console.warn('[Agent] Failed to read attachments:', err);
                    // Fallback: tell agent to use read_file tool
                    const paths = attachments.attachedFiles.map((f: any) => f.path).join(', ');
                    agentPrompt = `${queryText}\n\n[Attached files at: ${paths} — use read_file tool to access them]`;
                }
            }
            if (deepMode.isDeepFileMode && deepMode.selectedFiles.length > 0) {
                const cached = deepMode.getCachedContent?.();
                if (cached) {
                    agentPrompt = `${agentPrompt}\n\n--- Selected Files Content ---\n${cached}`;
                }
            }

            // Inject on-screen rich context (web page or file content) if available
            if (onScreenEnabled) {
                let onScreenInjected = false;
                if (webAccessState?.result?.accessGranted && webAccessState.result.webContent) {
                    agentPrompt = `${agentPrompt}\n\n--- ON-SCREEN WEB CONTENT (${webAccessState.result.url || 'current page'}) ---\n${webAccessState.result.webContent.slice(0, 20000)}\n--- END ON-SCREEN WEB CONTENT ---`;
                    onScreenInjected = true;
                } else if (fileAccessState?.result?.accessGranted && fileAccessState.result.fileContent) {
                    // Cap file content to reduce token waste — Excel CSVs can be 60K+ chars
                    const maxAgentFileChars = 15000;
                    const rawContent = fileAccessState.result.fileContent;
                    const isTruncated = rawContent.length > maxAgentFileChars;
                    const cappedContent = isTruncated
                      ? rawContent.slice(0, maxAgentFileChars) + `\n\n[... file truncated — ${Math.round(rawContent.length / 1000)}K chars total. Use read_file tool to access full data if needed.]`
                      : rawContent;
                    agentPrompt = `${agentPrompt}\n\n--- ON-SCREEN FILE CONTENT (${fileAccessState.result.fileName || 'active document'}) ---\n${cappedContent}\n--- END ON-SCREEN FILE CONTENT ---`;
                    onScreenInjected = true;
                }
                // Fallback: if file/web content unavailable but we have context insight from screenshot,
                // inject the structured insight data so the agent can use what's visible on screen
                if (!onScreenInjected && contextInsight) {
                    const insightParts: string[] = [];
                    if (contextInsight.seeing) insightParts.push(`VISIBLE: ${contextInsight.seeing}`);
                    if (contextInsight.key_data && contextInsight.key_data.length > 0) {
                        insightParts.push('KEY DATA FROM SCREEN:');
                        for (const kd of contextInsight.key_data) {
                            if (typeof kd === 'object' && kd !== null) {
                                const entries = Object.entries(kd).map(([k, v]) => `${k}: ${v}`).join(', ');
                                insightParts.push(`  - ${entries}`);
                            } else {
                                insightParts.push(`  - ${String(kd)}`);
                            }
                        }
                    }
                    if (insightParts.length > 0) {
                        agentPrompt = `${agentPrompt}\n\n--- ON-SCREEN CONTEXT (extracted from screenshot) ---\n${insightParts.join('\n')}\n\nNOTE: Full file content was not available. Use the data above from the screenshot analysis. If more data is needed, analyze the attached screenshot visually.\n--- END ON-SCREEN CONTEXT ---`;
                    }
                }
            }

            // ── Prompt Enhancer: DISABLED — agent uses ask_user tool for mid-run clarification instead ──

            // For follow-ups, prepend recent conversation so the agent can resolve
            // references like "that file" / "the answer above" without re-discovering
            // everything from scratch. Cap each turn so a long agent transcript doesn't
            // dominate the prompt; skip messages that ended up empty (e.g. cancelled).
            if (isAgentFollowUp) {
                const recentTurns = chat.messages.slice(-4)
                    .map(m => {
                        const body = (m.content || '').trim();
                        if (!body) return '';
                        return `[${m.role}]: ${body.length > 700 ? body.slice(0, 700) + '…' : body}`;
                    })
                    .filter(s => s.length > 0)
                    .join('\n\n');
                if (recentTurns) {
                    agentPrompt = `--- PRIOR CONVERSATION (most recent turns) ---\n${recentTurns}\n--- END PRIOR CONVERSATION ---\n\nUser's new request: ${agentPrompt}`;
                }
            }

            claudeAgent.startAgent(agentPrompt, agentScreenshot, windowCtx.activeWindowContext, extraScreenshots.length > 0 ? extraScreenshots : undefined);
            return;
        }

        // Intent classification — route action commands to executor, skip obvious chat
        if (queryText && !actionType && queryText.trim().length >= 4) {
            const trimmed = queryText.trim();
            const words = trimmed.split(/\s+/);
            const startsWithAction = /^(open|save|rename|move|delete|close|create|copy|go to|navigate|launch|start|kill|exit|quit|run)\b/i.test(trimmed);
            const startsWithQuestion = /^(what|why|how|who|when|where|explain|tell|describe|define|is|are|can|could|should|would|do|does|did|summarize|summary|analyse|analyze|review|compare|list|show|give|write|draft|generate)\b/i.test(trimmed);
            const endsWithQuestion = trimmed.endsWith('?');
            // Classify if: starts with action verb (any length) OR short imperative (≤8 words, not a question)
            const shouldClassify = startsWithAction || (!startsWithQuestion && !endsWithQuestion && words.length <= 8);
            if (shouldClassify) {
                const intent = await agent.classify(queryText);
                if (intent) {
                    e?.preventDefault();
                    clearInput();
                    if (inputRef.current) { inputRef.current.style.height = '38px'; setTextareaHeight(38); }
                    return;
                }
            }
        }

        // Check if this is a document/image generation request
        if (queryText && !actionType) {
            const intent = docGen.checkIntent(queryText);
            if (intent.isGeneration && intent.confidence >= 0.7) {
                e?.preventDefault();
                // Build explicit context from current mode
                let docGenContext: string | undefined;
                if (deepMode.isDeepFileMode && deepMode.selectedFiles.length > 0) {
                    try {
                        const contextPreamble = 'IMPORTANT: Generate the document based ONLY on the following file contents. Do NOT use generic templates. Every fact in your output must come from these files.\n\n';

                        // Tier 1: Use pre-loaded cache (zero IPC — fastest path, fires when green dots show)
                        if (deepMode.allSelectedLoaded) {
                            const cachedContent = deepMode.getCachedContent();
                            if (cachedContent && cachedContent.length > 50) {
                                docGenContext = contextPreamble + cachedContent;
                            }
                        }

                        // Tier 2: Mixed cache + fresh read for any uncached files
                        if (!docGenContext) {
                            const filesToRead = deepMode.discoveredFiles.filter((f: any) => deepMode.selectedFiles.includes(f.id));
                            if (filesToRead.length > 0) {
                                const cachedResults: any[] = [];
                                const uncachedFiles: any[] = [];
                                for (const file of filesToRead) {
                                    const cached = deepMode.fileContentCache.get(file.id);
                                    if (cached?.content && cached.content.length > 10) {
                                        cachedResults.push({ ...file, content: cached.content, pageCount: cached.pageCount });
                                    } else {
                                        uncachedFiles.push(file);
                                    }
                                }
                                if (uncachedFiles.length > 0) {
                                    const freshResult = await (window as any).electron.readMultipleFiles(uncachedFiles);
                                    if (freshResult?.results) {
                                        cachedResults.push(...freshResult.results);
                                    }
                                }
                                const sections = cachedResults
                                    .filter((r: any) => {
                                        const c = r.content;
                                        return c && typeof c === 'string' && c.length > 10 && !c.includes('[object Object]') && !r.error;
                                    })
                                    .map((r: any) => `--- FILE: ${r.originalTitle || r.name || 'Document'} ---\n${typeof r.content === 'string' ? r.content : JSON.stringify(r.content)}`)
                                    .join('\n\n');
                                if (sections.length > 50) {
                                    docGenContext = contextPreamble + sections;
                                }
                            }
                        }

                        // Tier 3: Fallback to light excerpts
                        if (!docGenContext) {
                            const fileNames = deepMode.selectedFiles
                                .map((id: string) => {
                                    const file = deepMode.discoveredFiles.find((f: any) => f.id === id);
                                    return file?.name || file?.originalTitle || id;
                                }).join(', ');
                            const excerpts = deepMode.lightExcerpts && deepMode.lightExcerpts.size > 0
                                ? Array.from(deepMode.lightExcerpts.entries())
                                    .filter(([k]: [string, string]) => deepMode.selectedFiles.includes(k))
                                    .map(([k, v]: [string, string]) => {
                                        const file = deepMode.discoveredFiles.find((f: any) => f.id === k);
                                        return `--- ${file?.name || k} ---\n${v}`;
                                    }).join('\n\n')
                                : '';
                            docGenContext = `Currently selected files: ${fileNames}\n\nFile excerpts:\n${excerpts}`;
                        }
                    } catch {
                        // Emergency fallback to excerpts
                        const fileNames = deepMode.selectedFiles
                            .map((id: string) => {
                                const file = deepMode.discoveredFiles.find((f: any) => f.id === id);
                                return file?.name || file?.originalTitle || id;
                            }).join(', ');
                        const excerpts = deepMode.lightExcerpts && deepMode.lightExcerpts.size > 0
                            ? Array.from(deepMode.lightExcerpts.entries())
                                .filter(([k]: [string, string]) => deepMode.selectedFiles.includes(k))
                                .map(([k, v]: [string, string]) => {
                                    const file = deepMode.discoveredFiles.find((f: any) => f.id === k);
                                    return `--- ${file?.name || k} ---\n${v}`;
                                }).join('\n\n')
                            : '';
                        docGenContext = `Currently selected files: ${fileNames}\n\nFile excerpts:\n${excerpts}`;
                    }
                } else if (screenshot.showScreenshot && screenshot.lastScreenshot64) {
                    // Screenshot mode: pass actual image to docgen for vision-based generation
                    docGenContext = '[Screenshot is attached — generate based on the visible content in the screenshot]';
                } else if (attachments.attachedFiles.length > 0) {
                    // Attachments — read actual content for doc generation
                    try {
                        const attachItems = attachments.attachedFiles.map((f: any) => ({
                            id: f.path, name: f.name,
                            type: 'file', source: 'Attached', localPath: f.path,
                        }));
                        const attachResult = await window.electron.readMultipleFiles(attachItems);
                        if (attachResult?.results?.length > 0) {
                            const contextPreamble = 'IMPORTANT: Generate the document based ONLY on the following attached file contents. Every fact must come from these files.\n\n';
                            const sections = attachResult.results
                                .filter((r: any) => r.content && typeof r.content === 'string' && r.content.length > 10 && !r.error)
                                .map((r: any) => `--- FILE: ${r.name || 'Document'} ---\n${r.content}`)
                                .join('\n\n');
                            if (sections.length > 50) {
                                docGenContext = contextPreamble + sections;
                            }
                        }
                        if (!docGenContext) {
                            const names = attachments.attachedFiles.map((f: any) => f.name).join(', ');
                            docGenContext = `Currently attached files: ${names}. Generate based on these files only.`;
                        }
                    } catch {
                        const names = attachments.attachedFiles.map((f: any) => f.name).join(', ');
                        docGenContext = `Currently attached files: ${names}. Generate based on these files only.`;
                    }
                }
                // Follow-up fallback: use conversation context if no active mode
                if (!docGenContext) {
                    const lastAssistantMsg = chat.messages.slice().reverse().find(m => m.role === 'assistant');
                    if (lastAssistantMsg && lastAssistantMsg.content.length > 50) {
                        docGenContext = 'Convert the following content into the requested format. Preserve all information faithfully.\n\n' + lastAssistantMsg.content;
                    } else if (chat.getActiveDocContent?.()) {
                        docGenContext = chat.getActiveDocContent!();
                    }
                }
                const docGenImage = (screenshot.showScreenshot && screenshot.lastScreenshot64 && !deepMode.isDeepFileMode) ? screenshot.lastScreenshot64 : null;
                if (intent.ambiguous) {
                    docGen.handleAmbiguousIntent(queryText, intent.possibleFormats);
                } else {
                    // Add compact tag to chat history
                    chat.setMessages(prev => [...prev, {
                        role: 'user' as const,
                        content: queryText,
                        attachedFile: { name: `📊 Generating ${intent.format.toUpperCase()}...`, content: '' }
                    }]);
                    docGen.generate(queryText, intent.format, docGenContext, docGenImage);
                }
                // Clear input
                clearInput();
                if (inputRef.current) { inputRef.current.style.height = '38px'; setTextareaHeight(38); }
                return;
            }
        }

        // On Screen context injection — auto: inject full doc/web content when available
        const isOnScreenActive = onScreenEnabled && !insightDismissed && contextInsight;
        const shouldInjectFullDoc = isOnScreenActive
            && fileAccessState?.result?.accessGranted && fileAccessState.result.fileContent;
        const shouldInjectWebContent = isOnScreenActive && !shouldInjectFullDoc
            && webAccessState?.result?.accessGranted && webAccessState.result.webContent;

        const userRawText = manualQuery || queryRef.current || query;
        // When on-screen is active, always anchor the prompt to the current screen context
        // This prevents Gemini from answering from stale conversation history (e.g., previous PDF)
        const onScreenPrefix = (isOnScreenActive && !manualQuery && !shouldInjectFullDoc && !shouldInjectWebContent)
            ? 'Answer based on the current screen content (screenshot attached). If you cannot see the requested information on screen, say so.\n\n'
            : '';
        const finalPrompt = (manualQuery && actionType)
            ? (actionType === 'onscreen' ? manualQuery : buildPrompt(manualQuery, detectContextMode(), getPersona()))
            : shouldInjectFullDoc
                ? buildEscalatedPrompt(userRawText, fileAccessState.result)
                : shouldInjectWebContent
                    ? buildWebEscalatedPrompt(userRawText, webAccessState.result)
                    : isOnScreenActive
                        ? onScreenPrefix + userRawText
                        : manualQuery;
        // Always show the user's raw text in chat — never the escalated/prefixed prompt
        const hasPromptModification = shouldInjectFullDoc || shouldInjectWebContent || (isOnScreenActive && onScreenPrefix);
        const finalDisplayQuery = (!actionType && hasPromptModification) ? userRawText : (displayQuery || userRawText);

        // If there's a completed agent session, commit it to chat history before new messages
        if (claudeAgent.state !== 'idle') {
            if (claudeAgent.streamingText) {
                const files = claudeAgent.producedFiles.map(f => ({ path: f.path, name: f.name, format: f.format, size: f.size }));
                chat.setMessages(prev => [...prev, {
                    role: 'assistant' as const,
                    content: claudeAgent.streamingText,
                    ...(files.length > 0 ? { agentFiles: files } : {}),
                }]);
            }
            claudeAgent.reset();
        }

        setLastActionType(actionType || null);
        chat.handleSubmit(e, finalPrompt, isVoice, finalDisplayQuery, queryRef.current || query, inputRef, setQuery, setTextareaHeight);
    };

    const clear = () => {
        clearInput();
        if (inputRef.current) { inputRef.current.style.height = 'auto'; inputRef.current.style.height = '38px'; inputRef.current.style.overflowY = 'hidden'; setTextareaHeight(38); }
        chat.setMessages([]);
        setCurrentChatId(null);
        screenshot.setLastScreenshot64(null);
        setInsightDismissed(false);
        setInsightStopped(false); // Full reset — next toggle will do fresh scan
        setContextInsight(null);
        sessionCtx.clear();
        claudeAgent.clearHistory(); // Full reset including file history
        window.speechSynthesis.cancel();
        window.electron.hideWindow();
    };

    const handleScroll = () => {
        if (chat.scrollRef.current) {
            const { scrollTop, scrollHeight, clientHeight } = chat.scrollRef.current;
            chat.isAtBottomRef.current = scrollHeight - scrollTop - clientHeight < 50;
        }
    };

    // ── Render ────────────────────────────────────────────────────────────────
    return (
        <div
            className={cn('flex items-center justify-center h-screen w-screen p-0 animate-in', windowCtx.isResizing && 'resizing', attachments.isDragOver && 'drag-over-active')}
            // `overflow: clip` — NOT `overflow: hidden`. Hidden still creates
            // a scroll container that accepts scrollLeft/scrollTop from
            // scrollIntoView (e.g. when a caret in a long textarea goes
            // past the viewport edge). That was pushing the whole app
            // sideways, stranding the chat UI off-screen after a long
            // canvas edit and never restoring on mode switch. `clip`
            // doesn't create a scroll container, so there's nothing to
            // scroll — chrome stays put regardless of caret position.
            style={{ overflow: 'clip' }}
            onDragEnter={attachments.handleDragEnter}
            onDragLeave={attachments.handleDragLeave}
            onDragOver={attachments.handleDragOver}
            onDrop={attachments.handleDrop}
        >
            <div className="glass isolate w-full h-full rounded-2xl flex flex-col drag relative pb-10" style={{ overflow: 'clip' }}>

                {/* Canvas overlay — always mounted so multi-canvas tab state (items,
                    undo stack, open tabs) survives Chat↔Canvas switches. KlypixCanvas
                    toggles its own visibility via appVisible and propagates that to
                    each inner CanvasSurface's tabActive so global side effects
                    (autosave restore dialog, focus claim) only fire when canvas is
                    actually shown. */}
                <KlypixCanvas appVisible={activeTab === 'canvas'} />

                {/* Sandbox approval — floats above both chat and canvas so the
                    Allow/Deny card is reachable from either view. Renders null
                    when idle. Must live outside the claudeAgent-gated subtree
                    because the canvas agent uses the same sandbox IPC but has
                    no claudeAgent state. */}
                <div className="absolute top-14 left-1/2 -translate-x-1/2 z-[999] w-[92%] max-w-[560px] pointer-events-auto no-drag">
                    <SandboxApprovalDialog />
                </div>

                {/* Drag & Drop Overlay */}
                {attachments.isDragOver && (
                    <div className="absolute inset-0 z-[9999] bg-black/60 backdrop-blur-sm flex items-center justify-center rounded-2xl border-2 border-dashed border-emerald-400/60 animate-in fade-in duration-150">
                        <div className="flex flex-col items-center gap-3">
                            <div className="w-16 h-16 rounded-2xl bg-emerald-500/20 flex items-center justify-center"><Paperclip size={28} className="text-emerald-400" /></div>
                            <span className="text-white/90 text-lg font-medium">Drop files here</span>
                            <span className="text-white/40 text-sm">PDF, DOCX, XLSX, TXT, Images & more (max 5 files, 10MB each)</span>
                        </div>
                    </div>
                )}

                {/* Decorative glows */}
                <div className="absolute -top-24 -left-24 w-64 h-64 bg-emerald-500/10 blur-[100px] pointer-events-none z-0" />
                <div className="absolute -bottom-24 -right-24 w-64 h-64 bg-emerald-500/10 blur-[100px] pointer-events-none z-0" />

                {/* Image Preview Modal */}
                {screenshot.previewImage && (
                    <div className="absolute inset-0 z-50 bg-[#1c1c1c]/95 backdrop-blur-3xl flex flex-col no-drag animate-in fade-in zoom-in-95 duration-200">
                        <div className="pt-9 px-4 pb-2 flex items-center justify-between">
                            <div className="flex items-center gap-2">
                                <button onClick={() => { if (screenshot.maximizedByPreview && windowCtx.isMaximized) windowCtx.handleMaximize(); screenshot.setPreviewImage(null); screenshot.setMaximizedByPreview(false); }} className="flex items-center gap-1.5 p-2 pr-3 hover:bg-white/10 rounded-lg transition-all text-white/50 hover:text-white cursor-pointer">
                                    <ChevronLeft size={18} /><span className="text-[10px] font-bold uppercase tracking-widest">Back</span>
                                </button>
                            </div>
                            <div className="flex items-center gap-4">
                                <button onClick={async () => { try { const res = await fetch(`data:image/jpeg;base64,${screenshot.previewImage}`); const blob = await res.blob(); const url = URL.createObjectURL(blob); const a = document.createElement('a'); a.href = url; a.download = `capture_${Date.now()}.jpg`; a.click(); URL.revokeObjectURL(url); } catch (e) { console.error(e); } }} className="text-white/50 hover:bg-white/10 hover:text-white p-2 rounded-lg transition-all flex items-center gap-2 cursor-pointer" title="Download image">
                                    <Download size={14} /><span className="text-[10px] hidden sm:block uppercase tracking-wider font-bold">Save</span>
                                </button>
                                <button onClick={() => { if (!windowCtx.isMaximized) screenshot.setMaximizedByPreview(true); else screenshot.setMaximizedByPreview(false); windowCtx.handleMaximize(); }} className="text-white/50 hover:bg-white/10 hover:text-white p-2 rounded-lg transition-all flex items-center gap-2 mr-1 cursor-pointer" title="Maximize Window">
                                    <Maximize size={14} /><span className="text-[10px] hidden sm:block uppercase tracking-wider font-bold">Full Screen</span>
                                </button>
                                <button onClick={() => (window as any).electron.minimizeWindow()} className="p-1.5 hover:bg-white/10 rounded-lg transition-all text-white/50 hover:text-white cursor-pointer"><Minus size={14} /></button>
                            </div>
                        </div>
                        <div className="px-4 pb-3 border-b border-white/5">
                            <span className="text-xs font-bold uppercase tracking-widest text-white/80">Screen Capture</span>
                        </div>
                        <div className="flex-1 p-4 flex items-center justify-center overflow-auto">
                            <img src={`data:image/jpeg;base64,${screenshot.previewImage}`} className="max-w-full max-h-full rounded-xl shadow-[0_10px_40px_rgba(0,0,0,0.5)] border border-white/5 object-contain" alt="Captured Screen" />
                        </div>
                    </div>
                )}

                {/* Pinned History Overlay */}
                {pinnedChats.showHistory && (
                    <div className="absolute inset-0 z-40 bg-[#242323]/95 backdrop-blur-2xl flex flex-col no-drag animate-in slide-in-from-right duration-300">
                        <div className="pt-9 px-4 pb-2 flex items-center justify-between">
                            <div className="flex items-center gap-2">
                                <button onClick={() => pinnedChats.setShowHistory(false)} className="p-1 hover:bg-white/10 rounded-lg transition-all text-white/60"><ChevronLeft size={18} /></button>
                            </div>
                            <div className="flex items-center gap-4 no-drag shrink-0">
                                <button onClick={() => (window as any).electron.minimizeWindow()} className="p-1.5 hover:bg-white/10 rounded-lg transition-all text-white/20 hover:text-white cursor-pointer"><Minus size={16} /></button>
                                <button onClick={() => pinnedChats.setShowHistory(false)} className="p-1.5 hover:bg-white/10 rounded-lg transition-all text-white/20 hover:text-white cursor-pointer"><X size={16} /></button>
                            </div>
                        </div>
                        <div className="px-4 pb-3 border-b border-white/5">
                            <span className="text-xs font-bold uppercase tracking-widest text-white/80">Pinned Conversations</span>
                        </div>
                        <div className="flex-1 overflow-y-auto p-4 space-y-2 relative scroll-smooth">
                            {pinnedChats.pinnedChats.length === 0 ? (
                                <div className="absolute inset-0 flex flex-col items-center justify-center text-white/30 gap-3"><Archive size={32} /><span className="text-xs uppercase tracking-widest font-bold">No pinned chats</span></div>
                            ) : (
                                pinnedChats.pinnedChats.map(c => (
                                    <div key={c.id} onClick={() => pinnedChats.handleLoadPinnedChat(c)} className={cn('w-full text-left p-3 rounded-xl border border-white/5 bg-white/5 hover:bg-white/10 transition-all cursor-pointer group flex items-start justify-between gap-4', currentChatId === c.id ? 'ring-1 ring-emerald-500/50 bg-emerald-500/10' : '')}>
                                        <div className="flex flex-col gap-1 min-w-0 flex-1">
                                            <span className="text-xs text-white/90 font-medium truncate">{c.previewText}</span>
                                            <span className="text-[9px] text-white/40">{new Date(c.timestamp).toLocaleString()} • {c.messages.length} messages</span>
                                        </div>
                                        <button onClick={(e) => pinnedChats.handleDeletePinnedChat(e, c.id)} className="p-1.5 text-red-400/50 hover:text-red-400 hover:bg-red-400/10 rounded-lg opacity-0 group-hover:opacity-100 transition-all shrink-0"><Trash2 size={14} /></button>
                                    </div>
                                ))
                            )}
                        </div>
                    </div>
                )}

                {/* Settings Overlay */}
                {settings.showSettings && (
                    <div className="absolute inset-0 z-50 bg-[#242323]/90 backdrop-blur-2xl flex flex-col no-drag animate-in fade-in zoom-in-95 duration-200">
                        <div className="pt-9 px-4 pb-2 flex items-center justify-between">
                            <div className="flex items-center gap-2">
                                <button onClick={() => settings.setShowSettings(false)} className="p-1 hover:bg-white/10 rounded-lg transition-all text-white/60"><ChevronLeft size={18} /></button>
                            </div>
                            <div className="flex items-center gap-4 no-drag shrink-0">
                                <button onClick={() => (window as any).electron.minimizeWindow()} className="p-1.5 hover:bg-white/10 rounded-lg transition-all text-white/20 hover:text-white cursor-pointer"><Minus size={16} /></button>
                                <button onClick={() => settings.setShowSettings(false)} className="p-1.5 hover:bg-white/10 rounded-lg transition-all text-white/20 hover:text-white cursor-pointer"><X size={16} /></button>
                            </div>
                        </div>
                        <div className="px-4 pb-3 border-b border-white/5">
                            <span className="text-xs font-bold uppercase tracking-widest text-white/80">Settings & Accessibility</span>
                        </div>
                        <div className="flex-1 overflow-y-auto p-6 space-y-8">
                            {/* Account Section */}
                            <div className="space-y-3">
                                <div className="flex items-center gap-2 text-white/40"><User size={14} /><span className="text-[10px] uppercase font-bold tracking-tighter">Account</span></div>
                                <div className="bg-white/5 border border-white/10 rounded-xl p-4">
                                    <div className="flex items-center gap-3">
                                        <div className="w-10 h-10 rounded-full bg-emerald-500/20 border border-emerald-500/30 flex items-center justify-center text-emerald-400 font-bold text-sm">
                                            {auth.user?.displayName?.[0]?.toUpperCase() || auth.user?.email?.[0]?.toUpperCase() || '?'}
                                        </div>
                                        <div className="flex-1 min-w-0">
                                            <div className="text-sm font-medium text-white truncate">{auth.user?.displayName || 'User'}</div>
                                            <div className="text-xs text-white/40 truncate">{auth.user?.email}</div>
                                        </div>
                                        <span className={cn('px-2 py-0.5 rounded-full text-[9px] font-bold uppercase tracking-wider', auth.user?.tier === 'admin' ? 'bg-amber-500/20 text-amber-400' : auth.user?.tier === 'pro' ? 'bg-emerald-500/20 text-emerald-400' : 'bg-white/10 text-white/50')}>{auth.user?.tier || 'free'}</span>
                                    </div>
                                    <div className="mt-3 pt-3 border-t border-white/5 flex items-center justify-between">
                                        <span className="text-[10px] text-white/30">Queries: {auth.user?.queriesToday || 0} today / {auth.user?.queriesTotal || 0} total</span>
                                        <button onClick={() => { auth.signOut(); settings.setShowSettings(false); }} className="text-[10px] text-red-400/70 hover:text-red-400 transition-colors cursor-pointer">Sign Out</button>
                                    </div>
                                </div>
                            </div>

                            <div className="space-y-3">
                                <div className="flex items-center gap-2 text-white/40"><Keyboard size={14} /><div className="flex flex-col"><span className="text-[10px] uppercase font-bold tracking-tighter">Global Shortcut</span><span className="text-[8px] text-white/30 uppercase tracking-widest font-medium">Use at least 2 keys (Modifier + Key)</span></div></div>
                                <div className="bg-white/5 border border-white/10 p-3 rounded-xl flex items-center justify-between">
                                    <span className="text-xs text-white/60">Activate Assistant</span>
                                    <button onClick={() => settings.setIsRecording(!settings.isRecording)} className={cn('flex gap-1 px-2 py-1.5 rounded-lg border transition-all', settings.isRecording ? 'bg-emerald-500/20 border-emerald-500/50 text-emerald-400 ring-2 ring-emerald-500/20' : 'bg-white/5 border-white/10 text-white/80 hover:bg-white/10 hover:border-white/20')}>
                                        {settings.isRecording ? <span className="text-[10px] font-bold animate-pulse uppercase tracking-widest">Press Keys Now...</span> : settings.currentShortcut.split('+').map((part, i) => <React.Fragment key={i}><kbd className="px-1.5 py-0.5 bg-white/10 border border-white/20 rounded text-[10px] font-mono shadow-sm">{part}</kbd>{i < settings.currentShortcut.split('+').length - 1 && <span className="text-white/20">+</span>}</React.Fragment>)}
                                    </button>
                                </div>
                            </div>
                            <div className="space-y-4">
                                <div className="flex items-center gap-2 text-white/40"><Volume2 size={14} /><span className="text-[10px] uppercase font-bold tracking-tighter">Accessibility & Voice</span></div>
                                <div className="grid grid-cols-2 gap-3">
                                    <button onClick={() => settings.setIsVoiceDictationEnabled(!settings.isVoiceDictationEnabled)} className={cn('p-4 rounded-2xl border transition-all flex flex-col items-start gap-3', settings.isVoiceDictationEnabled ? 'bg-white/10 border-white/20' : 'bg-white/5 border-white/5 grayscale')}>
                                        {settings.isVoiceDictationEnabled ? <Mic size={20} className="text-white" /> : <MicOff size={20} className="text-white/40" />}
                                        <div className="text-left"><div className="text-[11px] font-bold text-white mb-0.5">Voice Dictation</div><div className="text-[9px] text-white/40 leading-tight">Speak instead of typing</div></div>
                                    </button>
                                    <button onClick={() => settings.setIsTTSEnabled(!settings.isTTSEnabled)} className={cn('p-4 rounded-2xl border transition-all flex flex-col items-start gap-3', settings.isTTSEnabled ? 'bg-white/10 border-white/20' : 'bg-white/5 border-white/5 grayscale')}>
                                        {settings.isTTSEnabled ? <Volume2 size={20} className="text-white" /> : <VolumeX size={20} className="text-white/40" />}
                                        <div className="text-left"><div className="text-[11px] font-bold text-white mb-0.5">Speak Responses</div><div className="text-[9px] text-white/40 leading-tight">AI reads answers aloud</div></div>
                                    </button>
                                </div>
                            </div>
                            <div className="space-y-4 pb-4">
                                <div className="flex items-center gap-2 text-white/40"><Shield size={14} /><span className="text-[10px] uppercase font-bold tracking-tighter">Privacy & Memory</span></div>
                                <div className="grid grid-cols-2 gap-3">
                                    <button onClick={() => settings.setIsPrivacyMode(!settings.isPrivacyMode)} className={cn('p-4 rounded-2xl border transition-all flex flex-col items-start gap-3', settings.isPrivacyMode ? 'bg-emerald-500/10 border-emerald-500/20' : 'bg-white/5 border-white/5')}>
                                        {settings.isPrivacyMode ? <Shield size={20} className="text-emerald-400" /> : <ShieldOff size={20} className="text-white/40" />}
                                        <div className="text-left"><div className="text-[11px] font-bold text-white mb-0.5">Privacy Mode</div><div className="text-[9px] text-white/40 leading-tight">{settings.isPrivacyMode ? 'Masking window titles' : 'High context mode'}</div></div>
                                    </button>
                                    <button onClick={() => { import('./api/memoryStore').then(m => { const data = m.exportMemoryData(); const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }); const url = URL.createObjectURL(blob); const a = document.createElement('a'); a.href = url; a.download = `alt-space-memory-${new Date().toISOString().split('T')[0]}.json`; document.body.appendChild(a); a.click(); document.body.removeChild(a); URL.revokeObjectURL(url); }); }} className="p-4 rounded-2xl border border-white/5 bg-white/5 hover:bg-white/10 transition-all flex flex-col items-start gap-3 group">
                                        <Download size={20} className="text-white/40 group-hover:text-white transition-colors" />
                                        <div className="text-left"><div className="text-[11px] font-bold text-white mb-0.5">Download Memory</div><div className="text-[9px] text-white/40 leading-tight">Export profile & history</div></div>
                                    </button>
                                    <button onClick={() => { if (confirm('Are you sure you want to clear your local AI memory? This will reset your Living Persona.')) { import('./api/memoryStore').then(m => m.clearMemory()); alert('Memory cleared.'); window.location.reload(); } }} className="p-4 rounded-2xl border border-white/5 bg-white/5 hover:bg-red-500/10 hover:border-red-500/20 transition-all flex flex-col items-start gap-3 group">
                                        <Eraser size={20} className="text-white/40 group-hover:text-red-400 transition-colors" />
                                        <div className="text-left"><div className="text-[11px] font-bold text-white mb-0.5">Clear Memory</div><div className="text-[9px] text-white/40 leading-tight">Reset history & persona</div></div>
                                    </button>
                                </div>
                            </div>
                            <div className="space-y-4 pb-4">
                                <div className="flex items-center gap-2 text-white/40"><FileText size={14} /><span className="text-[10px] uppercase font-bold tracking-tighter">Document Reading</span></div>
                                <div className="grid grid-cols-2 gap-3">
                                    <button onClick={() => settings.setPdfOcrMode('gemini')} className={cn('p-4 rounded-2xl border transition-all flex flex-col items-start gap-3', settings.pdfOcrMode === 'gemini' ? 'bg-emerald-500/10 border-emerald-500/20' : 'bg-white/5 border-white/5')}>
                                        <Globe size={20} className={settings.pdfOcrMode === 'gemini' ? 'text-emerald-400' : 'text-white/40'} />
                                        <div className="text-left"><div className="text-[11px] font-bold text-white mb-0.5">Gemini Vision</div><div className="text-[9px] text-white/40 leading-tight">Cloud AI reads scanned PDFs. Fast & accurate. Uses API tokens.</div></div>
                                    </button>
                                    <button onClick={() => settings.setPdfOcrMode('local')} className={cn('p-4 rounded-2xl border transition-all flex flex-col items-start gap-3', settings.pdfOcrMode === 'local' ? 'bg-emerald-500/10 border-emerald-500/20' : 'bg-white/5 border-white/5')}>
                                        <Lock size={20} className={settings.pdfOcrMode === 'local' ? 'text-emerald-400' : 'text-white/40'} />
                                        <div className="text-left"><div className="text-[11px] font-bold text-white mb-0.5">Local OCR</div><div className="text-[9px] text-white/40 leading-tight">Tesseract reads locally. Slower but free, fully private.</div></div>
                                    </button>
                                </div>
                                <div className="space-y-4 pb-4">
                                    <div className="flex items-center gap-2 text-white/40"><Zap size={14} /><span className="text-[10px] uppercase font-bold tracking-tighter">Power Button</span></div>
                                    <div className="space-y-3">
                                        <input type="text" maxLength={20} value={settings.powerButtonLabel} onChange={e => settings.setPowerButtonLabel(e.target.value)} placeholder="Label — e.g. Translate" className="w-full px-4 py-2.5 rounded-xl bg-white/5 border border-white/10 text-white text-[11px] placeholder:text-white/25 focus:outline-none focus:border-emerald-500/30 transition-colors" />
                                        <textarea rows={2} value={settings.powerButtonPrompt} onChange={e => settings.setPowerButtonPrompt(e.target.value)} placeholder="Prompt — e.g. Translate the above to Arabic" className="w-full px-4 py-2.5 rounded-xl bg-white/5 border border-white/10 text-white text-[11px] placeholder:text-white/25 focus:outline-none focus:border-emerald-500/30 transition-colors resize-none" />
                                        <div className="text-[9px] text-white/25">Shows a ⚡ quick-action button after every AI response.</div>
                                    </div>
                                </div>

                                {/* Agent Engine Settings */}
                                <div className="space-y-4 pb-4">
                                    <div className="flex items-center gap-2 text-white/40"><Zap size={14} /><span className="text-[10px] uppercase font-bold tracking-tighter">Agent Engine</span></div>
                                    <AgentSettings />
                                </div>
                            </div>
                        </div>
                        <div className="p-4 border-t border-white/5 flex justify-center">
                            <button onClick={() => settings.setShowSettings(false)} className="bg-white/10 hover:bg-white/20 text-white text-[10px] font-bold uppercase tracking-widest px-8 py-2.5 rounded-xl transition-all">Back to Chat</button>
                        </div>
                    </div>
                )}

                {/* Title Bar */}
                <div
                    ref={titleBarRef}
                    className="title-bar"
                    onPointerDown={(e) => {
                        // Only the title-bar BACKGROUND drags the window. Any
                        // interactive child (mode tabs, window controls, CDP
                        // pill) opts out via .no-drag so its click still works.
                        if (e.button !== 0) return;
                        const target = e.target as HTMLElement;
                        if (target.closest('.no-drag')) return;
                        window.electron.windowDragStart();
                        const end = () => {
                            window.electron.windowDragEnd();
                            window.removeEventListener('pointerup', end);
                            window.removeEventListener('pointercancel', end);
                        };
                        window.addEventListener('pointerup', end);
                        window.addEventListener('pointercancel', end);
                    }}
                    onDoubleClick={(e) => {
                        const target = e.target as HTMLElement;
                        if (target.closest('.no-drag')) return;
                        handleTitleBarMaximize();
                    }}
                >
                    <div className="flex items-center gap-2">
                        <div className="flex items-center gap-2 opacity-60"><img src={logoUrl} className="w-4 h-4" alt="logo" /><span className="text-[11px] font-bold tracking-wider text-white font-poppins uppercase">Klypix</span></div>
                        {/* CDP caution icon — collapsed banner, click to expand */}
                        {showCdpBanner && !cdpBannerDismissed && cdpBannerCollapsed && (
                            <button
                                onClick={() => setCdpBannerCollapsed(false)}
                                className="no-drag px-1.5 py-0.5 rounded-lg bg-amber-500/15 hover:bg-amber-500/25 border border-amber-500/20 transition-all cursor-pointer group flex items-center gap-1.5"
                                title="Browser integration needed — click to set up"
                            >
                                <AlertTriangle size={12} className="text-amber-400" style={{ animation: 'cdpPulse 2s ease-in-out infinite' }} />
                                <span className="text-[9px] text-amber-400/80 font-medium">CDP</span>
                            </button>
                        )}
                    </div>
                    {/* Chat / Canvas mode tabs — centered in title bar */}
                    <ModeTabs active={activeTab} onChange={setActiveTab} />
                    <div className="flex items-center gap-2">
                        <div className="window-controls">
                            <button onClick={windowCtx.handleMinimize} className="p-1 hover:bg-white/10 rounded transition-all text-white/40 hover:text-white" title="Minimize to Tray"><Minus size={14} /></button>
                            <button onClick={handleTitleBarMaximize} className="p-1 hover:bg-white/10 rounded transition-all text-white/40 hover:text-white" title={titleBarMaximizeIsOn ? 'Restore' : (activeTab === 'canvas' ? 'Fullscreen canvas' : 'Maximize')}>{titleBarMaximizeIsOn ? <Copy size={12} /> : <Square size={12} />}</button>
                            <button onClick={clear} className="p-1 hover:bg-red-500/20 rounded transition-all text-white/40 hover:text-red-400" title="Dismiss"><X size={14} /></button>
                        </div>
                    </div>
                </div>

                {/* Header / Input */}
                <div ref={headerRef} className="p-4 flex items-center gap-3 border-b border-white/5 relative">
                    <KlypixMascot
                        onScreenEnabled={onScreenEnabled}
                        agentMode={agentMode}
                        onToggleOnScreen={() => {
                            setOnScreenEnabled((prev: boolean) => {
                                if (!prev) {
                                    setContextInsight(null);
                                    setInsightDismissed(false);
                                    setFileAccessState({ loading: false, result: null });
                                } else {
                                    setInsightDismissed(true);
                                    setContextInsight(null);
                                }
                                return !prev;
                            });
                        }}
                        onToggleAgent={() => setAgentMode(!agentMode)}
                    />
                    <div className="relative flex-1 no-drag flex items-center gap-2">
                        <textarea
                            ref={inputRef} rows={1} defaultValue={query}
                            onInput={() => {
                                if (inputRef.current) {
                                    queryRef.current = inputRef.current.value;
                                    setQuery(inputRef.current.value); // Sync state for send button
                                    inputRef.current.style.height = 'auto';
                                    const nh = Math.min(inputRef.current.scrollHeight, 180);
                                    inputRef.current.style.height = `${nh}px`;
                                    inputRef.current.style.overflowY = inputRef.current.scrollHeight > 180 ? 'auto' : 'hidden';
                                    setTextareaHeight(nh);
                                }
                            }}
                            onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(); } }}
                            placeholder={agentMode ? "Tell KLYPIX what to do..." : "Ask about this screen or directly press send"}
                            style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}
                            className={cn('w-full bg-white/5 border rounded-xl py-2 px-4 text-[15px] focus:outline-none focus:ring-2 transition-all placeholder:text-white/40 outline-none resize-none overflow-hidden leading-snug flex items-center min-h-[38px]', agentMode ? 'border-purple-500/30 focus:ring-purple-500/50' : 'border-white/10 focus:ring-emerald-500/50', screenshot.showScreenshot && 'pr-16')}
                        />
                        {screenshot.showScreenshot && (
                            <div className="absolute right-2 top-1/2 -translate-y-1/2 flex items-center gap-1.5 animate-in fade-in zoom-in-95">
                                {screenshot.lastScreenshot64 && (
                                    <div className="group relative">
                                        <img src={`data:image/jpeg;base64,${screenshot.lastScreenshot64}`} className="h-7 w-12 object-cover rounded border border-white/20 hover:border-emerald-500/50 transition-all cursor-zoom-in" alt="Preview" onClick={() => screenshot.setPreviewImage(screenshot.lastScreenshot64)} />
                                        <button onClick={() => screenshot.setLastScreenshot64(null)} className="absolute -top-1.5 -right-1.5 p-0.5 bg-red-500 rounded-full text-white opacity-0 group-hover:opacity-100 transition-all hover:scale-110 cursor-pointer"><X size={8} /></button>
                                    </div>
                                )}
                                <button
                                    onClick={async () => {
                                        let b: string | null = null;
                                        if (screenshot.captureMode === 'partial') {
                                            b = await screenshot.launchSnipping();
                                            if (b) screenshot.addToStack(b, `Snip ${screenshot.screenshotStack.length + 1}`);
                                        } else {
                                            b = await screenshot.captureFullScreen();
                                            if (b) screenshot.addToStack(b, `Screen ${screenshot.screenshotStack.length + 1}`);
                                        }
                                        if (b) { screenshot.setLastScreenshot64(b); suggestions.setLastScreenshotImmediate(b); setTimeout(() => suggestions.fetchSuggestions(true), 50); }
                                    }}
                                    className="h-7 px-1.5 rounded border border-indigo-500/30 bg-indigo-500/10 hover:bg-indigo-500/20 text-indigo-400 text-[10px] font-medium transition-all cursor-pointer flex items-center gap-0.5"
                                    title="Capture another screenshot"
                                >
                                    <span>+</span>
                                </button>
                            </div>
                        )}
                    </div>
                    <div className="flex items-center gap-1.5 no-drag bg-white/5 p-1 rounded-xl border border-white/10">
                        <button onClick={() => { screenshot.setShowScreenshot(false); deepMode.setIsDeepFileMode(false); screenshot.clearStack(); suggestions.stopSuggestions(); suggestions.setSuggestions([]); suggestions.setLastSuggestionContext(''); setInsightDismissed(true); }} className={cn('p-1.5 rounded-lg transition-all duration-200', !screenshot.showScreenshot && !deepMode.isDeepFileMode ? 'bg-white/15 text-white shadow-sm' : 'text-white/40 hover:bg-white/10')} title="Home"><Home size={16} /></button>
                        <button onClick={async () => { setInsightDismissed(true); screenshot.setShowScreenshot(true); screenshot.setCaptureMode('full'); deepMode.setIsDeepFileMode(false); screenshot.clearStack(); suggestions.setSuggestions([]); suggestions.setLastSuggestionContext(''); deepMode.setFailedAccessNames([]); try { const b = await screenshot.captureFullScreen(); if (b) { screenshot.addToStack(b, `Screen 1`); screenshot.setLastScreenshot64(b); suggestions.setLastScreenshotImmediate(b); setTimeout(() => suggestions.fetchSuggestions(true), 50); } } catch (e) { console.error(e); } }} className={cn('p-1.5 rounded-lg transition-all duration-200', screenshot.showScreenshot && screenshot.captureMode === 'full' && !deepMode.isDeepFileMode ? 'bg-white/20 text-white shadow-sm' : 'text-white/40 hover:bg-white/10')} title="Capture Screen"><Maximize size={16} /></button>
                        <button onClick={async () => { setInsightDismissed(true); screenshot.setShowScreenshot(true); screenshot.setCaptureMode('partial'); deepMode.setIsDeepFileMode(false); screenshot.clearStack(); suggestions.setSuggestions([]); suggestions.setLastSuggestionContext(''); try { const b = await screenshot.launchSnipping(); if (b) { screenshot.setLastScreenshot64(b); screenshot.addToStack(b, `Snip 1`); suggestions.setLastScreenshotImmediate(b); setTimeout(() => suggestions.fetchSuggestions(true), 50); } } catch (e) { console.error(e); } }} className={cn('p-1.5 rounded-lg transition-all duration-200', screenshot.showScreenshot && screenshot.captureMode === 'partial' && !deepMode.isDeepFileMode ? 'bg-white/20 text-white shadow-sm' : 'text-white/40 hover:bg-white/10')} title="Snip Region"><Scissors size={16} /></button>
                        <button onClick={() => { setInsightDismissed(true); deepMode.activateDeepMode(); screenshot.setShowScreenshot(false); screenshot.clearStack(); suggestions.setSuggestions([]); suggestions.setLastSuggestionContext(''); setContextInsight(null); if (deepMode.selectedFiles.length > 0 && deepMode.allSelectedLoaded) { setTimeout(() => suggestions.fetchSuggestions(true), 100); } }} className={cn('p-1.5 rounded-lg transition-all duration-200', deepMode.isDeepFileMode ? 'bg-emerald-500/20 text-emerald-400 shadow-sm' : 'text-white/40 hover:bg-white/10')} title="Scan Files"><FileSearch size={16} /></button>
                    </div>
                    <div className="flex items-center gap-1 no-drag">
                        <button onClick={attachments.handleAttachClick} className={cn('p-1.5 rounded-lg transition-all', attachments.attachedFiles.length > 0 ? 'bg-emerald-500/20 text-emerald-400' : 'text-white/40 hover:bg-white/10 hover:text-white/70')} title={`Attach files (${attachments.attachedFiles.length}/${MAX_ATTACHED})`}><Paperclip size={16} /></button>
                        {settings.isVoiceDictationEnabled && (
                            <button
                                onClick={async () => {
                                    if (voiceRecognitionRef.current) {
                                        // Stop recording — send audio to Gemini for transcription
                                        const recorder = voiceRecognitionRef.current as MediaRecorder;
                                        recorder.stop();
                                        return;
                                    }

                                    try {
                                        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });

                                        // Audio level analyzer for visual feedback
                                        const ctx = new AudioContext();
                                        const source = ctx.createMediaStreamSource(stream);
                                        const analyser = ctx.createAnalyser();
                                        analyser.fftSize = 256;
                                        analyser.smoothingTimeConstant = 0.7;
                                        source.connect(analyser);
                                        const dataArray = new Uint8Array(analyser.frequencyBinCount);
                                        const updateLevel = () => {
                                            analyser.getByteFrequencyData(dataArray);
                                            const avg = dataArray.reduce((a, b) => a + b, 0) / dataArray.length;
                                            setVoiceLevel(Math.min(avg / 128, 1));
                                            if (voiceAnalyzerRef.current) {
                                                voiceAnalyzerRef.current.animFrame = requestAnimationFrame(updateLevel);
                                            }
                                        };
                                        const animFrame = requestAnimationFrame(updateLevel);
                                        voiceAnalyzerRef.current = { stream, ctx, animFrame };

                                        // MediaRecorder to capture audio
                                        const recorder = new MediaRecorder(stream, { mimeType: 'audio/webm;codecs=opus' });
                                        const chunks: Blob[] = [];
                                        recorder.ondataavailable = (e) => { if (e.data.size > 0) chunks.push(e.data); };
                                        recorder.onstop = async () => {
                                            setIsVoiceRecording(false);
                                            setVoiceLevel(0);
                                            voiceRecognitionRef.current = null;
                                            // Cleanup audio
                                            if (voiceAnalyzerRef.current) {
                                                cancelAnimationFrame(voiceAnalyzerRef.current.animFrame);
                                                voiceAnalyzerRef.current.stream.getTracks().forEach(t => t.stop());
                                                voiceAnalyzerRef.current.ctx.close();
                                                voiceAnalyzerRef.current = null;
                                            }

                                            if (chunks.length === 0) return;
                                            const blob = new Blob(chunks, { type: 'audio/webm' });

                                            // Convert to base64 and send to Gemini for transcription
                                            if (inputRef.current) inputRef.current.value = 'Transcribing...';
                                            const reader = new FileReader();
                                            reader.onloadend = async () => {
                                                const base64Audio = (reader.result as string).split(',')[1];
                                                try {
                                                    const { callGeminiFlash } = await import('./api/gemini');
                                                    const transcript = await callGeminiFlash(
                                                        'Transcribe the following audio. Return ONLY the transcribed text, nothing else. If the audio is in Arabic, transcribe in Arabic. If in English, transcribe in English. If mixed, transcribe each part in its language.',
                                                        `[Audio data provided as base64 inline. The user spoke into their microphone. Please transcribe what they said.]`,
                                                        { maxOutputTokens: 500, temperature: 0.1 }
                                                    );
                                                    // Gemini text-only can't process audio directly — fall back to submitting as voice
                                                    // For now, use the audio blob with Gemini's multimodal
                                                    const { GoogleGenerativeAI } = await import('@google/generative-ai');
                                                    const { getApiKeySync } = await import('./api/gemini');
                                                    const genAI = new GoogleGenerativeAI(getApiKeySync());
                                                    const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' }, { apiVersion: 'v1beta' });
                                                    const result = await model.generateContent([
                                                        'Transcribe this audio exactly. Return ONLY the spoken words, nothing else. Support Arabic and English.',
                                                        { inlineData: { data: base64Audio, mimeType: 'audio/webm' } },
                                                    ]);
                                                    const text = result.response.text().trim();
                                                    if (text && inputRef.current) {
                                                        inputRef.current.value = text;
                                                        setQuery(text);
                                                        // Auto-submit the transcription
                                                        submit(undefined, text, true);
                                                    } else if (inputRef.current) {
                                                        inputRef.current.value = '';
                                                    }
                                                } catch (err) {
                                                    console.error('Transcription failed:', err);
                                                    if (inputRef.current) inputRef.current.value = '';
                                                }
                                            };
                                            reader.readAsDataURL(blob);
                                        };

                                        recorder.start();
                                        voiceRecognitionRef.current = recorder;
                                        setIsVoiceRecording(true);
                                    } catch (err) {
                                        console.error('Microphone access denied:', err);
                                        alert('Microphone access denied. Please allow microphone access in system settings.');
                                    }
                                }}
                                className={cn('relative rounded-xl transition-all ml-1 cursor-pointer overflow-hidden', isVoiceRecording ? 'bg-red-500/20 ring-2 ring-red-500/40 animate-pulse' : 'bg-white/5 text-white/40 hover:bg-white/10')}
                                style={{ width: 36, height: 36 }}
                                title={isVoiceRecording ? 'Stop & transcribe' : 'Voice input (Arabic/English)'}
                            >
                                {isVoiceRecording ? (
                                    <div className="absolute inset-0 flex items-center justify-center">
                                        <div className="flex items-center gap-[2px] h-full py-2">
                                            {[0.6, 1, 0.7, 0.9, 0.5].map((scale, i) => (
                                                <div
                                                    key={i}
                                                    className="w-[3px] rounded-full bg-red-400 transition-all duration-75"
                                                    style={{
                                                        height: `${Math.max(15, voiceLevel * scale * 100)}%`,
                                                        opacity: 0.5 + voiceLevel * 0.5,
                                                    }}
                                                />
                                            ))}
                                        </div>
                                    </div>
                                ) : (
                                    <div className="absolute inset-0 flex items-center justify-center">
                                        <Mic size={18} />
                                    </div>
                                )}
                            </button>
                        )}
                        {chat.isTyping || chat.isAnalyzing ? (
                            <button onClick={chat.stopGeneration} className="p-2 bg-white/10 hover:bg-white/20 text-white rounded-xl transition-all no-drag ml-1" title="Stop Generation"><StopIcon size={18} className="fill-current" /></button>
                        ) : (
                            <button onClick={() => submit()} disabled={chat.isAnalyzing || (!query.trim() && !screenshot.showScreenshot && !deepMode.isDeepFileMode && attachments.attachedFiles.length === 0)} className="p-2 bg-white/10 hover:bg-white/20 disabled:opacity-30 text-white rounded-xl transition-all no-drag ml-1">
                                <svg width="18" height="18" viewBox="0 0 24 24" fill="none"><path d="M3.4 22L21.6 12L3.4 2L3.39 9.77L16.4 12L3.39 14.23L3.4 22Z" fill="currentColor" /></svg>
                            </button>
                        )}
                    </div>
                </div>

                {/* Attached Files Pills */}
                {attachments.attachedFiles.length > 0 && (
                    <div className="px-4 py-2 flex items-center gap-2 flex-wrap border-b border-white/[0.04] no-drag animate-in fade-in slide-in-from-top-1 duration-200">
                        <span className="text-[10px] text-white/30 uppercase tracking-wider font-medium">Attached:</span>
                        {attachments.attachedFiles.map(f => (
                            <div key={f.path} className="flex items-center gap-1.5 px-2.5 py-1 bg-emerald-500/[0.08] border border-emerald-500/[0.15] rounded-lg group animate-in zoom-in-95 duration-150">
                                {IMAGE_EXTS.includes(f.ext) ? <ImageIcon size={11} className="text-emerald-400/70" /> : <FileText size={11} className="text-emerald-400/70" />}
                                <span className="text-[11px] text-white/70 max-w-[140px] truncate">{f.name}</span>
                                <span className="text-[9px] text-white/30">{(f.size / 1024).toFixed(0)}KB</span>
                                <button onClick={() => attachments.removeAttachedFile(f.path)} className="ml-0.5 p-0.5 rounded hover:bg-red-500/20 text-white/30 hover:text-red-400 transition-all opacity-0 group-hover:opacity-100"><X size={10} /></button>
                            </div>
                        ))}
                        {attachments.attachedFiles.length >= MAX_ATTACHED && <span className="text-[9px] text-amber-400/60">Max {MAX_ATTACHED} files</span>}
                    </div>
                )}

                {/* Search Bar */}
                {chat.isSearchOpen && (
                    <div className="px-4 py-2 border-b border-white/5 bg-emerald-500/5 flex items-center gap-3 animate-in slide-in-from-top-2 duration-200 no-drag">
                        <div className="relative flex-1">
                            <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-white/30" />
                            <input ref={chat.searchInputRef} type="text" value={chat.searchQuery} onChange={(e) => chat.setSearchQuery(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') chat.handleSearchNav('next'); if (e.key === 'Escape') { chat.setIsSearchOpen(false); chat.setSearchQuery(''); } }} placeholder="Search in chat" className="w-full bg-white/5 border border-white/10 rounded-lg py-1.5 pl-9 pr-4 text-xs text-white focus:outline-none focus:ring-1 focus:ring-emerald-500/50 transition-all placeholder:text-white/20" />
                        </div>
                        {chat.searchResultIndices.length > 0 && (
                            <div className="flex items-center gap-2">
                                <span className="text-[10px] font-bold text-emerald-400/80 bg-emerald-500/10 px-2 py-1 rounded-md min-w-[40px] text-center">{chat.currentSearchIndex + 1} / {chat.searchResultIndices.length}</span>
                                <div className="flex items-center gap-1">
                                    <button onClick={() => chat.handleSearchNav('prev')} className="p-1 hover:bg-white/10 rounded-md text-white/50 hover:text-white transition-all"><ChevronUp size={14} /></button>
                                    <button onClick={() => chat.handleSearchNav('next')} className="p-1 hover:bg-white/10 rounded-md text-white/50 hover:text-white transition-all"><ChevronDown size={14} /></button>
                                </div>
                            </div>
                        )}
                        <button onClick={() => { chat.setIsSearchOpen(false); chat.setSearchQuery(''); }} className="p-1 hover:bg-white/10 rounded-md text-white/30 hover:text-white transition-all"><X size={14} /></button>
                    </div>
                )}

                {/* Quick Actions */}
                {!settings.showSettings && !pinnedChats.showHistory && !screenshot.previewImage && (
                    <div ref={quickActionsRef} className="px-4 py-2 flex items-start justify-between gap-2 border-b border-white/[0.04] no-drag bg-white/[0.02] backdrop-blur-sm relative z-[50] overflow-visible">
                        <div className="flex items-center gap-2 flex-wrap relative">
                            {deepMode.isDeepFileMode && (
                                <div className="relative">
                                    <button id="files-toggle-button"
                                        onClick={() => {
                                            const opening = !deepMode.isFilesDropdownOpen;
                                            deepMode.setIsFilesDropdownOpen(opening);
                                            if (opening) { if (window.innerHeight < 300) window.electron.resizeWindow(360); deepMode.refreshDiscoveredItems(); }
                                        }}
                                        className="px-3 py-1.5 text-[12px] font-medium text-blue-300 bg-blue-500/[0.08] border border-blue-400/[0.12] rounded-lg hover:bg-blue-500/[0.15] hover:border-blue-400/25 transition-all duration-200 flex items-center gap-1.5 backdrop-blur-sm"
                                    >
                                        <div className="w-1 h-1 rounded-full bg-blue-400 animate-pulse" />
                                        <span>({deepMode.discoveredFiles.length} Items Found)</span>
                                        {deepMode.selectedFiles.length > 0 && <span className="bg-emerald-500 text-black px-1.5 rounded-full text-[8px] font-bold ml-0.5">{deepMode.selectedFiles.length}</span>}
                                        <ChevronDown size={10} className={`transition-transform duration-200 ${deepMode.isFilesDropdownOpen ? 'rotate-180' : ''}`} />
                                    </button>
                                    {deepMode.isFilesDropdownOpen && createPortal(
                                        <div ref={deepMode.filesDropdownRef} className="fixed w-72 max-h-[200px] overflow-y-auto bg-zinc-900/95 backdrop-blur-xl border border-white/[0.06] rounded-xl shadow-2xl p-2 z-[9999] flex flex-col gap-0.5 animate-in fade-in zoom-in-95 duration-150" style={{ top: (document.getElementById('files-toggle-button')?.getBoundingClientRect()?.bottom ?? 0) + 4, left: document.getElementById('files-toggle-button')?.getBoundingClientRect()?.left ?? 0 }}>
                                            {deepMode.discoveredFiles.length === 0 && !deepMode.isScanningFiles && <div className="text-[10px] text-white/40 p-2 text-center">No background sources found</div>}
                                            <div className="flex flex-col gap-0.5">
                                                {deepMode.discoveredFiles.map(item => (
                                                    <label key={item.id} className="flex items-start gap-2 p-1.5 hover:bg-white/5 rounded cursor-pointer group transition-colors">
                                                        <input type="checkbox" className="mt-0.5 accent-emerald-500 cursor-pointer" checked={deepMode.selectedFiles.includes(item.id)}
                                                            onChange={(e) => {
                                                                deepMode.userSelectionRef.current = true;
                                                                suggestions.setSuggestions([]);
                                                                if (e.target.checked) {
                                                                    deepMode.setSelectedFiles([...deepMode.selectedFiles, item.id]);
                                                                    deepMode.preloadFileContent(item.id);
                                                                } else {
                                                                    deepMode.setSelectedFiles(deepMode.selectedFiles.filter(id => id !== item.id));
                                                                    deepMode.removeFromCache(item.id);
                                                                }
                                                            }}
                                                        />
                                                        <div className="flex flex-col min-w-0 overflow-hidden">
                                                            <div className="flex items-center gap-1.5 overflow-hidden">
                                                                {item.type === 'web' ? <Globe size={11} className="text-blue-400 shrink-0" /> : <FileText size={11} className="text-emerald-400 shrink-0" />}
                                                                <span className="text-[10px] text-white/80 font-medium truncate" title={item.name}>{item.name}</span>
                                                                {(() => {
                                                                    const cached = deepMode.fileContentCache.get(item.id);
                                                                    if (cached?.loading) return <span className="flex items-center gap-1 shrink-0"><Loader2 size={10} className="animate-spin text-emerald-400" /><button onClick={(e) => { e.stopPropagation(); deepMode.cancelPreload(item.id); }} className="w-4 h-4 flex items-center justify-center rounded-full bg-red-500/20 hover:bg-red-500/40 text-red-400 transition-colors cursor-pointer" title="Cancel loading"><X size={9} /></button></span>;
                                                                    if (cached?.content) return <span className="w-1.5 h-1.5 rounded-full shrink-0 bg-emerald-400" title="Content loaded" />;
                                                                    if (cached?.error) return <span className="flex items-center gap-1 shrink-0"><span className="w-1.5 h-1.5 rounded-full bg-red-400" title={cached.error} /><button onClick={(e) => { e.stopPropagation(); deepMode.retryPreload(item.id); }} className="text-[9px] px-1.5 py-0.5 rounded bg-white/10 hover:bg-white/20 text-white/50 hover:text-white/80 transition-colors cursor-pointer" title="Retry loading">↻</button></span>;
                                                                    return <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${item.status === 'linked' ? 'bg-emerald-400' : item.status === 'web-only' ? 'bg-blue-400' : 'bg-white/20'}`} title={item.status === 'linked' ? 'Linked to local file' : item.status === 'web-only' ? 'Web content (URL available)' : 'Detected by title only'} />;
                                                                })()}
                                                            </div>
                                                            <span className="text-[8px] text-white/30 truncate ml-4">{item.source}</span>
                                                        </div>
                                                    </label>
                                                ))}
                                            </div>
                                        </div>,
                                        document.body
                                    )}
                                </div>
                            )}
                            {deepMode.isDeepFileMode && (
                                <button onClick={(e) => { e.preventDefault(); const t = deepMode.selectedFiles.length + attachments.attachedFiles.length; if (!chat.isAnalyzing && t >= 2) { deepMode.setIsFilesDropdownOpen(false); submit(undefined, COMPARE_TEMPLATE, false, 'Compare Documents', 'Compare'); } else if (t < 2) alert('Please select or attach at least 2 files to compare.'); }} disabled={chat.isAnalyzing || (deepMode.selectedFiles.length + attachments.attachedFiles.length) < 2} className={cn('px-3 py-1.5 text-[12px] font-medium rounded-lg transition-all duration-200 active:scale-[0.97]', (deepMode.selectedFiles.length + attachments.attachedFiles.length) >= 2 ? 'text-emerald-300 bg-emerald-500/[0.08] hover:bg-emerald-500/[0.15] cursor-pointer' : 'text-white/20 bg-white/[0.03] opacity-50 cursor-not-allowed')}>Compare</button>
                            )}
                            {[
                                { label: 'Risk', template: RISK_TEMPLATE, display: 'Risk Analysis', actionType: 'Risk' },
                                { label: 'Actions', template: ACTIONS_TEMPLATE, display: 'Action Plan', actionType: 'Actions' },
                                { label: 'Clarify', template: CLARIFY_TEMPLATE, display: 'Clarify Concept', actionType: 'Clarify' },
                                { label: 'Extract', template: EXTRACT_TEMPLATE, display: 'Extract', actionType: 'Extract' },
                                { label: 'Summarize', template: SUMMARIZE_TEMPLATE, display: 'Summarize', actionType: 'Summarize' },
                                { label: 'Trading', template: TRADING_TEMPLATE, display: 'Trading Analysis', actionType: 'Trading' },
                            ].map(({ label, template, display, actionType }) => (
                                <button key={label} onClick={(e) => { e.preventDefault(); if (!chat.isAnalyzing) { const userText = queryRef.current?.trim(); queryRef.current = ''; if (inputRef.current) inputRef.current.value = ''; const prompt = userText ? `${template}\n\n--- TEXT TO PROCESS ---\n${userText}\n--- END TEXT ---` : template; const displayText = userText ? `${display} — "${userText.length > 60 ? userText.substring(0, 60) + '...' : userText}"` : display; submit(undefined, prompt, false, displayText, actionType); } }} disabled={chat.isAnalyzing} className="px-3 py-1.5 text-[12px] font-medium text-white/70 bg-white/[0.03] rounded-lg hover:text-emerald-300 hover:bg-emerald-500/[0.1] hover:shadow-[0_0_12px_rgba(16,185,129,0.06)] transition-all duration-200 disabled:opacity-30 disabled:hover:bg-transparent disabled:hover:text-white/50 disabled:hover:shadow-none active:scale-[0.97]">{label}</button>
                            ))}
                            <div className="relative no-drag">
                                <button onClick={() => setShowRewriteMenu(p => !p)} disabled={chat.isAnalyzing} className={cn('px-3 py-1.5 text-[12px] font-medium rounded-lg transition-all duration-200 disabled:opacity-30 no-drag active:scale-[0.97]', showRewriteMenu ? 'bg-violet-500/[0.12] text-violet-300' : 'text-white/50 bg-white/[0.03] hover:text-violet-300 hover:bg-violet-500/[0.1]')}>Rewrite ▾</button>
                                {showRewriteMenu && (
                                    <div className="absolute bottom-full left-0 mb-2 flex flex-col gap-0.5 bg-zinc-900/90 backdrop-blur-xl border border-white/[0.06] rounded-xl shadow-2xl p-1.5 z-[200] min-w-[130px] no-drag animate-in fade-in zoom-in-95 duration-150">
                                        {[{ label: 'Professional', template: REWRITE_PROFESSIONAL_TEMPLATE, display: 'Rewrite: Professional', actionType: 'Rewrite' }, { label: 'Shorter', template: REWRITE_SHORTER_TEMPLATE, display: 'Rewrite: Shorter', actionType: 'Rewrite' }, { label: 'Clearer', template: REWRITE_CLEARER_TEMPLATE, display: 'Rewrite: Clearer', actionType: 'Rewrite' }].map(opt => (
                                            <button key={opt.label} onClick={() => { setShowRewriteMenu(false); if (!chat.isAnalyzing) { const userText = queryRef.current?.trim(); queryRef.current = ''; if (inputRef.current) inputRef.current.value = ''; const prompt = userText ? `${opt.template}\n\n--- TEXT TO PROCESS ---\n${userText}\n--- END TEXT ---` : opt.template; const displayText = userText ? `${opt.display} — "${userText.length > 60 ? userText.substring(0, 60) + '...' : userText}"` : opt.display; submit(undefined, prompt, false, displayText, opt.actionType); } }} className="no-drag text-left px-3 py-2 text-[12px] font-medium text-white/70 hover:text-violet-300 hover:bg-violet-500/[0.08] rounded-lg transition-all duration-150 cursor-pointer">{opt.label}</button>
                                        ))}
                                    </div>
                                )}
                            </div>
                        </div>
                        <div className="flex flex-col items-end gap-2 shrink-0 no-drag ml-auto">
                            <div className="flex items-center gap-1.5">
                                {chat.messages.length > 0 && (
                                    <>
                                        <button onClick={() => chat.setKeepConversation(!chat.keepConversation)} className={cn('flex items-center gap-1.5 px-2 py-1.5 rounded-lg cursor-pointer whitespace-nowrap transition-all duration-200 active:scale-[0.97]', chat.keepConversation ? 'bg-emerald-500/[0.12] text-emerald-300' : 'text-white/55 hover:text-white/80 hover:bg-white/[0.06]')} title={chat.keepConversation ? 'Keep Chat: ON' : 'Keep Chat: OFF'}>
                                            <MessageSquare size={11} /><span className="text-[10px] uppercase font-bold tracking-wider">Keep Chat</span>
                                        </button>
                                        <button onClick={pinnedChats.handlePinConversation} className={cn('flex items-center gap-1.5 px-2 py-1.5 rounded-lg transition-all duration-200 active:scale-[0.97]', currentChatId ? 'bg-amber-500/[0.12] text-amber-400 hover:bg-red-500/[0.12] hover:text-red-400' : 'bg-white/[0.03] text-amber-500/60 hover:text-amber-400 hover:bg-amber-500/[0.06]')} title={currentChatId ? 'Unpin & Delete' : 'Pin Conversation'}>
                                            <Bookmark size={11} className={currentChatId ? 'fill-amber-400' : ''} /><span className="text-[10px] uppercase font-bold tracking-wider">{currentChatId ? 'Unpin' : 'Pin'}</span>
                                        </button>
                                    </>
                                )}
                                {pinnedChats.pinnedChats.length > 0 && (
                                    <button onClick={() => pinnedChats.setShowHistory(true)} className="flex items-center gap-1.5 px-2 py-1.5 bg-white/[0.03] hover:bg-white/[0.06] rounded-lg text-white/55 hover:text-white/80 transition-all duration-200 active:scale-[0.97]" title="View Pinned History">
                                        <Archive size={11} /><span className="text-[10px] uppercase font-bold tracking-wider">History</span>
                                    </button>
                                )}
                            </div>
                            <div className="flex items-center gap-1.5">
                                {chat.messages.length > 0 && (
                                    <button onClick={() => { chat.setIsSearchOpen(!chat.isSearchOpen); if (!chat.isSearchOpen) setTimeout(() => chat.searchInputRef.current?.focus(), 100); else chat.setSearchQuery(''); }} className={cn('flex items-center justify-center w-7 h-7 rounded-lg cursor-pointer transition-all duration-200 active:scale-[0.93]', chat.isSearchOpen ? 'bg-emerald-500/[0.12] text-emerald-300' : 'text-white/55 hover:text-white/80 hover:bg-white/[0.06]')} title="Search Conversation"><Search size={10} /></button>
                                )}
                                {chat.messages.length > 0 && (() => {
                                    const agentBusy = claudeAgent.state === 'running'
                                        || claudeAgent.state === 'waiting_permission'
                                        || claudeAgent.state === 'waiting_user_answer'
                                        || claudeAgent.state === 'routing';
                                    return (
                                    <button
                                        disabled={agentBusy}
                                        onClick={async () => {
                                            // Safety: don't allow clearing while the agent is in-flight —
                                            // user must Stop first or wait for completion. The disabled attr
                                            // already prevents this, but keep a runtime guard too.
                                            if (agentBusy) return;
                                            // Memory: extract facts from the conversation before wiping it.
                                            // Fire-and-forget; we don't block the clear on the extraction.
                                            try {
                                                const { isMemoryEnabled } = await import('./services/memory');
                                                if (isMemoryEnabled() && chat.messages.length >= 3) {
                                                    const { getMemoryManager } = await import('./services/memory');
                                                    const mgr = getMemoryManager();
                                                    mgr.runSessionEndExtraction(
                                                        chat.messages.map(m => ({ role: m.role, content: String(m.content || '') }))
                                                    ).catch(() => {});
                                                }
                                            } catch {}
                                            chat.setMessages([]); chat.saveMessages([]); setCurrentChatId(null); setInsightDismissed(false); suggestions.setSuggestions([]); suggestions.setLastSuggestionContext(''); suggestions.stopSuggestions(); setContextInsight(null); clearInsightCache(); claudeAgent.reset(); claudeAgent.clearHistory();
                                        }}
                                        className={cn(
                                            'flex items-center gap-1.5 px-2 py-1.5 rounded-lg transition-all duration-200',
                                            agentBusy
                                                ? 'bg-white/[0.02] text-white/20 cursor-not-allowed'
                                                : 'bg-red-500/[0.04] hover:bg-red-500/[0.10] text-red-400/60 hover:text-red-400 active:scale-[0.97] cursor-pointer'
                                        )}
                                        title={agentBusy ? 'Stop the agent first to clear the chat' : 'Clear Chat'}
                                    >
                                        <Eraser size={11} /><span className="text-[10px] uppercase font-bold tracking-wider">Clear</span>
                                    </button>
                                    );
                                })()}
                            </div>
                        </div>
                    </div>
                )}

                {/* CDP Browser Restart Banner — shows for 4s then collapses to icon in title bar */}
                {showCdpBanner && !cdpBannerDismissed && !cdpBannerCollapsed && (
                    <CdpRestartBanner
                        browsers={cdpBrowsersNeedRestart}
                        onDismiss={() => setCdpBannerCollapsed(true)}
                    />
                )}

                {/* Sandbox setup banner — shown when WSL2 is not available */}
                <SandboxSetupBanner />

                {/* PDF Password Prompt — shown when a password-protected PDF is detected */}
                {passwordNeeded && (
                    <PdfPasswordModal
                        fileName={passwordNeeded.fileName}
                        filePath={passwordNeeded.filePath}
                        onSubmit={async (password) => {
                            const result = await (window as any).electron.readPdfWithPassword(passwordNeeded.filePath, password);
                            if (result.content) {
                                setPasswordNeeded(null);
                                // Re-submit with the unlocked content
                                submit(undefined, `Here is the content of ${passwordNeeded.fileName}:\n\n${result.content}`);
                                return true;
                            }
                            return false;
                        }}
                        onDismiss={() => setPasswordNeeded(null)}
                    />
                )}

                {/* Agent Mode: Confirmation Card */}
                {agent.pendingIntent && (
                    <ConfirmationCard
                        intent={agent.pendingIntent}
                        onConfirm={async () => { await agent.execute(agent.pendingIntent!); }}
                        onCancel={() => agent.dismiss()}
                    />
                )}

                {/* Agent Mode: Result Card */}
                {agent.lastResult && !agent.pendingIntent && (
                    <ResultCard
                        result={agent.lastResult}
                        canUndo={!!agent.lastResult.undoPayload}
                        onUndo={() => {
                            const last = agent.history[agent.history.length - 1];
                            if (last) agent.undo(last);
                        }}
                        onDismiss={() => agent.dismiss()}
                    />
                )}

                {/* Onboarding cards — first launch only */}
                {showOnboarding && chat.messages.length === 0 && (
                    <OnboardingCards
                        onScreenshot={() => {
                            setShowOnboarding(false);
                            screenshot.captureFullScreen();
                        }}
                        onDeepMode={() => {
                            setShowOnboarding(false);
                            deepMode.activateDeepMode();
                        }}
                        onCommand={(cmd) => {
                            setShowOnboarding(false);
                            submit(undefined, cmd, false, cmd);
                        }}
                        onDismiss={() => setShowOnboarding(false)}
                    />
                )}

                {/* What I See — contextual intelligence card */}
                {!showOnboarding && onScreenEnabled && !agentMode && (isLoadingInsight || insightStopped) && !insightDismissed && (!contextInsight || insightStopped) && !screenshot.showScreenshot && !deepMode.isDeepFileMode && (
                    <WhatISeeSkeleton
                        initialStopped={insightStopped}
                        onDismiss={() => { setInsightDismissed(true); /* keep insightStopped=true so sleeping card returns on retoggle */ }}
                        onStop={() => { setIsLoadingInsight(false); setInsightStopped(true); setContextInsight(null); }}
                        onRefresh={async () => {
                            setInsightStopped(false);
                            setIsLoadingInsight(true);
                            setContextInsight(null);
                            try {
                                // Always capture a FRESH screenshot on refresh
                                isCapturingForInsightRef.current = true;
                                const img = await (window as any).electron.captureScreen();
                                isCapturingForInsightRef.current = false;
                                if (img) {
                                    screenshot.setLastScreenshot64(img);
                                    const { getContextInsight } = await import('./api/gemini');
                                    const insight = await getContextInsight(img, undefined, currentScreenContext);
                                    if (insight) {
                                        insight.actions = enforceActionTypes(insight.actions || [], currentScreenContext);
                                        setContextInsight(insight);
                                    }
                                }
                            } catch (err) {
                                isCapturingForInsightRef.current = false;
                                console.error('[WhatISee] Refresh failed:', err);
                            }
                            finally { setIsLoadingInsight(false); }
                        }}
                    />
                )}
                {!showOnboarding && onScreenEnabled && !agentMode && contextInsight && !insightDismissed && !insightStopped && !screenshot.showScreenshot && !deepMode.isDeepFileMode && (
                    <div className="transition-opacity duration-500">
                    <WhatISeeCard
                        insight={contextInsight}
                        mode={deepMode.isDeepFileMode ? 'deepfile' : screenshot.captureMode === 'partial' && screenshot.lastScreenshot64 ? 'snip' : 'screen'}
                        screenContext={currentScreenContext}
                        fileAccessState={fileAccessState}
                        webAccessState={webAccessState}
                        onStop={() => { setInsightStopped(true); setContextInsight(null); }}
                        onRefresh={async () => {
                            setIsLoadingInsight(true);
                            setContextInsight(null);
                            clearInsightCache();
                            try {
                                isCapturingForInsightRef.current = true;
                                const img = await (window as any).electron.captureScreen();
                                isCapturingForInsightRef.current = false;
                                if (img) {
                                    screenshot.setLastScreenshot64(img);
                                    const { getContextInsight } = await import('./api/gemini');
                                    const focus = getContextFocus(currentScreenContext);
                                    const insight = await getContextInsight(img, focus, currentScreenContext);
                                    if (insight) {
                                        insight.actions = enforceActionTypes(insight.actions || [], currentScreenContext);
                                        insight.actions = reorderActions(insight.actions, (insight as any).firstAction);
                                        setContextInsight(insight);
                                    }
                                }
                            } catch {
                                isCapturingForInsightRef.current = false;
                            } finally { setIsLoadingInsight(false); }
                        }}
                        onReadFullPage={async () => {
                            const title = windowCtx.activeWindowContext.title || '';
                            setWebAccessState({ loading: true, result: webAccessState.result });
                            try {
                                const result = await (window as any).electron.readWebContentClipboard({ title });
                                if (result?.content) {
                                    setWebAccessState({ loading: false, result: {
                                        webContent: result.content, url: null, method: 'clipboard', accessGranted: true,
                                    }});
                                } else {
                                    setWebAccessState(prev => ({ loading: false, result: prev.result }));
                                }
                            } catch {
                                setWebAccessState(prev => ({ loading: false, result: prev.result }));
                            }
                        }}
                        onAction={async (action) => {
                            const actionType = action.type || 'chat';
                            const useFile = fileAccessState?.result?.accessGranted;
                            const useWeb = webAccessState?.result?.accessGranted;
                            const useScreen = true; // On Screen is always ON when card is visible
                            const fileResult = useFile ? fileAccessState?.result : null;
                            const webResult = useWeb ? webAccessState?.result : null;
                            const basePrompt = (action.prompt || action.label) + (actionType === 'clipboard' ? '\n\nReturn ONLY the requested content. No explanations, no markdown.' : '');
                            const prompt = useFile ? buildEscalatedPrompt(basePrompt, fileResult)
                                : useWeb ? buildWebEscalatedPrompt(basePrompt, webResult)
                                : basePrompt;

                            if (actionType === 'clipboard') {
                                try {
                                    const { callGeminiFlashWithImage } = await import('./api/gemini');
                                    const result = await callGeminiFlashWithImage(
                                        prompt,
                                        useScreen ? (screenshot.lastScreenshot64 || undefined) : undefined,
                                        { maxOutputTokens: 2000, temperature: 0.1 }
                                    );
                                    if (result) {
                                        await (window as any).electron.copyToClipboard({ text: result, html: result });
                                        chat.setMessages(prev => [...prev, { role: 'assistant' as const, content: `✓ Copied to clipboard: "${result.substring(0, 100)}${result.length > 100 ? '...' : ''}"` }]);
                                    }
                                } catch (err: any) {
                                    chat.setMessages(prev => [...prev, { role: 'assistant' as const, content: `✗ Failed to extract: ${err?.message || 'No response from AI'}` }]);
                                }
                            } else if (actionType === 'document') {
                                const fmtFromLabel = (action.label || '').match(/\b(excel|xlsx|spreadsheet|pdf|word|docx|ppt|pptx|powerpoint)\b/i);
                                const fmtMap: Record<string, string> = { excel: 'xlsx', xlsx: 'xlsx', spreadsheet: 'xlsx', pdf: 'pdf', word: 'docx', docx: 'docx', ppt: 'pptx', pptx: 'pptx', powerpoint: 'pptx' };
                                const fmt = (action as any).documentFormat || (fmtFromLabel ? fmtMap[fmtFromLabel[1].toLowerCase()] : null) || 'xlsx';
                                const fileContent = useFile ? fileResult?.fileContent : undefined;
                                chat.setMessages(prev => [...prev, { role: 'user' as const, content: action.label, attachedFile: { name: `📄 Generating ${fmt.toUpperCase()}...`, content: '' } }]);
                                docGen.generate(action.prompt || action.label, fmt as any, fileContent || undefined, useScreen ? screenshot.lastScreenshot64 : undefined);
                            } else {
                                // Default: chat — pass actionType='onscreen' to skip docGen/agent intent classification
                                if (action.type === 'extract_table') {
                                    agent.startScreenAction({ label: action.label, icon: '📊', action: 'extract_table', outputFormat: 'xlsx', prompt: action.prompt || 'Extract the table to Excel' });
                                }
                                submit(undefined, prompt, false, action.label, 'onscreen');
                            }
                        }}
                        onContextOverride={async (newContext: ScreenContext) => {
                            clearInsightCache();
                            setCurrentScreenContext(newContext);
                            setIsLoadingInsight(true);
                            try {
                                const contextFocus = getContextFocus(newContext);
                                const insight = await getContextInsight(screenshot.lastScreenshot64 || '', contextFocus, newContext);
                                if (insight) {
                                    insight.actions = enforceActionTypes(insight.actions || [], newContext);
                                    setContextInsight(insight);
                                }
                            } catch {
                                const fallbackActions = getContextActionsWithTranslate(newContext, windowCtx.activeWindowContext.title);
                                setContextInsight({ seeing: `${getContextDisplayLabel(newContext)} — re-analyzed`, key_data: [], actions: fallbackActions });
                            } finally {
                                setIsLoadingInsight(false);
                            }
                        }}
                        onDismiss={() => { setInsightDismissed(true); setInsightStopped(true); }}
                    />
                    </div>
                )}

                {/* Multi-Screenshot Comparison */}
                {screenshot.screenshotStack.length > 0 && screenshot.showScreenshot && (
                    <ScreenshotStackBar
                        stack={screenshot.screenshotStack}
                        onCapture={async () => {
                            if (screenshot.captureMode === 'partial') {
                                const snip = await screenshot.launchSnipping();
                                if (snip) {
                                    screenshot.addToStack(snip, `Snip ${screenshot.screenshotStack.length + 1}`);
                                    screenshot.setLastScreenshot64(snip);
                                    suggestions.setLastScreenshotImmediate(snip);
                                    setTimeout(() => suggestions.fetchSuggestions(true), 50);
                                }
                            } else {
                                const b = await screenshot.captureFullScreen();
                                if (b) {
                                    screenshot.addToStack(b, `Screen ${screenshot.screenshotStack.length + 1}`);
                                    screenshot.setLastScreenshot64(b);
                                    suggestions.setLastScreenshotImmediate(b);
                                    setTimeout(() => suggestions.fetchSuggestions(true), 50);
                                }
                            }
                        }}
                        onCompare={() => {
                            const stackImages = screenshot.screenshotStack.map(s => s.base64);
                            const labels = screenshot.screenshotStack.map((s, i) => `Screenshot ${i + 1}`).join(' vs ');
                            const prompt = `Compare these ${stackImages.length} screenshots. Describe what changed between them, what's different, and what stayed the same. Be specific about visual differences.`;
                            // Add user message with all stack images encoded as multi: prefix
                            chat.setMessages(prev => [...prev, { role: 'user' as const, content: `Compare: ${labels}`, attachedImage: `multi:${JSON.stringify(stackImages)}` }]);
                            chat.setIsAnalyzing(true);
                            // Send all stack images directly to AI
                            chat.finishSubmit(prompt, stackImages, chat.keepConversation ? chat.messages : []);
                        }}
                        onAskAbout={() => {
                            submit(undefined, `I have ${screenshot.screenshotStack.length} screenshots captured. Analyze all of them together and describe what you see across all of them.`, false, 'Analyze screenshots');
                        }}
                        onRemove={(i) => screenshot.removeFromStack(i)}
                        onClear={() => screenshot.clearStack()}
                        onPreview={(b64) => screenshot.setPreviewImage(b64)}
                    />
                )}

                {/* Smart Paste Banner */}
                {agent.clipboardInfo && (
                    <SmartPasteBanner
                        clipboardInfo={agent.clipboardInfo}
                        onAiFormat={() => {
                            const ci = agent.clipboardInfo!;
                            const prompts: Record<string, string> = {
                                table: `Format and clean this table data, then output as a well-structured markdown table:\n\n${ci.text}`,
                                json: `Format this JSON with proper indentation:\n\n${ci.text}`,
                                code: `Format this code with proper indentation and syntax:\n\n${ci.text}`,
                                urls: `Here are URLs from my clipboard. List them cleanly with any titles you can infer:\n\n${ci.text}`,
                                emails: `Extract and list all email addresses from this text:\n\n${ci.text}`,
                            };
                            submit(undefined, prompts[ci.type] || ci.text, false, `Smart Paste: ${ci.type}`);
                            agent.setClipboardInfo(null);
                        }}
                        onSave={async () => {
                            const result = await agent.smartPasteAction(agent.clipboardInfo!, 'save');
                            if (result.success) agent.setClipboardInfo(null);
                        }}
                        onCopyFormatted={async () => {
                            await agent.smartPasteAction(agent.clipboardInfo!, 'copy');
                        }}
                        onRewrite={(style) => {
                            const ci = agent.clipboardInfo!;
                            const prompts: Record<string, string> = {
                                professional: `Rewrite this text to be professional, polished, and business-appropriate. Preserve all factual content. Return ONLY the rewritten text:\n\n${ci.text}`,
                                shorter: `Rewrite this text to be 50% shorter. Keep all key facts. Return ONLY the shortened text:\n\n${ci.text}`,
                                clearer: `Rewrite this text so it cannot be misunderstood. One idea per sentence. Return ONLY the clarified text:\n\n${ci.text}`,
                            };
                            submit(undefined, prompts[style], false, `Rewrite: ${style}`);
                            agent.setClipboardInfo(null);
                        }}
                        onSummarize={() => {
                            const ci = agent.clipboardInfo!;
                            submit(undefined, `Summarize this text in 2-3 bullet points. Focus on the key message and any action items:\n\n${ci.text}`, false, 'Summarize clipboard');
                            agent.setClipboardInfo(null);
                        }}
                        onUseInPrompt={() => {
                            const ci = agent.clipboardInfo!;
                            if (inputRef.current) {
                                inputRef.current.value = ci.text;
                                setQuery(ci.text);
                                inputRef.current.focus();
                            }
                            agent.setClipboardInfo(null);
                        }}
                        onDismiss={() => agent.setClipboardInfo(null)}
                    />
                )}

                {/* Smart Suggestions — always visible when a capture/deep mode is active */}
                {(screenshot.showScreenshot || deepMode.isDeepFileMode) && (
                    <div ref={suggestions.suggestionsRef} className="px-4 pt-3 pb-2 flex flex-col gap-3 border-b border-white/[0.04] no-drag bg-emerald-500/[0.03] backdrop-blur-md min-h-[44px] animate-in fade-in slide-in-from-top-1 duration-300">
                        <div className="flex items-center gap-2.5 px-1">
                            {/* Crossfade wrapper — both states always rendered, opacity toggles */}
                            <div className="relative flex items-center">
                                {/* Thinking state (brain + text) */}
                                <div className={`flex items-center gap-2.5 transition-all duration-500 ease-in-out ${suggestions.isFetchingSuggestions ? 'opacity-100 translate-y-0 scale-100' : 'opacity-0 translate-y-1 scale-95 absolute pointer-events-none'}`}>
                                    <ThinkingBrain />
                                    <div className="flex flex-col gap-0.5">
                                        <span className="text-[13px] text-emerald-400/80 font-medium tracking-wide font-poppins"
                                            style={{ animation: suggestions.isFetchingSuggestions ? 'klypixTextFade 2.8s ease-in-out infinite' : 'none' }}>
                                            Thinking...
                                        </span>
                                        <span className="text-[10px] text-white/25 uppercase tracking-[0.15em] font-poppins">smart suggestions</span>
                                    </div>
                                </div>
                                {/* Idle state (dots + label) */}
                                <div className={`flex items-center gap-1.5 transition-all duration-500 ease-in-out ${!suggestions.isFetchingSuggestions ? 'opacity-100 translate-y-0 scale-100' : 'opacity-0 -translate-y-1 scale-95 absolute pointer-events-none'}`}>
                                    <div className="flex items-center gap-1.5 h-5">{[1, 2, 3, 4, 5].map(i => <div key={i} className="w-1.5 h-1.5 rounded-full bg-emerald-500/40" />)}</div>
                                    <span className="text-[10px] text-white/30 uppercase tracking-[0.2em] font-poppins">Smart suggestions</span>
                                </div>
                            </div>
                            {suggestions.isFetchingSuggestions ? (
                                <button onClick={() => suggestions.stopSuggestions()} className="p-1 rounded-lg text-red-400/60 hover:text-red-400 hover:bg-red-500/10 transition-all shrink-0 cursor-pointer" title="Stop loading suggestions"><X size={11} /></button>
                            ) : (
                                <>
                                    {suggestions.wasStopped && suggestions.suggestions.length === 0 && (
                                        <span className="text-white/20 text-[9px]">Stopped</span>
                                    )}
                                    <button onClick={() => suggestions.fetchSuggestions(true)} className="p-1 rounded-lg text-white/30 hover:text-white hover:bg-white/5 transition-all shrink-0 cursor-pointer" title="Refresh Suggestions"><RefreshCw size={11} /></button>
                                </>
                            )}
                            <button onClick={() => { const ns = !suggestions.showSuggestionsContent; suggestions.setShowSuggestionsContent(ns); suggestions.setIsUserManuallyHidden(!ns); }} className="p-1 rounded-lg text-white/30 hover:text-white hover:bg-white/5 transition-all shrink-0">{suggestions.showSuggestionsContent ? <ChevronUp size={12} /> : <ChevronDown size={12} />}</button>
                        </div>
                        {deepMode.failedAccessNames.length > 0 && (
                            <div className="flex items-center gap-2 px-3 py-2 bg-red-500/[0.06] border-l-2 border-red-500/30 rounded-lg animate-in fade-in slide-in-from-top-1">
                                <X size={12} className="text-red-400 shrink-0" />
                                <span className="text-[10px] font-medium text-red-300 flex-1">Some items are still loading: <span className="font-bold">{deepMode.failedAccessNames.join(', ')}</span></span>
                                <button onClick={() => deepMode.setFailedAccessNames([])} className="text-red-300/50 hover:text-red-300 cursor-pointer shrink-0"><X size={10} /></button>
                            </div>
                        )}
                        {suggestions.showSuggestionsContent && (
                            <div className="flex-1 flex flex-wrap items-center gap-1.5 py-0.5">
                                {suggestions.isFetchingSuggestions && suggestions.suggestions.length === 0 ? (
                                    <div className="flex flex-col gap-2 w-full">{[1, 2, 3].map(i => <div key={i} className="shimmer-bar rounded-full h-8" style={{ animationDelay: `${i * 0.15}s`, width: `${90 - i * 12}%` }} />)}</div>
                                ) : (
                                    suggestions.suggestions.map((s, i) => {
                                        // Color coding by type
                                        const typeStyles: Record<string, string> = {
                                            chat: 'bg-white/[0.04] border-l-2 border-emerald-500/20 hover:bg-emerald-500/[0.08] hover:border-emerald-500/40 hover:text-emerald-200 hover:shadow-[0_0_16px_rgba(16,185,129,0.05)]',
                                            document: 'bg-amber-500/[0.04] border-l-2 border-amber-500/25 hover:bg-amber-500/[0.08] hover:border-amber-500/40 hover:text-amber-200 hover:shadow-[0_0_16px_rgba(245,158,11,0.05)]',
                                            clipboard: 'bg-purple-500/[0.04] border-l-2 border-purple-500/25 hover:bg-purple-500/[0.08] hover:border-purple-500/40 hover:text-purple-200 hover:shadow-[0_0_16px_rgba(168,85,247,0.05)]',
                                            // Legacy type names (backward compat)
                                            analysis: 'bg-white/[0.04] border-l-2 border-emerald-500/20 hover:bg-emerald-500/[0.08] hover:border-emerald-500/40 hover:text-emerald-200 hover:shadow-[0_0_16px_rgba(16,185,129,0.05)]',
                                            docgen: 'bg-amber-500/[0.04] border-l-2 border-amber-500/25 hover:bg-amber-500/[0.08] hover:border-amber-500/40 hover:text-amber-200 hover:shadow-[0_0_16px_rgba(245,158,11,0.05)]',
                                            action: 'bg-purple-500/[0.04] border-l-2 border-purple-500/25 hover:bg-purple-500/[0.08] hover:border-purple-500/40 hover:text-purple-200 hover:shadow-[0_0_16px_rgba(168,85,247,0.05)]',
                                        };
                                        const typeIcons: Record<string, string> = { chat: '', document: '📊 ', clipboard: '🔗 ', analysis: '', docgen: '📊 ', action: '🔗 ' };
                                        const sType = s.type || 'chat';

                                        const handleSuggestionClick = async () => {
                                            if (sType === 'document' || sType === 'docgen') {
                                                if (docGen.isGenerating) return; // Prevent duplicate clicks
                                                // Extract format from label
                                                const fmtMatch = s.label.match(/\b(excel|xlsx|spreadsheet|pdf|word|docx|doc|csv|ppt|pptx|powerpoint)\b/i);
                                                const formatMap: Record<string, string> = { excel: 'xlsx', xlsx: 'xlsx', spreadsheet: 'xlsx', pdf: 'pdf', word: 'docx', docx: 'docx', doc: 'docx', csv: 'xlsx', ppt: 'pptx', pptx: 'pptx', powerpoint: 'pptx' };
                                                const fmt = fmtMatch ? (formatMap[fmtMatch[1].toLowerCase()] || 'xlsx') : 'xlsx';
                                                // Build context from deep mode files, attachments, OR screenshot
                                                let docGenContext: string | undefined;
                                                let docGenImage: string | null = null;
                                                if (deepMode.isDeepFileMode && deepMode.selectedFiles.length > 0 && deepMode.allSelectedLoaded) {
                                                    const cachedContent = deepMode.getCachedContent();
                                                    if (cachedContent && cachedContent.length > 50) {
                                                        docGenContext = 'IMPORTANT: Generate the document based ONLY on the following file contents. Do NOT use generic templates. Every fact in your output must come from these files.\n\n' + cachedContent;
                                                    }
                                                } else if (attachments.attachedFiles.length > 0) {
                                                    // Read attached files for docgen context
                                                    try {
                                                        const fileObjs = attachments.attachedFiles.map(f => ({ id: f.path, name: f.name, localPath: f.path, type: 'file' as const, source: 'Attached' }));
                                                        const result = await (window as any).electron.readMultipleFiles(fileObjs);
                                                        if (result?.results) {
                                                            const sections = result.results
                                                                .filter((r: any) => r.content && typeof r.content === 'string' && r.content.length > 10)
                                                                .map((r: any) => `--- FILE: ${r.name || 'Document'} ---\n${r.content}`)
                                                                .join('\n\n');
                                                            if (sections.length > 50) {
                                                                docGenContext = 'IMPORTANT: Generate the document based ONLY on the following file contents. Do NOT use generic templates.\n\n' + sections;
                                                            }
                                                        }
                                                    } catch { /* fall through */ }
                                                } else if (screenshot.showScreenshot && screenshot.lastScreenshot64) {
                                                    docGenImage = screenshot.lastScreenshot64;
                                                }
                                                // Add compact tag to chat history
                                                chat.setMessages(prev => [...prev, {
                                                    role: 'user' as const,
                                                    content: s.label,
                                                    attachedFile: { name: `📊 Generating ${fmt.toUpperCase()}...`, content: '' }
                                                }]);
                                                docGen.generate(s.prompt, fmt as any, docGenContext, docGenImage);
                                            } else if (sType === 'clipboard' || sType === 'action') {
                                                // Clipboard action — submit with clean extraction instruction
                                                // Pass actionType='clipboard' to skip doc gen detection in submit()
                                                const clipboardPrompt = s.prompt + '\n\nIMPORTANT: Respond with ONLY the extracted content — no explanations, no headers, no markdown. Just the raw text/data to copy to clipboard.';
                                                pendingClipboardCopyRef.current = true;
                                                // Store the index where the assistant response WILL appear
                                                // (current messages + 1 for user message + 1 for assistant = last index after response)
                                                clipboardTargetIndexRef.current = chat.messages.length + 1;
                                                submit(undefined, clipboardPrompt, false, s.label, 'clipboard');
                                            } else {
                                                // Chat/analysis → normal chat
                                                submit(undefined, s.prompt, false, s.label);
                                            }
                                        };

                                        return (
                                            <button key={i} onClick={handleSuggestionClick} title={s.prompt}
                                                className={`truncate max-w-full whitespace-nowrap px-3.5 py-2.5 rounded-lg text-[13px] text-white/70 transition-all duration-200 active:scale-[0.98] cursor-pointer ${typeStyles[sType]}`}
                                            >
                                                {typeIcons[sType]}{s.label}
                                            </button>
                                        );
                                    })
                                )}
                            </div>
                        )}
                    </div>
                )}

                {/* Launch Pad Chips — shown in default state only (no mode active, no suggestions) */}
                {!screenshot.showScreenshot && !deepMode.isDeepFileMode && suggestions.suggestions.length === 0 && !suggestions.isFetchingSuggestions && chat.messages.length === 0 && (
                    <div className="px-4 py-3 flex flex-wrap gap-2 no-drag animate-in fade-in duration-300">
                        {(() => {
                            const chips: Array<{ label: string; action: () => void; icon?: string }> = [];
                            // Clipboard-derived
                            const clipInfo = agent.clipboardInfo;
                            if (clipInfo?.type === 'url') chips.push({ label: 'Analyze this link', icon: '🔗', action: () => submit(undefined, `Analyze this URL: ${clipInfo.content}`, false, 'Analyze link') });
                            else if (clipInfo?.type === 'text' && clipInfo.content?.length > 10) chips.push({ label: 'Rewrite this', icon: '✏️', action: () => submit(undefined, `Rewrite this text: ${clipInfo.content}`, false, 'Rewrite') });
                            // Persona-derived
                            const persona = getPersona();
                            if (persona && persona !== 'Helpful User' && (persona.toLowerCase().includes('document') || persona.toLowerCase().includes('file') || persona.toLowerCase().includes('pharma'))) {
                                if (chips.length < 3) chips.push({ label: 'Scan a document', icon: '📄', action: () => { deepMode.activateDeepMode(); screenshot.setShowScreenshot(false); screenshot.clearStack(); suggestions.setSuggestions([]); suggestions.setLastSuggestionContext(''); } });
                            }
                            // Memory-derived
                            if (sessionCtx.data.generatedDocs.length > 0 && chips.length < 3) {
                                chips.push({ label: 'Generate another document', icon: '📊', action: () => {} });
                            }
                            // Default for new users
                            if (chips.length === 0) {
                                chips.push({ label: 'Capture my screen', icon: '📷', action: () => { screenshot.setShowScreenshot(true); screenshot.setCaptureMode('full'); deepMode.setIsDeepFileMode(false); screenshot.clearStack(); suggestions.setSuggestions([]); suggestions.setLastSuggestionContext(''); suggestions.fetchSuggestions(true); } });
                                chips.push({ label: 'Scan a file', icon: '📄', action: () => { deepMode.activateDeepMode(); screenshot.setShowScreenshot(false); screenshot.clearStack(); suggestions.setSuggestions([]); suggestions.setLastSuggestionContext(''); } });
                            }
                            return chips.slice(0, 3).map((chip, i) => (
                                <button key={i} onClick={chip.action} className="px-3.5 py-2 rounded-xl text-[13px] text-white/60 bg-white/[0.04] border border-white/10 hover:bg-white/[0.08] hover:text-white/80 hover:border-white/20 transition-all duration-200 active:scale-[0.97] cursor-pointer">
                                    {chip.icon && <span className="mr-1.5">{chip.icon}</span>}{chip.label}
                                </button>
                            ));
                        })()}
                    </div>
                )}

                {/* Response Area */}
                <div className="flex-1 overflow-hidden flex flex-col no-drag">
                    <div ref={chat.scrollRef} onScroll={handleScroll} className="flex-1 overflow-y-auto space-y-2 px-6 pt-2 pb-16">
                        {/* Conversational Prompt Enhancer (shown when agent prompt is vague) */}
                        {showPromptEnhancer && enhancerData && (
                            <EnhancerChat
                                originalPrompt={enhancerData.originalPrompt}
                                analysis={enhancerData.analysis}
                                fields={enhancerData.fields}
                                initialValues={enhancerData.initialValues}
                                onEnhancedSubmit={(enhanced) => {
                                    setShowPromptEnhancer(false);
                                    const ctx = enhancerData.pendingAgentContext;
                                    if (ctx) {
                                      const finalPrompt = ctx.agentPrompt.replace(enhancerData.originalPrompt, enhanced);
                                      claudeAgent.startAgent(finalPrompt, ctx.screenshot, ctx.windowCtx, ctx.extraScreenshots);
                                    }
                                    setEnhancerData(null);
                                }}
                                onSkip={() => {
                                    setShowPromptEnhancer(false);
                                    const ctx = enhancerData.pendingAgentContext;
                                    if (ctx) {
                                      claudeAgent.startAgent(ctx.agentPrompt, ctx.screenshot, ctx.windowCtx, ctx.extraScreenshots);
                                    }
                                    setEnhancerData(null);
                                }}
                                onCancel={() => {
                                    setShowPromptEnhancer(false);
                                    setEnhancerData(null);
                                }}
                            />
                        )}

                        {/* Format picker (shown when generation intent is ambiguous) */}
                        {docGen.showFormatPicker && (
                            <FormatPicker
                                formats={docGen.pickerFormats}
                                onSelect={docGen.selectFormat}
                                onCancel={docGen.cancelFormatPicker}
                            />
                        )}

                        {chat.messages.map((msg, idx) => (
                            <MessageItem key={idx} msg={msg} idx={idx} copiedIndex={chat.copiedIndex} copyToClipboard={chat.copyToClipboard} onViewImage={screenshot.setPreviewImage} searchQuery={chat.searchQuery} isActiveResult={chat.searchResultIndices[chat.currentSearchIndex] === idx} resultRef={chat.activeResultRef} onSendToCanvas={handleSendToCanvas} />
                        ))}

                        {/* Claude Agent UI — renders below the user's prompt message */}
                        {claudeAgent.state !== 'idle' && claudeAgent.state !== 'routing' && (
                            <div ref={agentCardRef} className="space-y-3">
                                <WorkflowPanel
                                    steps={claudeAgent.steps}
                                    cost={claudeAgent.cost}
                                    isRunning={claudeAgent.state === 'running' || claudeAgent.state === 'waiting_permission' || claudeAgent.state === 'waiting_user_answer'}
                                    wasStopped={claudeAgent.state === 'stopped'}
                                    onAbort={claudeAgent.abort}
                                    trustMode={trustMode}
                                    onTrustModeChange={handleTrustModeChange}
                                    onFollowUp={(msg: string) => {
                                        claudeAgent.sendFollowUp(msg);
                                        chat.setMessages(prev => [...prev, { role: 'user' as const, content: msg, sourceMode: 'agent' as any }]);
                                    }}
                                    fileCount={claudeAgent.producedFiles.length}
                                    routerMetrics={claudeAgent.getRouterMetrics?.() ?? null}
                                />
                                {/* Agent-produced file cards */}
                                {claudeAgent.producedFiles.length > 0 && (
                                    <div className="space-y-2">
                                        {claudeAgent.producedFiles.map((file, i) => {
                                            const formatIcons: Record<string, string> = {
                                                pdf: '\uD83D\uDCC4', docx: '\uD83D\uDCC3', xlsx: '\uD83D\uDCCA',
                                                pptx: '\uD83D\uDCBB', csv: '\uD83D\uDCCB', txt: '\uD83D\uDCC4',
                                                md: '\uD83D\uDCDD', json: '\u2699\uFE0F', html: '\uD83C\uDF10',
                                            };
                                            const icon = formatIcons[file.format] || '\uD83D\uDCC1';
                                            return (
                                                <div key={`${file.path}_${i}`} className="flex items-center gap-3 px-4 py-3 glass rounded-xl border border-purple-500/20">
                                                    <span className="text-xl">{icon}</span>
                                                    <div className="flex-1 min-w-0">
                                                        <p className="text-sm text-white font-medium truncate">{file.name}</p>
                                                        <p className="text-[10px] text-gray-500 truncate">{file.path}</p>
                                                    </div>
                                                    <div className="flex items-center gap-2">
                                                        <button
                                                            onClick={() => window.electron.openExternal(`file:///${file.path.replace(/\\/g, '/')}`)}
                                                            className="px-3 py-1.5 bg-purple-500/20 border border-purple-500/30 rounded-lg text-xs text-purple-300 hover:bg-purple-500/30 transition-colors"
                                                        >
                                                            Open
                                                        </button>
                                                        <button
                                                            onClick={async () => {
                                                                const dir = file.path.replace(/[/\\][^/\\]+$/, '');
                                                                await window.electron.agent.runShell({ command: `explorer.exe "${dir}"` });
                                                            }}
                                                            className="px-3 py-1.5 bg-white/5 border border-white/10 rounded-lg text-xs text-gray-400 hover:bg-white/10 transition-colors"
                                                        >
                                                            Show in Folder
                                                        </button>
                                                    </div>
                                                </div>
                                            );
                                        })}
                                    </div>
                                )}
                                {/* Agent streaming text — always visible once agent starts, robot stays stable */}
                                {(claudeAgent.state !== 'idle' && claudeAgent.state !== 'routing') && (
                                    <div className="flex items-start gap-3 px-1">
                                        <div className="flex-shrink-0 mt-1">
                                            <AgentRobot isWorking={claudeAgent.state === 'running' || claudeAgent.state === 'waiting_permission' || claudeAgent.state === 'waiting_user_answer'} />
                                        </div>
                                        <div className="flex-1 min-w-0">
                                            <div className="text-[10px] text-purple-400/60 font-medium mb-1">KLYPIX Agent</div>
                                            {claudeAgent.streamingText ? (
                                                <div className="markdown-content text-[15px] leading-relaxed text-white/90">
                                                    <ReactMarkdown remarkPlugins={[remarkGfm]}>{claudeAgent.streamingText}</ReactMarkdown>
                                                </div>
                                            ) : (
                                                <div className="text-xs text-gray-500 italic">Working...</div>
                                            )}
                                        </div>
                                    </div>
                                )}
                                {claudeAgent.permissionRequest && (
                                    <PermissionTabs
                                        request={claudeAgent.permissionRequest}
                                        onAllow={claudeAgent.approvePermission}
                                        onDeny={claudeAgent.denyPermission}
                                        trustMode={trustMode}
                                        onTrustModeChange={handleTrustModeChange}
                                    />
                                )}
                                {/* Sandbox approval dialog is mounted once at App-root floating
                                    position so it covers canvas too — see SandboxApprovalDialog
                                    mount above. Do not remount here or both instances listen. */}
                                {/* Agent asking user a clarifying question */}
                                {claudeAgent.userQuestion && (
                                    <div className="px-4 py-3 bg-purple-500/10 border border-purple-500/30 rounded-xl animate-slideIn">
                                        <p className="text-white/80 text-[13px] mb-2.5">{claudeAgent.userQuestion.question}</p>
                                        {claudeAgent.userQuestion.options && claudeAgent.userQuestion.options.length > 0 ? (
                                            <div className="flex flex-wrap gap-1.5">
                                                {claudeAgent.userQuestion.options.map((opt: string) => (
                                                    <button
                                                        key={opt}
                                                        onClick={() => claudeAgent.answerQuestion(opt)}
                                                        className="px-3 py-1.5 text-xs rounded-full border border-white/15 bg-white/5 text-white/70 hover:bg-purple-500/15 hover:border-purple-500/30 hover:text-purple-300 transition-all cursor-pointer"
                                                    >
                                                        {opt}
                                                    </button>
                                                ))}
                                            </div>
                                        ) : (
                                            <div className="flex gap-1.5">
                                                <input
                                                    type="text"
                                                    placeholder="Type your answer..."
                                                    className="flex-1 bg-white/5 border border-white/15 rounded-full px-3 py-1.5 text-xs text-white/80 placeholder:text-white/30 focus:outline-none focus:border-purple-500/40"
                                                    onKeyDown={(e) => {
                                                        if (e.key === 'Enter' && (e.target as HTMLInputElement).value.trim()) {
                                                            claudeAgent.answerQuestion((e.target as HTMLInputElement).value.trim());
                                                        }
                                                    }}
                                                />
                                                <button
                                                    onClick={(e) => {
                                                        const input = (e.target as HTMLElement).previousElementSibling as HTMLInputElement;
                                                        if (input?.value?.trim()) claudeAgent.answerQuestion(input.value.trim());
                                                    }}
                                                    className="px-3 py-1.5 text-xs rounded-full bg-purple-500/20 border border-purple-500/30 text-purple-300 hover:bg-purple-500/30 cursor-pointer"
                                                >→</button>
                                            </div>
                                        )}
                                    </div>
                                )}
                                {claudeAgent.errorMessage && (
                                    <div className="px-4 py-3 bg-red-500/10 border border-red-500/30 rounded-xl text-sm text-red-300 flex items-start gap-3">
                                        <span className="text-red-400 text-lg mt-0.5">!</span>
                                        <div>
                                            <p className="font-medium text-red-400 mb-1">Agent Stopped</p>
                                            <p className="text-red-300/80 text-xs leading-relaxed">{claudeAgent.errorMessage}</p>
                                        </div>
                                    </div>
                                )}
                            </div>
                        )}
                        {/* Power Button + Action-specific follow-up buttons */}
                        {chat.messages.length > 0 && chat.messages[chat.messages.length - 1].role === 'assistant' && !chat.isAnalyzing && !chat.isTyping && (() => {
                            const contextButtons = lastActionType ? getActionButtons(lastActionType) : [];
                            const showPowerButton = settings.powerButtonLabel.trim() !== '' && settings.powerButtonPrompt.trim() !== '';
                            if (!showPowerButton && contextButtons.length === 0) return null;
                            const lastMsg = chat.messages[chat.messages.length - 1];
                            return (
                                <div className="flex items-center gap-1.5 px-1 pb-1 animate-in fade-in slide-in-from-bottom-1 duration-200">
                                    {showPowerButton && (
                                        <button onClick={() => {
                                            // Inject previous answer directly into the prompt.
                                            // actionType='onscreen' skips doc gen detection (so long text doesn't trigger PDF/PPTX).
                                            const prompt = `${settings.powerButtonPrompt}\n\nApply the above to this content:\n\n${lastMsg.content}`;
                                            submit(undefined, prompt, false, `⚡ ${settings.powerButtonLabel}`, 'onscreen');
                                        }} className="px-2.5 py-1 text-[10px] font-medium bg-emerald-500/10 border border-emerald-500/20 text-emerald-300 rounded-lg hover:bg-emerald-500/20 transition-all duration-200 active:scale-[0.97] animate-in fade-in slide-in-from-bottom-1 duration-200">
                                            <Zap size={12} className="text-emerald-400 mr-1 inline" />{settings.powerButtonLabel}
                                        </button>
                                    )}
                                    {contextButtons.map(btn => (
                                        <button key={btn.label} onClick={async () => {
                                            if (btn.action === 'reprompt' && btn.prompt) {
                                                submit(undefined, btn.prompt, false, btn.label);
                                            } else if (btn.action === 'copy-markdown-checklist') {
                                                const checklist = extractMarkdownChecklist(lastMsg.content);
                                                window.electron.copyToClipboard({ text: checklist, html: checklist.replace(/\n/g, '<br>') });
                                            } else if (btn.action === 'copy-html-table') {
                                                const table = extractMarkdownTable(lastMsg.content);
                                                if (table) {
                                                    const html = await marked.parse(table);
                                                    window.electron.copyToClipboard({ text: table, html });
                                                }
                                            }
                                        }} className="px-2.5 py-1 text-[10px] font-medium text-white/50 bg-white/[0.03] border border-white/[0.06] rounded-lg hover:text-emerald-300 hover:bg-emerald-500/[0.08] hover:border-emerald-500/20 transition-all duration-200 active:scale-[0.97]">
                                            {btn.label}
                                        </button>
                                    ))}
                                </div>
                            );
                        })()}
                        {(chat.response || chat.isAnalyzing) && (
                            <div className="flex flex-col items-start gap-1.5">
                                <div className="flex items-center gap-1.5">
                                    <img src={logoUrl} className="w-3.5 h-3.5 opacity-80" alt="logo" />
                                    <span className="text-[10px] font-bold tracking-tight text-white/50 uppercase font-poppins">Klypix</span>
                                    {deepMode.activeFileInfo && <span className="flex items-center gap-1 ml-1 px-1.5 py-0.5 rounded-md bg-emerald-500/15 border border-emerald-500/25 text-emerald-400 text-[10px] font-medium"><FileSearch size={10} />{deepMode.activeFileInfo.fileName}{deepMode.activeFileInfo.pageCount > 0 ? ` (${deepMode.activeFileInfo.pageCount} ${deepMode.activeFileInfo.pageCount === 1 ? 'page' : 'pages'})` : ''}</span>}
                                    {deepMode.isReadingFile && (
                                        <div className="flex items-center gap-2 ml-1 px-3 py-1.5 rounded-lg bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 text-[11px] font-medium animate-pulse">
                                            <Loader2 size={12} className="animate-spin" />
                                            <div>
                                                <div>Processing files...</div>
                                                <div className="text-[9px] text-emerald-400/50 font-normal">Large or scanned PDFs may take longer</div>
                                            </div>
                                        </div>
                                    )}
                                </div>
                                {chat.isAnalyzing ? (
                                    <RespondingKlypix mode={deepMode.isDeepFileMode ? 'document' : screenshot.showScreenshot ? 'screen' : 'chat'} />
                                ) : (
                                    <div className="markdown-content text-[15px] leading-relaxed text-white/90">
                                        <ReactMarkdown remarkPlugins={[remarkGfm]}>{chat.displayedResponse}</ReactMarkdown>
                                        {chat.isTyping && <span className="inline-block w-2 h-4 bg-white/20 animate-pulse ml-1 align-middle" />}
                                    </div>
                                )}
                                {/* Post-response action buttons */}
                                {!chat.isTyping && !chat.isAnalyzing && chat.displayedResponse && chat.displayedResponse.split(/\s+/).length >= 200 && (
                                    <div className="flex flex-wrap gap-1.5 mt-3 no-drag" style={{ WebkitAppRegion: 'no-drag' } as any}>
                                        {/* Table detected → Save as Excel */}
                                        {(chat.displayedResponse.includes('|') && chat.displayedResponse.split('\n').filter(l => l.includes('|')).length >= 3) && (
                                            <button onClick={async () => {
                                                const lines = chat.displayedResponse.split('\n').filter(l => l.trim().startsWith('|') || l.includes('|'));
                                                const dataLines = lines.filter(l => !l.match(/^[\s|:-]+$/));
                                                if (dataLines.length >= 2) {
                                                    const headers = dataLines[0].split('|').map(h => h.trim()).filter(Boolean);
                                                    const rows = dataLines.slice(1).map(l => l.split('|').map(c => c.trim()).filter(Boolean));
                                                    await (window as any).electron.generateFile({
                                                        format: 'xlsx',
                                                        spec: { filename: 'response_table.xlsx', sheets: [{ name: 'Sheet1', columns: headers.map(h => ({ header: h })), rows }] }
                                                    });
                                                }
                                            }} className="flex items-center gap-1 px-2.5 py-1 rounded-lg bg-emerald-500/10 border border-emerald-500/20 hover:bg-emerald-500/20 text-emerald-400/80 hover:text-emerald-400 text-[11px] transition-all cursor-pointer">
                                                <span>📊</span> Save as Excel
                                            </button>
                                        )}
                                        {/* Code detected → Save as file */}
                                        {chat.displayedResponse.includes('```') && (
                                            <button onClick={async () => {
                                                const codeMatch = chat.displayedResponse.match(/```(\w*)\n([\s\S]*?)```/);
                                                if (codeMatch) {
                                                    const ext = codeMatch[1] || 'txt';
                                                    const code = codeMatch[2];
                                                    await (window as any).electron.generateFile({ format: ext, content: code, spec: { filename: `code_snippet.${ext}` } });
                                                }
                                            }} className="flex items-center gap-1 px-2.5 py-1 rounded-lg bg-blue-500/10 border border-blue-500/20 hover:bg-blue-500/20 text-blue-400/80 hover:text-blue-400 text-[11px] transition-all cursor-pointer">
                                                <span>💻</span> Save code
                                            </button>
                                        )}
                                        {/* Always: Save as PDF */}
                                        <button onClick={async () => {
                                            await (window as any).electron.generateFile({ format: 'pdf', content: chat.displayedResponse, spec: { filename: 'response.pdf' } });
                                        }} className="flex items-center gap-1 px-2.5 py-1 rounded-lg bg-white/5 border border-white/10 hover:bg-white/10 text-white/40 hover:text-white/60 text-[11px] transition-all cursor-pointer">
                                            <span>📄</span> Save as PDF
                                        </button>
                                        {/* Always: Save as text */}
                                        <button onClick={async () => {
                                            await (window as any).electron.generateFile({ format: 'txt', content: chat.displayedResponse, spec: { filename: 'response.txt' } });
                                        }} className="flex items-center gap-1 px-2.5 py-1 rounded-lg bg-white/5 border border-white/10 hover:bg-white/10 text-white/40 hover:text-white/60 text-[11px] transition-all cursor-pointer">
                                            <span>📝</span> Save as text
                                        </button>
                                        {/* Remember document for cross-reference (only in deep mode) */}
                                        {deepMode.isDeepFileMode && deepMode.selectedFiles.length > 0 && (
                                            <button onClick={async () => {
                                                const firstFile = deepMode.selectedFiles[0];
                                                const docName = deepMode.activeFileInfo?.fileName || (typeof firstFile === 'string' ? firstFile : (firstFile as any)?.name) || 'document';
                                                await agent.saveDocumentMemory(docName, chat.displayedResponse);
                                                chat.setMessages(prev => [...prev, { role: 'assistant' as const, content: '🧠 Document remembered. I\'ll flag changes if you open a related document later.' }]);
                                            }} className="flex items-center gap-1 px-2.5 py-1 rounded-lg bg-purple-500/10 border border-purple-500/20 hover:bg-purple-500/20 text-purple-400/80 hover:text-purple-400 text-[11px] transition-all cursor-pointer">
                                                <span>🧠</span> Remember this
                                            </button>
                                        )}
                                    </div>
                                )}
                            </div>
                        )}
                    </div>
                </div>

                {/* Generated document card — inline after chat */}
                {(docGen.generatedDoc || docGen.isGenerating) && (
                    <div className="px-4 pb-3 relative z-[60]">
                        <GeneratedDocCard
                            doc={docGen.generatedDoc || { format: docGen.activeFormat || 'txt', rawContent: '', spec: null, filename: '', preview: docGen.genProgress, imageBase64: null, imageMimeType: null }}
                            isGenerating={docGen.isGenerating}
                            genProgress={docGen.genProgress}
                            onDownload={() => docGen.downloadFile()}
                            onDismiss={() => docGen.clearGenerated()}
                            onCancel={() => docGen.cancelGeneration()}
                            onRevise={(instruction) => {
                                if (docGen.generatedDoc) {
                                    docGen.generate(
                                        `Revise the previously generated ${docGen.generatedDoc.format} file. Previous content:\n${docGen.generatedDoc.rawContent}\n\nRevision instruction: ${instruction}`,
                                        docGen.generatedDoc.format
                                    );
                                }
                            }}
                            onConvert={(targetFormat) => {
                                if (docGen.generatedDoc) {
                                    docGen.generate(
                                        `Convert the following content to ${targetFormat} format. Preserve all content, structure, and formatting.\n\nOriginal content:\n${docGen.generatedDoc.rawContent}`,
                                        targetFormat as any
                                    );
                                }
                            }}
                        />
                    </div>
                )}

                {/* Footer */}
                <div ref={footerRef} className="absolute bottom-0 left-0 w-full px-4 py-2 flex items-center justify-between text-[11px] text-slate-500 border-t border-white/10 bg-[#242323]/90 backdrop-blur-2xl z-20">
                    <div className="flex items-center gap-2">
                        <span className="bg-white/10 px-2 py-0.5 rounded uppercase font-medium tracking-tight text-[11px] font-poppins">{settings.currentShortcut}</span>
                        <span>to toggle</span>
                    </div>
                    <div className="flex items-center gap-4 no-drag relative">
                        <div className="flex items-center gap-1 opacity-40 hover:opacity-70 transition-opacity">
                            <span>by</span>
                            <button onClick={() => window.electron.openExternal('https://dahshanlabs.com')} className="font-bold tracking-tight text-white/60 hover:text-emerald-400 transition-colors cursor-pointer underline-offset-2 hover:underline" title="Dahshan Labs">Dahshan Labs</button>
                        </div>
                        <div className="relative">
                            <button onClick={() => setShowModelDropdown(!showModelDropdown)} className={cn('flex items-center gap-1.5 px-2 py-1 rounded-full border transition-all text-[11px] font-medium tracking-tight h-[22px]', showModelDropdown ? 'bg-white/20 border-white/20 text-white' : 'bg-white/5 border-white/10 hover:border-white/20 hover:bg-white/10 text-white/70')} title="Change AI Model">
                                <span className="truncate max-w-[100px]">{AVAILABLE_MODELS.find(m => m.id === settings.selectedModel)?.name || 'Gemini 2.5 Flash'}</span>
                                <ChevronLeft size={10} className={cn('transition-transform', showModelDropdown ? 'rotate-90' : '-rotate-90')} />
                            </button>
                            {showModelDropdown && (
                                <div className="absolute bottom-[100%] right-0 mb-2 w-[300px] bg-[#242323]/95 backdrop-blur-3xl border border-white/10 rounded-xl shadow-[0_-10px_40px_rgba(0,0,0,0.8)] p-2 z-50 animate-in slide-in-from-bottom-2 fade-in duration-200">
                                    <div className="text-[9px] uppercase font-bold text-white/40 px-2 pb-2 mb-2 tracking-widest border-b border-white/5">Select AI Engine</div>
                                    <div className="grid grid-cols-2 gap-1">
                                        {AVAILABLE_MODELS.map((model) => {
                                            const isActive = model.id === settings.selectedModel;
                                            const isComingSoon = model.status === 'coming_soon';
                                            return (
                                                <button key={model.id} onClick={() => { if (!isComingSoon) { settings.setSelectedModel(model.id); setShowModelDropdown(false); } }} className={cn('w-full flex items-center justify-between px-2 py-1.5 rounded-lg text-[10px] transition-all text-left group', isActive ? 'bg-emerald-500/20 text-emerald-400 ring-1 ring-emerald-500/30' : isComingSoon ? 'opacity-40 cursor-not-allowed hover:bg-white/5' : 'text-white/70 hover:bg-white/10')} title={isComingSoon ? 'Model integration pending.' : `Use ${model.name}`}>
                                                    <span className="font-medium truncate max-w-[100px]">{model.name}</span>
                                                    {isActive && <Check size={10} className="text-emerald-400 flex-shrink-0" />}
                                                    {isComingSoon && <Lock size={9} className="text-white/30 flex-shrink-0 group-hover:text-white/50" />}
                                                </button>
                                            );
                                        })}
                                    </div>
                                </div>
                            )}
                        </div>
                        <button onClick={chat.copyFullChat} disabled={chat.messages.length === 0} className={cn('p-1.5 rounded-lg transition-all', chat.isCopyFullActive ? 'text-emerald-400 bg-emerald-500/10' : 'text-white/40 hover:bg-white/10')} title="Copy Full Conversation">{chat.isCopyFullActive ? <Check size={14} /> : <Copy size={14} />}</button>
                        <button
                            onClick={() => setShowMemoryPanel(true)}
                            className={cn(
                                'p-1.5 rounded-lg transition-all',
                                memoryEnabled
                                    ? 'text-emerald-400 bg-emerald-500/10 hover:bg-emerald-500/20'
                                    : 'text-white/40 hover:bg-white/10'
                            )}
                            title={memoryEnabled ? 'Memory ON' : 'Memory OFF'}
                        >
                            <Brain size={14} />
                        </button>
                        <button onClick={() => settings.setShowSettings(!settings.showSettings)} className={cn('p-1.5 rounded-lg transition-all', settings.showSettings ? 'bg-white/20 text-white' : 'text-white/40 hover:bg-white/10')} title="Settings"><Settings size={14} /></button>
                    </div>
                    <div className="absolute bottom-0 left-0 w-full h-[2px] bg-emerald-500/40 shadow-[0_0_10px_rgba(16,185,129,0.3)]" />
                </div>
            </div>

            {/* Memory Panel */}
            {showMemoryPanel && <MemoryPanel onClose={() => setShowMemoryPanel(false)} />}

            {/* Update Toast */}
            {updater.showToast && (
                <UpdateToast
                    state={updater}
                    onInstall={updater.installUpdate}
                    onDismiss={updater.dismiss}
                />
            )}
        </div>
    );
}
