import React from 'react';
import { MessageCircle, LayoutGrid } from 'lucide-react';
import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';
import { t, useLocale } from '../i18n/strings';

const cn = (...inputs: ClassValue[]) => twMerge(clsx(inputs));

export type AppTab = 'chat' | 'canvas';

interface ModeTabsProps {
    active: AppTab;
    onChange: (tab: AppTab) => void;
    /** Count of pending canvas invitations — renders a badge on the Canvas
     *  tab so the user notices them from Chat/Agent without opening Canvas.
     *  0 / undefined → no badge. */
    canvasBadge?: number;
}

export function ModeTabs({ active, onChange, canvasBadge }: ModeTabsProps) {
    useLocale();
    return (
        <div className="no-drag flex items-center gap-0.5 px-1 py-0.5 rounded-full bg-black/40 border border-white/10 shadow-[0_2px_10px_rgba(0,0,0,0.3)]">
            <TabButton
                icon={<MessageCircle size={10} />}
                label={t('chat.tab.chat')}
                active={active === 'chat'}
                onClick={() => onChange('chat')}
            />
            <TabButton
                icon={<LayoutGrid size={10} />}
                label={t('chat.tab.canvas')}
                active={active === 'canvas'}
                onClick={() => onChange('canvas')}
                badge={canvasBadge}
            />
        </div>
    );
}

interface TabButtonProps {
    icon: React.ReactNode;
    label: string;
    active: boolean;
    onClick: () => void;
    badge?: number;
}

function TabButton({ icon, label, active, onClick, badge }: TabButtonProps) {
    return (
        <button
            onClick={onClick}
            className={cn(
                'relative flex items-center gap-1 px-2.5 py-0.5 rounded-full text-[9px] font-bold uppercase tracking-widest transition-all cursor-pointer',
                active
                    ? 'bg-emerald-500/20 text-emerald-300 shadow-[0_0_10px_rgba(16,185,129,0.2)]'
                    : 'text-white/40 hover:text-white/70 hover:bg-white/5'
            )}
        >
            {icon}
            <span>{label}</span>
            {!!badge && badge > 0 && (
                <span
                    className="absolute -top-1 -right-1 min-w-[14px] h-[14px] rounded-full bg-emerald-500 text-black text-[8px] font-bold flex items-center justify-center px-[3px] tracking-normal"
                    style={{ lineHeight: 1 }}
                >
                    {badge > 9 ? '9+' : badge}
                </span>
            )}
        </button>
    );
}
