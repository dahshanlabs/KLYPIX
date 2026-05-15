import { useState, useEffect } from 'react';

export function useSettings() {
    const [isTTSEnabled, setIsTTSEnabled] = useState(false);
    const [isVoiceDictationEnabled, setIsVoiceDictationEnabled] = useState(true);
    const [isPrivacyMode, setIsPrivacyMode] = useState(() => {
        const saved = localStorage.getItem('privacy_mode');
        return saved !== null ? JSON.parse(saved) : true;
    });
    const [showSettings, setShowSettings] = useState(false);
    const [currentShortcut, setCurrentShortcut] = useState('Alt+Space');
    const [isRecording, setIsRecording] = useState(false);
    const [selectedModel, setSelectedModel] = useState(() => {
        const saved = localStorage.getItem('selected_model');
        if (saved === 'gemini-1.5-flash') return 'gemini-2.5-flash';
        return saved || 'gemini-2.5-flash';
    });
    const [pdfOcrMode, setPdfOcrMode] = useState<'gemini' | 'local'>(() => {
        return (localStorage.getItem('pdf_ocr_mode') as 'gemini' | 'local') || 'gemini';
    });
    const [powerButtonLabel, setPowerButtonLabel] = useState(() => localStorage.getItem('power_button_label') || '');
    const [powerButtonPrompt, setPowerButtonPrompt] = useState(() => localStorage.getItem('power_button_prompt') || '');

    useEffect(() => {
        localStorage.setItem('privacy_mode', JSON.stringify(isPrivacyMode));
    }, [isPrivacyMode]);

    useEffect(() => {
        localStorage.setItem('selected_model', selectedModel);
    }, [selectedModel]);

    useEffect(() => {
        localStorage.setItem('pdf_ocr_mode', pdfOcrMode);
        (window as any).electron?.setPdfOcrMode?.(pdfOcrMode);
    }, [pdfOcrMode]);

    useEffect(() => {
        localStorage.setItem('power_button_label', powerButtonLabel);
    }, [powerButtonLabel]);

    useEffect(() => {
        localStorage.setItem('power_button_prompt', powerButtonPrompt);
    }, [powerButtonPrompt]);

    useEffect(() => {
        window.electron.getShortcut().then(setCurrentShortcut);
        // Sync PDF OCR mode to main process on init
        (window as any).electron?.setPdfOcrMode?.(pdfOcrMode);
    }, []);

    useEffect(() => {
        if (!isRecording) return;

        const handleGlobalKeyDown = async (e: KeyboardEvent) => {
            e.preventDefault();
            e.stopPropagation();

            const modifiers = [];
            if (e.ctrlKey) modifiers.push('Ctrl');
            if (e.shiftKey) modifiers.push('Shift');
            if (e.altKey) modifiers.push('Alt');
            if (e.metaKey) modifiers.push('Command');

            const key = e.key === ' ' ? 'Space' : e.key;
            const isModifierOnly = ['Control', 'Shift', 'Alt', 'Meta'].includes(e.key);

            if (!isModifierOnly) {
                if (modifiers.length === 0) {
                    alert('Shortcut must include at least one modifier key (Alt, Ctrl, or Shift)');
                    setIsRecording(false);
                    return;
                }

                const newShortcut = [...modifiers, key].join('+');
                const result = await window.electron.setShortcut(newShortcut);
                if (result.success) {
                    setCurrentShortcut(newShortcut);
                    setIsRecording(false);
                } else {
                    alert(result.error || 'Failed to set shortcut');
                    setIsRecording(false);
                }
            }
        };

        window.addEventListener('keydown', handleGlobalKeyDown, true);
        return () => window.removeEventListener('keydown', handleGlobalKeyDown, true);
    }, [isRecording]);

    return {
        isTTSEnabled, setIsTTSEnabled,
        isVoiceDictationEnabled, setIsVoiceDictationEnabled,
        isPrivacyMode, setIsPrivacyMode,
        showSettings, setShowSettings,
        currentShortcut, setCurrentShortcut,
        isRecording, setIsRecording,
        selectedModel, setSelectedModel,
        pdfOcrMode, setPdfOcrMode,
        powerButtonLabel, setPowerButtonLabel,
        powerButtonPrompt, setPowerButtonPrompt,
    };
}
