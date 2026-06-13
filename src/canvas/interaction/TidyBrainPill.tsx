import { Sprout, X } from 'lucide-react';
import { t, useLocale } from '../../i18n/strings';

// The brain offers to tidy ITSELF — the discoverable, no-slash path to the
// gardener. Appears only when there's genuinely something to consolidate
// (computed by selectConsolidationCandidates, so it's silent on normal
// canvases and below threshold), and only on the active tab. One click runs
// the gardener; ✕ dismisses it for this view. Bottom-left, clear of the
// command bar (bottom-center), status bar, and the AI Activity tray (top-right).
interface Props {
    cardCount: number;
    areaCount: number;
    onTidy: () => void;
    onDismiss: () => void;
}

export function TidyBrainPill({ cardCount, areaCount, onTidy, onDismiss }: Props) {
    useLocale();
    const label = t('canvas.tidy.suggest')
        .replace('{cards}', String(cardCount))
        .replace('{areas}', String(areaCount));
    return (
        <div data-canvas-ui="1" className="absolute bottom-4 left-16 z-40 no-drag animate-in fade-in slide-in-from-left-1 duration-200">
            <div className="flex items-center gap-2 pl-2.5 pr-1.5 py-1.5 rounded-2xl bg-[#12121a]/95 backdrop-blur-xl border border-blue-400/30 shadow-[0_8px_32px_rgba(0,0,0,0.5)]">
                <Sprout size={15} className="text-blue-300 shrink-0" />
                <span className="text-[12px] text-white/75 max-w-[260px] truncate">{label}</span>
                <button
                    onClick={onTidy}
                    className="text-[12px] font-medium px-2.5 py-1 rounded-lg bg-blue-400/15 text-blue-200 hover:bg-blue-400/30 transition-all cursor-pointer shrink-0"
                >
                    {t('canvas.tidy.action')}
                </button>
                <button
                    onClick={onDismiss}
                    title={t('canvas.command_bar.close_hint')}
                    className="w-6 h-6 flex items-center justify-center rounded-full text-white/35 hover:bg-white/10 hover:text-white/70 transition-all cursor-pointer shrink-0"
                >
                    <X size={11} />
                </button>
            </div>
        </div>
    );
}
