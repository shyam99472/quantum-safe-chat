/**
 * AIFeatures.jsx — UI components for AI-powered chat enhancements.
 *
 * Components:
 *   1. TranslationToggle — Show Original / Show Translated per message
 *   2. NSFWFilter — Replaces toxic words with asterisks, blocks unsafe files
 *   3. PrivacyModal — Warns about detected PII before sending
 *   4. SummaryModal — Shows AI-generated conversation summary
 *   5. CalendarPopup — Shows extracted events with .ics download
 *   6. TranscriptionView — Shows transcribed audio text
 *   7. AIToolbar — Compact toolbar for triggering AI features
 */
import React, { useContext, useState } from 'react';
import { AIContext } from '../context/AIContext';

// ── Styles ─────────────────────────────────────────────────────────
const modalOverlay = {
    position: 'fixed',
    top: 0,
    left: 0,
    width: '100vw',
    height: '100vh',
    backgroundColor: 'rgba(0,0,0,0.45)',
    backdropFilter: 'blur(4px)',
    zIndex: 2000,
    display: 'flex',
    justifyContent: 'center',
    alignItems: 'center',
    animation: 'fadeIn 0.2s ease',
};

const modalBox = {
    backgroundColor: '#fff',
    borderRadius: '16px',
    padding: '28px',
    width: '450px',
    maxWidth: '92vw',
    maxHeight: '80vh',
    overflowY: 'auto',
    boxShadow: '0 25px 50px rgba(0,0,0,0.15)',
};

const btnPrimary = {
    padding: '10px 20px',
    border: 'none',
    borderRadius: '8px',
    backgroundColor: '#128C7E',
    color: '#fff',
    cursor: 'pointer',
    fontWeight: '600',
    fontSize: '14px',
    transition: 'background-color 0.2s',
};

const btnDanger = {
    ...btnPrimary,
    backgroundColor: '#dc2626',
};

const btnSecondary = {
    ...btnPrimary,
    backgroundColor: '#e5e7eb',
    color: '#374151',
};

const btnWarning = {
    ...btnPrimary,
    backgroundColor: '#f59e0b',
    color: '#1a1a1a',
};

const chipStyle = {
    display: 'inline-flex',
    alignItems: 'center',
    gap: '4px',
    padding: '2px 8px',
    borderRadius: '999px',
    fontSize: '11px',
    cursor: 'pointer',
    transition: 'all 0.15s ease',
    border: '1px solid #e5e7eb',
    backgroundColor: '#f9fafb',
    color: '#4b5563',
    userSelect: 'none',
};

const chipActiveStyle = {
    ...chipStyle,
    backgroundColor: '#dbeafe',
    borderColor: '#93c5fd',
    color: '#1d4ed8',
};

// ── 1. Translation Toggle ──────────────────────────────────────────
export const TranslationToggle = ({ messageId, originalText }) => {
    const { aiResults, requestTranslation, aiAvailable, targetLanguage } = useContext(AIContext);
    const [showTranslated, setShowTranslated] = useState(false);
    const result = aiResults[messageId]?.translate;
    const nsfwResult = aiResults[messageId]?.['nsfw-check'];

    const handleTranslate = () => {
        if (!aiAvailable) return;
        if (!result) {
            requestTranslation(messageId, originalText, targetLanguage);
        }
        setShowTranslated(!showTranslated);
    };

    const displayText = showTranslated && result?.translatedText
        ? result.translatedText
        : nsfwResult?.flagged
            ? nsfwResult.filteredText
        : originalText;

    return (
        <div>
            <div style={{ wordBreak: 'break-word' }}>{displayText}</div>
            <button
                onClick={handleTranslate}
                style={{
                    ...chipStyle,
                    marginTop: '4px',
                    opacity: aiAvailable ? 1 : 0.55,
                    ...(showTranslated ? chipActiveStyle : {}),
                }}
                disabled={!aiAvailable}
                title={showTranslated ? 'Show original' : 'Translate'}
            >
                🌐 {showTranslated ? 'Original' : 'Translate'}
                {!result && !showTranslated ? '' : ''}
            </button>
            {nsfwResult?.flagged && (
                <span style={{
                    ...chipStyle,
                    backgroundColor: '#fef2f2',
                    borderColor: '#fca5a5',
                    color: '#b91c1c',
                    cursor: 'default',
                    marginTop: '4px',
                    marginLeft: '4px',
                }}>
                    Filtered
                </span>
            )}
        </div>
    );
};

