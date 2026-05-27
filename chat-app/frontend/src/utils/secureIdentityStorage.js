const IDENTITY_STORAGE_KEY = 'chatIdentityBundleEncrypted';
const PBKDF2_ITERATIONS = 250000;
const SALT_LENGTH = 16;
const IV_LENGTH = 12;

const webCrypto = typeof window !== 'undefined' ? window.crypto : globalThis.crypto;

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

const toBase64 = (buffer) => btoa(String.fromCharCode(...new Uint8Array(buffer)));
const fromBase64 = (value) => Uint8Array.from(atob(value), (char) => char.charCodeAt(0)).buffer;

async function deriveEncryptionKey(passphrase, saltBuffer) {
    const baseKey = await webCrypto.subtle.importKey(
        'raw',
        textEncoder.encode(passphrase),
        'PBKDF2',
        false,
        ['deriveKey']
    );

    return webCrypto.subtle.deriveKey(
        {
            name: 'PBKDF2',
            salt: new Uint8Array(saltBuffer),
            iterations: PBKDF2_ITERATIONS,
            hash: 'SHA-256'
        },
        baseKey,
        { name: 'AES-GCM', length: 256 },
        false,
        ['encrypt', 'decrypt']
    );
}

export function loadEncryptedIdentityRecord() {
    const rawValue = localStorage.getItem(IDENTITY_STORAGE_KEY);
    return rawValue ? JSON.parse(rawValue) : null;
}

export async function storeEncryptedIdentity(identityBundle, passphrase) {
    const salt = webCrypto.getRandomValues(new Uint8Array(SALT_LENGTH));
    const iv = webCrypto.getRandomValues(new Uint8Array(IV_LENGTH));
    const encryptionKey = await deriveEncryptionKey(passphrase, salt.buffer);
    const ciphertext = await webCrypto.subtle.encrypt(
        {
            name: 'AES-GCM',
            iv
        },
        encryptionKey,
        textEncoder.encode(JSON.stringify(identityBundle))
    );

    const record = {
        username: identityBundle.username,
        salt: toBase64(salt.buffer),
        iv: toBase64(iv.buffer),
        ciphertext: toBase64(ciphertext)
    };
    localStorage.setItem(IDENTITY_STORAGE_KEY, JSON.stringify(record));
    return record;
}

export async function unlockEncryptedIdentity(passphrase) {
    const record = loadEncryptedIdentityRecord();
    if (!record) return null;

    const encryptionKey = await deriveEncryptionKey(passphrase, fromBase64(record.salt));
    const decrypted = await webCrypto.subtle.decrypt(
        {
            name: 'AES-GCM',
            iv: new Uint8Array(fromBase64(record.iv))
        },
        encryptionKey,
        fromBase64(record.ciphertext)
    );

    return JSON.parse(textDecoder.decode(decrypted));
}

export function clearEncryptedIdentity() {
    localStorage.removeItem(IDENTITY_STORAGE_KEY);
}
