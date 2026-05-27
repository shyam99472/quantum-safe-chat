import { v4 as uuidv4 } from "uuid";
import { KeyRatchet } from "./keyRatchet";

const MAX_RATCHET_ADVANCE = 50;
const SESSION_STORAGE_KEY = "chatDirectSessions";
const webCrypto = typeof window !== "undefined" ? window.crypto : globalThis.crypto;

class SessionManager {
    constructor() {
        this.currentSession = null;

        // Add logging hook strictly for visibility
        if (typeof window !== "undefined") {
            window.addEventListener("beforeunload", () => {
                if (this.currentSession) {
                    console.log("Session ending due to browser lifecycle event");
                }
            });
        }
    }

    /**
     * Derive a deterministic sessionId from both parties' public keys.
     * Both sides independently compute the same value (sorted keys → SHA‑256 → hex UUID).
     */
    async deriveSessionId(publicKey1, publicKey2) {
        const sorted = [publicKey1, publicKey2].sort();
        const combined = sorted.join('||');
        return this.deriveSessionIdFromSeed(combined);
    }

    async deriveSessionIdFromSeed(seed) {
        const hashBuffer = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(seed));
        const h = Array.from(new Uint8Array(hashBuffer)).map(b => b.toString(16).padStart(2, '0')).join('');
        return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
    }

    async createSession(sessionKey, existingSessionId = null) {
        const sessionId = existingSessionId || uuidv4();

        const sendRatchet = new KeyRatchet();
        const receiveRatchet = new KeyRatchet();
        await sendRatchet.initializeRatchet(sessionKey);
        await receiveRatchet.initializeRatchet(sessionKey);

        this.currentSession = {
            sessionId,
            sessionKey, // strictly for reference; do not persist naturally
            createdAt: Date.now(),
            sendIndex: 0,
            receiveIndex: 0,
            ratchetIndex: 0,
            sendRatchet,
            receiveRatchet,
            pendingReceiveState: null
        };

        console.log("Session created:", sessionId);
        return this.currentSession;
    }

    async persistSession(sessionId, sessionKey, metadata = {}) {
        if (typeof window === "undefined") return;
        const rawKey = await webCrypto.subtle.exportKey("raw", sessionKey);
        const stored = JSON.parse(localStorage.getItem(SESSION_STORAGE_KEY) || "{}");
        stored[sessionId] = {
            sessionId,
            rawKey: Array.from(new Uint8Array(rawKey)),
            metadata,
            updatedAt: Date.now()
        };
        localStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(stored));
    }

    async loadPersistedSessionKey(sessionId) {
        if (typeof window === "undefined" || !sessionId) return null;
        const stored = JSON.parse(localStorage.getItem(SESSION_STORAGE_KEY) || "{}");
        const record = stored[sessionId];
        if (!record?.rawKey) return null;

        return webCrypto.subtle.importKey(
            "raw",
            new Uint8Array(record.rawKey),
            { name: "AES-GCM" },
            true,
            ["encrypt", "decrypt"]
        );
    }

    getSession() {
        return this.currentSession;
    }

    getSendKey() {
        return this.currentSession ? this.currentSession.sendRatchet.getCurrentKey() : null;
    }

    async advanceSendRatchet() {
        if (!this.currentSession) return null;
        this.currentSession.sendIndex++;
        await this.currentSession.sendRatchet.advanceRatchet();
        return {
            key: this.currentSession.sendRatchet.getCurrentKey(),
            index: this.currentSession.sendIndex
        };
    }

    /**
     * Validate and prepare the receive ratchet for the incoming messageIndex.
     * @returns {Promise<{isValid: boolean, key: CryptoKey}>}
     */
    async prepareReceiveRatchet(messageIndex) {
        if (!this.currentSession) {
            return { isValid: false };
        }

        const session = this.currentSession;

        // 1. Replay Protection
        if (messageIndex <= session.receiveIndex) {
            console.warn("Replay attack detected. Message ignored.");
            return { isValid: false };
        }

        // 2. Ratchet Distance Attack Protection (DoS mitigation)
        if (messageIndex > session.receiveIndex + MAX_RATCHET_ADVANCE) {
            console.warn("Ratchet advance threshold exceeded. Session reset triggered.");
            this.resetSession();
            return { isValid: false };
        }

        const previewRatchet = new KeyRatchet();
        await previewRatchet.initializeRatchet(session.receiveRatchet.getCurrentKey());

        let previewIndex = session.ratchetIndex;
        while (previewIndex < messageIndex) {
            await previewRatchet.advanceRatchet();
            previewIndex++;
        }

        const previewKey = previewRatchet.getCurrentKey();
        session.pendingReceiveState = {
            key: previewKey,
            messageIndex,
            ratchetIndex: previewIndex
        };

        return {
            isValid: true,
            key: previewKey
        };
    }

    /**
     * Commit the ratchet sequence after a successful decryption to keep aligned with Sender.
     */
    async commitReceiveRatchet(messageIndex) {
        if (!this.currentSession) return;

        const session = this.currentSession;
        const pendingState = session.pendingReceiveState;

        if (!pendingState || pendingState.messageIndex !== messageIndex) {
            return;
        }

        await session.receiveRatchet.initializeRatchet(pendingState.key);
        session.receiveIndex = messageIndex;
        session.ratchetIndex = pendingState.ratchetIndex;
        session.pendingReceiveState = null;
    }

    cancelReceiveRatchet() {
        if (!this.currentSession) return;
        this.currentSession.pendingReceiveState = null;
    }

    resetSession() {
        if (this.currentSession) {
            console.log("Session destroyed:", this.currentSession.sessionId);
        }
        this.currentSession = null;
    }
}

export const sessionManager = new SessionManager();
