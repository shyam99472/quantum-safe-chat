import React, { createContext, useState, useEffect } from 'react';
import { clearEncryptedIdentity } from '../utils/secureIdentityStorage';

export const AuthContext = createContext();

const USER_STORAGE_KEY = 'chatUser';
const TOKEN_STORAGE_KEY = 'chatToken';
const PRIVATE_KEY_STORAGE_KEY = 'temp_privKey_raw';
const KYBER_PRIVATE_KEY_STORAGE_KEY = 'temp_kyber_priv';
const DILITHIUM_PRIVATE_KEY_STORAGE_KEY = 'temp_dilithium_priv';
export const AuthProvider = ({ children }) => {
    const [user, setUser] = useState(null);
    const [privateKey, setPrivateKey] = useState(null);
    const [kyberPrivateKey, setKyberPrivateKey] = useState(null);
    const [dilithiumPrivateKey, setDilithiumPrivateKey] = useState(null);

    useEffect(() => {
        const restoreKeys = async () => {
            const savedUser = localStorage.getItem(USER_STORAGE_KEY);
            if (savedUser) {
                const userData = JSON.parse(savedUser);
                const rawPrivKey = sessionStorage.getItem(PRIVATE_KEY_STORAGE_KEY);
                const rawKyber = sessionStorage.getItem(KYBER_PRIVATE_KEY_STORAGE_KEY);
                const rawDilithium = sessionStorage.getItem(DILITHIUM_PRIVATE_KEY_STORAGE_KEY);
                const persistedPrivKey = rawPrivKey || null;
                const persistedKyber = rawKyber || null;
                const persistedDilithium = rawDilithium || null;

                if (persistedPrivKey && persistedKyber && persistedDilithium) {
                    try {
                        const privKeyBuffer = new Uint8Array(JSON.parse(persistedPrivKey)).buffer;

                        const importedPrivKey = await window.crypto.subtle.importKey(
                            "pkcs8",
                            privKeyBuffer,
                            { name: "ECDH", namedCurve: "P-256" },
                            true,
                            ["deriveKey", "deriveBits"]
                        );

                        setUser(userData);
                        setPrivateKey(importedPrivKey);
                        setKyberPrivateKey(persistedKyber);
                        setDilithiumPrivateKey(persistedDilithium);
                        console.log("Restored cryptographic identity from session storage.");
                    } catch (err) {
                        console.error("Failed to restore identity", err);
                        sessionStorage.removeItem(PRIVATE_KEY_STORAGE_KEY);
                        sessionStorage.removeItem(KYBER_PRIVATE_KEY_STORAGE_KEY);
                        sessionStorage.removeItem(DILITHIUM_PRIVATE_KEY_STORAGE_KEY);
                    }
                }
            }
        };
        restoreKeys();
    }, []);

    const login = (userData, privKey, kPrivKey, dPrivKey, token) => {
        setUser(userData);
        setPrivateKey(privKey);
        setKyberPrivateKey(kPrivKey);
        setDilithiumPrivateKey(dPrivKey);
        localStorage.setItem(USER_STORAGE_KEY, JSON.stringify(userData));
        if (token) localStorage.setItem(TOKEN_STORAGE_KEY, token);
    };

    const logout = () => {
        setUser(null);
        setPrivateKey(null);
        setKyberPrivateKey(null);
        setDilithiumPrivateKey(null);
        localStorage.removeItem(USER_STORAGE_KEY);
        localStorage.removeItem(TOKEN_STORAGE_KEY);
        sessionStorage.removeItem(PRIVATE_KEY_STORAGE_KEY);
        sessionStorage.removeItem(KYBER_PRIVATE_KEY_STORAGE_KEY);
        sessionStorage.removeItem(DILITHIUM_PRIVATE_KEY_STORAGE_KEY);
        clearEncryptedIdentity();
    };

    return (
        <AuthContext.Provider value={{ user, privateKey, kyberPrivateKey, dilithiumPrivateKey, login, logout }}>
            {children}
        </AuthContext.Provider>
    );
};
