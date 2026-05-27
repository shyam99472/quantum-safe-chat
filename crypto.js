/**
 * crypto.js
 * Frontend utility module for cryptographic operations using Web Crypto API.
 */

// Safely access the global crypto object (browser or modern Node.js)
const webCrypto = typeof window !== 'undefined' ? window.crypto : globalThis.crypto;

/**
 * Utility: Convert ArrayBuffer to Base64 string.
 * Made asynchronous to adhere to the module's async nature.
 * @param {ArrayBuffer} buffer
 * @returns {Promise<string>}
 */
async function arrayBufferToBase64(buffer) {
    const bytes = new Uint8Array(buffer);
    let binary = '';
    // Process in chunks if dealing with very large buffers, but simple iteration is fine for typical payloads
    for (let i = 0; i < bytes.byteLength; i++) {
        binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
}

/**
 * Utility: Convert Base64 string to ArrayBuffer.
 * Made asynchronous to adhere to the module's async nature.
 * @param {string} base64
 * @returns {Promise<ArrayBuffer>}
 */
async function base64ToArrayBuffer(base64) {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
        bytes[i] = binary.charCodeAt(i);
    }
    return bytes.buffer;
}

/**
 * Generates an X25519 key pair using SubtleCrypto.
 * @returns {Promise<CryptoKeyPair>} A Promise that resolves to the generated key pair.
 */
export async function generateKeyPair() {
    return await webCrypto.subtle.generateKey(
        {
            name: "X25519",
        },
        true, // Make the keys extractable
        ["deriveKey", "deriveBits"]
    );
}

/**
 * Exports a public key to a base64 string (SPKI format).
 * @param {CryptoKey} publicKey - The public key to export.
 * @returns {Promise<string>} A Promise that resolves to the base64 encoded public key.
 */
export async function exportPublicKey(publicKey) {
    const exportedBuffer = await webCrypto.subtle.exportKey("spki", publicKey);
    return await arrayBufferToBase64(exportedBuffer);
}

/**
 * Imports a remote public key from a base64 string (SPKI format).
 * @param {string} base64Key - The base64 encoded remote public key.
 * @returns {Promise<CryptoKey>} A Promise that resolves to the imported CryptoKey.
 */
export async function importPublicKey(base64Key) {
    const buffer = await base64ToArrayBuffer(base64Key);
    return await webCrypto.subtle.importKey(
        "spki",
        buffer,
        {
            name: "X25519"
        },
        true,
        []
    );
}

/**
 * Derives a shared secret using ECDH and derives an AES-256-GCM key from it using HKDF (SHA-256).
 * @param {CryptoKey} privateKey - Your local private key.
 * @param {CryptoKey} remotePublicKey - The remote party's imported public key.
 * @returns {Promise<CryptoKey>} A Promise resolving to the derived AES-256-GCM CryptoKey.
 */
export async function deriveAESKey(privateKey, remotePublicKey) {
    // 1. Derive shared secret bits using ECDH (X25519 output is 256 bits)
    const sharedSecretBits = await webCrypto.subtle.deriveBits(
        {
            name: "X25519",
            public: remotePublicKey
        },
        privateKey,
        256
    );

    // 2. Import the derived shared secret as an raw HKDF key
    const hkdfKey = await webCrypto.subtle.importKey(
        "raw",
        sharedSecretBits,
        { name: "HKDF" },
        false, // Not extractable
        ["deriveKey"]
    );

    // 3. Derive AES-256-GCM key from the HKDF key using SHA-256
    const aesKey = await webCrypto.subtle.deriveKey(
        {
            name: "HKDF",
            hash: "SHA-256",
            salt: new Uint8Array(), // Empty salt (standard baseline if not using a specific salt)
            info: new Uint8Array(), // Empty info (standard baseline)
        },
        hkdfKey,
        {
            name: "AES-GCM",
            length: 256
        },
        true, // Make AES key extractable if needed, otherwise false
        ["encrypt", "decrypt"]
    );

    return aesKey;
}

/**
 * Encrypts a plaintext message using AES-GCM.
 * Generates a random 12-byte nonce.
 * @param {string} plaintext - The plaintext message to encrypt.
 * @param {CryptoKey} aesKey - The AES-256-GCM key derived earlier.
 * @returns {Promise<{ciphertext: string, nonce: string}>} A Promise resolving to base64 encoded ciphertext and nonce.
 */
export async function encryptMessage(plaintext, aesKey) {
    // Generate a random 12-byte nonce (96 bits), the recommended size for AES-GCM
    const nonce = webCrypto.getRandomValues(new Uint8Array(12));
    const encoder = new TextEncoder();
    const encodedPlaintext = encoder.encode(plaintext);

    const ciphertextBuffer = await webCrypto.subtle.encrypt(
        {
            name: "AES-GCM",
            iv: nonce
        },
        aesKey,
        encodedPlaintext
    );

    const ciphertextBase64 = await arrayBufferToBase64(ciphertextBuffer);
    const nonceBase64 = await arrayBufferToBase64(nonce.buffer);

    return {
        ciphertext: ciphertextBase64,
        nonce: nonceBase64
    };
}

/**
 * Decrypts a ciphertext using AES-GCM.
 * @param {string} ciphertext - The base64 encoded ciphertext.
 * @param {CryptoKey} aesKey - The AES-256-GCM key.
 * @param {string} nonce - The base64 encoded nonce used during encryption.
 * @returns {Promise<string>} A Promise resolving to the decrypted plaintext.
 */
export async function decryptMessage(ciphertext, aesKey, nonce) {
    const ciphertextBuffer = await base64ToArrayBuffer(ciphertext);
    const nonceBuffer = await base64ToArrayBuffer(nonce);

    const decryptedBuffer = await webCrypto.subtle.decrypt(
        {
            name: "AES-GCM",
            iv: new Uint8Array(nonceBuffer) // The exact same IV generated during encryption
        },
        aesKey,
        ciphertextBuffer
    );

    const decoder = new TextDecoder();
    return decoder.decode(decryptedBuffer);
}
