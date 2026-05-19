import React, { useEffect, useState } from 'react';
import { Terminal, ExternalLink, X } from 'lucide-react';
import { t, useLocale } from '../i18n/strings';

interface SandboxStatus {
  available: boolean;
  distro: string | null;
  running: boolean;
  workspaceReady: boolean;
  diskUsageMB: number;
  error?: string;
}

const DISMISSED_KEY = 'klypix:sandboxBannerDismissed';
const POWER_USER_KEY = 'klypix:powerUser';

export function SandboxSetupBanner() {
  useLocale();
  const [status, setStatus] = useState<SandboxStatus | null>(null);
  const [dismissed, setDismissed] = useState(() => localStorage.getItem(DISMISSED_KEY) === '1');
  // Phase 22: hide for new-install UX. The WSL2 prompt was confusing
  // first-time users who never asked for Python sandboxing — keep it
  // out of sight until the user opts into Power User mode via Settings.
  const [powerUser, setPowerUser] = useState(() => localStorage.getItem(POWER_USER_KEY) === '1');

  useEffect(() => {
    const electron = (window as any).electron;
    if (!electron?.sandbox) return;

    // Get current status
    electron.sandbox.getStatus().then((s: SandboxStatus) => setStatus(s));

    // Listen for status updates (fires on init)
    electron.sandbox.onStatus((s: SandboxStatus) => setStatus(s));
  }, []);

  // Sync power-user flag when the user flips it elsewhere (Settings panel).
  // localStorage doesn't emit events on the same tab, so this catches
  // cross-tab toggles and is a no-op for same-tab updates (Settings will
  // re-render its own consumer).
  useEffect(() => {
    const handler = () => setPowerUser(localStorage.getItem(POWER_USER_KEY) === '1');
    window.addEventListener('storage', handler);
    return () => window.removeEventListener('storage', handler);
  }, []);

  const handleDismiss = () => {
    setDismissed(true);
    localStorage.setItem(DISMISSED_KEY, '1');
  };

  // Only show if Power User mode is on AND sandbox is not available AND not dismissed.
  if (!powerUser || !status || status.available || dismissed) return null;

  return (
    <div className="mb-3 bg-blue-500/10 border border-blue-500/25 rounded-xl p-2.5 flex items-start gap-2 animate-slideIn">
      <Terminal size={14} className="text-blue-400 flex-shrink-0 mt-0.5" />
      <div className="flex-1 min-w-0">
        <p className="text-blue-300 text-[12px] font-medium mb-0.5">{t('sandbox.title')}</p>
        <p className="text-white/60 text-[11px] leading-relaxed">
          {t('sandbox.desc')}
          {status.error && <span className="block mt-1 text-white/40 text-[10px]">({status.error})</span>}
        </p>
        <a
          href="https://learn.microsoft.com/en-us/windows/wsl/install"
          target="_blank"
          rel="noopener noreferrer"
          onClick={(e) => {
            e.preventDefault();
            (window as any).electron?.openExternal?.('https://learn.microsoft.com/en-us/windows/wsl/install');
          }}
          className="inline-flex items-center gap-1 text-[11px] text-blue-400 hover:text-blue-300 mt-1 cursor-pointer"
        >
          {t('sandbox.install')}
          <ExternalLink size={10} />
        </a>
      </div>
      <button
        onClick={handleDismiss}
        className="text-white/30 hover:text-white/60 transition-colors cursor-pointer flex-shrink-0"
        title="Dismiss"
      >
        <X size={12} />
      </button>
    </div>
  );
}
