import React from 'react';
import { X, FileSpreadsheet, FileText, Presentation, FileType, Image, Code, File } from 'lucide-react';
import type { GenerationFormat } from '../core/docGeneration';
import { FORMAT_LABELS } from '../core/docGeneration';

interface FormatPickerProps {
    formats: GenerationFormat[];
    onSelect: (format: GenerationFormat) => void;
    onCancel: () => void;
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

export function FormatPicker({ formats, onSelect, onCancel }: FormatPickerProps) {
    return (
        <div className="bg-[#1a1a1a] border border-white/10 rounded-xl p-4 shadow-xl mb-3">
            <div className="flex items-center justify-between mb-3">
                <span className="text-white/60 text-xs font-medium uppercase tracking-wider">What format?</span>
                <button onClick={onCancel} className="text-white/30 hover:text-white/60 transition-colors cursor-pointer">
                    <X size={14} />
                </button>
            </div>
            <div className="flex flex-wrap gap-2">
                {formats.map(fmt => {
                    const Icon = FORMAT_ICONS[fmt] || File;
                    return (
                        <button
                            key={fmt}
                            onClick={() => onSelect(fmt)}
                            className="flex items-center gap-2 px-3 py-2 bg-white/5 hover:bg-emerald-500/20 border border-white/10 hover:border-emerald-500/30 rounded-lg text-white/70 hover:text-white text-sm transition-all cursor-pointer"
                        >
                            <Icon size={14} />
                            {FORMAT_LABELS[fmt]}
                        </button>
                    );
                })}
            </div>
        </div>
    );
}
