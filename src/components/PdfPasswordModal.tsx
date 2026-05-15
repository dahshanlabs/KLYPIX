import React, { useState, useRef, useEffect } from 'react';
import { Lock, X, Loader2 } from 'lucide-react';

interface PdfPasswordModalProps {
    fileName: string;
    filePath: string;
    onSubmit: (password: string) => Promise<boolean>;
    onDismiss: () => void;
}

export function PdfPasswordModal({ fileName, filePath, onSubmit, onDismiss }: PdfPasswordModalProps) {
    const [password, setPassword] = useState('');
    const [error, setError] = useState('');
    const [loading, setLoading] = useState(false);
    const inputRef = useRef<HTMLInputElement>(null);

    useEffect(() => {
        setTimeout(() => inputRef.current?.focus(), 100);
    }, []);

    const handleSubmit = async () => {
        if (!password.trim()) return;
        setLoading(true);
        setError('');
        const success = await onSubmit(password.trim());
        setLoading(false);
        if (!success) {
            setError('Incorrect password. Try again.');
            setPassword('');
            inputRef.current?.focus();
        }
    };

    return (
        <div className="mx-4 my-2 rounded-xl border border-amber-500/20 bg-amber-500/5 backdrop-blur-sm overflow-hidden" style={{ WebkitAppRegion: 'no-drag' } as any}>
            <div className="p-4">
                <div className="flex items-start gap-3">
                    <div className="w-9 h-9 rounded-lg bg-amber-500/15 flex items-center justify-center shrink-0 mt-0.5">
                        <Lock size={16} className="text-amber-400" />
                    </div>
                    <div className="flex-1 min-w-0">
                        <div className="text-white/90 text-sm font-medium mb-1">Password Required</div>
                        <div className="text-white/40 text-xs mb-3 truncate">
                            <span className="text-amber-400/80 font-mono">{fileName}</span> is password-protected.
                        </div>
                        <div className="flex items-center gap-2">
                            <input
                                ref={inputRef}
                                type="password"
                                value={password}
                                onChange={(e) => setPassword(e.target.value)}
                                onKeyDown={(e) => { if (e.key === 'Enter') handleSubmit(); if (e.key === 'Escape') onDismiss(); }}
                                placeholder="Enter PDF password..."
                                className="flex-1 bg-white/5 border border-white/10 rounded-lg px-3 py-1.5 text-sm text-white/80 placeholder:text-white/30 outline-none focus:border-amber-500/50 transition-colors"
                            />
                            <button
                                onClick={handleSubmit}
                                disabled={loading || !password.trim()}
                                className="px-3 py-1.5 bg-amber-600 hover:bg-amber-500 disabled:opacity-50 text-white text-xs font-medium rounded-lg transition-all cursor-pointer flex items-center gap-1.5"
                            >
                                {loading ? <Loader2 size={12} className="animate-spin" /> : null}
                                Unlock
                            </button>
                        </div>
                        {error && (
                            <div className="text-red-400 text-xs mt-2">{error}</div>
                        )}
                        <div className="text-white/25 text-[10px] mt-2">
                            Or drag & drop the file as an attachment instead.
                        </div>
                    </div>
                    <button onClick={onDismiss} className="text-white/30 hover:text-white/60 cursor-pointer p-1 shrink-0">
                        <X size={14} />
                    </button>
                </div>
            </div>
        </div>
    );
}
