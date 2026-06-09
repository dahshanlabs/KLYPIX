// SettingsPanel — the SINGLE unified settings UI.
//
// Replaces the old inline settings overlay; absorbs everything that lived
// there (Account, Gemini key, voice toggles, privacy/memory, PDF OCR,
// Power Button, Agent Engine) and adds the new features (3 rebindable
// hotkeys, clipboard retention/excludes/enable, About).
//
// Sections (sidebar, top-to-bottom):
//   • Account     — sign-in card, tier, query counter, sign out
//   • Hotkeys     — rebind chat / palette / quickAction shortcuts
//   • AI          — provider + Gemini key + PDF OCR mode
//   • Voice       — dictation + speak-responses toggles
//   • Power Button— custom label + prompt for the chat power button
//   • Clipboard   — enable, retention, exclude apps, clear history
//   • Privacy     — privacy mode, memory toggle, download/clear memory,
//                   forget everything
//   • Agent       — embeds the existing AgentSettings component
//   • About       — version + links
//
// Design rules baked in:
//   • Auto-save on change. Mac-style — no "Save" button.
//   • Sidebar uses lucide icons + label + active-row accent.
//   • Live keyboard rebind with conflict detection.
//   • All toggles use one Switch component for consistency.

import { useEffect, useRef, useState } from 'react';
import {
    X, Keyboard, Clipboard as ClipboardIcon, Sparkles, Lock, Info, Plus, Trash2,
    AlertCircle, Check, ChevronLeft, User as UserIcon, Mic, MicOff, Volume2, VolumeX,
    Shield, ShieldOff, Eye, EyeOff, ExternalLink, Globe, FileText, Zap, Bot,
    Eraser, Download, Minus, Square, Copy as CopyIcon, Languages, FolderOpen, Plug, Loader2, Terminal,
} from 'lucide-react';
import clsx, { type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';
import { AgentSettings } from './AgentSettings';
import { OfflineModelsPanel } from './OfflineModelsPanel';
import { useLocale, type Locale } from '../i18n/strings';

const cn = (...inputs: ClassValue[]) => twMerge(clsx(inputs));

type SectionId = 'account' | 'language' | 'hotkeys' | 'ai' | 'voice' | 'power' | 'clipboard' | 'canvas' | 'privacy' | 'agent' | 'about';

const SECTIONS: { id: SectionId; label: string; icon: typeof Keyboard }[] = [
    { id: 'account', label: 'Account', icon: UserIcon },
    { id: 'language', label: 'Language', icon: Languages },
    { id: 'hotkeys', label: 'Hotkeys', icon: Keyboard },
    { id: 'ai', label: 'AI', icon: Sparkles },
    { id: 'voice', label: 'Voice', icon: Mic },
    { id: 'power', label: 'Power Button', icon: Zap },
    { id: 'clipboard', label: 'Clipboard', icon: ClipboardIcon },
    { id: 'canvas', label: 'Canvas', icon: FolderOpen },
    { id: 'privacy', label: 'Privacy', icon: Lock },
    { id: 'agent', label: 'Agent Engine', icon: Bot },
    { id: 'about', label: 'About', icon: Info },
];

interface Props {
    onClose: () => void;
    settings: any;       // useSettings() return
    auth: any;           // useAuth() context
    t: (key: any) => string;
}

// Safe translation: when a key is missing, our t() returns the key string
// itself (truthy), so `t('foo') || 'fallback'` never fires. tx() detects
// that case and falls back to the provided English literal.
function makeTx(t: (k: any) => string) {
    return (key: string, fallback: string): string => {
        const r = t(key);
        return !r || r === key ? fallback : r;
    };
}

export function SettingsPanel({ onClose, settings, auth, t }: Props) {
    const tx = makeTx(t);
    const [section, setSection] = useState<SectionId>('account');
    // Mirror the chat window's title-bar controls (minimize + maximize +
    // close) so users have the same window-management affordances in
    // Settings as they do in chat. Subscribes to main's maximize-state
    // broadcast so the icon toggles between "maximize" and "restore" in
    // sync with the actual window state.
    const [isMax, setIsMax] = useState(false);
    useEffect(() => {
        const el: any = (window as any).electron;
        if (!el) return;
        el.isMaximized?.().then((v: boolean) => setIsMax(!!v)).catch(() => {});
        const off = el.onMaximizeStateChanged?.((v: boolean) => setIsMax(!!v));
        return () => { try { off?.(); } catch {} };
    }, []);

    const SIDEBAR_LABELS: Record<SectionId, string> = {
        account: tx('settings.tab.account', 'Account'),
        language: tx('settings.tab.language', 'Language'),
        hotkeys: tx('settings.tab.hotkeys', 'Hotkeys'),
        ai: tx('settings.tab.ai', 'AI'),
        voice: tx('settings.tab.voice', 'Voice'),
        power: tx('settings.tab.power', 'Power Button'),
        clipboard: tx('settings.tab.clipboard', 'Clipboard'),
        canvas: tx('settings.tab.canvas', 'Canvas'),
        privacy: tx('settings.tab.privacy', 'Privacy'),
        agent: tx('settings.tab.agent', 'Agent Engine'),
        about: tx('settings.tab.about', 'About'),
    };

    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            if (e.key === 'Escape') { e.preventDefault(); onClose(); }
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [onClose]);

    return (
        <div className="absolute inset-0 z-[200] bg-[#1c1c1c]/[0.97] backdrop-blur-2xl flex flex-col no-drag animate-in fade-in duration-200">
            {/* Title bar — mirrors the chat header (back · title · window controls).
                The bar itself is `drag` so the user can move the window by
                grabbing it; inner buttons are `no-drag` so clicks go to the
                buttons instead of starting a window drag. */}
            <div className="pt-9 px-4 pb-2 flex items-center justify-between border-b border-white/5 drag">
                <button
                    onClick={onClose}
                    className="flex items-center gap-1.5 p-2 pr-3 hover:bg-white/10 rounded-lg transition-all text-white/50 hover:text-white cursor-pointer no-drag"
                >
                    <ChevronLeft size={18} />
                    <span className="text-[10px] font-bold uppercase tracking-widest">{tx('common.back', 'Back')}</span>
                </button>
                <div className="flex items-center gap-2 text-white/85">
                    <span className="text-[11px] font-bold uppercase tracking-[0.2em]">{tx('settings.tab.account', 'Settings').length > 0 ? 'Settings' : 'Settings'}</span>
                </div>
                <div className="flex items-center gap-1 no-drag">
                    <button
                        onClick={() => (window as any).electron?.minimizeWindow?.()}
                        title={tx('chat.minimize_tray', 'Minimize')}
                        className="text-white/40 hover:text-white/90 hover:bg-white/8 p-1.5 rounded-lg transition-colors cursor-pointer"
                    >
                        <Minus size={14} />
                    </button>
                    <button
                        onClick={async () => { try { await (window as any).electron?.toggleMaximize?.(); } catch {} }}
                        title={isMax ? (tx('chat.restore', 'Restore') || 'Restore') : (tx('chat.fullscreen', 'Maximize') || 'Maximize')}
                        className="text-white/40 hover:text-white/90 hover:bg-white/8 p-1.5 rounded-lg transition-colors cursor-pointer"
                    >
                        {isMax ? <CopyIcon size={13} /> : <Square size={13} />}
                    </button>
                    <button
                        onClick={onClose}
                        title={tx('common.back', 'Close')}
                        className="text-white/40 hover:text-white/90 hover:bg-white/8 p-1.5 rounded-lg transition-colors cursor-pointer"
                    >
                        <X size={16} />
                    </button>
                </div>
            </div>

            {/* Body: sidebar + content */}
            <div className="flex-1 flex overflow-hidden">
                {/* Sidebar */}
                <div className="w-[210px] border-r border-white/5 py-3 px-2 flex flex-col gap-0.5 overflow-y-auto">
                    {SECTIONS.map(s => {
                        const Icon = s.icon;
                        const active = s.id === section;
                        return (
                            <button
                                key={s.id}
                                onClick={() => setSection(s.id)}
                                className={cn(
                                    'flex items-center gap-2.5 px-3 py-2 rounded-lg text-left text-[12.5px] font-semibold transition-all',
                                    active
                                        ? 'bg-white/10 text-white shadow-sm'
                                        : 'text-white/55 hover:text-white/85 hover:bg-white/5',
                                )}
                            >
                                <Icon size={14} className={active ? 'text-emerald-400' : ''} />
                                {SIDEBAR_LABELS[s.id]}
                            </button>
                        );
                    })}
                    <div className="mt-auto pt-4 px-3 text-[10px] text-white/30 leading-relaxed">
                        {tx('settings.autosave_note', 'Changes save automatically.')}
                    </div>
                </div>

                {/* Content */}
                <div className="flex-1 overflow-y-auto px-8 py-6">
                    {section === 'account' && <AccountSection auth={auth} tx={tx} onClose={onClose} />}
                    {section === 'language' && <LanguageSection tx={tx} />}
                    {section === 'hotkeys' && <HotkeysSection tx={tx} />}
                    {section === 'ai' && <AISection settings={settings} tx={tx} />}
                    {section === 'voice' && <VoiceSection settings={settings} tx={tx} />}
                    {section === 'power' && <PowerButtonSection settings={settings} tx={tx} />}
                    {section === 'clipboard' && <ClipboardSection tx={tx} />}
                    {section === 'canvas' && <div className="flex flex-col gap-6"><VaultSection tx={tx} /><MCPConnectionSection tx={tx} /><OfflineModelsPanel tx={tx} /></div>}
                    {section === 'privacy' && <PrivacySection settings={settings} tx={tx} />}
                    {section === 'agent' && <AgentSection tx={tx} />}
                    {section === 'about' && <AboutSection tx={tx} />}
                </div>
            </div>
        </div>
    );
}

