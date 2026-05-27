const webCrypto = typeof window !== 'undefined' ? window.crypto : globalThis.crypto;

class KeyRatchet {
    constructor() {
        this.currentKey = null;
    }

    async initializeRatchet(initialKey) {
        const rawKey = await webCrypto.subtle.exportKey("raw", initialKey);

        this.currentKey = await webCrypto.subtle.importKey(
            "raw",
            rawKey,
            { name: "AES-GCM" },
            true,
            ["encrypt", "decrypt"]
        );
    }

    async deriveNextKey(currentKey) {
        // Extract raw key material
        const rawKey = await webCrypto.subtle.exportKey("raw", currentKey);

        // Import as raw HKDF base key
        const hkdfKey = await webCrypto.subtle.importKey(
            "raw",
            rawKey,
            { name: "HKDF" },
            false,
            ["deriveKey"]
        );

        // Derive next AES-GCM key
        const nextKey = await webCrypto.subtle.deriveKey(
            {
                name: "HKDF",
                hash: "SHA-256",
                salt: new Uint8Array(),
                info: new TextEncoder().encode("ratchet-step")
            },
            hkdfKey,
            {
                name: "AES-GCM",
                length: 256
            },
            true,
            ["encrypt", "decrypt"]
        );

        return nextKey;
    }

    getCurrentKey() {
        return this.currentKey;
    }

    async advanceRatchet() {
        if (!this.currentKey) throw new Error("Ratchet not initialized");
        this.currentKey = await this.deriveNextKey(this.currentKey);
    }
}

export { KeyRatchet };
