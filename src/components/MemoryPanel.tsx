import React, { useEffect, useState } from 'react';
import { Brain, Pin, Trash2, X, ToggleLeft, ToggleRight, Sparkles, Check } from 'lucide-react';
import { getMemoryManager, getMemoryStore } from '../services/memory';
import type { Memory, MemorySettings, MemoryStats } from '../services/memory';
import { MemoryConsentDialog } from './MemoryConsentDialog';

interface PendingRow {
  id: string;
  type: 'semantic' | 'episodic' | 'procedural';
  content: string;
  category: string;
  confidence: number;
  createdAt: number;
}

interface MemoryPanelProps {
  onClose: () => void;
}

export function MemoryPanel({ onClose }: MemoryPanelProps) {
  const [settings, setSettings] = useState<MemorySettings | null>(null);
  const [memories, setMemories] = useState<Memory[]>([]);
  const [stats, setStats] = useState<MemoryStats>({ total: 0, semantic: 0, episodic: 0, procedural: 0, pinned: 0 });
  const [filter, setFilter] = useState<'all' | 'semantic' | 'episodic' | 'procedural' | 'pinned'>('all');
  const [showConsent, setShowConsent] = useState(false);
  const [pending, setPending] = useState<PendingRow[]>([]);

  const mgr = getMemoryManager();
  const store = getMemoryStore();

  const refresh = async () => {
    const s = await mgr.getSettings();
    setSettings(s);
    const all = await store.getActiveMemories({ pinnedFirst: true, recentFirst: true, limit: 200 });
    setMemories(all);
    setStats(await store.getStats());
    setPending(await store.getPendingMemories());
  };

  const approvePending = async (id: string) => {
    await store.approvePendingMemory(id);
    refresh();
  };
  const discardPending = async (id: string) => {
    await store.discardPendingMemory(id);
    refresh();
  };
  const approveAllPending = async () => {
    for (const p of pending) await store.approvePendingMemory(p.id);
    refresh();
  };
  const discardAllPending = async () => {
    await store.clearPendingMemories();
    refresh();
  };

  useEffect(() => { refresh(); }, []);

  const toggleEnabled = async () => {
    if (!settings) return;
    // First-time enable → show consent dialog; cannot flip ON without it.
    // Off→On and user hasn't seen consent yet → show consent first.
    if (!settings.enabled && !settings.consentShown) {
      setShowConsent(true);
      return;
    }
    await mgr.setEnabled(!settings.enabled);
    refresh();
  };

  const handleConsentEnable = async () => {
    // Mark consent as seen AND enable — both in one write.
    await mgr.updateSettings({ enabled: true, consentShown: true });
    setShowConsent(false);
    refresh();
  };

  const handleConsentCancel = () => {
    // "Not Now" — don't mark consentShown, leave toggle OFF.
    // Next time they try, they'll see the dialog again.
    setShowConsent(false);
  };

  const togglePin = async (m: Memory) => {
    await store.updateMemory(m.id, { pinned: !m.pinned });
    refresh();
  };

  const deleteMemory = async (id: string) => {
    await store.deleteMemory(id);
    refresh();
  };

  const clearAll = async () => {
    if (!confirm('Delete ALL memories? This cannot be undone.')) return;
    await store.deleteAllMemories();
    refresh();
  };

  const filtered = memories.filter(m => {
    if (filter === 'all') return true;
    if (filter === 'pinned') return m.pinned;
    return m.type === filter;
  });

  if (!settings) return null;

  return (
    <>
    {showConsent && (
      <MemoryConsentDialog onEnable={handleConsentEnable} onCancel={handleConsentCancel} />
    )}
    <div className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm flex items-center justify-center p-4" onClick={onClose}>
      <div
        className="bg-[#1a1a1a] border border-white/10 rounded-2xl w-full max-w-[520px] max-h-[80vh] flex flex-col shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-white/10">
          <div className="flex items-center gap-2">
            <Brain size={16} className="text-purple-400" />
            <span className="text-white/90 text-sm font-medium">Memory</span>
            <span className="text-[10px] text-white/40 bg-white/5 px-1.5 py-0.5 rounded">
              {stats.total} total
            </span>
          </div>
          <button onClick={onClose} className="text-white/40 hover:text-white/80 cursor-pointer">
            <X size={14} />
          </button>
        </div>

        {/* Master toggle */}
        <div className="px-4 py-3 border-b border-white/10 bg-white/3">
          <button
            onClick={toggleEnabled}
            className="w-full flex items-center justify-between gap-2 cursor-pointer"
          >
            <div className="text-left">
              <p className="text-white/90 text-[13px] font-medium">
                {settings.enabled ? 'Memory is ON' : 'Memory is OFF'}
              </p>
              <p className="text-white/50 text-[11px]">
                {settings.enabled
                  ? 'The agent remembers facts across sessions'
                  : 'Turn on to let the agent learn from conversations'}
              </p>
            </div>
            {settings.enabled
              ? <ToggleRight size={28} className="text-emerald-400" />
              : <ToggleLeft size={28} className="text-white/30" />}
          </button>
        </div>

        {/* Stats + filters */}
        {stats.total > 0 && (
          <div className="px-4 py-2 border-b border-white/10 flex gap-1 overflow-x-auto">
            {([
              ['all', `All (${stats.total})`],
              ['pinned', `📌 ${stats.pinned}`],
              ['semantic', `Facts ${stats.semantic}`],
              ['procedural', `Prefs ${stats.procedural}`],
              ['episodic', `History ${stats.episodic}`],
            ] as const).map(([key, label]) => (
              <button
                key={key}
                onClick={() => setFilter(key as any)}
                className={`px-2.5 py-1 text-[11px] rounded-full border whitespace-nowrap transition-all cursor-pointer ${
                  filter === key
                    ? 'bg-purple-500/20 border-purple-500/40 text-purple-300'
                    : 'bg-white/5 border-white/10 text-white/60 hover:bg-white/10'
                }`}
              >
                {label}
              </button>
            ))}
          </div>
        )}

        {/* Pending extractions — shown when askBeforeSaving is ON and we have pending items */}
        {pending.length > 0 && (
          <div className="border-b border-white/10 bg-purple-500/5">
            <div className="flex items-center justify-between px-4 py-2 border-b border-purple-500/10">
              <div className="flex items-center gap-1.5">
                <Sparkles size={12} className="text-purple-400" />
                <span className="text-purple-300 text-[11px] font-medium uppercase tracking-wider">
                  Review ({pending.length} extracted)
                </span>
              </div>
              <div className="flex gap-1">
                <button
                  onClick={approveAllPending}
                  className="px-2 py-0.5 text-[10px] rounded bg-emerald-500/15 border border-emerald-500/30 text-emerald-300 hover:bg-emerald-500/25 cursor-pointer"
                >
                  Save all
                </button>
                <button
                  onClick={discardAllPending}
                  className="px-2 py-0.5 text-[10px] rounded bg-white/5 border border-white/10 text-white/60 hover:bg-red-500/15 hover:text-red-300 cursor-pointer"
                >
                  Discard all
                </button>
              </div>
            </div>
            <div className="px-3 py-2 space-y-1 max-h-[180px] overflow-y-auto">
              {pending.map(p => (
                <div
                  key={p.id}
                  className="group flex items-start gap-2 bg-white/3 hover:bg-white/5 border border-purple-500/10 rounded-lg p-2"
                >
                  <span className={`text-[9px] px-1.5 py-0.5 rounded uppercase tracking-wider flex-shrink-0 mt-0.5 ${
                    p.type === 'semantic' ? 'bg-blue-500/15 text-blue-300'
                    : p.type === 'procedural' ? 'bg-emerald-500/15 text-emerald-300'
                    : 'bg-yellow-500/15 text-yellow-300'
                  }`}>
                    {p.type === 'semantic' ? 'fact' : p.type === 'procedural' ? 'pref' : 'hist'}
                  </span>
                  <p className="flex-1 text-white/80 text-[12px] leading-relaxed">{p.content}</p>
                  <div className="flex gap-1 flex-shrink-0">
                    <button
                      onClick={() => approvePending(p.id)}
                      className="p-1 rounded bg-emerald-500/15 hover:bg-emerald-500/30 text-emerald-300 cursor-pointer"
                      title="Save"
                    >
                      <Check size={11} />
                    </button>
                    <button
                      onClick={() => discardPending(p.id)}
                      className="p-1 rounded bg-white/5 hover:bg-red-500/25 text-white/50 hover:text-red-300 cursor-pointer"
                      title="Discard"
                    >
                      <X size={11} />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Memory list */}
        <div className="flex-1 overflow-y-auto p-3 space-y-1.5">
          {filtered.length === 0 && (
            <div className="text-center py-8 text-white/40 text-[12px]">
              {stats.total === 0
                ? 'No memories yet. Say "remember that..." or let the agent learn from sessions.'
                : 'No memories in this filter.'}
            </div>
          )}
          {filtered.map(m => (
            <div
              key={m.id}
              className="group bg-white/3 hover:bg-white/5 border border-white/5 rounded-lg p-2.5 flex items-start gap-2 transition-all"
            >
              <span className={`text-[9px] px-1.5 py-0.5 rounded uppercase tracking-wider flex-shrink-0 mt-0.5 ${
                m.type === 'semantic' ? 'bg-blue-500/15 text-blue-300'
                : m.type === 'procedural' ? 'bg-emerald-500/15 text-emerald-300'
                : 'bg-yellow-500/15 text-yellow-300'
              }`}>
                {m.type === 'semantic' ? 'fact' : m.type === 'procedural' ? 'pref' : 'hist'}
              </span>
              <p className="flex-1 text-white/80 text-[12px] leading-relaxed">{m.content}</p>
              <div className="flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity flex-shrink-0">
                <button
                  onClick={() => togglePin(m)}
                  className={`p-1 rounded hover:bg-white/10 cursor-pointer ${m.pinned ? 'text-yellow-400' : 'text-white/40'}`}
                  title={m.pinned ? 'Unpin' : 'Pin'}
                >
                  <Pin size={11} />
                </button>
                <button
                  onClick={() => deleteMemory(m.id)}
                  className="p-1 rounded hover:bg-red-500/20 text-white/40 hover:text-red-400 cursor-pointer"
                  title="Delete"
                >
                  <Trash2 size={11} />
                </button>
              </div>
            </div>
          ))}
        </div>

        {/* Footer */}
        <div className="px-4 py-2.5 border-t border-white/10 flex items-center justify-between">
          <p className="text-[10px] text-white/30">
            Stored locally. Never sent to the cloud.
          </p>
          {stats.total > 0 && (
            <button
              onClick={clearAll}
              className="text-[11px] text-red-400 hover:text-red-300 cursor-pointer"
            >
              Clear all
            </button>
          )}
        </div>
      </div>
    </div>
    </>
  );
}
