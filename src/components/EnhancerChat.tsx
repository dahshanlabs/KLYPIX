import React, { useState, useEffect, useRef, useCallback } from 'react';
import { Sparkles, Zap, SkipForward } from 'lucide-react';
import type { EnhancementAnalysis } from '../core/promptEnhancer';
import type { EnhancerField } from '../core/promptEnhancerFields';
import { assembleEnhancedPrompt } from '../core/promptAssembler';

// ── Types ───────────────────────────────────────────────────────────────────

interface EnhancerChatProps {
  originalPrompt: string;
  analysis: EnhancementAnalysis;
  fields: EnhancerField[];
  initialValues: Record<string, any>;
  onEnhancedSubmit: (enhancedPrompt: string) => void;
  onSkip: () => void;
  onCancel: () => void;
}

interface ChatMessage {
  id: string;
  type: 'question' | 'answer';
  text: string;
  fieldId?: string;
  chips?: Array<{ value: string; label: string }>;
  isMulti?: boolean;
  isNumber?: boolean;
  isText?: boolean;
  answered?: boolean;
}

// ── Questions from field definitions ────────────────────────────────────────

const FIELD_QUESTIONS: Record<string, string> = {
  chart_type: 'What type of chart works best?',
  data_focus: 'What data should we focus on?',
  chart_count: 'How many charts?',
  output_format: 'What output format?',
  depth: 'How deep should the analysis go?',
  focus_areas: 'What areas to focus on?',
  sections: 'Which sections to include?',
  transformation: 'What operation?',
  doc_type: 'What type of document?',
  tone: 'What tone?',
  additional_context: 'Any additional details?',
};

// ── Component ───────────────────────────────────────────────────────────────

