/**
 * aiClient.js — HTTP client for the FastAPI AI service.
 *
 * Responsibilities:
 *   - Send HTTP requests to FastAPI (port 8000)
 *   - 3-second timeout on every request
 *   - Fail silently (never breaks chat flow)
 *   - Concurrency limiter (max 5 concurrent AI jobs)
 *   - NEVER sends private keys, session keys, or raw decrypted secrets
 *
 * Allowed log fields: messageId, feature type.
 * FORBIDDEN logs: plaintext sensitive data, keys.
 */

const AI_SERVICE_URL = process.env.AI_SERVICE_URL || 'http://localhost:8000';
const AI_TIMEOUT_MS = 3000;
const MAX_CONCURRENT_JOBS = 5;
const { Blob } = require('buffer');
const FALLBACK_ENABLED = process.env.AI_FALLBACK_ENABLED !== 'false';

function fallbackTranslate(text, targetLanguage = 'en') {
    return {
        translatedText: text,
        targetLanguage,
        fallback: true,
        note: 'AI service offline; showing original text.'
    };
}

function fallbackNsfwCheckText(text) {
    const blockedTerms = ['nude', 'porn', 'sex', 'kill', 'hate'];
    const pattern = new RegExp(`\\b(${blockedTerms.join('|')})\\b`, 'gi');
    const flagged = pattern.test(text);
    return {
        flagged,
        scores: flagged ? { fallback_match: 1 } : {},
        filteredText: text.replace(pattern, (match) => '*'.repeat(match.length)),
        fallback: true
    };
}

function fallbackPrivacyCheck(text) {
    const detectors = [
        { type: 'EMAIL_ADDRESS', regex: /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi },
        { type: 'PHONE_NUMBER', regex: /\b(?:\+?\d[\d\s().-]{7,}\d)\b/g },
        { type: 'CREDIT_CARD', regex: /\b(?:\d[ -]*?){13,19}\b/g },
        { type: 'IP_ADDRESS', regex: /\b(?:\d{1,3}\.){3}\d{1,3}\b/g }
    ];
    const entities = [];

    for (const detector of detectors) {
        for (const match of text.matchAll(detector.regex)) {
            entities.push({
                type: detector.type,
                start: match.index,
                end: match.index + match[0].length,
                score: 0.8,
                text: match[0]
            });
        }
    }

    return {
        hasPII: entities.length > 0,
        entities,
        fallback: true
    };
}

function fallbackSummarize(messages) {
    const recent = messages.slice(-5).filter(Boolean);
    return {
        summary: recent.length
            ? `Recent chat covered: ${recent.join(' ')}`
            : 'No messages available to summarize.',
        fallback: true
    };
}

function fallbackCalendarExtract(text) {
    const eventPattern = /\b(?:today|tomorrow|on\s+\d{1,2}[/-]\d{1,2}(?:[/-]\d{2,4})?|at\s+\d{1,2}(?::\d{2})?\s?(?:am|pm)?)\b/gi;
    const found = text.match(eventPattern);
    return {
        events: found ? [{ date: '', time: '', event: text }] : [],
        fallback: true
    };
}

function fallbackResult(endpoint, body) {
    if (!FALLBACK_ENABLED) return null;

    switch (endpoint) {
        case '/translate':
            return fallbackTranslate(body.text, body.targetLanguage);
        case '/nsfw-check':
            return fallbackNsfwCheckText(body.text);
        case '/privacy-check':
            return fallbackPrivacyCheck(body.text);
        case '/summarize':
            return fallbackSummarize(body.messages || []);
        case '/calendar-extract':
            return fallbackCalendarExtract(body.text || '');
        default:
            return null;
    }
}

let _activeJobs = 0;
const _queue = [];

/**
 * Internal: process the job queue (FIFO, drop if overloaded).
 */
function _processQueue() {
    while (_activeJobs < MAX_CONCURRENT_JOBS && _queue.length > 0) {
        const job = _queue.shift();
        _activeJobs++;
        job()
            .catch(() => {})
            .finally(() => {
                _activeJobs--;
                _processQueue();
            });
    }
}

/**
 * Enqueue an AI fetch job with concurrency control.
 * Drops the oldest queued request if the queue grows past 20.
 */
function enqueueJob(fn) {
    if (_queue.length > 20) {
        _queue.shift(); // Drop oldest
    }
    return new Promise((resolve, reject) => {
        _queue.push(async () => {
            try {
                const result = await fn();
                resolve(result);
            } catch (err) {
                reject(err);
            }
        });
        _processQueue();
    });
}

/**
 * Internal fetch helper with abort-controller timeout.
 */