// ─── Section: Account ──────────────────────────────────────────────────────

function AccountSection({ auth, tx, onClose }: { auth: any; tx: (k: string, fb: string) => string; onClose: () => void }) {
    if (!auth) return <Section title={tx('settings.tab.account', 'Account')} caption="Authentication is unavailable."><div /></Section>;
    return (
        <Section title={tx('settings.tab.account', 'Account')} caption="">
            {auth.isAuthenticated ? (
                <div className="p-5 rounded-2xl bg-gradient-to-br from-emerald-500/8 via-white/[0.03] to-transparent border border-white/8">
                    <div className="flex items-center gap-4">
                        <div className="w-12 h-12 rounded-2xl bg-emerald-500/20 border border-emerald-500/30 flex items-center justify-center text-emerald-400 font-bold text-base">
                            {auth.user?.displayName?.[0]?.toUpperCase() || auth.user?.email?.[0]?.toUpperCase() || '?'}
                        </div>
                        <div className="flex-1 min-w-0">
                            <div className="text-[15px] font-bold text-white/95 truncate">{auth.user?.displayName || 'User'}</div>
                            <div className="text-[12px] text-white/55 truncate">{auth.user?.email}</div>
                        </div>
                        <span className={cn(
                            'px-2.5 py-1 rounded-full text-[10px] font-bold uppercase tracking-wider shrink-0',
                            auth.user?.tier === 'admin' ? 'bg-amber-500/20 text-amber-400'
                                : auth.user?.tier === 'pro' ? 'bg-emerald-500/20 text-emerald-400'
                                    : 'bg-white/10 text-white/55',
                        )}>
                            {tx(`settings.tier_${auth.user?.tier || 'free'}`, auth.user?.tier || 'free')}
                        </span>
                    </div>
                    <div className="mt-4 pt-4 border-t border-white/8 flex items-center justify-between">
                        <span className="text-[11.5px] text-white/45">
                            {tx('settings.queries_count', '{today} today · {total} total')
                                .replace('{today}', String(auth.user?.queriesToday || 0))
                                .replace('{total}', String(auth.user?.queriesTotal || 0))}
                        </span>
                        <button
                            onClick={() => { auth.signOut(); onClose(); }}
                            className="text-[11.5px] text-rose-300 hover:text-rose-200 font-semibold transition-colors cursor-pointer"
                        >
                            {tx('settings.signout', 'Sign out')}
                        </button>
                    </div>
                </div>
            ) : (
                <div className="p-5 rounded-2xl bg-white/[0.03] border border-white/8">
                    <div className="text-[12.5px] text-white/70 leading-relaxed">
                        {tx('settings.signin_cta_body', 'Sign in to sync your settings and unlock Pro features.')}
                    </div>
                    <button
                        onClick={() => { onClose(); (window as any).klypixShowSignIn?.(); }}
                        className="mt-3 w-full px-3 py-2.5 rounded-xl bg-emerald-500/20 hover:bg-emerald-500/30 border border-emerald-500/40 text-emerald-300 text-[12.5px] font-semibold transition-colors cursor-pointer"
                    >
                        {tx('settings.signin_cta_button', 'Sign in')}
                    </button>
                </div>
            )}
        </Section>
    );
}

// ─── Section: Language ─────────────────────────────────────────────────────

function LanguageSection({ tx }: { tx: (k: string, fb: string) => string }) {
    const [locale, setLocaleFn] = useLocale();
    const LANGS: { id: Locale; native: string; subtitle: string }[] = [
        { id: 'en', native: 'English', subtitle: tx('settings.language.english_subtitle', 'English (left-to-right)') },
        { id: 'ar', native: 'العربية', subtitle: tx('settings.language.arabic_subtitle', 'العربية (يمين-إلى-يسار)') },
    ];
    return (
        <Section
            title={tx('settings.tab.language', 'Language')}
            caption={tx('settings.language.caption', 'Switch the app interface between English and Arabic. Arabic flips the layout to right-to-left.')}
        >
            <div className="grid grid-cols-2 gap-3">
                {LANGS.map(lang => {
                    const active = locale === lang.id;
                    return (
                        <button
                            key={lang.id}
                            onClick={() => setLocaleFn(lang.id)}
                            // Each tile pins its own dir so the native label
                            // always reads naturally regardless of the
                            // app-level direction.
                            dir={lang.id === 'ar' ? 'rtl' : 'ltr'}
                            className={cn(
                                'relative flex flex-col items-start justify-center gap-1 px-5 py-5 rounded-2xl border text-left transition-all cursor-pointer',
                                active
                                    ? 'bg-emerald-500/10 border-emerald-500/40 ring-1 ring-emerald-500/20'
                                    : 'bg-white/[0.025] border-white/8 hover:bg-white/[0.05] hover:border-white/15',
                            )}
                        >
                            <span className="text-[20px] font-bold text-white/95 tracking-tight">{lang.native}</span>
                            <span className="text-[11.5px] text-white/50">{lang.subtitle}</span>
                            {active && (
                                <span className="absolute top-3 right-3 w-6 h-6 rounded-full bg-emerald-500/25 border border-emerald-500/50 flex items-center justify-center">
                                    <Check size={13} className="text-emerald-300" />
                                </span>
                            )}
                        </button>
                    );
                })}
            </div>
        </Section>
    );
}

