import React from 'react';

// 3×3 alignment picker — matches the pattern users know from Figma /
// Keynote / PowerPoint. Each cell commits BOTH textAlign (column) and
// verticalAlign (row) in a single click; the current combination is
// highlighted. Consumed by the right-click context menu for bordered
// text items; hidden for plain text (no box = no meaning).

export type TextAlignH = 'left' | 'center' | 'right';
export type TextAlignV = 'top' | 'middle' | 'bottom';

interface Props {
    currentH: TextAlignH;
    currentV: TextAlignV;
    onChange: (h: TextAlignH, v: TextAlignV) => void;
}

const H_VALUES: TextAlignH[] = ['left', 'center', 'right'];
const V_VALUES: TextAlignV[] = ['top', 'middle', 'bottom'];

export function AlignmentGrid({ currentH, currentV, onChange }: Props) {
    return (
        <div
            style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(3, 28px)',
                gridTemplateRows: 'repeat(3, 28px)',
                gap: 2,
                padding: 8,
            }}
            onPointerDown={(e) => e.stopPropagation()}
            onMouseDown={(e) => e.stopPropagation()}
        >
            {V_VALUES.flatMap(v =>
                H_VALUES.map(h => {
                    const isActive = h === currentH && v === currentV;
                    return (
                        <button
                            key={`${h}-${v}`}
                            onClick={(e) => {
                                e.stopPropagation();
                                onChange(h, v);
                            }}
                            style={{
                                width: 28,
                                height: 28,
                                border: isActive
                                    ? '1px solid #10b981'
                                    : '1px solid rgba(255,255,255,0.15)',
                                background: isActive
                                    ? 'rgba(16,185,129,0.35)'
                                    : 'transparent',
                                borderRadius: 4,
                                cursor: 'pointer',
                                display: 'flex',
                                alignItems: v === 'top' ? 'flex-start' : v === 'middle' ? 'center' : 'flex-end',
                                justifyContent: h === 'left' ? 'flex-start' : h === 'center' ? 'center' : 'flex-end',
                                padding: 4,
                                transition: 'background 120ms, border-color 120ms',
                            }}
                            onMouseEnter={(e) => {
                                if (!isActive) e.currentTarget.style.background = 'rgba(16,185,129,0.18)';
                            }}
                            onMouseLeave={(e) => {
                                if (!isActive) e.currentTarget.style.background = 'transparent';
                            }}
                            aria-label={`Align ${v} ${h}`}
                        >
                            <div
                                style={{
                                    width: 6,
                                    height: 6,
                                    borderRadius: '50%',
                                    background: isActive ? '#ffffff' : 'rgba(255,255,255,0.45)',
                                }}
                            />
                        </button>
                    );
                }),
            )}
        </div>
    );
}
