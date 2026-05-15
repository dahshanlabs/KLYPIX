import React from 'react';
import {
    AlignStartVertical, AlignCenterVertical, AlignEndVertical,
    AlignStartHorizontal, AlignCenterHorizontal, AlignEndHorizontal,
    AlignHorizontalDistributeCenter, AlignVerticalDistributeCenter,
} from 'lucide-react';
import type { AlignOp } from './alignItems';

// Submenu body for the right-click "Align items ▸" entry. Two rows of
// six edge-snap buttons plus a Distribute row underneath. Distribute
// buttons disable when the selection has fewer than 3 items (nothing
// meaningful to spread). Each click commits one op + closes the menu —
// repeat use is via re-opening the menu, same pattern as the existing
// text-alignment grid.

interface Props {
    canDistribute: boolean;
    onPick: (op: AlignOp) => void;
}

export function ItemAlignPanel({ canDistribute, onPick }: Props) {
    return (
        <div
            className="p-2 w-[176px]"
            onPointerDown={(e) => e.stopPropagation()}
            onMouseDown={(e) => e.stopPropagation()}
        >
            <div className="text-[10px] font-semibold uppercase tracking-wide text-white/35 mb-1.5 px-0.5">
                Horizontal
            </div>
            <div className="grid grid-cols-3 gap-1 mb-2">
                <AlignBtn label="Align left"     onClick={() => onPick('align-left')}>
                    <AlignStartVertical size={14} />
                </AlignBtn>
                <AlignBtn label="Align center"   onClick={() => onPick('align-center-h')}>
                    <AlignCenterVertical size={14} />
                </AlignBtn>
                <AlignBtn label="Align right"    onClick={() => onPick('align-right')}>
                    <AlignEndVertical size={14} />
                </AlignBtn>
            </div>
            <div className="text-[10px] font-semibold uppercase tracking-wide text-white/35 mb-1.5 px-0.5">
                Vertical
            </div>
            <div className="grid grid-cols-3 gap-1 mb-2">
                <AlignBtn label="Align top"      onClick={() => onPick('align-top')}>
                    <AlignStartHorizontal size={14} />
                </AlignBtn>
                <AlignBtn label="Align middle"   onClick={() => onPick('align-center-v')}>
                    <AlignCenterHorizontal size={14} />
                </AlignBtn>
                <AlignBtn label="Align bottom"   onClick={() => onPick('align-bottom')}>
                    <AlignEndHorizontal size={14} />
                </AlignBtn>
            </div>
            <div className="h-px bg-white/10 my-1" />
            <div className="text-[10px] font-semibold uppercase tracking-wide text-white/35 mb-1.5 px-0.5">
                Distribute
            </div>
            <div className="grid grid-cols-2 gap-1">
                <AlignBtn
                    label={canDistribute ? 'Distribute horizontally' : 'Distribute (need 3+ items)'}
                    disabled={!canDistribute}
                    onClick={() => onPick('distribute-h')}
                >
                    <AlignHorizontalDistributeCenter size={14} />
                </AlignBtn>
                <AlignBtn
                    label={canDistribute ? 'Distribute vertically' : 'Distribute (need 3+ items)'}
                    disabled={!canDistribute}
                    onClick={() => onPick('distribute-v')}
                >
                    <AlignVerticalDistributeCenter size={14} />
                </AlignBtn>
            </div>
        </div>
    );
}

interface AlignBtnProps {
    label: string;
    disabled?: boolean;
    onClick: () => void;
    children: React.ReactNode;
}
function AlignBtn({ label, disabled, onClick, children }: AlignBtnProps) {
    return (
        <button
            title={label}
            disabled={disabled}
            onClick={onClick}
            className={`h-8 flex items-center justify-center rounded-md transition-colors ${
                disabled
                    ? 'opacity-30 cursor-not-allowed text-white/40'
                    : 'bg-white/5 text-white/65 hover:bg-emerald-500/20 hover:text-emerald-300 cursor-pointer'
            }`}
        >
            {children}
        </button>
    );
}
