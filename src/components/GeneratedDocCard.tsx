import React from 'react';
import { Download, RefreshCw, FileSpreadsheet, FileText, Presentation, FileType, Image, Code, File, Check } from 'lucide-react';
import type { GeneratedDoc } from '../hooks/useDocGenerator';
import { FORMAT_LABELS } from '../core/docGeneration';

interface GeneratedDocCardProps {
    doc: GeneratedDoc;
    isGenerating: boolean;
    genProgress: string;
    onDownload: () => void;
    onRevise: (instruction: string) => void;
    onConvert?: (targetFormat: string) => void;
    onDismiss?: () => void;
    onCancel?: () => void;
}

const FORMAT_ICONS: Record<string, any> = {
    xlsx: FileSpreadsheet,
    docx: FileText,
    pptx: Presentation,
    pdf: FileType,
    image: Image,
    md: FileText,
    txt: File,
    csv: FileSpreadsheet,
    json: Code,
    code: Code,
};

const CONVERSION_TARGETS: Record<string, string[]> = {
    pdf: ['docx', 'pptx', 'txt'],
    docx: ['pdf', 'pptx', 'txt'],
    pptx: ['pdf', 'docx'],
    xlsx: ['csv', 'pdf'],
    txt: ['pdf', 'docx'],
    md: ['pdf', 'docx'],
    csv: ['xlsx', 'pdf'],
};

const FORMAT_SHORT: Record<string, string> = {
    pdf: 'PDF', docx: 'Word', pptx: 'PPT', xlsx: 'Excel',
    csv: 'CSV', txt: 'TXT', md: 'MD', json: 'JSON',
};

// Generation stages for animated progress
const GEN_STAGES = [
    { label: 'Reading context', duration: 1500 },
    { label: 'Analyzing content', duration: 2000 },
    { label: 'Structuring document', duration: 3000 },
    { label: 'Rendering output', duration: 2000 },
];

