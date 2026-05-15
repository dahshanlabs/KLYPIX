import React, { useEffect, useRef, useState } from 'react';

// Small centered text-input modal used anywhere we'd normally reach for
// window.prompt(). Electron's renderer disables window.prompt entirely —
// it returns an empty string and logs a warning — so tag names, comment
// bodies, template names etc. were silently never captured.

interface Props {
    title: string;
    placeholder?: string;
    defaultValue?: string;
    submitLabel?: string;
    onSubmit: (value: string) => void;
    onCancel: () => void;
}

export function InlinePrompt({
    title,
    placeholder,
    defaultValue,
    submitLabel = 'OK',
    onSubmit,
    onCancel,
}: Props) {
    const [value, setValue] = useState(defaultValue ?? '');
    const inputRef = useRef<HTMLInputElement>(null);

    useEffect(() => {
        inputRef.current?.focus();
        inputRef.current?.select();
        const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') onCancel(); };
        window.addEventListener('keydown', esc);
        return () => window.removeEventListener('keydown', esc);
    }, [onCancel]);

    const submit = () => {
        const v = value.trim();
        if (!v) { onCancel(); return; }
        onSubmit(v);
    };

    return (
        <div
            data-canvas-ui="1"
            className="fixed inset-0 z-[90] flex items-center justify-center bg-black/40 no-drag"
            onPointerDown={(e) => { if (e.target === e.currentTarget) onCancel(); }}
        >
            <div
                className="min-w-[320px] max-w-[420px] bg-[#12121a] border border-white/10 rounded-xl shadow-[0_20px_60px_rgba(0,0,0,0.6)] p-4"
                onPointerDown={(e) => e.stopPropagation()}
            >
                <div className="text-[13px] font-medium text-white/80 mb-2">{title}</div>
                <input
                    ref={inputRef}
                    type="text"
                    value={value}
                    placeholder={placeholder}
                    onChange={(e) => setValue(e.target.value)}
                    onKeyDown={(e) => {
                        if (e.key === 'Enter') { e.preventDefault(); submit(); }
                    }}
                    className="w-full px-3 py-2 bg-black/40 border border-white/10 rounded-md text-[13px] text-white placeholder-white/30 outline-none focus:border-emerald-500/60"
                />
                <div className="flex items-center justify-end gap-2 mt-3">
                    <button
                        onClick={onCancel}
                        className="px-3 py-1.5 text-[12px] text-white/60 hover:text-white/90 rounded-md hover:bg-white/5"
                    >
                        Cancel
                    </button>
                    <button
                        onClick={submit}
                        className="px-3 py-1.5 text-[12px] text-white bg-emerald-500/80 hover:bg-emerald-500 rounded-md"
                    >
                        {submitLabel}
                    </button>
                </div>
            </div>
        </div>
    );
}