// ─── Section: Hotkeys ──────────────────────────────────────────────────────

interface HotkeyDef {
    id: 'chat' | 'palette' | 'quickAction';
    label: string;
    description: string;
    defaultValue: string;
}
const HOTKEY_DEFS: HotkeyDef[] = [
    { id: 'chat', label: 'Open chat overlay', description: 'Bring up the screenshot-aware chat assistant from anywhere', defaultValue: 'Alt+Space' },
    { id: 'palette', label: 'Open Command Palette', description: 'Quick search, clipboard history, apps, files, AI commands', defaultValue: 'Alt+K' },
    { id: 'quickAction', label: 'AI Quick Action', description: 'Run translate / improve / summarize on the selected text', defaultValue: 'Alt+;' },
];

function HotkeysSection({ tx }: { tx: (k: string, fb: string) => string }) {
    const HOTKEY_LABELS: Record<string, { label: string; desc: string }> = {
        chat: { label: tx('settings.hotkeys.chat_label', 'Open chat overlay'), desc: tx('settings.hotkeys.chat_desc', 'Bring up the screenshot-aware chat assistant from anywhere') },
        palette: { label: tx('settings.hotkeys.palette_label', 'Open Command Palette'), desc: tx('settings.hotkeys.palette_desc', 'Quick search, clipboard history, apps, files, AI commands') },
        quickAction: { label: tx('settings.hotkeys.quick_label', 'AI Quick Action'), desc: tx('settings.hotkeys.quick_desc', 'Run translate / improve / summarize on the selected text') },
    };
    const [values, setValues] = useState<Record<string, string>>({});
    const [loading, setLoading] = useState(true);
    useEffect(() => {
        (async () => {
            const bridge: any = (window as any).electron?.hotkey;
            if (bridge?.getAll) {
                try {
                    const all = await bridge.getAll();
                    if (all && typeof all === 'object') setValues(all);
                } catch {}
            } else {
                try {
                    const chat = await (window as any).electron?.getShortcut?.();
                    if (chat) setValues({ chat, palette: 'Alt+K', quickAction: 'Alt+;' });
                } catch {}
            }
            setLoading(false);
        })();
    }, []);

    return (
        <Section title={tx('settings.tab.hotkeys', 'Hotkeys')} caption={tx('settings.hotkeys.caption', 'Global keyboard shortcuts that work even when Klypix is hidden.')}>
            <div className="flex flex-col gap-3">
                {HOTKEY_DEFS.map(def => (
                    <HotkeyRow
                        key={def.id}
                        def={{ ...def, label: HOTKEY_LABELS[def.id]?.label || def.label, description: HOTKEY_LABELS[def.id]?.desc || def.description }}
                        currentValue={values[def.id] || def.defaultValue}
                        loading={loading}
                        onSet={(v) => setValues(prev => ({ ...prev, [def.id]: v }))}
                        siblings={values}
                        recordingLabel={tx('settings.hotkeys.press_any_key', 'Press any key…')}
                    />
                ))}
            </div>
            <Note>
                {tx('settings.hotkeys.conflict_note', "Hotkey conflicts with other apps cannot be detected by Klypix — if a hotkey doesn't fire, another app is likely capturing it. Try a less common combo.")}
            </Note>
        </Section>
    );
}

function HotkeyRow({ def, currentValue, loading, onSet, siblings, recordingLabel }: {
    def: HotkeyDef;
    currentValue: string;
    loading: boolean;
    onSet: (v: string) => void;
    siblings: Record<string, string>;
    recordingLabel: string;
}) {
    const [recording, setRecording] = useState(false);
    const [error, setError] = useState<string | null>(null);

    function captureFromEvent(e: KeyboardEvent): string | null {
        const parts: string[] = [];
        if (e.ctrlKey) parts.push('Ctrl');
        if (e.altKey) parts.push('Alt');
        if (e.shiftKey) parts.push('Shift');
        if (e.metaKey) parts.push('Super');
        const mainKey = e.key;
        if (['Control', 'Alt', 'Shift', 'Meta'].includes(mainKey)) return null;
        let k = mainKey;
        // Electron accelerators: 'Space' is the named form, but `;` / `,` /
        // `.` / `/` etc. must stay literal — Electron does NOT recognize
        // 'Semicolon' or 'Comma' as key names and throws on register.
        if (mainKey === ' ') k = 'Space';
        else if (mainKey.length === 1) k = /[a-z]/i.test(mainKey) ? mainKey.toUpperCase() : mainKey;
        else k = mainKey.charAt(0).toUpperCase() + mainKey.slice(1);
        parts.push(k);
        return parts.join('+');
    }

    useEffect(() => {
        if (!recording) return;
        const onKey = async (e: KeyboardEvent) => {
            e.preventDefault();
            e.stopPropagation();
            if (e.key === 'Escape') {
                setRecording(false);
                setError(null);
                return;
            }
            const accel = captureFromEvent(e);
            if (!accel) return;
            for (const [sid, sval] of Object.entries(siblings)) {
                if (sid !== def.id && sval === accel) {
                    setError(`Already used by "${HOTKEY_DEFS.find(d => d.id === sid)?.label}"`);
                    return;
                }
            }
            const bridge: any = (window as any).electron?.hotkey;
            if (bridge?.set) {
                const res = await bridge.set({ id: def.id, accelerator: accel });
                if (res?.ok) {
                    onSet(accel);
                    setRecording(false);
                    setError(null);
                } else {
                    setError(res?.error || 'Failed to register');
                }
            } else if (def.id === 'chat') {
                const res = await (window as any).electron?.setShortcut?.(accel);
                if (res?.success) {
                    onSet(accel);
                    setRecording(false);
                    setError(null);
                } else {
                    setError(res?.error || 'Failed to register');
                }
            } else {
                setError('Backend update unavailable');
            }
        };
        window.addEventListener('keydown', onKey, true);
        return () => window.removeEventListener('keydown', onKey, true);
    }, [recording, siblings, def.id]);

    return (
        <div className="flex items-center justify-between gap-4 p-4 rounded-xl bg-white/[0.025] border border-white/8 hover:bg-white/[0.04] transition-colors">
            <div className="flex-1 min-w-0">
                <div className="text-[13px] font-semibold text-white/90">{def.label}</div>
                <div className="text-[11.5px] text-white/45 mt-0.5">{def.description}</div>
                {error && (
                    <div className="text-[11px] text-rose-400 mt-1.5 flex items-center gap-1">
                        <AlertCircle size={11} /> {error}
                    </div>
                )}
            </div>
            <button
                onClick={() => { setError(null); setRecording(r => !r); }}
                disabled={loading}
                className={cn(
                    'min-w-[180px] flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg border text-[12px] font-mono transition-all',
                    recording
                        ? 'bg-emerald-500/15 border-emerald-500/40 text-emerald-300 animate-pulse'
                        : 'bg-white/[0.04] border-white/10 text-white/85 hover:bg-white/8 hover:border-white/20 cursor-pointer',
                    loading && 'opacity-50',
                )}
            >
                {recording ? recordingLabel : formatAccelerator(currentValue)}
            </button>
        </div>
    );
}

function formatAccelerator(acc: string): string {
    return acc
        .replace(/CommandOrControl|CmdOrCtrl/g, 'Ctrl')
        .replace(/Semicolon/g, ';')
        .replace(/Plus/g, '+')
        .replace(/\+/g, ' + ');
}

// ─── Section: AI ───────────────────────────────────────────────────────────