export function EnhancerChat({
  originalPrompt, analysis, fields, initialValues,
  onEnhancedSubmit, onSkip, onCancel,
}: EnhancerChatProps) {
  const [fieldValues, setFieldValues] = useState<Record<string, any>>(initialValues);
  const [currentStep, setCurrentStep] = useState(0);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [animating, setAnimating] = useState(false);
  const [textInput, setTextInput] = useState('');
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Filter fields: skip fields that already have values from context, or fields with no options for multi_chip
  const activeFields = fields.filter(f => {
    // Skip fields already populated from context (unless they're the default)
    const val = initialValues[f.id];
    if (val && f.type === 'chip_select' && val !== f.defaultValue) return false;
    // Skip multi_chip fields with no dynamic options and no placeholder
    if (f.type === 'multi_chip' && (!f.options || f.options.length === 0) && !f.placeholder) return false;
    return true;
  });

  // Auto-scroll to bottom
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages]);

  // Focus text input when needed
  useEffect(() => {
    if (inputRef.current && activeFields[currentStep]?.type === 'text') {
      inputRef.current.focus();
    }
  }, [currentStep, activeFields]);

  // Add first question on mount (ref guards against StrictMode double-fire)
  const initialized = useRef(false);
  useEffect(() => {
    if (initialized.current) return;
    initialized.current = true;
    if (activeFields.length === 0) {
      onSkip();
      return;
    }
    addQuestion(0);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const addQuestion = useCallback((stepIdx: number) => {
    const field = activeFields[stepIdx];
    if (!field) return;

    setAnimating(true);
    setTimeout(() => {
      const question: ChatMessage = {
        id: `q-${field.id}`,
        type: 'question',
        text: FIELD_QUESTIONS[field.id] || field.label,
        fieldId: field.id,
        chips: field.options && field.options.length > 0 ? field.options : undefined,
        isMulti: field.type === 'multi_chip',
        isNumber: field.type === 'number',
        isText: field.type === 'text' || (field.type === 'multi_chip' && (!field.options || field.options.length === 0)),
      };
      setMessages(prev => [...prev, question]);
      setAnimating(false);
    }, 300);
  }, [activeFields]);

  const advanceStep = useCallback((stepIdx: number, answerText: string) => {
    // Mark current question as answered
    setMessages(prev => prev.map(m =>
      m.id === `q-${activeFields[stepIdx]?.id}` ? { ...m, answered: true } : m
    ));

    // Add answer message
    setMessages(prev => [...prev, {
      id: `a-${activeFields[stepIdx]?.id}`,
      type: 'answer',
      text: answerText,
    }]);

    const nextStep = stepIdx + 1;
    if (nextStep < activeFields.length) {
      setCurrentStep(nextStep);
      addQuestion(nextStep);
    } else {
      // All questions answered — auto-submit after brief delay
      setTimeout(() => {
        const enhanced = assembleEnhancedPrompt(originalPrompt, analysis.taskType, fieldValues);
        onEnhancedSubmit(enhanced);
      }, 400);
    }
  }, [activeFields, addQuestion, analysis.taskType, fieldValues, onEnhancedSubmit, originalPrompt]);

  const handleChipSelect = useCallback((fieldId: string, value: string, label: string, isMulti: boolean) => {
    if (isMulti) {
      // For multi-select, toggle the value
      setFieldValues(prev => {
        const current = Array.isArray(prev[fieldId]) ? prev[fieldId] : [];
        const exists = current.includes(value);
        return { ...prev, [fieldId]: exists ? current.filter((v: string) => v !== value) : [...current, value] };
      });
      // Don't advance — user clicks a "Done" button for multi
      return;
    }

    setFieldValues(prev => ({ ...prev, [fieldId]: value }));
    advanceStep(currentStep, label);
  }, [currentStep, advanceStep]);

  const handleNumberSelect = useCallback((fieldId: string, num: number) => {
    setFieldValues(prev => ({ ...prev, [fieldId]: num }));
    advanceStep(currentStep, `${num}`);
  }, [currentStep, advanceStep]);

  const handleTextSubmit = useCallback((fieldId: string) => {
    const value = textInput.trim();
    if (!value) return;
    setFieldValues(prev => ({ ...prev, [fieldId]: value }));
    setTextInput('');
    advanceStep(currentStep, value);
  }, [textInput, currentStep, advanceStep]);

  const handleMultiDone = useCallback((fieldId: string) => {
    const selected = fieldValues[fieldId];
    const labels = Array.isArray(selected)
      ? selected.map(v => {
          const field = activeFields.find(f => f.id === fieldId);
          const opt = field?.options?.find(o => o.value === v);
          return opt?.label || v;
        })
      : [];
    advanceStep(currentStep, labels.length > 0 ? labels.join(', ') : 'None selected');
  }, [fieldValues, activeFields, currentStep, advanceStep]);

  // Keyboard: Escape to cancel, Enter to submit text
  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onCancel();
      }
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [onCancel]);

  return (
    <div className="mb-3 space-y-2">
      {/* Chat messages */}
      <div ref={scrollRef} className="space-y-2 max-h-[400px] overflow-y-auto">
        {messages.map(msg => (
          <div key={msg.id} className={msg.type === 'question' ? '' : 'flex justify-end'}>
            {msg.type === 'question' ? (
              <div className="animate-slideIn">
                {/* KLYPIX question bubble */}
                <div className="flex items-start gap-2">
                  <div className="w-5 h-5 rounded-full bg-purple-500/20 border border-purple-500/30 flex items-center justify-center flex-shrink-0 mt-0.5">
                    <Sparkles size={10} className="text-purple-400" />
                  </div>
                  <div>
                    <p className="text-white/80 text-[13px] mb-2">{msg.text}</p>

                    {/* Chip options (single select) */}
                    {msg.chips && !msg.isMulti && !msg.answered && (
                      <div className="flex flex-wrap gap-1.5">
                        {msg.chips.map(opt => (
                          <button
                            key={opt.value}
                            onClick={() => handleChipSelect(msg.fieldId!, opt.value, opt.label, false)}
                            className="px-3 py-1.5 text-xs rounded-full border border-white/15 bg-white/5 text-white/70 hover:bg-purple-500/15 hover:border-purple-500/30 hover:text-purple-300 transition-all cursor-pointer"
                          >
                            {opt.label}
                          </button>
                        ))}
                      </div>
                    )}

                    {/* Chip options (multi select) */}
                    {msg.chips && msg.isMulti && !msg.answered && (
                      <div>
                        <div className="flex flex-wrap gap-1.5 mb-2">
                          {msg.chips.map(opt => {
                            const selected = Array.isArray(fieldValues[msg.fieldId!]) && fieldValues[msg.fieldId!].includes(opt.value);
                            return (
                              <button
                                key={opt.value}
                                onClick={() => handleChipSelect(msg.fieldId!, opt.value, opt.label, true)}
                                className={`px-3 py-1.5 text-xs rounded-full border transition-all cursor-pointer ${
                                  selected
                                    ? 'bg-emerald-500/20 border-emerald-500/40 text-emerald-300'
                                    : 'bg-white/5 border-white/15 text-white/70 hover:bg-emerald-500/10 hover:border-emerald-500/20'
                                }`}
                              >
                                {opt.label}
                              </button>
                            );
                          })}
                        </div>
                        <button
                          onClick={() => handleMultiDone(msg.fieldId!)}
                          className="text-[10px] text-purple-400 hover:text-purple-300 cursor-pointer"
                        >
                          Done selecting →
                        </button>
                      </div>
                    )}

                    {/* Number picker */}
                    {msg.isNumber && !msg.answered && (
                      <div className="flex gap-1.5">
                        {[1, 2, 3, 4, 5].map(n => (
                          <button
                            key={n}
                            onClick={() => handleNumberSelect(msg.fieldId!, n)}
                            className="w-8 h-8 text-xs rounded-full border border-white/15 bg-white/5 text-white/70 hover:bg-purple-500/15 hover:border-purple-500/30 hover:text-purple-300 transition-all cursor-pointer"
                          >
                            {n}
                          </button>
                        ))}
                      </div>
                    )}

                    {/* Text input */}
                    {msg.isText && !msg.answered && (
                      <div className="flex gap-1.5">
                        <input
                          ref={inputRef}
                          type="text"
                          value={textInput}
                          onChange={(e) => setTextInput(e.target.value)}
                          onKeyDown={(e) => { if (e.key === 'Enter') handleTextSubmit(msg.fieldId!); }}
                          placeholder={activeFields[currentStep]?.placeholder || 'Type here...'}
                          className="flex-1 bg-white/5 border border-white/15 rounded-full px-3 py-1.5 text-xs text-white/80 placeholder:text-white/30 focus:outline-none focus:border-purple-500/40"
                        />
                        <button
                          onClick={() => handleTextSubmit(msg.fieldId!)}
                          className="px-3 py-1.5 text-xs rounded-full bg-purple-500/20 border border-purple-500/30 text-purple-300 hover:bg-purple-500/30 cursor-pointer"
                        >
                          →
                        </button>
                      </div>
                    )}

                    {/* Show selected answer on answered chip questions */}
                    {msg.answered && msg.chips && (
                      <div className="flex flex-wrap gap-1.5 opacity-50">
                        {msg.chips.map(opt => {
                          const isSelected = msg.isMulti
                            ? Array.isArray(fieldValues[msg.fieldId!]) && fieldValues[msg.fieldId!].includes(opt.value)
                            : fieldValues[msg.fieldId!] === opt.value;
                          return isSelected ? (
                            <span key={opt.value} className="px-3 py-1.5 text-xs rounded-full bg-purple-500/20 border border-purple-500/30 text-purple-300">
                              {opt.label}
                            </span>
                          ) : null;
                        })}
                      </div>
                    )}
                  </div>
                </div>
              </div>
            ) : (
              /* User answer bubble */
              <div className="animate-slideIn">
                <span className="inline-block px-3 py-1.5 text-xs rounded-full bg-emerald-500/15 border border-emerald-500/25 text-emerald-300">
                  {msg.text}
                </span>
              </div>
            )}
          </div>
        ))}

        {/* Typing indicator */}
        {animating && (
          <div className="flex items-center gap-2">
            <div className="w-5 h-5 rounded-full bg-purple-500/20 border border-purple-500/30 flex items-center justify-center">
              <Sparkles size={10} className="text-purple-400" />
            </div>
            <div className="flex gap-1">
              <span className="w-1.5 h-1.5 bg-purple-400/60 rounded-full animate-bounce" style={{ animationDelay: '0ms' }} />
              <span className="w-1.5 h-1.5 bg-purple-400/60 rounded-full animate-bounce" style={{ animationDelay: '150ms' }} />
              <span className="w-1.5 h-1.5 bg-purple-400/60 rounded-full animate-bounce" style={{ animationDelay: '300ms' }} />
            </div>
          </div>
        )}
      </div>

      {/* Skip button — always visible */}
      <div className="flex items-center justify-between px-1">
        <button
          onClick={onSkip}
          className="flex items-center gap-1 text-white/30 hover:text-white/50 text-[11px] transition-colors cursor-pointer"
        >
          <SkipForward size={10} />
          Just go
        </button>
        <span className="text-[10px] text-white/15">
          {currentStep + 1}/{activeFields.length}
        </span>
      </div>
    </div>
  );
}
