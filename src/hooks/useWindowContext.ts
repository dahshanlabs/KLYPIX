import { useState, useEffect, useCallback } from 'react';
import type { WindowContext } from '../types';

export function useWindowContext() {
    const [isMaximized, setIsMaximized] = useState(false);
    const [isResizing, setIsResizing] = useState(false);
    const [isVisible, setIsVisible] = useState(true);
    const [activeWindowContext, setActiveWindowContext] = useState<WindowContext>({
        title: 'Unknown',
        process: 'Unknown',
    });

    useEffect(() => {
        const cleanup = (window as any).electron.onWindowResizing((resizing: boolean) => {
            setIsResizing(resizing);
        });
        return () => cleanup();
    }, []);

    // Listen for maximize state changes from main process (drag/resize unmaximizes)
    useEffect(() => {
        const cleanup = (window as any).electron.onMaximizeStateChanged?.((maximized: boolean) => {
            setIsMaximized(maximized);
        });
        return () => cleanup?.();
    }, []);

    // Sync maximize state from Electron (source of truth)
    const syncMaximizeState = useCallback(async () => {
        try {
            const maximized = await (window as any).electron.isMaximized();
            setIsMaximized(maximized);
        } catch { /* ignore */ }
    }, []);

    // Sync on visibility change (after Alt+Space toggle)
    useEffect(() => {
        const handler = () => {
            if (!document.hidden) syncMaximizeState();
        };
        document.addEventListener('visibilitychange', handler);
        return () => document.removeEventListener('visibilitychange', handler);
    }, [syncMaximizeState]);

    const handleMinimize = () => {
        window.electron.minimizeWindow();
    };

    const handleMaximize = async () => {
        const maximized = await (window as any).electron.toggleMaximize();
        setIsMaximized(maximized);
    };

    return {
        isMaximized, setIsMaximized,
        isResizing, setIsResizing,
        isVisible, setIsVisible,
        activeWindowContext, setActiveWindowContext,
        handleMinimize,
        handleMaximize,
    };
}