async function aiFetch(endpoint, body, options = {}) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), AI_TIMEOUT_MS);

    try {
        const url = `${AI_SERVICE_URL}${endpoint}`;
        const fetchOptions = {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
            signal: controller.signal,
            ...options,
        };

        // If body is FormData (file uploads), remove Content-Type to let fetch set boundary
        if (options.isFormData) {
            delete fetchOptions.headers['Content-Type'];
            fetchOptions.body = body; // raw FormData
        }

        const res = await fetch(url, fetchOptions);
        if (!res.ok) {
            throw new Error(`AI service returned ${res.status}`);
        }
        return await res.json();
    } catch (err) {
        // Fail silently — log only feature type, no sensitive data
        if (err.name === 'AbortError') {
            console.warn(`[aiClient] Timeout on ${endpoint}`);
        } else {
            console.warn(`[aiClient] Error on ${endpoint}: ${err.message}`);
        }
        return fallbackResult(endpoint, body);
    } finally {
        clearTimeout(timeout);
    }
}

// ── Public API ───────────────────────────────────────────────────────

/**
 * Translate text.
 * @param {string} text - Plaintext to translate (user-approved).
 * @param {string} targetLanguage - Target language code.
 * @returns {Promise<{translatedText: string}|null>}
 */
async function translate(text, targetLanguage = 'en') {
    return enqueueJob(() =>
        aiFetch('/translate', { text, targetLanguage })
    );
}

/**
 * NSFW check for text.
 * @param {string} text - Plaintext to check.
 * @returns {Promise<{flagged: boolean, filteredText: string, scores: object}|null>}
 */
async function nsfwCheckText(text) {
    return enqueueJob(() =>
        aiFetch('/nsfw-check', { text })
    );
}

/**
 * NSFW check for image file (via file path on backend).
 * NOTE: This requires the image bytes, handled specially.
 * @param {Buffer} fileBuffer - Image file buffer.
 * @param {string} filename - Original filename.
 * @returns {Promise<{safe: boolean, detections: Array}|null>}
 */
async function nsfwCheckImage(fileBuffer, filename) {
    // For image check, we need to use FormData
    // This is handled via the HTTP route, not the socket flow typically
    return enqueueJob(async () => {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), AI_TIMEOUT_MS);
        try {
            const fd = new FormData();
            fd.append('file', new Blob([fileBuffer]), filename);

            const url = `${AI_SERVICE_URL}/nsfw-check-image`;
            const res = await fetch(url, {
                method: 'POST',
                body: fd,
                signal: controller.signal,
            });
            if (!res.ok) throw new Error(`AI service returned ${res.status}`);
            return await res.json();
        } catch (err) {
            if (err.name === 'AbortError') {
                console.warn('[aiClient] Timeout on /nsfw-check-image');
            } else {
                console.warn(`[aiClient] Error on /nsfw-check-image: ${err.message}`);
            }
            return FALLBACK_ENABLED
                ? { safe: true, detections: [], fallback: true, error: 'Image AI service unavailable' }
                : null;
        } finally {
            clearTimeout(timeout);
        }
    });
}

/**
 * Privacy / PII check.
 * @param {string} text - Plaintext to scan.
 * @returns {Promise<{hasPII: boolean, entities: Array}|null>}
 */
async function privacyCheck(text) {
    return enqueueJob(() =>
        aiFetch('/privacy-check', { text })
    );
}

/**
 * Summarize messages.
 * @param {string[]} messages - Array of plaintext messages.
 * @returns {Promise<{summary: string}|null>}
 */
async function summarize(messages) {
    return enqueueJob(() =>
        aiFetch('/summarize', { messages })
    );
}

/**
 * Extract calendar events from text.
 * @param {string} text - Plaintext to parse.
 * @returns {Promise<{events: Array}|null>}
 */
async function calendarExtract(text) {
    return enqueueJob(() =>
        aiFetch('/calendar-extract', { text })
    );
}

/**
 * Transcribe audio file.
 * @param {Buffer} audioBuffer - Audio file buffer.
 * @param {string} filename - Original filename.
 * @returns {Promise<{text: string, language: string, duration: number}|null>}
 */
async function transcribe(audioBuffer, filename) {
    return enqueueJob(async () => {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), AI_TIMEOUT_MS * 10); // 30s for transcription
        try {
            const fd = new FormData();
            fd.append('file', new Blob([audioBuffer]), filename);

            const url = `${AI_SERVICE_URL}/transcribe`;
            const res = await fetch(url, {
                method: 'POST',
                body: fd,
                signal: controller.signal,
            });
            if (!res.ok) throw new Error(`AI service returned ${res.status}`);
            return await res.json();
        } catch (err) {
            console.warn(`[aiClient] Error on /transcribe: ${err.message}`);
            return FALLBACK_ENABLED
                ? { text: '', fallback: true, error: 'Transcription service unavailable' }
                : null;
        } finally {
            clearTimeout(timeout);
        }
    });
}

/**
 * Health check for AI service availability.
 * @returns {Promise<boolean>}
 */
async function isAvailable() {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 2000);
    try {
        const res = await fetch(`${AI_SERVICE_URL}/health`, { signal: controller.signal });
        return res.ok || FALLBACK_ENABLED;
    } catch {
        return FALLBACK_ENABLED;
    } finally {
        clearTimeout(timeout);
    }
}

module.exports = {
    translate,
    nsfwCheckText,
    nsfwCheckImage,
    privacyCheck,
    summarize,
    calendarExtract,
    transcribe,
    isAvailable,
};
