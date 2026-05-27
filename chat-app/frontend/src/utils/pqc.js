import { MlKem512 } from 'crystals-kyber-js';

// Base64 helper functions
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

const kyber = new MlKem512();

export async function generateKyberKeyPair() {
    const [pk, sk] = await kyber.generateKeyPair();
    return {
        publicKey: arrayBufferToBase64(pk),
        privateKey: arrayBufferToBase64(sk)
    };
}

export async function encapsulateKyber(publicKeyBase64) {
    const pk = base64ToArrayBuffer(publicKeyBase64);
    const [ct, ss] = await kyber.encap(pk);
    return {
        ciphertext: arrayBufferToBase64(ct),
        sharedSecret: ss // Uint8Array
    };
}

export async function decapsulateKyber(ciphertextBase64, privateKeyBase64) {
    const ct = base64ToArrayBuffer(ciphertextBase64);
    const sk = base64ToArrayBuffer(privateKeyBase64);
    const ss = await kyber.decap(ct, sk);
    return ss; // Uint8Array
}