// Provider availability mirrors the truth in src/core/aiRouter.ts: only
// Gemini actually streams in chat today; the others return mock
// "coming_soon" stubs. We disable selection on those so the picker is
// honest instead of letting users pick something that silently breaks.
// When an adapter ships, flip its `available: true` and the row unlocks.
const AI_PROVIDERS = [
    { id: 'gemini', label: 'Google Gemini', model: 'gemini-2.5-flash', free: true, recommended: true, available: true },
    { id: 'claude', label: 'Anthropic Claude', model: 'claude-sonnet-4-6', free: false, available: false },
    { id: 'openai', label: 'OpenAI GPT', model: 'gpt-4o', free: false, available: false },
    { id: 'glm', label: 'Zhipu GLM', model: 'glm-4', free: false, available: false },
    { id: 'deepseek', label: 'DeepSeek', model: 'deepseek-v3', free: false, available: false },
];

function AISection({ settings, tx }: { settings: any; tx: (k: string, fb: string) => string }) {
    const [provider, setProvider] = useState('gemini');
    const [geminiKey, setGeminiKey] = useState('');
    const [keyVisible, setKeyVisible] = useState(false);
    const [savedToast, setSavedToast] = useState(false);
    const savedTimer = useRef<number | null>(null);

    useEffect(() => {
        try {
            const p = localStorage.getItem('klypix:defaultProvider');
            if (p) setProvider(p);
        } catch {}
        try {
            const k = localStorage.getItem('gemini_api_key') || '';
            setGeminiKey(k);
        } catch {}
    }, []);

    function flashSaved() {
        setSavedToast(true);
        if (savedTimer.current) window.clearTimeout(savedTimer.current);
        savedTimer.current = window.setTimeout(() => setSavedToast(false), 1300) as unknown as number;
    }

    function setProviderAndPersist(p: string) {
        setProvider(p);
        try { localStorage.setItem('klypix:defaultProvider', p); } catch {}
        flashSaved();
    }

    async function saveGeminiKey(v: string) {
        setGeminiKey(v);
        try {
            if (v) localStorage.setItem('gemini_api_key', v);
            else localStorage.removeItem('gemini_api_key');
        } catch {}
        try { await (window as any).electron?.apiKey?.store?.(v); } catch {}
        flashSaved();
    }

    return (
        <Section title={tx('settings.tab.ai', 'AI')} caption={tx('settings.ai.caption', 'Default model for chat, suggestions, and AI Quick Actions.')}>
            <SettingRow label={tx('settings.ai.default_provider', 'Default provider')} description={tx('settings.ai.default_provider_desc', 'Used by the chat overlay and AI Quick Actions.')} vertical>
                <div className="w-full grid grid-cols-1 gap-2">
                    {AI_PROVIDERS.map(p => {
                        const disabled = !p.available;
                        return (
                            <button
                                key={p.id}
                                onClick={() => { if (!disabled) setProviderAndPersist(p.id); }}
                                disabled={disabled}
                                className={cn(
                                    'flex items-center justify-between gap-3 px-3 py-2.5 rounded-lg border text-left transition-all',
                                    disabled
                                        ? 'bg-white/[0.015] border-white/5 opacity-50 cursor-not-allowed'
                                        : provider === p.id
                                            ? 'bg-emerald-500/8 border-emerald-500/35 ring-1 ring-emerald-500/15 cursor-pointer'
                                            : 'bg-white/[0.025] border-white/8 hover:bg-white/[0.04] cursor-pointer',
                                )}
                            >
                                <div className="flex-1 min-w-0">
                                    <div className="flex items-center gap-1.5 flex-wrap">
                                        <span className="text-[12.5px] font-semibold text-white/90">{p.label}</span>
                                        {p.recommended && <span className="text-[9px] uppercase tracking-wider px-1.5 py-px rounded bg-emerald-500/15 text-emerald-300 font-bold">{tx('settings.ai.recommended', 'Recommended')}</span>}
                                        {p.free && <span className="text-[9px] uppercase tracking-wider px-1.5 py-px rounded bg-sky-500/15 text-sky-300 font-bold">{tx('settings.ai.free_tier', 'Free tier')}</span>}
                                        {disabled && <span className="text-[9px] uppercase tracking-wider px-1.5 py-px rounded bg-white/10 text-white/55 font-bold">{tx('settings.ai.coming_soon', 'Coming soon')}</span>}
                                    </div>
                                    <div className="text-[10.5px] text-white/45 mt-0.5 font-mono">{p.model}</div>
                                </div>
                                {provider === p.id && !disabled && <Check size={14} className="text-emerald-400 shrink-0" />}
                                {disabled && <Lock size={12} className="text-white/30 shrink-0" />}
                            </button>
                        );
                    })}
                </div>
            </SettingRow>

            <SettingRow label={tx('settings.ai.gemini_key', 'Gemini API key')} description={tx('settings.ai.gemini_key_desc', 'Get a free key at aistudio.google.com/apikey')} vertical>
                <div className="w-full flex gap-2">
                    <input
                        type={keyVisible ? 'text' : 'password'}
                        value={geminiKey}
                        onChange={e => saveGeminiKey(e.target.value)}
                        placeholder="AIzaSy…"
                        className="flex-1 px-3 py-2 rounded-lg bg-white/5 border border-white/10 text-[12px] text-white placeholder:text-white/35 focus:outline-none focus:border-emerald-500/40 transition-colors font-mono"
                    />
                    <button
                        onClick={() => setKeyVisible(v => !v)}
                        className="px-3 py-2 rounded-lg bg-white/[0.04] border border-white/10 text-white/70 text-[11.5px] font-semibold hover:bg-white/8 transition-all cursor-pointer flex items-center gap-1.5"
                    >
                        {keyVisible ? <EyeOff size={12} /> : <Eye size={12} />}
                        {keyVisible ? tx('settings.ai.hide', 'Hide') : tx('settings.ai.show', 'Show')}
                    </button>
                    {geminiKey && (
                        <button
                            onClick={() => saveGeminiKey('')}
                            title={tx('settings.privacy.clear', 'Clear')}
                            className="px-2.5 py-2 rounded-lg bg-white/[0.04] border border-white/10 text-white/60 hover:text-rose-300 hover:bg-rose-500/10 hover:border-rose-500/25 transition-all cursor-pointer"
                        >
                            <Trash2 size={12} />
                        </button>
                    )}
                    <button
                        onClick={() => (window as any).electron?.openExternal?.('https://aistudio.google.com/apikey')}
                        className="px-3 py-2 rounded-lg bg-emerald-500/10 border border-emerald-500/30 text-emerald-300 text-[11.5px] font-semibold hover:bg-emerald-500/20 transition-all cursor-pointer flex items-center gap-1.5"
                    >
                        <ExternalLink size={11} /> {tx('settings.ai.get_key', 'Get key')}
                    </button>
                </div>
                {!geminiKey && (
                    <div className="text-[11px] text-amber-300/85 mt-1.5 flex items-center gap-1.5 px-2.5 py-1.5 rounded-md bg-amber-500/8 border border-amber-500/20">
                        <AlertCircle size={11} />
                        {tx('settings.ai.no_key_warning', "No Gemini key set — chat, suggestions, and AI Quick Actions won't work until you add one.")}
                    </div>
                )}
                {savedToast && (
                    <div className="text-[10.5px] text-emerald-300 mt-1.5 flex items-center gap-1 animate-in fade-in">
                        <Check size={11} /> {tx('settings.ai.saved', 'Saved')}
                    </div>
                )}
            </SettingRow>

            <SettingRow label={tx('settings.ai.pdf_label', 'PDF & document reading')} description={tx('settings.ai.pdf_desc', 'How Klypix extracts text from PDFs and images. Gemini Vision is more accurate; Local OCR keeps the data on-device.')}>
                <div className="flex gap-2">
                    <ChoicePill
                        active={settings?.pdfOcrMode === 'gemini'}
                        onClick={() => settings?.setPdfOcrMode?.('gemini')}
                        icon={Globe}
                        label={tx('settings.gemini_vision', 'Gemini Vision')}
                    />
                    <ChoicePill
                        active={settings?.pdfOcrMode === 'local'}
                        onClick={() => settings?.setPdfOcrMode?.('local')}
                        icon={Lock}
                        label={tx('settings.local_ocr', 'Local OCR')}
                    />
                </div>
            </SettingRow>

            <Note>
                {tx('settings.ai.other_providers_note', 'Other provider keys (Claude, OpenAI, GLM, DeepSeek) are managed in the Agent Engine section below since each provider has its own budget + model settings.')}
            </Note>
        </Section>
    );
}

