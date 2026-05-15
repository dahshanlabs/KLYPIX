import { useState, useCallback } from 'react';

export interface ScreenshotEntry {
    base64: string;
    timestamp: number;
    label?: string;
}

export function useScreenshot() {
    const [showScreenshot, setShowScreenshot] = useState(false);
    const [captureMode, setCaptureMode] = useState<'full' | 'partial'>('full');
    const [isCapturing, setIsCapturing] = useState(false);
    const [lastScreenshot64, setLastScreenshot64] = useState<string | null>(null);
    const [useLastScreenshot, setUseLastScreenshot] = useState(false);
    const [previewImage, setPreviewImage] = useState<string | null>(null);
    const [maximizedByPreview, setMaximizedByPreview] = useState(false);
    const [screenshotStack, setScreenshotStack] = useState<ScreenshotEntry[]>([]);

    const captureFullScreen = async (): Promise<string | null> => {
        setIsCapturing(true);
        const base64 = await window.electron.captureScreen();
        setIsCapturing(false);
        if (base64) setLastScreenshot64(base64);
        return base64;
    };

    const captureRaw = async (): Promise<string | null> => {
        return await window.electron.captureScreenRaw();
    };

    const launchSnipping = async (): Promise<string | null> => {
        setIsCapturing(true);
        try {
            const base64 = await window.electron.launchNativeSnipping();
            if (base64) setLastScreenshot64(base64);
            return base64;
        } finally {
            setIsCapturing(false);
        }
    };

    // ── Screenshot Stack (for multi-screenshot comparison) ─────────────
    const addToStack = useCallback((base64: string, label?: string) => {
        setScreenshotStack(prev => {
            const entry: ScreenshotEntry = { base64, timestamp: Date.now(), label };
            const updated = [...prev, entry];
            return updated.slice(-5); // Max 5 screenshots
        });
    }, []);

    const removeFromStack = useCallback((index: number) => {
        setScreenshotStack(prev => prev.filter((_, i) => i !== index));
    }, []);

    const clearStack = useCallback(() => {
        setScreenshotStack([]);
    }, []);

    const captureAndAddToStack = useCallback(async (label?: string): Promise<string | null> => {
        setIsCapturing(true);
        const base64 = await window.electron.captureScreen();
        setIsCapturing(false);
        if (base64) {
            setLastScreenshot64(base64);
            addToStack(base64, label);
        }
        return base64;
    }, [addToStack]);

    return {
        showScreenshot, setShowScreenshot,
        captureMode, setCaptureMode,
        isCapturing, setIsCapturing,
        lastScreenshot64, setLastScreenshot64,
        useLastScreenshot, setUseLastScreenshot,
        previewImage, setPreviewImage,
        maximizedByPreview, setMaximizedByPreview,
        captureFullScreen,
        captureRaw,
        launchSnipping,
        // Multi-screenshot
        screenshotStack,
        addToStack,
        removeFromStack,
        clearStack,
        captureAndAddToStack,
    };
}
