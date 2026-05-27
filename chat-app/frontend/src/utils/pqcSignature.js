import { ml_dsa65 } from '@noble/post-quantum/ml-dsa.js';

function arrayBufferToBase64(buffer) {
    const bytes = new Uint8Array(buffer);
    let binary = '';
    for (let i = 0; i < bytes.byteLength; i++) {
        binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
}

function base64ToArrayBuffer(base64) {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
        bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
}

export function generateDilithiumKeyPair() {
    const { publicKey, secretKey } = ml_dsa65.keygen();
    return {
        publicKey: arrayBufferToBase64(publicKey),
        privateKey: arrayBufferToBase64(secretKey)
    };
}

function canonicalSerialize(value) {
    if (value === null || typeof value !== 'object') {
        return JSON.stringify(value);
    }

    if (Array.isArray(value)) {
        return `[${value.map(canonicalSerialize).join(',')}]`;
    }

    const entries = Object.keys(value)
        .sort()
        .map((key) => `${JSON.stringify(key)}:${canonicalSerialize(value[key])}`);
    return `{${entries.join(',')}}`;
}

export function buildHandshakeTranscript(payload) {
    return canonicalSerialize({
        version: payload.version,
        senderId: payload.senderId,
        receiverId: payload.receiverId,
        senderEcdhPublicKey: payload.senderEcdhPublicKey,
        kyberCiphertext: payload.kyberCiphertext,
        timestamp: payload.timestamp
    });
}

export function signHandshake(data, privateKeyBase64) {
    const secretKey = base64ToArrayBuffer(privateKeyBase64);
    const msg = new TextEncoder().encode(data);
    const signature = ml_dsa65.sign(msg, secretKey);
    return arrayBufferToBase64(signature);
}

export function verifyHandshake(data, signatureBase64, publicKeyBase64) {
    try {
        const publicKey = base64ToArrayBuffer(publicKeyBase64);
        const signature = base64ToArrayBuffer(signatureBase64);
        const msg = new TextEncoder().encode(data);
        return ml_dsa65.verify(signature, msg, publicKey);
    } catch (err) {
        console.error("Signature verification error:", err);
        return false;
    }
}
