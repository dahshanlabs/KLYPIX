import React, { useState, useEffect } from 'react';
import { DEEPSEEK_MODELS } from '../core/agent/modelAdapter';
import { EvalRunner } from '../evals/EvalRunner';

const PROVIDERS = [
  { id: 'claude', name: 'Claude', placeholder: 'sk-ant-...', color: 'text-orange-400' },
  { id: 'gemini', name: 'Gemini', placeholder: 'AIza...', color: 'text-blue-400' },
  { id: 'openai', name: 'OpenAI / GPT', placeholder: 'sk-...', color: 'text-green-400' },
  { id: 'glm', name: 'GLM (ZhipuAI)', placeholder: 'API key...', color: 'text-red-400' },
  { id: 'deepseek', name: 'DeepSeek', placeholder: 'sk-...', color: 'text-cyan-400' },
];

const keyApi = (provider: string, electron: any) => {
  if (provider === 'deepseek') return electron?.deepseekKey;
  return electron?.claudeKey; // existing behavior for claude/other providers
};

export const AgentSettings: React.FC = () => {
  const [provider, setProvider] = useState(() => localStorage.getItem('klypix:agentProvider') || 'claude');
  const [storedKey, setStoredKey] = useState('');
  const [deepseekModel, setDeepseekModel] = useState(() => {
    const saved = localStorage.getItem('klypix:deepseekModel');
    // Migrate V3-era IDs that DeepSeek silently routes to v4-flash.
    if (saved === 'deepseek-reasoner') return 'deepseek-v4-pro';
    if (saved === 'deepseek-chat') return 'deepseek-v4-flash';
    return saved || 'deepseek-v4-pro';
  });
  const [budget, setBudget] = useState(5.0);
  const [dailySpend, setDailySpend] = useState(0);
  const [enabled, setEnabled] = useState(true);
  const [costHistory, setCostHistory] = useState<number[]>([]);
  const [savedMsg, setSavedMsg] = useState('');

  const electron = (window as any).electron;

  useEffect(() => { loadSettings(); }, [provider]);

  const loadSettings = async () => {
    if (!electron) return;
    try {
      const key = await keyApi(provider, electron)?.get();
      setStoredKey(key ? `${key.slice(0, 7)}..${key.slice(-4)}` : '');
      setBudget(await electron.agentSettings?.getBudget?.() ?? 5.0);
      setDailySpend(await electron.agentSettings?.getDailySpend?.() ?? 0);
      setEnabled(await electron.agentSettings?.getEnabled?.() ?? true);
      setCostHistory(await electron.agentSettings?.getCostHistory?.() ?? []);
    } catch (err) { console.error('[AgentSettings] Load failed:', err); }
  };

  const flash = (msg: string) => { setSavedMsg(msg); setTimeout(() => setSavedMsg(''), 2500); };

  const saveKey = async (key: string) => {
    await keyApi(provider, electron)?.store(key);
    setStoredKey(`${key.slice(0, 7)}..${key.slice(-4)}`);
    flash('Key saved');
  };

  const clearKey = async () => {
    await keyApi(provider, electron)?.clear();
    setStoredKey('');
    flash('Key cleared');
  };

  const currentProvider = PROVIDERS.find(p => p.id === provider);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-white">Agent Settings</h3>
        <label className="flex items-center gap-2 text-xs">
          <input
            type="checkbox" checked={enabled}
            onChange={e => { setEnabled(e.target.checked); electron?.agentSettings?.setEnabled(e.target.checked); }}
            className="w-3.5 h-3.5 accent-emerald-500"
          />
          <span className="text-gray-400">{enabled ? 'Enabled' : 'Disabled'}</span>
        </label>
      </div>

      {/* AI Provider Selector */}
      <div className="space-y-1.5">
        <label className="text-xs text-gray-400">AI Provider</label>
        <div className="grid grid-cols-2 gap-1.5">
          {PROVIDERS.map(p => (
            <button
              key={p.id}
              onClick={() => { setProvider(p.id); localStorage.setItem('klypix:agentProvider', p.id); flash(`Switched to ${p.name}`); }}
              className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-all ${
                provider === p.id
                  ? 'bg-purple-500/20 border border-purple-500/40 text-purple-300'
                  : 'bg-white/5 border border-white/10 text-gray-500 hover:text-white/70 hover:bg-white/10'
              }`}
            >
              {p.name}
            </button>
          ))}
        </div>
      </div>

      {/* DeepSeek model picker */}
      {provider === 'deepseek' && (
        <div className="space-y-1.5">
          <label className="text-xs text-gray-400">DeepSeek Model</label>
          <div className="grid grid-cols-2 gap-1.5">
            {DEEPSEEK_MODELS.map(m => (
              <button
                key={m.id}
                onClick={() => { setDeepseekModel(m.id); localStorage.setItem('klypix:deepseekModel', m.id); flash(`Model: ${m.name}`); }}
                className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-all text-left ${
                  deepseekModel === m.id
                    ? 'bg-cyan-500/20 border border-cyan-500/40 text-cyan-300'
                    : 'bg-white/5 border border-white/10 text-gray-500 hover:text-white/70 hover:bg-white/10'
                }`}
                title={m.desc}
              >
                <div className="font-semibold">{m.name}</div>
                <div className="text-[10px] opacity-70 truncate">{m.desc}</div>
              </button>
            ))}
          </div>
        </div>
      )}

      {/* API Key */}
      <div className="space-y-1.5">
        <label className="text-xs text-gray-400">{currentProvider?.name || 'API'} Key</label>
        <div className="flex gap-2">
          <input
            type="password" placeholder={currentProvider?.placeholder || 'API key...'}
            onChange={e => { if (e.target.value.length > 10) saveKey(e.target.value); }}
            className="flex-1 px-3 py-1.5 bg-black/30 border border-white/10 rounded-lg text-white text-xs placeholder-gray-500"
          />
          {storedKey && (
            <button onClick={clearKey} className="px-2 py-1.5 text-xs text-red-400 hover:text-red-300">Clear</button>
          )}
        </div>
        {storedKey && <p className="text-[10px] text-emerald-400">Stored: {storedKey}</p>}
      </div>

      {/* Budget */}
      <div className="space-y-1.5">
        <label className="text-xs text-gray-400">Daily Budget: ${budget.toFixed(2)}</label>
        <input
          type="range" min="0.5" max="50" step="0.5" value={budget}
          onChange={e => { const v = parseFloat(e.target.value); setBudget(v); electron?.agentSettings?.setBudget(v); }}
          className="w-full h-1.5 bg-gray-700 rounded-lg appearance-none cursor-pointer accent-emerald-500"
        />
        <div className="flex justify-between text-[10px] text-gray-500">
          <span>Today: ${dailySpend.toFixed(4)}</span>
          <span>Budget: ${budget.toFixed(2)}</span>
        </div>
        <div className="w-full bg-gray-700 rounded-full h-1.5 overflow-hidden">
          <div
            className={`h-full rounded-full transition-all ${
              dailySpend / budget > 1 ? 'bg-red-500' : dailySpend / budget > 0.75 ? 'bg-yellow-500' : 'bg-emerald-500'
            }`}
            style={{ width: `${Math.min((dailySpend / budget) * 100, 100)}%` }}
          />
        </div>
      </div>

      {/* Cost History */}
      {costHistory.some(c => c > 0) && (
        <div className="space-y-1.5">
          <label className="text-xs text-gray-400">Last 7 Days</label>
          <div className="flex items-end gap-1 h-12">
            {costHistory.map((c, i) => {
              const max = Math.max(...costHistory, budget);
              return (
                <div key={i} className="flex-1 bg-emerald-500/30 rounded-t"
                  style={{ height: `${Math.max((c / max) * 100, 2)}%` }}
                  title={`$${c.toFixed(3)}`}
                />
              );
            })}
          </div>
        </div>
      )}

      {savedMsg && <p className="text-xs text-emerald-400">{savedMsg}</p>}

      {/* Eval Harness — gated behind a details toggle so it stays out of the way */}
      <details className="pt-2 border-t border-white/10">
        <summary className="text-xs text-gray-400 cursor-pointer hover:text-white py-1">
          Eval Harness (Dev) — measure model swaps before you ship them
        </summary>
        <div className="pt-3">
          <EvalRunner />
        </div>
      </details>
    </div>
  );
};