// ─── Section: Voice ────────────────────────────────────────────────────────

function VoiceSection({ settings, tx }: { settings: any; tx: (k: string, fb: string) => string }) {
    return (
        <Section title={tx('settings.tab.voice', 'Voice')} caption={tx('settings.voice.caption', 'Speak to Klypix and have it read responses out loud.')}>
            <SettingRow
                label={tx('settings.voice_dictation', 'Voice dictation')}
                description={tx('settings.voice_dictation.hint', 'Speak instead of typing.')}
            >
                <Switch checked={!!settings?.isVoiceDictationEnabled} onChange={v => settings?.setIsVoiceDictationEnabled?.(v)} />
            </SettingRow>
            <SettingRow
                label={tx('settings.speak_responses', 'Speak responses')}
                description={tx('settings.speak_responses.hint', 'AI reads answers aloud.')}
            >
                <Switch checked={!!settings?.isTTSEnabled} onChange={v => settings?.setIsTTSEnabled?.(v)} />
            </SettingRow>
        </Section>
    );
}

// ─── Section: Power Button ─────────────────────────────────────────────────

function PowerButtonSection({ settings, tx }: { settings: any; tx: (k: string, fb: string) => string }) {
    return (
        <Section title={tx('settings.tab.power', 'Power Button')} caption={tx('settings.power.caption', 'The custom one-tap action that appears under chat responses. Set a label and the instruction Klypix runs against the answer.')}>
            <SettingRow label={tx('settings.power_button.label', 'Label')} description={tx('settings.power.label_desc', 'Up to 20 characters.')} vertical>
                <input
                    dir="auto"
                    type="text"
                    maxLength={20}
                    value={settings?.powerButtonLabel || ''}
                    onChange={e => settings?.setPowerButtonLabel?.(e.target.value)}
                    placeholder={tx('settings.power_button.label', 'e.g. Make Arabic')}
                    className="w-full px-3 py-2 rounded-lg bg-white/5 border border-white/10 text-[12.5px] text-white placeholder:text-white/35 focus:outline-none focus:border-emerald-500/40 transition-colors"
                />
            </SettingRow>
            <SettingRow label={tx('settings.power.prompt_label', 'Instruction')} description={tx('settings.power_button.hint', 'What Klypix should do with the response when you click the button.')} vertical>
                <textarea
                    dir="auto"
                    rows={3}
                    value={settings?.powerButtonPrompt || ''}
                    onChange={e => settings?.setPowerButtonPrompt?.(e.target.value)}
                    placeholder={tx('settings.power_button.prompt', 'e.g. Translate to Arabic, formal tone.')}
                    className="w-full px-3 py-2 rounded-lg bg-white/5 border border-white/10 text-[12.5px] text-white placeholder:text-white/35 focus:outline-none focus:border-emerald-500/40 transition-colors resize-none"
                />
            </SettingRow>
        </Section>
    );
}

// ─── Section: Clipboard ────────────────────────────────────────────────────

function ClipboardSection({ tx }: { tx: (k: string, fb: string) => string }) {
    const [enabled, setEnabled] = useState(true);
    const [retention, setRetention] = useState(200);
    const [excludes, setExcludes] = useState<string[]>([]);
    const [newExclude, setNewExclude] = useState('');
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        (async () => {
            const bridge: any = (window as any).electron?.clipboardSettings;
            if (bridge?.get) {
                try {
                    const s = await bridge.get();
                    if (s) {
                        if (typeof s.enabled === 'boolean') setEnabled(s.enabled);
                        if (typeof s.retention === 'number') setRetention(s.retention);
                        if (Array.isArray(s.excludes)) setExcludes(s.excludes);
                    }
                } catch {}
            } else {
                try {
                    const e = localStorage.getItem('klypix:clipboardEnabled');
                    setEnabled(e === null ? true : e === '1');
                    const r = parseInt(localStorage.getItem('klypix:clipboardRetention') || '200', 10);
                    if (!isNaN(r)) setRetention(r);
                    const x = JSON.parse(localStorage.getItem('klypix:clipboardExcludes') || '[]');
                    if (Array.isArray(x)) setExcludes(x);
                } catch {}
            }
            setLoading(false);
        })();
    }, []);

    function persist(next: { enabled?: boolean; retention?: number; excludes?: string[] }) {
        const merged = { enabled, retention, excludes, ...next };
        const bridge: any = (window as any).electron?.clipboardSettings;
        if (bridge?.set) {
            bridge.set(merged).catch(() => {});
        }
        try {
            localStorage.setItem('klypix:clipboardEnabled', merged.enabled ? '1' : '0');
            localStorage.setItem('klypix:clipboardRetention', String(merged.retention));
            localStorage.setItem('klypix:clipboardExcludes', JSON.stringify(merged.excludes));
        } catch {}
    }

    function addExclude() {
        const v = newExclude.trim();
        if (!v) return;
        if (excludes.includes(v)) { setNewExclude(''); return; }
        const next = [...excludes, v];
        setExcludes(next);
        setNewExclude('');
        persist({ excludes: next });
    }

    function removeExclude(v: string) {
        const next = excludes.filter(x => x !== v);
        setExcludes(next);
        persist({ excludes: next });
    }

    async function clearHistory() {
        const bridge: any = (window as any).electron?.clipboardHistory;
        if (bridge?.clear) await bridge.clear();
    }

    return (
        <Section title={tx('settings.tab.clipboard', 'Clipboard')} caption={tx('settings.clipboard.caption', 'Capture everything you copy and let you search it later.')}>
            <SettingRow
                label={tx('settings.clipboard.enable_label', 'Enable clipboard history')}
                description={tx('settings.clipboard.enable_desc', 'When off, Klypix stops recording the OS clipboard. Pinned items remain.')}
            >
                <Switch
                    checked={enabled}
                    onChange={v => { setEnabled(v); persist({ enabled: v }); }}
                    disabled={loading}
                />
            </SettingRow>

            <SettingRow
                label={tx('settings.clipboard.retention_label', 'Retention')}
                description={tx('settings.clipboard.retention_desc', `Keep the last {n} unpinned items. Pinned items are never auto-deleted.`).replace('{n}', String(retention))}
            >
                <div className="flex items-center gap-3 w-[280px]">
                    <input
                        type="range"
                        min={50}
                        max={500}
                        step={25}
                        value={retention}
                        onChange={e => { const v = parseInt(e.target.value, 10); setRetention(v); persist({ retention: v }); }}
                        disabled={loading || !enabled}
                        className="flex-1 accent-emerald-500"
                    />
                    <span className="text-[12px] font-mono text-white/70 w-12 text-right tabular-nums">{retention}</span>
                </div>
            </SettingRow>

            <SettingRow
                label={tx('settings.clipboard.excludes_label', 'Exclude apps')}
                description={tx('settings.clipboard.excludes_desc', "Clipboard captures from these apps are dropped. Match by process name (e.g. '1password', 'lastpass'). Built-in password-manager filter is always on.")}
                vertical
            >
                <div className="w-full flex flex-col gap-2">
                    <div className="flex flex-wrap gap-1.5">
                        {excludes.length === 0 && <span className="text-[11.5px] text-white/40 italic">{tx('settings.clipboard.excludes_empty', 'None yet')}</span>}
                        {excludes.map(x => (
                            <span key={x} className="inline-flex items-center gap-1 pl-2.5 pr-1 py-1 rounded-full bg-white/8 border border-white/10 text-[11.5px] text-white/85">
                                {x}
                                <button onClick={() => removeExclude(x)} className="ml-0.5 p-0.5 rounded-full hover:bg-rose-500/30 text-white/50 hover:text-rose-300 transition-colors">
                                    <X size={10} />
                                </button>
                            </span>
                        ))}
                    </div>
                    <div className="flex gap-2">
                        <input
                            type="text"
                            value={newExclude}
                            onChange={e => setNewExclude(e.target.value)}
                            onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); addExclude(); } }}
                            placeholder={tx('settings.clipboard.exclude_placeholder', 'Process name (e.g. 1password, keepass)')}
                            disabled={!enabled}
                            className="flex-1 px-3 py-2 rounded-lg bg-white/5 border border-white/10 text-[12px] text-white placeholder:text-white/35 focus:outline-none focus:border-emerald-500/40 transition-colors"
                        />
                        <button
                            onClick={addExclude}
                            disabled={!enabled || !newExclude.trim()}
                            className="px-3 py-2 rounded-lg bg-emerald-500/15 border border-emerald-500/30 text-emerald-300 text-[12px] font-semibold hover:bg-emerald-500/25 disabled:opacity-40 disabled:cursor-not-allowed transition-all flex items-center gap-1.5 cursor-pointer"
                        >
                            <Plus size={12} /> {tx('settings.clipboard.add', 'Add')}
                        </button>
                    </div>
                </div>
            </SettingRow>

            <SettingRow label={tx('settings.clipboard.clear_label', 'Clear all history')} description={tx('settings.clipboard.clear_desc', 'Deletes all unpinned items. Pinned items stay.')}>
                <button
                    onClick={clearHistory}
                    className="px-3 py-2 rounded-lg bg-rose-500/10 border border-rose-500/25 text-rose-300 text-[12px] font-semibold hover:bg-rose-500/20 transition-all flex items-center gap-1.5 cursor-pointer"
                >
                    <Trash2 size={12} /> {tx('settings.clipboard.clear_action', 'Clear unpinned')}
                </button>
            </SettingRow>
        </Section>
    );
}

