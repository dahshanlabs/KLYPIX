import { useState, useEffect } from 'react';

export interface UpdateState {
    status: 'idle' | 'checking' | 'available' | 'downloading' | 'ready' | 'error';
    version: string | null;
    releaseNotes: string | null;
    mandatory: boolean;
    progress: number;          // 0-100
    bytesPerSecond: number;
    transferred: number;
    total: number;
    error: string | null;
    currentVersion: string | null;
}

export function useUpdater() {
    const [state, setState] = useState<UpdateState>({
        status: 'idle',
        version: null,
        releaseNotes: null,
        mandatory: false,
        progress: 0,
        bytesPerSecond: 0,
        transferred: 0,
        total: 0,
        error: null,
        currentVersion: null,
    });
    const [dismissed, setDismissed] = useState(false);

    useEffect(() => {
        const electron = (window as any).electron;
        if (!electron?.updater) return;

        // Get current version on mount
        electron.updater.getVersion().then((v: string) => {
            setState(prev => ({ ...prev, currentVersion: v }));
        });

        const cleanups = [
            electron.updater.onChecking(() => {
                setState(prev => ({ ...prev, status: 'checking' }));
            }),
            electron.updater.onAvailable((info: any) => {
                setState(prev => ({
                    ...prev,
                    status: 'available',
                    version: info.version,
                    releaseNotes: info.releaseNotes || null,
                    mandatory: info.mandatory || false,
                }));
                setDismissed(false);
            }),
            electron.updater.onNotAvailable(() => {
                setState(prev => ({ ...prev, status: 'idle' }));
            }),
            electron.updater.onProgress((progress: any) => {
                setState(prev => ({
                    ...prev,
                    status: 'downloading',
                    progress: progress.percent || 0,
                    bytesPerSecond: progress.bytesPerSecond || 0,
                    transferred: progress.transferred || 0,
                    total: progress.total || 0,
                }));
            }),
            electron.updater.onDownloaded((info: any) => {
                setState(prev => ({
                    ...prev,
                    status: 'ready',
                    version: info.version,
                }));
            }),
            electron.updater.onError((err: any) => {
                setState(prev => ({
                    ...prev,
                    status: 'error',
                    error: err.message || 'Update failed',
                }));
            }),
        ];

        return () => cleanups.forEach(fn => fn?.());
    }, []);

    const installUpdate = () => {
        (window as any).electron?.updater?.install();
    };

    const checkForUpdate = () => {
        (window as any).electron?.updater?.check();
    };

    const dismiss = () => {
        if (!state.mandatory) setDismissed(true);
    };

    return {
        ...state,
        dismissed,
        installUpdate,
        checkForUpdate,
        dismiss,
        showToast: !dismissed && (state.status === 'available' || state.status === 'downloading' || state.status === 'ready'),
    };
}
