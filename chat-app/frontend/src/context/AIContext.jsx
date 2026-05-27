/**
 * AIContext.jsx — React context for AI feature results and state.
 *
 * Provides:
 *   - aiResults: Map of messageId → { translation, nsfw, privacy, calendar, transcription }
 *   - AI action dispatchers (requestTranslation, requestNsfwCheck, etc.)
 *   - aiAvailable: boolean (whether AI service is reachable)
 *   - summaryResult / showSummaryModal for the summarizer
 *   - privacyWarning / showPrivacyModal for the privacy guard
 *
 * All AI actions are async, non-blocking, and fire-and-forget.
 * They NEVER modify the encrypted message flow.
 */
import React, { createContext, useContext, useState, useEffect, useCallback, useRef } from 'react';
import { SocketContext } from './SocketContext';

export const AIContext = createContext();

const fileToBase64 = async (file) => {
    const buffer = await file.arrayBuffer();
    let binary = '';
    const bytes = new Uint8Array(buffer);
    for (let i = 0; i < bytes.length; i++) {
        binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
};

export const AIProvider = ({ children }) => {
    const { socket } = useContext(SocketContext);

    // Map: messageId → { translation, nsfw, calendar, transcription }
    const [aiResults, setAiResults] = useState({});

    // AI service availability
    const [aiAvailable, setAiAvailable] = useState(false);
    const [aiStatus, setAiStatus] = useState('checking');

    // Summary modal state
    const [summaryResult, setSummaryResult] = useState(null);
    const [showSummaryModal, setShowSummaryModal] = useState(false);

    // Privacy modal state
    const [privacyWarning, setPrivacyWarning] = useState(null);
    const [showPrivacyModal, setShowPrivacyModal] = useState(false);
    const privacyResolveRef = useRef(null);
    const privacyRequestIdRef = useRef(0);

    // User preference: target translation language
    const [targetLanguage, setTargetLanguage] = useState(
        () => localStorage.getItem('ai_target_lang') || 'en'
    );

    // Persist language preference
    useEffect(() => {
        localStorage.setItem('ai_target_lang', targetLanguage);
    }, [targetLanguage]);

    const checkAiAvailability = useCallback(() => {
        if (!socket) {
            setAiAvailable(false);
            setAiStatus('offline');
            return;
        }

        setAiStatus('checking');
        socket.emit('ai_check_available', {}, (resp) => {
            const available = Boolean(resp?.available);
            setAiAvailable(available);
            setAiStatus(available ? 'online' : 'offline');
        });
    }, [socket]);

    // Listen for AI results from the backend
    useEffect(() => {
        if (!socket) return;

        const handleAiResult = ({ messageId, resultType, data }) => {
            if (!messageId && resultType !== 'summarize') return;

            if (resultType === 'summarize') {
                setSummaryResult(data);
                setShowSummaryModal(true);
                return;
            }

            setAiResults(prev => ({
                ...prev,
                [messageId]: {
                    ...prev[messageId],
                    [resultType]: data,
                },
            }));
        };

        const handleAiAvailability = ({ available }) => {
            setAiAvailable(Boolean(available));
            setAiStatus(available ? 'online' : 'offline');
        };

        socket.on('ai_result', handleAiResult);
        socket.on('ai_availability', handleAiAvailability);

        const initialCheck = window.setTimeout(checkAiAvailability, 0);
        const availabilityInterval = window.setInterval(checkAiAvailability, 30000);

        return () => {
            window.clearTimeout(initialCheck);
            window.clearInterval(availabilityInterval);
            socket.off('ai_result', handleAiResult);
            socket.off('ai_availability', handleAiAvailability);
        };
    }, [socket, checkAiAvailability]);

    // ── Dispatchers ────────────────────────────────────────────────

    const requestTranslation = useCallback((messageId, text, lang) => {
        if (!socket || !aiAvailable) return;
        socket.emit('ai_process_request', {
            messageId,
            type: 'translate',
            text,
            targetLanguage: lang || targetLanguage,
        });
    }, [socket, aiAvailable, targetLanguage]);

    const requestNsfwCheck = useCallback((messageId, text) => {
        if (!socket || !aiAvailable) return;
        socket.emit('ai_process_request', {
            messageId,
            type: 'nsfw-check',
            text,
        });
    }, [socket, aiAvailable]);

    /**
     * Privacy check — returns a Promise that resolves to the user's decision.
     * Shows a modal with: 'send', 'auto-delete', or 'cancel'.
     */
    const requestPrivacyCheck = useCallback((text) => {
        if (!socket || !aiAvailable) return Promise.resolve({ action: 'send' });

        return new Promise((resolve) => {
            const requestId = `privacy-${Date.now()}-${++privacyRequestIdRef.current}`;
            const onResult = ({ resultType, data, requestId: resultRequestId }) => {
                if (resultType !== 'privacy-check' || resultRequestId !== requestId) return;
                socket.off('ai_result', onResult);

                if (data && data.hasPII) {
                    setPrivacyWarning(data);
                    setShowPrivacyModal(true);
                    privacyResolveRef.current = resolve;
                } else {
                    resolve({ action: 'send' });
                }
            };

            socket.on('ai_result', onResult);
            socket.emit('ai_process_request', {
                requestId,
                type: 'privacy-check',
                text,
            });

            // Timeout: if no response in 3s, proceed with send
            setTimeout(() => {
                socket.off('ai_result', onResult);
                resolve({ action: 'send' });
            }, 3500);
        });
    }, [socket, aiAvailable]);

    const resolvePrivacy = useCallback((action) => {
        setShowPrivacyModal(false);
        setPrivacyWarning(null);
        if (privacyResolveRef.current) {
            privacyResolveRef.current({ action });
            privacyResolveRef.current = null;
        }
    }, []);

    const requestSummary = useCallback((messages) => {
        if (!socket || !aiAvailable) return;
        socket.emit('ai_process_request', {
            type: 'summarize',
            messages,
        });
    }, [socket, aiAvailable]);

    const requestCalendarExtract = useCallback((messageId, text) => {
        if (!socket || !aiAvailable) return;
        socket.emit('ai_process_request', {
            messageId,
            type: 'calendar-extract',
            text,
        });
    }, [socket, aiAvailable]);

    const requestFileNsfwCheck = useCallback(async (messageId, file) => {
        if (!socket || !aiAvailable || !file?.type?.startsWith('image/')) return;
        const fileBase64 = await fileToBase64(file);
        socket.emit('ai_process_request', {
            messageId,
            type: 'nsfw-check-image',
            fileBase64,
            filename: file.name || 'image'
        });
    }, [socket, aiAvailable]);

    const requestTranscription = useCallback(async (messageId, file) => {
        if (!socket || !aiAvailable || !file?.type?.startsWith('audio/')) return;
        const fileBase64 = await fileToBase64(file);
        socket.emit('ai_process_request', {
            messageId,
            type: 'transcribe',
            fileBase64,
            filename: file.name || 'audio'
        });
    }, [socket, aiAvailable]);

    // Clear results for a specific message (e.g., when switching chats)
    const clearResults = useCallback(() => {
        setAiResults({});
    }, []);

    const value = {
        aiResults,
        aiAvailable,
        aiStatus,
        targetLanguage,
        setTargetLanguage,
        checkAiAvailability,
        requestTranslation,
        requestNsfwCheck,
        requestFileNsfwCheck,
        requestPrivacyCheck,
        resolvePrivacy,
        privacyWarning,
        showPrivacyModal,
        requestSummary,
        summaryResult,
        showSummaryModal,
        setShowSummaryModal,
        requestCalendarExtract,
        requestTranscription,
        clearResults,
    };

    return (
        <AIContext.Provider value={value}>
            {children}
        </AIContext.Provider>
    );
};
