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
}

export function ModeTabs({ active, onChange }: ModeTabsProps) {
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
            />
        </div>
    );
}

interface TabButtonProps {
    icon: React.ReactNode;
    label: string;
    active: boolean;
    onClick: () => void;
}

function TabButton({ icon, label, active, onClick }: TabButtonProps) {
    return (
        <button
            onClick={onClick}
            className={cn(
                'flex items-center gap-1 px-2.5 py-0.5 rounded-full text-[9px] font-bold uppercase tracking-widest transition-all cursor-pointer',
                active
                    ? 'bg-emerald-500/20 text-emerald-300 shadow-[0_0_10px_rgba(16,185,129,0.2)]'
                    : 'text-white/40 hover:text-white/70 hover:bg-white/5'
            )}
        >
            {icon}
            <span>{label}</span>
        </button>
    );
}