// ─── Section: Privacy ──────────────────────────────────────────────────────

function PrivacySection({ settings, tx }: { settings: any; tx: (k: string, fb: string) => string }) {
    const [memoryOn, setMemoryOn] = useState(true);
    const [confirmingForget, setConfirmingForget] = useState(false);

    useEffect(() => {
        try {
            setMemoryOn(localStorage.getItem('klypix:memoryEnabled') !== '0');
        } catch {}
    }, []);

    function setMemoryAndPersist(v: boolean) {
        setMemoryOn(v);
        try { localStorage.setItem('klypix:memoryEnabled', v ? '1' : '0'); } catch {}
    }

    async function downloadMemory() {
        try {
            const mod = await import('../api/memoryStore');
            const data = mod.exportMemoryData();
            const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `klypix-memory-${new Date().toISOString().split('T')[0]}.json`;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(url);
        } catch (e) { console.error('memory export failed', e); }
    }

    async function clearMemory() {
        if (!confirm('Clear local AI memory? This resets your Living Persona.')) return;
        try {
            const mod = await import('../api/memoryStore');
            mod.clearMemory();
            alert('Memory cleared.');
            window.location.reload();
        } catch {}
    }

    async function forgetEverything() {
        if (!confirmingForget) { setConfirmingForget(true); setTimeout(() => setConfirmingForget(false), 4000); return; }
        const KEYS = ['alt_space_memory_v1', 'klypix_persona_v2', 'klypix:learnedPatterns', 'klypix:agentHistory', 'pinned_chats', 'klypix:sessionSpend'];
        try { KEYS.forEach(k => localStorage.removeItem(k)); } catch {}
        try { await (window as any).electron?.clipboardHistory?.clear?.(); } catch {}
        setConfirmingForget(false);
    }

    return (
        <Section title={tx('settings.tab.privacy', 'Privacy')} caption={tx('settings.privacy.caption', 'What Klypix remembers about you, and how to clear it.')}>
            <SettingRow
                label={tx('settings.privacy_mode', 'Privacy mode')}
                description={tx('settings.privacy_mode.hint', 'Replace sensitive window/file names with generic categories before they reach the AI provider.')}
            >
                <Switch checked={!!settings?.isPrivacyMode} onChange={v => settings?.setIsPrivacyMode?.(v)} />
            </SettingRow>

            <SettingRow
                label={tx('settings.privacy.memory_label', 'Memory')}
                description={tx('settings.privacy.memory_desc', 'Synthesize a short profile from your interactions to make answers more relevant. Last 20 chats only.')}
            >
                <Switch checked={memoryOn} onChange={setMemoryAndPersist} />
            </SettingRow>

            <SettingRow label={tx('settings.download_memory', 'Download memory')} description={tx('settings.download_memory.hint', 'Export your stored memory as JSON.')}>
                <button
                    onClick={downloadMemory}
                    className="px-3 py-2 rounded-lg bg-white/[0.04] border border-white/10 text-white/85 text-[12px] font-semibold hover:bg-white/8 transition-all flex items-center gap-1.5 cursor-pointer"
                >
                    <Download size={12} /> {tx('settings.privacy.export', 'Export')}
                </button>
            </SettingRow>

            <SettingRow label={tx('settings.clear_memory', 'Clear memory')} description={tx('settings.clear_memory.hint', 'Reset the Living Persona and last 20 interactions.')}>
                <button
                    onClick={clearMemory}
                    className="px-3 py-2 rounded-lg bg-rose-500/10 border border-rose-500/25 text-rose-300 text-[12px] font-semibold hover:bg-rose-500/20 transition-all flex items-center gap-1.5 cursor-pointer"
                >
                    <Eraser size={12} /> {tx('settings.privacy.clear', 'Clear')}
                </button>
            </SettingRow>

            <SettingRow label={tx('settings.privacy.forget_label', 'Forget everything')} description={tx('settings.privacy.forget_desc', 'Wipe ALL stored memory, agent history, pinned chats, and clipboard history.')}>
                <button
                    onClick={forgetEverything}
                    className={cn(
                        'px-3 py-2 rounded-lg border text-[12px] font-semibold transition-all flex items-center gap-1.5 cursor-pointer',
                        confirmingForget
                            ? 'bg-rose-500/25 border-rose-500/50 text-rose-200 ring-1 ring-rose-500/30 animate-pulse'
                            : 'bg-rose-500/10 border-rose-500/25 text-rose-300 hover:bg-rose-500/20',
                    )}
                >
                    <Trash2 size={12} /> {confirmingForget ? tx('settings.privacy.forget_confirm', 'Click again to confirm') : tx('settings.privacy.forget_action', 'Forget everything')}
                </button>
            </SettingRow>

            <Note>
                {tx('settings.privacy.local_note', "All data above is stored locally on this machine. Cloud sync only covers explicitly pinned canvas / clipboard items, and only when you're signed in.")}
            </Note>
        </Section>
    );
}

