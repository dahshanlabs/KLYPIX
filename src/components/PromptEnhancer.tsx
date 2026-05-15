import React, { useState, useEffect, useCallback } from 'react';
import { X, Sparkles, Zap, ChevronDown, ChevronUp } from 'lucide-react';
import type { EnhancementAnalysis } from '../core/promptEnhancer';
import type { EnhancerField } from '../core/promptEnhancerFields';
import { assembleEnhancedPrompt } from '../core/promptAssembler';

interface PromptEnhancerProps {
  originalPrompt: string;
  analysis: EnhancementAnalysis;
  fields: EnhancerField[];
  initialValues: Record<string, any>;
  onEnhancedSubmit: (enhancedPrompt: string) => void;
  onSkip: () => void;
  onCancel: () => void;
}

export function PromptEnhancer({
  originalPrompt, analysis, fields, initialValues,
  onEnhancedSubmit, onSkip, onCancel,
}: PromptEnhancerProps) {
  const [fieldValues, setFieldValues] = useState<Record<string, any>>(initialValues);
  const [showPreview, setShowPreview] = useState(false);

  // Build the enhanced prompt from current field values
  const enhancedPrompt = assembleEnhancedPrompt(originalPrompt, analysis.taskType, fieldValues);

  const updateField = useCallback((id: string, value: any) => {
    setFieldValues(prev => ({ ...prev, [id]: value }));
  }, []);

  const toggleMultiChip = useCallback((fieldId: string, chipValue: string) => {
    setFieldValues(prev => {
      const current = Array.isArray(prev[fieldId]) ? prev[fieldId] : [];
      const exists = current.includes(chipValue);
      return {
        ...prev,
        [fieldId]: exists ? current.filter((v: string) => v !== chipValue) : [...current, chipValue],
      };
    });
  }, []);

  // Keyboard shortcuts
  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        onEnhancedSubmit(enhancedPrompt);
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        onCancel();
      }
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [enhancedPrompt, onEnhancedSubmit, onCancel]);

  return (
    <div className="bg-[#1a1a1a] border border-purple-500/30 rounded-xl shadow-xl mb-3 animate-slideIn overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-2.5 border-b border-white/10">
        <div className="flex items-center gap-2">
          <Sparkles size={14} className="text-purple-400" />
          <span className="text-white/80 text-xs font-medium uppercase tracking-wider">
            Enhance Your Prompt
          </span>
          <span className="text-[10px] text-purple-400/60 bg-purple-500/10 px-1.5 py-0.5 rounded">
            {analysis.taskType}
          </span>
        </div>
        <button onClick={onCancel} className="text-white/30 hover:text-white/60 transition-colors cursor-pointer">
          <X size={14} />
        </button>
      </div>

      {/* Original prompt */}
      <div className="px-4 py-2 bg-white/3">
        <p className="text-white/40 text-[10px] mb-0.5">Your prompt:</p>
        <p className="text-white/70 text-xs">{originalPrompt}</p>
      </div>

      {/* Smart fields */}
      <div className="px-4 py-3 space-y-3 max-h-[300px] overflow-y-auto">
        {fields.map(field => (
          <div key={field.id}>
            <label className="text-white/50 text-[10px] font-medium uppercase tracking-wider mb-1.5 block">
              {field.label}
            </label>

            {/* Chip select (single) */}
            {field.type === 'chip_select' && field.options && (
              <div className="flex flex-wrap gap-1.5">
                {field.options.map(opt => {
                  const isSelected = fieldValues[field.id] === opt.value;
                  return (
                    <button
                      key={opt.value}
                      onClick={() => updateField(field.id, opt.value)}
                      className={`px-2.5 py-1 text-xs rounded-lg border transition-all cursor-pointer ${
                        isSelected
                          ? 'bg-purple-500/20 border-purple-500/40 text-purple-300'
                          : 'bg-white/5 border-white/10 text-white/60 hover:bg-purple-500/10 hover:border-purple-500/20 hover:text-white/80'
                      }`}
                    >
                      {opt.label}
                    </button>
                  );
                })}
              </div>
            )}

            {/* Multi chip (toggle) */}
            {field.type === 'multi_chip' && (
              <div>
                {field.options && field.options.length > 0 ? (
                  <div className="flex flex-wrap gap-1.5">
                    {field.options.map(opt => {
                      const selected = Array.isArray(fieldValues[field.id]) && fieldValues[field.id].includes(opt.value);
                      return (
                        <button
                          key={opt.value}
                          onClick={() => toggleMultiChip(field.id, opt.value)}
                          className={`px-2.5 py-1 text-xs rounded-lg border transition-all cursor-pointer ${
                            selected
                              ? 'bg-emerald-500/20 border-emerald-500/40 text-emerald-300'
                              : 'bg-white/5 border-white/10 text-white/60 hover:bg-emerald-500/10 hover:border-emerald-500/20'
                          }`}
                        >
                          {opt.label}
                        </button>
                      );
                    })}
                  </div>
                ) : (
                  <input
                    type="text"
                    placeholder={field.placeholder || 'Type values...'}
                    className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-1.5 text-xs text-white/80 placeholder:text-white/30 focus:outline-none focus:border-purple-500/40"
                    onChange={(e) => updateField(field.id, e.target.value.split(',').map(s => s.trim()).filter(Boolean))}
                  />
                )}
              </div>
            )}

            {/* Text input */}
            {field.type === 'text' && (
              <input
                type="text"
                value={fieldValues[field.id] || ''}
                placeholder={field.placeholder || ''}
                className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-1.5 text-xs text-white/80 placeholder:text-white/30 focus:outline-none focus:border-purple-500/40"
                onChange={(e) => updateField(field.id, e.target.value)}
              />
            )}

            {/* Number input */}
            {field.type === 'number' && (
              <div className="flex items-center gap-2">
                {[1, 2, 3, 4, 5].map(n => (
                  <button
                    key={n}
                    onClick={() => updateField(field.id, n)}
                    className={`w-8 h-8 text-xs rounded-lg border transition-all cursor-pointer ${
                      fieldValues[field.id] === n
                        ? 'bg-purple-500/20 border-purple-500/40 text-purple-300'
                        : 'bg-white/5 border-white/10 text-white/60 hover:bg-purple-500/10'
                    }`}
                  >
                    {n}
                  </button>
                ))}
              </div>
            )}
          </div>
        ))}
      </div>

      {/* Preview toggle */}
      <button
        onClick={() => setShowPreview(!showPreview)}
        className="w-full px-4 py-1.5 text-[10px] text-white/40 hover:text-white/60 flex items-center justify-center gap-1 transition-colors cursor-pointer"
      >
        {showPreview ? <ChevronUp size={10} /> : <ChevronDown size={10} />}
        Preview enhanced prompt
      </button>

      {showPreview && (
        <div className="px-4 pb-2">
          <pre className="text-[10px] text-white/40 bg-white/3 rounded-lg p-2 whitespace-pre-wrap max-h-[100px] overflow-y-auto">
            {enhancedPrompt}
          </pre>
        </div>
      )}

      {/* Action buttons */}
      <div className="px-4 py-2.5 border-t border-white/10 flex items-center justify-between">
        <button
          onClick={onSkip}
          className="text-white/40 hover:text-white/60 text-xs transition-colors cursor-pointer"
        >
          Just go
        </button>
        <div className="flex items-center gap-2">
          <span className="text-[10px] text-white/20">Ctrl+Enter</span>
          <button
            onClick={() => onEnhancedSubmit(enhancedPrompt)}
            className="flex items-center gap-1.5 px-4 py-1.5 bg-purple-500/20 hover:bg-purple-500/30 border border-purple-500/40 rounded-lg text-purple-300 text-xs font-medium transition-all cursor-pointer"
          >
            <Zap size={12} />
            Send Enhanced
          </button>
        </div>
      </div>
    </div>
  );
}