// ── 2. NSFW Filter ─────────────────────────────────────────────────
export const NSFWFilteredText = ({ messageId, text }) => {
    const { aiResults } = useContext(AIContext);
    const result = aiResults[messageId]?.['nsfw-check'];

    if (result?.flagged) {
        return (
            <div>
                <div style={{ wordBreak: 'break-word', color: '#ef4444' }}>
                    {result.filteredText}
                </div>
                <span style={{
                    ...chipStyle,
                    backgroundColor: '#fef2f2',
                    borderColor: '#fca5a5',
                    color: '#b91c1c',
                    cursor: 'default',
                    marginTop: '4px',
                }}>
                    ⚠️ Filtered
                </span>
            </div>
        );
    }

    return <div style={{ wordBreak: 'break-word' }}>{text}</div>;
};

export const NSFWFileBlock = ({ messageId }) => {
    const { aiResults } = useContext(AIContext);
    const result = aiResults[messageId]?.['nsfw-check-image'];

    if (result && !result.safe) {
        return (
            <div style={{
                padding: '12px',
                backgroundColor: '#fef2f2',
                borderRadius: '8px',
                border: '1px solid #fca5a5',
                textAlign: 'center',
                color: '#b91c1c',
                fontSize: '13px',
            }}>
                🚫 Inappropriate content detected. Download blocked.
            </div>
        );
    }

    return null;
};

// ── 3. Privacy Modal ───────────────────────────────────────────────
export const PrivacyModal = () => {
    const { showPrivacyModal, privacyWarning, resolvePrivacy } = useContext(AIContext);

    if (!showPrivacyModal || !privacyWarning) return null;

    return (
        <div style={modalOverlay}>
            <div style={modalBox}>
                <h3 style={{ margin: '0 0 12px', color: '#b91c1c', fontSize: '18px' }}>
                    🛡️ Privacy Warning
                </h3>
                <p style={{ color: '#4b5563', fontSize: '14px', lineHeight: '1.6' }}>
                    Potential personal information detected in your message:
                </p>
                <div style={{
                    margin: '12px 0',
                    padding: '12px',
                    backgroundColor: '#fffbeb',
                    borderRadius: '8px',
                    border: '1px solid #fcd34d',
                    maxHeight: '200px',
                    overflowY: 'auto',
                }}>
                    {privacyWarning.entities?.map((entity, idx) => (
                        <div key={idx} style={{
                            display: 'flex',
                            justifyContent: 'space-between',
                            padding: '4px 0',
                            fontSize: '13px',
                            borderBottom: idx < privacyWarning.entities.length - 1 ? '1px solid #fde68a' : 'none',
                        }}>
                            <span style={{ fontWeight: '600', color: '#92400e' }}>{entity.type}</span>
                            <span style={{ color: '#78716c' }}>"{entity.text}"</span>
                        </div>
                    ))}
                </div>
                <p style={{ color: '#6b7280', fontSize: '13px', margin: '8px 0 16px' }}>
                    Choose how to proceed:
                </p>
                <div style={{ display: 'flex', gap: '10px', justifyContent: 'flex-end', flexWrap: 'wrap' }}>
                    <button onClick={() => resolvePrivacy('cancel')} style={btnSecondary}>
                        Cancel
                    </button>
                    <button onClick={() => resolvePrivacy('auto-delete')} style={btnWarning}>
                        ⏱️ Auto-delete (5 min)
                    </button>
                    <button onClick={() => resolvePrivacy('send')} style={btnDanger}>
                        Send Anyway
                    </button>
                </div>
            </div>
        </div>
    );
};