// ─── Section: Agent Engine ─────────────────────────────────────────────────

function AgentSection({ tx }: { tx: (k: string, fb: string) => string }) {
    return (
        <Section title={tx('settings.tab.agent', 'Agent Engine')} caption={tx('settings.agent.caption', 'Budget, provider keys, and per-model settings for the autonomous agent.')}>
            <div className="p-4 rounded-xl bg-white/[0.025] border border-white/8">
                <AgentSettings />
            </div>
        </Section>
    );
}

// ─── Section: About ────────────────────────────────────────────────────────

function AboutSection({ tx }: { tx: (k: string, fb: string) => string }) {
    const [version, setVersion] = useState('—');
    useEffect(() => {
        (async () => {
            try {
                const v = await (window as any).electron?.getAppVersion?.();
                if (v) setVersion(String(v));
            } catch {}
        })();
    }, []);
    return (
        <Section title={tx('settings.tab.about', 'About')} caption="">
            <div className="p-6 rounded-2xl bg-gradient-to-br from-emerald-500/8 via-white/[0.03] to-transparent border border-white/8">
                <div className="flex items-center gap-3">
                    <div className="w-12 h-12 rounded-2xl bg-emerald-500/20 flex items-center justify-center">
                        <Sparkles size={22} className="text-emerald-400" />
                    </div>
                    <div>
                        <div className="text-[18px] font-bold text-white/95 tracking-tight">KLYPIX</div>
                        <div className="text-[11.5px] text-white/55">Version {version} · Windows</div>
                    </div>
                </div>
                <div className="mt-5 grid grid-cols-2 gap-2">
                    <a href="https://klypix.com" target="_blank" rel="noreferrer" onClick={(e) => { e.preventDefault(); (window as any).electron?.openExternal?.('https://klypix.com'); }}
                        className="px-3 py-2 rounded-lg bg-white/5 border border-white/10 text-white/85 text-[12px] font-semibold hover:bg-white/10 transition-colors text-center cursor-pointer">
                        {tx('settings.about.website', 'Website')}
                    </a>
                    <a href="mailto:support@klypix.com" onClick={(e) => { e.preventDefault(); (window as any).electron?.openExternal?.('mailto:support@klypix.com'); }}
                        className="px-3 py-2 rounded-lg bg-white/5 border border-white/10 text-white/85 text-[12px] font-semibold hover:bg-white/10 transition-colors text-center cursor-pointer">
                        {tx('settings.about.support', 'Support')}
                    </a>
                </div>
            </div>
            <Note>
                {tx('settings.about.built_by', 'Built by Dahshan Labs. All your data lives locally on this machine except for explicitly synced items.')}
            </Note>
        </Section>
    );
}

// Canvas vault folder — the default location canvas Open/Save dialogs point at.
// Self-contained: reads/writes through the electron.vault bridge (main process
// owns the value, stored in userData), so it needs no prop threading.
function VaultSection({ tx }: { tx: (k: string, fb: string) => string }) {
    const [path, setPath] = useState<string>('');
    useEffect(() => {
        (window as any).electron?.vault?.getDefaultPath?.()
            .then((p: string) => { if (typeof p === 'string') setPath(p); })
            .catch(() => { /* handler missing → leave empty (last-used location) */ });
    }, []);
    const persist = (p: string) => { setPath(p); (window as any).electron?.vault?.setDefaultPath?.(p); };
    const choose = async () => {
        const picked = await (window as any).electron?.vault?.chooseFolder?.();
        if (typeof picked === 'string' && picked) persist(picked);
    };
    return (
        <Section
            title={tx('settings.tab.canvas', 'Canvas')}
            caption={tx('settings.vault.caption', 'Choose the folder your .klypix canvases live in. Open & Save dialogs start here. Leave unset to use your last-used location.')}
        >
            <div className="rounded-xl bg-white/[0.03] border border-white/10 p-4 flex flex-col gap-3">
                <div className="text-[11px] uppercase tracking-wider text-white/40">{tx('settings.vault.folder', 'Vault folder')}</div>
                <div className="text-[13px] text-white/80 break-all min-h-[18px]">
                    {path || <span className="text-white/35">{tx('settings.vault.unset', 'Not set — dialogs open in your last-used location')}</span>}
                </div>
                <div className="flex items-center gap-2 flex-wrap">
                    <button
                        onClick={choose}
                        className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-emerald-500/15 text-emerald-300 hover:bg-emerald-500/25 text-[12.5px] font-medium transition-colors"
                    >
                        <FolderOpen size={14} />
                        {tx('settings.vault.choose', 'Choose folder')}
                    </button>
                    {path && (
                        <>
                            <button
                                onClick={() => (window as any).electron?.openExternal?.(path)}
                                className="px-3 py-1.5 rounded-lg bg-white/5 text-white/60 hover:bg-white/10 text-[12.5px] transition-colors"
                            >
                                {tx('settings.vault.open', 'Open folder')}
                            </button>
                            <button
                                onClick={() => persist('')}
                                className="px-3 py-1.5 rounded-lg text-white/40 hover:text-white/70 text-[12.5px] transition-colors"
                            >
                                {tx('settings.vault.reset', 'Reset')}
                            </button>
                        </>
                    )}
                </div>
            </div>
        </Section>
    );
}

