import React, { useState, useEffect } from 'react';

// ── Onboarding Cards ─────────────────────────────────────────────────────────
// Shows 4 interactive cards on first launch. Each card performs the actual action
// when clicked so the user sees real value immediately. Cards disappear after
// the user's first real interaction (stored in localStorage).

const ONBOARDING_KEY = 'klypix_onboarding_complete';

interface OnboardingCardsProps {
    onScreenshot: () => void;
    onDeepMode: () => void;
    onCommand: (cmd: string) => void;
    onDismiss: () => void;
}

const cards = [
    {
        id: 'screenshot',
        icon: '📸',
        title: 'Capture & analyze screens',
        description: 'Full screen or crop — capture one or compare multiple screenshots in a couple of clicks',
        action: 'screenshot',
        gradient: 'from-emerald-500/10 to-emerald-500/5',
        border: 'border-emerald-500/20',
        iconBg: 'bg-emerald-500/15',
    },
    {
        id: 'deepmode',
        icon: '📂',
        title: 'Read all your open files',
        description: 'I see every open file, tab, and PDF — select any to analyze, compare, or extract data',
        action: 'deepmode',
        gradient: 'from-blue-500/10 to-blue-500/5',
        border: 'border-blue-500/20',
        iconBg: 'bg-blue-500/15',
    },
    {
        id: 'command',
        icon: '⚡',
        title: 'Execute commands & create docs',
        description: '"open notepad" · "create a PDF report" · "export to Excel" · "go to google.com"',
        action: 'command',
        gradient: 'from-purple-500/10 to-purple-500/5',
        border: 'border-purple-500/20',
        iconBg: 'bg-purple-500/15',
    },
    {
        id: 'clipboard',
        icon: '📋',
        title: 'Smart clipboard detection',
        description: 'Copy anything — tables, code, emails, text — I detect it and offer to transform or rewrite',
        action: 'clipboard',
        gradient: 'from-amber-500/10 to-amber-500/5',
        border: 'border-amber-500/20',
        iconBg: 'bg-amber-500/15',
    },
];

export function OnboardingCards({ onScreenshot, onDeepMode, onCommand, onDismiss }: OnboardingCardsProps) {
    const [visible, setVisible] = useState(false);
    const [exitingCard, setExitingCard] = useState<string | null>(null);
    const [dismissed, setDismissed] = useState(false);

    useEffect(() => {
        // Stagger entrance animation
        const timer = setTimeout(() => setVisible(true), 200);
        return () => clearTimeout(timer);
    }, []);

    const handleCardClick = (card: typeof cards[0]) => {
        setExitingCard(card.id);

        setTimeout(() => {
            switch (card.action) {
                case 'screenshot':
                    onScreenshot();
                    break;
                case 'deepmode':
                    onDeepMode();
                    break;
                case 'command':
                    onCommand('open notepad');
                    break;
                case 'clipboard':
                    // Just dismiss — user needs to go copy something
                    break;
            }
            markComplete();
        }, 300);
    };

    const markComplete = () => {
        localStorage.setItem(ONBOARDING_KEY, 'true');
        setDismissed(true);
        setTimeout(() => onDismiss(), 400);
    };

    if (dismissed) return null;

    return (
        <div
            className={`px-4 transition-all duration-500 ${visible ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-4'}`}
            style={{ WebkitAppRegion: 'no-drag' } as any}
        >
            {/* Welcome header */}
            <div className="text-center mb-4 mt-2">
                <h2 className="text-white/90 text-lg font-semibold font-outfit tracking-tight">
                    Welcome to KLYPIX
                </h2>
                <p className="text-white/40 text-xs mt-1">
                    Try any of these to get started
                </p>
            </div>

            {/* Cards grid */}
            <div className="grid grid-cols-2 gap-2.5 mb-3">
                {cards.map((card, index) => (
                    <button
                        key={card.id}
                        onClick={() => handleCardClick(card)}
                        className={`
                            relative text-left p-3 rounded-xl border backdrop-blur-sm
                            bg-gradient-to-br ${card.gradient} ${card.border}
                            hover:scale-[1.02] active:scale-[0.98]
                            transition-all duration-300 cursor-pointer
                            ${exitingCard === card.id ? 'opacity-0 scale-95' : ''}
                        `}
                        style={{
                            transitionDelay: `${index * 80}ms`,
                            opacity: visible ? (exitingCard === card.id ? 0 : 1) : 0,
                            transform: visible
                                ? exitingCard === card.id
                                    ? 'scale(0.95)'
                                    : 'translateY(0)'
                                : 'translateY(12px)',
                        }}
                    >
                        {/* Icon */}
                        <div className={`w-8 h-8 ${card.iconBg} rounded-lg flex items-center justify-center text-base mb-2`}>
                            {card.icon}
                        </div>

                        {/* Text */}
                        <div className="text-white/85 text-[12px] font-medium leading-tight mb-1">
                            {card.title}
                        </div>
                        <div className="text-white/35 text-[10px] leading-snug">
                            {card.description}
                        </div>
                    </button>
                ))}
            </div>

            {/* Multi-screenshot hint */}
            <div className="text-center mb-2">
                <p className="text-white/25 text-[10px]">
                    💡 Capture multiple screenshots to compare them side by side
                </p>
            </div>

            {/* Skip link */}
            <div className="text-center mt-1">
                <button
                    onClick={markComplete}
                    className="text-white/40 text-[11px] hover:text-white/70 transition-colors cursor-pointer px-4 py-1.5 rounded-lg hover:bg-white/5"
                >
                    Skip — I know what I'm doing
                </button>
            </div>
        </div>
    );
}

export function isOnboardingComplete(): boolean {
    return localStorage.getItem(ONBOARDING_KEY) === 'true';
}

export function resetOnboarding(): void {
    localStorage.removeItem(ONBOARDING_KEY);
}