// ── 4. Summary Modal ───────────────────────────────────────────────
export const SummaryModal = () => {
    const { showSummaryModal, setShowSummaryModal, summaryResult } = useContext(AIContext);

    if (!showSummaryModal || !summaryResult) return null;

    return (
        <div style={modalOverlay}>
            <div style={modalBox}>
                <h3 style={{ margin: '0 0 16px', fontSize: '18px', color: '#1a1a1a' }}>
                    📋 Conversation Summary
                </h3>
                <div style={{
                    padding: '16px',
                    backgroundColor: '#f0fdf4',
                    borderRadius: '10px',
                    border: '1px solid #bbf7d0',
                    fontSize: '14px',
                    lineHeight: '1.7',
                    color: '#15803d',
                }}>
                    {summaryResult.summary || 'No summary available.'}
                </div>
                <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: '20px' }}>
                    <button onClick={() => setShowSummaryModal(false)} style={btnPrimary}>
                        Close
                    </button>
                </div>
            </div>
        </div>
    );
};

// ── 5. Calendar Popup ──────────────────────────────────────────────
export const CalendarPopup = ({ messageId }) => {
    const { aiResults } = useContext(AIContext);
    const [showPopup, setShowPopup] = useState(false);
    const result = aiResults[messageId]?.['calendar-extract'];

    if (!result || !result.events || result.events.length === 0) return null;

    const generateICS = (event) => {
        const dtStart = `${(event.date || '20260101').replace(/-/g, '')}T${(event.time || '0000').replace(/:/g, '')}00`;
        const dtEnd = dtStart; // Same time for simplicity
        const ics = [
            'BEGIN:VCALENDAR',
            'VERSION:2.0',
            'PRODID:-//ChatApp//AI Calendar//EN',
            'BEGIN:VEVENT',
            `DTSTART:${dtStart}`,
            `DTEND:${dtEnd}`,
            `SUMMARY:${event.event || 'Event'}`,
            'END:VEVENT',
            'END:VCALENDAR',
        ].join('\r\n');

        const blob = new Blob([ics], { type: 'text/calendar' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `${(event.event || 'event').replace(/\s+/g, '_')}.ics`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    };

    return (
        <div style={{ marginTop: '6px' }}>
            <button
                onClick={() => setShowPopup(!showPopup)}
                style={{
                    ...chipStyle,
                    backgroundColor: '#ede9fe',
                    borderColor: '#c4b5fd',
                    color: '#6d28d9',
                }}
            >
                📅 {result.events.length} event{result.events.length > 1 ? 's' : ''} detected
            </button>
            {showPopup && (
                <div style={{
                    marginTop: '8px',
                    padding: '12px',
                    backgroundColor: '#faf5ff',
                    borderRadius: '10px',
                    border: '1px solid #e9d5ff',
                    fontSize: '13px',
                }}>
                    {result.events.map((ev, idx) => (
                        <div key={idx} style={{
                            display: 'flex',
                            justifyContent: 'space-between',
                            alignItems: 'center',
                            padding: '6px 0',
                            borderBottom: idx < result.events.length - 1 ? '1px solid #e9d5ff' : 'none',
                        }}>
                            <div>
                                <div style={{ fontWeight: '600', color: '#4c1d95' }}>{ev.event}</div>
                                <div style={{ color: '#7c3aed', fontSize: '12px' }}>
                                    {ev.date} {ev.time && `at ${ev.time}`}
                                </div>
                            </div>
                            <button
                                onClick={() => generateICS(ev)}
                                style={{
                                    ...chipStyle,
                                    backgroundColor: '#6d28d9',
                                    color: '#fff',
                                    borderColor: '#6d28d9',
                                }}
                            >
                                📥 .ics
                            </button>
                        </div>
                    ))}
                </div>
            )}
        </div>
    );
};

// ── 6. Transcription View ──────────────────────────────────────────
export const TranscriptionView = ({ messageId }) => {
    const { aiResults } = useContext(AIContext);
    const result = aiResults[messageId]?.transcribe;

    if (!result || !result.text) return null;

    return (
        <div style={{
            marginTop: '6px',
            padding: '8px 12px',
            backgroundColor: '#f0f9ff',
            borderRadius: '8px',
            border: '1px solid #bae6fd',
            fontSize: '13px',
            color: '#0369a1',
        }}>
            <div style={{ fontWeight: '600', marginBottom: '4px', fontSize: '11px', color: '#0284c7' }}>
                🎙️ Transcription {result.language && `(${result.language})`}
            </div>
            <div style={{ lineHeight: '1.5' }}>{result.text}</div>
            {result.duration && (
                <div style={{ fontSize: '11px', color: '#7dd3fc', marginTop: '4px' }}>
                    Duration: {result.duration}s
                </div>
            )}
        </div>
    );
};

// ── 7. AI Toolbar ──────────────────────────────────────────────────
export const AIToolbar = ({ messages }) => {
    const { aiAvailable, aiStatus, checkAiAvailability, requestSummary, targetLanguage, setTargetLanguage } = useContext(AIContext);
    const [showLangPicker, setShowLangPicker] = useState(false);

    const languages = [
        { code: 'en', label: '🇬🇧 English' },
        { code: 'es', label: '🇪🇸 Spanish' },
        { code: 'fr', label: '🇫🇷 French' },
        { code: 'de', label: '🇩🇪 German' },
        { code: 'hi', label: '🇮🇳 Hindi' },
        { code: 'zh', label: '🇨🇳 Chinese' },
        { code: 'ja', label: '🇯🇵 Japanese' },
        { code: 'ar', label: '🇸🇦 Arabic' },
        { code: 'pt', label: '🇧🇷 Portuguese' },
        { code: 'ru', label: '🇷🇺 Russian' },
    ];

    const handleSummarize = () => {
        if (!messages || messages.length === 0) return;
        const plainTexts = messages
            .filter(m => m.text && !m.text.startsWith('['))
            .map(m => m.text)
            .slice(-50);
        requestSummary(plainTexts);
    };

    return (
        <div style={{
            display: 'flex',
            alignItems: 'center',
            gap: '6px',
            padding: '4px 12px',
            backgroundColor: '#f8fafc',
            borderBottom: '1px solid #e2e8f0',
            fontSize: '12px',
            position: 'relative',
        }}>
            <span style={{
                fontSize: '10px',
                fontWeight: '700',
                color: '#94a3b8',
                textTransform: 'uppercase',
                letterSpacing: '0.5px',
            }}>
                AI {aiStatus === 'checking' ? 'checking' : aiAvailable ? 'ready' : 'offline'}
            </span>

            {!aiAvailable && (
                <button onClick={checkAiAvailability} style={chipStyle} title="Retry AI service connection">
                    Retry
                </button>
            )}

            <button onClick={handleSummarize} style={{ ...chipStyle, opacity: aiAvailable ? 1 : 0.55 }} disabled={!aiAvailable} title="Summarize conversation">
                📋 Summary
            </button>

            <div style={{ position: 'relative' }}>
                <button
                    onClick={() => setShowLangPicker(!showLangPicker)}
                    style={{ ...chipStyle, opacity: aiAvailable ? 1 : 0.55 }}
                    disabled={!aiAvailable}
                    title="Set translation language"
                >
                    🌐 {targetLanguage.toUpperCase()}
                </button>
                {showLangPicker && (
                    <div style={{
                        position: 'absolute',
                        top: '100%',
                        left: 0,
                        zIndex: 100,
                        backgroundColor: '#fff',
                        borderRadius: '8px',
                        boxShadow: '0 4px 20px rgba(0,0,0,0.12)',
                        border: '1px solid #e5e7eb',
                        padding: '4px',
                        minWidth: '140px',
                    }}>
                        {languages.map(lang => (
                            <button
                                key={lang.code}
                                onClick={() => {
                                    setTargetLanguage(lang.code);
                                    setShowLangPicker(false);
                                }}
                                style={{
                                    display: 'block',
                                    width: '100%',
                                    textAlign: 'left',
                                    padding: '6px 10px',
                                    border: 'none',
                                    backgroundColor: targetLanguage === lang.code ? '#dbeafe' : 'transparent',
                                    borderRadius: '4px',
                                    cursor: 'pointer',
                                    fontSize: '12px',
                                    color: '#374151',
                                }}
                            >
                                {lang.label}
                            </button>
                        ))}
                    </div>
                )}
            </div>
        </div>
    );
};
