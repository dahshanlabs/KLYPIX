import React from 'react';
import { Brain, Shield, Check, X } from 'lucide-react';

interface MemoryConsentDialogProps {
  onEnable: () => void;
  onCancel: () => void;
}

export function MemoryConsentDialog({ onEnable, onCancel }: MemoryConsentDialogProps) {
  return (
    <div className="fixed inset-0 z-[60] bg-black/70 backdrop-blur-sm flex items-center justify-center p-4" onClick={onCancel}>
      <div
        className="bg-[#1a1a1a] border border-purple-500/30 rounded-2xl w-full max-w-[440px] shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-start gap-3 px-5 pt-5 pb-3">
          <div className="w-10 h-10 rounded-full bg-purple-500/15 border border-purple-500/30 flex items-center justify-center flex-shrink-0">
            <Brain size={18} className="text-purple-400" />
          </div>
          <div className="flex-1">
            <h2 className="text-white text-[15px] font-semibold">Enable Agent Memory?</h2>
            <p className="text-white/60 text-[12px] mt-0.5 leading-relaxed">
              KLYPIX will remember things about you to give better help over time.
            </p>
          </div>
        </div>

        {/* What we remember */}
        <div className="px-5 py-3 border-t border-white/5">
          <p className="text-emerald-400 text-[11px] font-medium uppercase tracking-wider mb-2 flex items-center gap-1.5">
            <Check size={12} /> What we remember
          </p>
          <ul className="space-y-1 text-white/70 text-[12px]">
            <li>• Your name, role, and workplace context</li>
            <li>• Projects you're working on</li>
            <li>• Preferences — tone, format, language, tools</li>
            <li>• How you like things done</li>
          </ul>
        </div>

        {/* What we never remember */}
        <div className="px-5 py-3 border-t border-white/5">
          <p className="text-red-400 text-[11px] font-medium uppercase tracking-wider mb-2 flex items-center gap-1.5">
            <X size={12} /> What we NEVER remember
          </p>
          <ul className="space-y-1 text-white/70 text-[12px]">
            <li>• Passwords, API keys, tokens</li>
            <li>• Credit card or bank account details</li>
            <li>• Social security or national ID numbers</li>
            <li>• Anything matching your privacy filter</li>
          </ul>
        </div>

        {/* Privacy */}
        <div className="mx-5 my-3 p-3 bg-emerald-500/5 border border-emerald-500/20 rounded-lg flex items-start gap-2">
          <Shield size={14} className="text-emerald-400 mt-0.5 flex-shrink-0" />
          <p className="text-emerald-300/90 text-[11px] leading-relaxed">
            <span className="font-medium">All memory is stored locally on your machine only.</span> Nothing is sent to Anthropic, Google, or any cloud service. You can view, edit, or delete memories any time.
          </p>
        </div>

        {/* Buttons */}
        <div className="flex gap-2 px-5 pb-5 pt-2">
          <button
            onClick={onCancel}
            className="flex-1 px-4 py-2 text-xs rounded-lg bg-white/5 border border-white/10 text-white/70 hover:bg-white/10 transition-all cursor-pointer"
          >
            Not Now
          </button>
          <button
            onClick={onEnable}
            className="flex-1 px-4 py-2 text-xs rounded-lg bg-purple-500/25 border border-purple-500/50 text-purple-200 hover:bg-purple-500/35 transition-all cursor-pointer font-medium"
          >
            Enable Memory
          </button>
        </div>
      </div>
    </div>
  );
}
