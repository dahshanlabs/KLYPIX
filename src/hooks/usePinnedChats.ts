import { useState, useEffect } from 'react';
import type { Message, PinnedChat } from '../types';

interface UsePinnedChatsOptions {
    messages: Message[];
    setMessages: React.Dispatch<React.SetStateAction<Message[]>>;
    currentChatId: string | null;
    setCurrentChatId: (id: string | null) => void;
}

export function usePinnedChats({ messages, setMessages, currentChatId, setCurrentChatId }: UsePinnedChatsOptions) {
    const [pinnedChats, setPinnedChats] = useState<PinnedChat[]>([]);
    const [showHistory, setShowHistory] = useState(false);

    useEffect(() => {
        try {
            const saved = localStorage.getItem('pinned_chats');
            if (saved) setPinnedChats(JSON.parse(saved));
        } catch (e) { console.error('Could not load pinned chats', e); }
    }, []);

    useEffect(() => {
        try {
            localStorage.setItem('pinned_chats', JSON.stringify(pinnedChats));
        } catch (e) { console.error('Could not save pinned chats', e); }
    }, [pinnedChats]);

    const handlePinConversation = () => {
        if (messages.length === 0) return;

        if (currentChatId) {
            setPinnedChats(prev => prev.filter(c => c.id !== currentChatId));
            setCurrentChatId(null);
        } else {
            let preview = messages[0].content;
            if (preview.length > 50) preview = preview.substring(0, 50) + '...';
            const newId = Date.now().toString();
            setPinnedChats(prev => {
                const updated = [{
                    id: newId,
                    timestamp: Date.now(),
                    previewText: preview,
                    messages: [...messages],
                }, ...prev];
                // Cap at 50 pinned chats — drop oldest
                if (updated.length > 50) return updated.slice(0, 50);
                return updated;
            });
            setCurrentChatId(newId);
        }
    };

    const handleLoadPinnedChat = (chat: PinnedChat) => {
        setMessages(chat.messages);
        setCurrentChatId(chat.id);
        setShowHistory(false);
    };

    const handleDeletePinnedChat = (e: React.MouseEvent, id: string) => {
        e.stopPropagation();
        setPinnedChats(prev => prev.filter(c => c.id !== id));
        if (currentChatId === id) {
            setCurrentChatId(null);
            setMessages([]);
        }
    };

    return {
        pinnedChats,
        showHistory, setShowHistory,
        handlePinConversation,
        handleLoadPinnedChat,
        handleDeletePinnedChat,
    };
}