export function GeneratedDocCard({ doc, isGenerating, genProgress, onDownload, onRevise, onConvert, onDismiss, onCancel }: GeneratedDocCardProps) {
    const [downloaded, setDownloaded] = React.useState(false);
    const [showReviseInput, setShowReviseInput] = React.useState(false);
    const [reviseText, setReviseText] = React.useState('');
    const [genStage, setGenStage] = React.useState(0);
    const [progressWidth, setProgressWidth] = React.useState(0);
    const reviseInputRef = React.useRef<HTMLInputElement>(null);
    const stageTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
    const Icon = FORMAT_ICONS[doc.format] || File;

    // Animated stage progression
    React.useEffect(() => {
        if (isGenerating) {
            setGenStage(0);
            setProgressWidth(5);
            let currentStage = 0;
            const advanceStage = () => {
                currentStage++;
                if (currentStage < GEN_STAGES.length) {
                    setGenStage(currentStage);
                    setProgressWidth(Math.min(15 + currentStage * 25, 85));
                    stageTimerRef.current = setTimeout(advanceStage, GEN_STAGES[currentStage].duration);
                }
            };
            stageTimerRef.current = setTimeout(advanceStage, GEN_STAGES[0].duration);
            // Start progress animation
            setTimeout(() => setProgressWidth(15), 100);
        } else {
            setProgressWidth(100);
            setTimeout(() => { setProgressWidth(0); setGenStage(0); }, 600);
            if (stageTimerRef.current) clearTimeout(stageTimerRef.current);
        }
        return () => { if (stageTimerRef.current) clearTimeout(stageTimerRef.current); };
    }, [isGenerating]);

    const handleDownload = async () => {
        await onDownload();
        setDownloaded(true);
        setTimeout(() => setDownloaded(false), 2000);
    };

    return (
        <div className="bg-[#1a1a1a] border border-white/10 rounded-xl overflow-hidden mb-3" style={{ WebkitAppRegion: 'no-drag' } as any}>
            {/* Header */}
            <div className="flex items-center gap-2.5 px-4 py-2.5 border-b border-white/5 relative overflow-hidden">
                {/* Animated icon */}
                <div className={isGenerating ? 'animate-pulse' : ''}>
                    <Icon size={16} className={isGenerating ? 'text-emerald-400 animate-spin' : 'text-emerald-400'} style={isGenerating ? { animationDuration: '2s' } : undefined} />
                </div>
                <div className="flex flex-col">
                    <span className="text-white/80 text-sm font-medium">{FORMAT_LABELS[doc.format]}</span>
                    {isGenerating && (
                        <span className="text-emerald-400/70 text-[10px] font-medium animate-pulse">
                            {GEN_STAGES[genStage]?.label || 'Generating'}...
                        </span>
                    )}
                </div>
                <span className="text-white/30 text-xs ml-auto">{doc.filename}</span>
                {onDismiss && !isGenerating && (
                    <button onClick={onDismiss} className="text-white/20 hover:text-white/50 transition-colors cursor-pointer p-1 -m-1 ml-2" title="Dismiss">
                        <svg width="10" height="10" viewBox="0 0 10 10"><path d="M1 1L9 9M9 1L1 9" stroke="currentColor" strokeWidth="1.5" /></svg>
                    </button>
                )}
                {/* Progress bar */}
                {(isGenerating || progressWidth > 0) && (
                    <div className="absolute bottom-0 left-0 right-0 h-[2px] bg-white/5">
                        <div
                            className="h-full bg-gradient-to-r from-emerald-500 to-emerald-400 transition-all ease-out"
                            style={{ width: `${progressWidth}%`, transitionDuration: isGenerating ? '2s' : '0.4s' }}
                        />
                    </div>
                )}
            </div>

            {/* Preview */}
            <div className="px-4 py-3">
                {isGenerating && !doc.preview ? (
                    /* Animated loading skeleton */
                    <div className="space-y-2.5">
                        <div className="flex items-center gap-3 mb-3">
                            <div className="w-8 h-8 rounded-lg bg-emerald-500/10 flex items-center justify-center">
                                <Icon size={16} className="text-emerald-400 animate-pulse" />
                            </div>
                            <div className="flex-1 space-y-1.5">
                                <div className="h-2.5 bg-white/[0.06] rounded-full w-3/4 animate-pulse" />
                                <div className="h-2 bg-white/[0.04] rounded-full w-1/2 animate-pulse" style={{ animationDelay: '150ms' }} />
                            </div>
                        </div>
                        {/* Skeleton lines */}
                        <div className="space-y-2">
                            <div className="h-2 bg-white/[0.05] rounded-full w-full animate-pulse" style={{ animationDelay: '100ms' }} />
                            <div className="h-2 bg-white/[0.04] rounded-full w-5/6 animate-pulse" style={{ animationDelay: '200ms' }} />
                            <div className="h-2 bg-white/[0.05] rounded-full w-4/6 animate-pulse" style={{ animationDelay: '300ms' }} />
                            <div className="h-2 bg-white/[0.03] rounded-full w-3/6 animate-pulse" style={{ animationDelay: '400ms' }} />
                        </div>
                        {genProgress && (
                            <pre className="text-white/30 text-[10px] font-mono whitespace-pre-wrap mt-2 max-h-[80px] overflow-y-auto">
                                {genProgress}
                            </pre>
                        )}
                    </div>
                ) : doc.format === 'image' && doc.imageBase64 ? (
                    <img
                        src={`data:${doc.imageMimeType || 'image/png'};base64,${doc.imageBase64}`}
                        alt="Generated"
                        className="max-w-full max-h-[300px] rounded-lg border border-white/10"
                    />
                ) : (
                    <pre className="text-white/60 text-xs font-mono whitespace-pre-wrap max-h-[200px] overflow-y-auto leading-relaxed">
                        {doc.preview || genProgress}
                    </pre>
                )}
            </div>

            {/* Actions */}
            <div className="flex gap-2 px-4 py-2.5 border-t border-white/5">
                {isGenerating && onCancel ? (
                    <button
                        onClick={onCancel}
                        className="flex items-center gap-1.5 px-3 py-1.5 bg-red-600/80 hover:bg-red-500 text-white text-xs font-medium rounded-lg transition-all cursor-pointer"
                    >
                        <svg width="10" height="10" viewBox="0 0 10 10" fill="currentColor"><rect width="10" height="10" rx="1"/></svg>
                        Stop Generation
                    </button>
                ) : (
                    <button
                        onClick={handleDownload}
                        disabled={isGenerating}
                        className="flex items-center gap-1.5 px-3 py-1.5 bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-medium rounded-lg transition-all disabled:opacity-50 cursor-pointer"
                    >
                        {downloaded ? <Check size={12} /> : <Download size={12} />}
                        {downloaded ? 'Saved' : `Download .${doc.format === 'image' ? 'png' : doc.format}`}
                    </button>
                )}
                {!showReviseInput ? (
                    <button
                        onClick={() => { setShowReviseInput(true); setTimeout(() => reviseInputRef.current?.focus(), 100); }}
                        disabled={isGenerating}
                        className="flex items-center gap-1.5 px-3 py-1.5 bg-white/5 hover:bg-white/10 text-white/60 text-xs font-medium rounded-lg transition-all disabled:opacity-50 cursor-pointer"
                    >
                        <RefreshCw size={12} />
                        Revise
                    </button>
                ) : (
                    <div className="flex items-center gap-1.5 flex-1">
                        <input
                            ref={reviseInputRef}
                            value={reviseText}
                            onChange={(e) => setReviseText(e.target.value)}
                            onKeyDown={(e) => {
                                if (e.key === 'Enter' && reviseText.trim()) {
                                    onRevise(reviseText.trim());
                                    setReviseText('');
                                    setShowReviseInput(false);
                                }
                                if (e.key === 'Escape') { setShowReviseInput(false); setReviseText(''); }
                            }}
                            placeholder="What to change..."
                            className="flex-1 bg-white/5 border border-white/10 rounded-lg px-2 py-1.5 text-xs text-white/80 placeholder:text-white/30 outline-none focus:border-emerald-500/50"
                        />
                        <button
                            onClick={() => { if (reviseText.trim()) { onRevise(reviseText.trim()); setReviseText(''); setShowReviseInput(false); } }}
                            className="px-2 py-1.5 bg-emerald-600 hover:bg-emerald-500 text-white text-xs rounded-lg cursor-pointer"
                        >
                            Go
                        </button>
                        <button
                            onClick={() => { setShowReviseInput(false); setReviseText(''); }}
                            className="text-white/30 hover:text-white/60 cursor-pointer px-1"
                        >
                            <svg width="10" height="10" viewBox="0 0 10 10"><path d="M1 1L9 9M9 1L1 9" stroke="currentColor" strokeWidth="1.5" /></svg>
                        </button>
                    </div>
                )}
            </div>

            {/* Convert to other formats */}
            {onConvert && !isGenerating && CONVERSION_TARGETS[doc.format] && (
                <div className="flex items-center gap-1.5 px-4 py-2 border-t border-white/5">
                    <span className="text-white/25 text-[10px] uppercase tracking-wider font-medium mr-1">Convert to</span>
                    {CONVERSION_TARGETS[doc.format]!.map(fmt => (
                        <button
                            key={fmt}
                            onClick={() => onConvert(fmt)}
                            className="px-2 py-1 bg-white/[0.03] hover:bg-white/[0.08] border border-white/[0.06] text-white/40 hover:text-white/70 text-[10px] font-medium rounded-md transition-all cursor-pointer"
                        >
                            {FORMAT_SHORT[fmt] || fmt.toUpperCase()}
                        </button>
                    ))}
                </div>
            )}
        </div>
    );
}