// One-click "Connect to Claude": writes the klypix-mcp server into the user's
// claude_desktop_config.json (atomically, preserving their other servers) so
// their everyday agent can read & write their canvases with no manual config.
function MCPConnectionSection({ tx }: { tx: (k: string, fb: string) => string }) {
    const mcp = (window as any).electron?.mcp;
    const [info, setInfo] = useState<any>(null);
    const [busy, setBusy] = useState(false);
    const [result, setResult] = useState<{ ok: boolean; msg: string } | null>(null);
    const refresh = () => {
        mcp?.detectClaudeDesktop?.()
            .then((r: any) => setInfo(r))
            .catch(() => setInfo({ unavailable: true }));
    };
    useEffect(() => { refresh(); }, []);

    const connect = async () => {
        if (!mcp?.connectClaudeDesktop) return;
        setBusy(true); setResult(null);
        try {
            const r = await mcp.connectClaudeDesktop();
            if (r?.ok) {
                setResult({ ok: true, msg: r.action === 'unchanged'
                    ? tx('settings.mcp.unchanged', "Already connected. If you don't see the tools, restart Claude Desktop.")
                    : tx('settings.mcp.connected', 'Connected! Restart Claude Desktop, then ask it to "list my canvases".') });
                refresh();
            } else {
                setResult({ ok: false, msg: r?.error || tx('settings.mcp.failed', 'Could not write the Claude config.') });
            }
        } catch (e: any) {
            setResult({ ok: false, msg: e?.message || tx('settings.mcp.failed', 'Could not write the Claude config.') });
        } finally { setBusy(false); }
    };

    const connectOther = async (client: 'cursor' | 'cline' | 'claudecode') => {
        if (!mcp?.connectClient) return;
        setBusy(true); setResult(null);
        try {
            const r = await mcp.connectClient(client);
            const label = client === 'claudecode' ? 'Claude Code' : client.charAt(0).toUpperCase() + client.slice(1);
            setResult({ ok: !!r?.ok, msg: r?.ok ? `Connected to ${label} — restart it to see your canvas tools.` : (r?.error || `Could not connect ${label}.`) });
        } catch (e: any) {
            setResult({ ok: false, msg: e?.message || `Could not connect ${client}.` });
        } finally { setBusy(false); }
    };

    const connected = !!info?.connectedAs;
    const parseError = info?.parseError;

    return (
        <Section
            title={tx('settings.mcp.title', 'Connect to Claude')}
            caption={tx('settings.mcp.caption', 'One click lets Claude Desktop read & write your canvases — no config files to edit. Your other MCP servers stay intact.')}
        >
            <div className="rounded-xl bg-white/[0.03] border border-white/10 p-4 flex flex-col gap-3">
                <div className="flex items-start gap-2 text-[12.5px]">
                    {connected
                        ? <Check size={15} className="text-emerald-400 mt-0.5 shrink-0" />
                        : <Plug size={15} className="text-white/45 mt-0.5 shrink-0" />}
                    <div className="text-white/75">
                        {info == null && tx('settings.mcp.checking', 'Checking your Claude Desktop config…')}
                        {info?.unavailable && tx('settings.mcp.unavailable', 'Connection helper unavailable in this build.')}
                        {info && !info.unavailable && (connected
                            ? tx('settings.mcp.isConnected', 'Your canvases are connected to Claude Desktop.') + (info.connectedAs ? ` (${info.connectedAs})` : '')
                            : info.found
                                ? tx('settings.mcp.foundNotConnected', 'Claude Desktop found — not connected yet.')
                                : tx('settings.mcp.notFound', "No Claude Desktop config yet — we'll create one when you connect."))}
                    </div>
                </div>

                {info?.vault && (
                    <div className="text-[11.5px] text-white/45">
                        {tx('settings.mcp.vaultLine', 'Agent reads canvases from:')} <span className="text-white/70 break-all">{info.vault}</span>
                        <span className="text-white/30"> · {tx('settings.mcp.vaultHint', 'change in the Vault section above')}</span>
                    </div>
                )}

                {parseError && (
                    <div className="flex items-start gap-2 text-[12px] text-amber-300/90 bg-amber-500/10 border border-amber-500/20 rounded-lg p-2.5">
                        <AlertCircle size={14} className="mt-0.5 shrink-0" />
                        <span>{parseError}</span>
                    </div>
                )}

                <div className="flex items-center gap-2 flex-wrap">
                    <button
                        onClick={connect}
                        disabled={busy || !!parseError}
                        className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-emerald-500/15 text-emerald-300 hover:bg-emerald-500/25 disabled:opacity-40 disabled:cursor-not-allowed text-[12.5px] font-medium transition-colors"
                    >
                        {busy ? <Loader2 size={14} className="animate-spin" /> : <Plug size={14} />}
                        {connected ? tx('settings.mcp.update', 'Update connection') : tx('settings.mcp.connect', 'Connect to Claude')}
                    </button>
                    {info?.path && (
                        <button
                            onClick={() => (window as any).electron?.openExternal?.(info.path)}
                            className="px-3 py-1.5 rounded-lg bg-white/5 text-white/55 hover:bg-white/10 text-[12.5px] transition-colors"
                            title={info.path}
                        >
                            {tx('settings.mcp.openConfig', 'Open config')}
                        </button>
                    )}
                </div>

                <div className="flex items-center gap-2 flex-wrap pt-0.5">
                    <span className="text-[11px] text-white/35">{tx('settings.mcp.also', 'Also connect (same canvases):')}</span>
                    <button onClick={() => connectOther('claudecode')} disabled={busy} className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-white/5 text-white/65 hover:bg-white/10 disabled:opacity-40 text-[11.5px] transition-colors"><Terminal size={12} />Claude Code</button>
                    <button onClick={() => connectOther('cursor')} disabled={busy} className="px-2.5 py-1 rounded-lg bg-white/5 text-white/55 hover:bg-white/10 disabled:opacity-40 text-[11.5px] transition-colors">Cursor</button>
                    <button onClick={() => connectOther('cline')} disabled={busy} className="px-2.5 py-1 rounded-lg bg-white/5 text-white/55 hover:bg-white/10 disabled:opacity-40 text-[11.5px] transition-colors">Cline</button>
                </div>

                {result && (
                    <div className={cn('flex items-start gap-2 text-[12px] rounded-lg p-2.5 border',
                        result.ok ? 'text-emerald-300 bg-emerald-500/10 border-emerald-500/20' : 'text-red-300 bg-red-500/10 border-red-500/20')}>
                        {result.ok ? <Check size={14} className="mt-0.5 shrink-0" /> : <AlertCircle size={14} className="mt-0.5 shrink-0" />}
                        <span>{result.msg}</span>
                    </div>
                )}

                {connected && Array.isArray(info?.otherServers) && info.otherServers.length > 0 && (
                    <div className="text-[11px] text-white/35">
                        {tx('settings.mcp.preserved', 'Other MCP servers kept:')} {info.otherServers.join(', ')}
                    </div>
                )}
            </div>
        </Section>
    );
}

// ─── Shared primitives ─────────────────────────────────────────────────────

function Section({ title, caption, children }: { title: string; caption: string; children: React.ReactNode }) {
    return (
        <div className="max-w-[680px]">
            <div className="mb-5">
                <h1 className="text-[20px] font-bold text-white/95 tracking-tight">{title}</h1>
                {caption && <p className="text-[12.5px] text-white/50 mt-1">{caption}</p>}
            </div>
            <div className="flex flex-col gap-3">{children}</div>
        </div>
    );
}

function SettingRow({ label, description, children, vertical }: { label: string; description?: string; children: React.ReactNode; vertical?: boolean }) {
    return (
        <div className={cn(
            'p-4 rounded-xl bg-white/[0.025] border border-white/8 transition-colors',
            vertical ? 'flex flex-col gap-3' : 'flex items-center justify-between gap-4',
        )}>
            <div className="flex-1 min-w-0">
                <div className="text-[13px] font-semibold text-white/90">{label}</div>
                {description && <div className="text-[11.5px] text-white/45 mt-0.5 leading-snug">{description}</div>}
            </div>
            <div className={vertical ? 'w-full' : ''}>{children}</div>
        </div>
    );
}

function Switch({ checked, onChange, disabled }: { checked: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
    return (
        <button
            onClick={() => !disabled && onChange(!checked)}
            disabled={disabled}
            className={cn(
                'relative w-11 h-6 rounded-full transition-all duration-200',
                checked ? 'bg-emerald-500' : 'bg-white/15',
                disabled ? 'opacity-40 cursor-not-allowed' : 'cursor-pointer',
            )}
        >
            <span
                className={cn(
                    'absolute top-0.5 w-5 h-5 rounded-full bg-white shadow-md transition-all duration-200',
                    checked ? 'left-[22px]' : 'left-0.5',
                )}
            />
        </button>
    );
}

function ChoicePill({ active, onClick, icon: Icon, label }: { active: boolean; onClick: () => void; icon: typeof Globe; label: string }) {
    return (
        <button
            onClick={onClick}
            className={cn(
                'flex items-center gap-2 px-3 py-2 rounded-lg border text-[12px] font-semibold transition-all cursor-pointer',
                active
                    ? 'bg-emerald-500/15 border-emerald-500/40 text-emerald-300'
                    : 'bg-white/[0.04] border-white/10 text-white/70 hover:bg-white/8',
            )}
        >
            <Icon size={13} />
            {label}
        </button>
    );
}

function Note({ children }: { children: React.ReactNode }) {
    return (
        <div className="mt-3 p-3 rounded-lg bg-white/[0.02] border border-white/5 text-[11.5px] text-white/55 leading-relaxed">
            {children}
        </div>
    );
}
