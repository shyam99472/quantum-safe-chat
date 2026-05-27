/**
 * aiSocket.js — Async AI event handler for Socket.IO
 *
 * This module is PURELY ADDITIVE. It does NOT modify any existing
 * message flow, encryption, session, ratchet, or PQC logic.
 *
 * Flow:
 *   1. Client sends message (encrypted) → instant delivery (unchanged)
 *   2. Client separately emits "ai_process_request" with { messageId, type, text }
 *   3. This handler calls aiClient → FastAPI
 *   4. Result emitted back via "ai_result"
 *
 * Security:
 *   - NEVER receives private keys, session keys, or raw crypto material
 *   - AI only sees plaintext AFTER user-side approval (client decrypts first)
 *   - All processing is fire-and-forget; socket events never blocked
 *
 * Logging: Only messageId and feature type. NEVER plaintext or keys.
 */

const aiClient = require('../services/aiClient');

module.exports = function (io) {
    io.on('connection', (socket) => {
        /**
         * ai_process_request — Async AI processing
         *
         * Payload:
         *   - messageId: string (MongoDB _id of the message)
         *   - type: 'translate' | 'nsfw-check' | 'privacy-check' | 'summarize' | 'calendar-extract' | 'transcribe'
         *   - text: string (plaintext, already decrypted client-side, user-approved)
         *   - targetLanguage?: string (for translate)
         *   - messages?: string[] (for summarize)
         */
        socket.on('ai_process_request', async (data) => {
            const { messageId, type, text, targetLanguage, messages: msgList, requestId, fileBase64, filename } = data || {};

            if (!type) return;

            // Log only allowed fields
            console.log(`[AI] Processing: type=${type}, messageId=${messageId || 'N/A'}`);

            let result = null;

            try {
                switch (type) {
                    case 'translate':
                        if (!text) break;
                        result = await aiClient.translate(text, targetLanguage || 'en');
                        break;

                    case 'nsfw-check':
                        if (!text) break;
                        result = await aiClient.nsfwCheckText(text);
                        break;

                    case 'privacy-check':
                        if (!text) break;
                        result = await aiClient.privacyCheck(text);
                        break;

                    case 'summarize':
                        if (!msgList || !Array.isArray(msgList) || msgList.length === 0) break;
                        result = await aiClient.summarize(msgList);
                        break;

                    case 'calendar-extract':
                        if (!text) break;
                        result = await aiClient.calendarExtract(text);
                        break;

                    case 'nsfw-check-image':
                        if (!fileBase64 || !filename) break;
                        result = await aiClient.nsfwCheckImage(Buffer.from(fileBase64, 'base64'), filename);
                        break;

                    case 'transcribe':
                        if (!fileBase64 || !filename) break;
                        result = await aiClient.transcribe(Buffer.from(fileBase64, 'base64'), filename);
                        break;

                    default:
                        console.warn(`[AI] Unknown type: ${type}`);
                        break;
                }
            } catch (err) {
                // Fail silently — never break the chat
                console.warn(`[AI] Failed for type=${type}: ${err.message}`);
            }

            if (result) {
                socket.emit('ai_result', {
                    messageId: messageId || null,
                    requestId: requestId || null,
                    resultType: type,
                    data: result,
                });
            }
        });

        /**
         * ai_check_available — Check if AI service is reachable
         */
        socket.on('ai_check_available', async (_, callback) => {
            const available = await aiClient.isAvailable();
            if (typeof callback === 'function') {
                callback({ available });
            } else {
                socket.emit('ai_availability', { available });
            }
        });
    });
};
