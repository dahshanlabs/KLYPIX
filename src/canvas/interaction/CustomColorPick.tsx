import React, { useRef } from 'react';

// "+" swatch that opens the OS native color picker for picking any
// color outside the 6-swatch palette. Sized to match the other palette
// chips (16×16, rounded full). The hidden <input type="color"> sits
// over the visual, so clicking the visual triggers the picker.
//
// Native color input semantics: onChange fires once when the picker
// closes with a selected color (not continuously during drag), so a
// single commit per pick — no history stacking. onInput would fire
// continuously during drag; we deliberately ignore it.

interface Props {
    onCommit: (c: string) => void;
    seed?: string;                // the color the picker opens to
}

export function CustomColorPick({ onCommit, seed }: Props) {
    const inputRef = useRef<HTMLInputElement>(null);
    return (
        <div className="relative w-4 h-4 shrink-0">
            <input
                ref={inputRef}
                type="color"
                defaultValue={seed || '#10b981'}
                onChange={(e) => onCommit((e.target as HTMLInputElement).value)}
                className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
                title="Custom color"
            />
            <div
                className="w-full h-full rounded-full ring-1 ring-white/20 hover:ring-white/60 flex items-center justify-center text-[9px] leading-none font-semibold text-white/75 pointer-events-none"
                style={{
                    background: 'conic-gradient(from 0deg, #ef4444, #f5a623, #10b981, #3b82f6, #a855f7, #ef4444)',
                }}
            >
                +
            </div>
        </div>
    );
}
