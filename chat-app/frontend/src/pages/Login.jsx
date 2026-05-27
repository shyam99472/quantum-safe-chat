import React, { useState, useContext } from 'react';
import { useNavigate } from 'react-router-dom';
import api from '../services/api';
import { AuthContext } from '../context/AuthContext';
import { MessageCircle } from 'lucide-react';
import { generateKeyPair, exportPublicKey } from '../utils/crypto';
import { generateKyberKeyPair } from '../utils/pqc';
import { generateDilithiumKeyPair } from '../utils/pqcSignature';
import { loadEncryptedIdentityRecord, storeEncryptedIdentity, unlockEncryptedIdentity } from '../utils/secureIdentityStorage';

const webCrypto = typeof window !== 'undefined' ? window.crypto : globalThis.crypto;

const importStoredPrivateKey = async (serializedPrivateKey) => {
    const privKeyBuffer = new Uint8Array(JSON.parse(serializedPrivateKey)).buffer;
    return webCrypto.subtle.importKey(
        "pkcs8",
        privKeyBuffer,
        { name: "ECDH", namedCurve: "P-256" },
        true,
        ["deriveKey", "deriveBits"]
    );
};

const Login = () => {
    const [username, setUsername] = useState('');
    const [passphrase, setPassphrase] = useState('');
    const [error, setError] = useState('');
    const { login } = useContext(AuthContext);
    const navigate = useNavigate();

    const handleSubmit = async (e) => {
        e.preventDefault();
        setError('');

        if (!username.trim()) {
            setError('Username is required');
            return;
        }

        if (passphrase.length < 8) {
            setError('Passphrase must be at least 8 characters');
            return;
        }

        try {
            // 1. Login to get user data (server now returns a JWT token too)
            const res = await api.post('/auth/login', { username });
            const { token, ...loggedInUser } = res.data;

            const persistedIdentityRecord = loadEncryptedIdentityRecord();
            let persistedIdentity = null;
            if (persistedIdentityRecord?.username === username.trim()) {
                try {
                    persistedIdentity = await unlockEncryptedIdentity(passphrase);
                } catch {
                    setError('Incorrect passphrase for the saved identity');
                    return;
                }
            }

            let keyPair;
            let base64PublicKey;
            let kyberKeyPair;
            let dilithiumKeyPair;
            let exportedPrivKeyArray;

            if (persistedIdentity?.username === username.trim()) {
                const importedPrivateKey = await importStoredPrivateKey(persistedIdentity.privateKey);
                keyPair = {
                    privateKey: importedPrivateKey,
                    publicKey: null
                };
                base64PublicKey = persistedIdentity.identityPublicKey;
                kyberKeyPair = {
                    publicKey: persistedIdentity.pqcPublicKey,
                    privateKey: persistedIdentity.kyberPrivateKey
                };
                dilithiumKeyPair = {
                    publicKey: persistedIdentity.dilithiumPublicKey,
                    privateKey: persistedIdentity.dilithiumPrivateKey
                };
                exportedPrivKeyArray = JSON.parse(persistedIdentity.privateKey);
            } else {
                keyPair = await generateKeyPair();
                base64PublicKey = await exportPublicKey(keyPair.publicKey);
                kyberKeyPair = await generateKyberKeyPair();
                dilithiumKeyPair = generateDilithiumKeyPair();
                const exportedPrivKey = await webCrypto.subtle.exportKey("pkcs8", keyPair.privateKey);
                exportedPrivKeyArray = Array.from(new Uint8Array(exportedPrivKey));
            }

            // 4. Send public keys to backend (protected route - token stored for interceptor)
            // Fix 7: Store token first so the /public-key PUT request carries the Authorization header
            localStorage.setItem('chatToken', token || '');
            await api.put('/auth/public-key', {
                publicKey: base64PublicKey,
                pqcPublicKey: kyberKeyPair.publicKey,
                dilithiumPublicKey: dilithiumKeyPair.publicKey
            });

            // 5. Update loggedInUser with the extremely critical NEW public keys before storing in Context
            loggedInUser.identityPublicKey = base64PublicKey;
            loggedInUser.pqcPublicKey = kyberKeyPair.publicKey;
            loggedInUser.dilithiumPublicKey = dilithiumKeyPair.publicKey;

            // 5b. Persist keys for refresh-survival (session only, cleared on logout or tab close)
            sessionStorage.setItem('temp_privKey_raw', JSON.stringify(exportedPrivKeyArray));
            sessionStorage.setItem('temp_kyber_priv', kyberKeyPair.privateKey);
            sessionStorage.setItem('temp_dilithium_priv', dilithiumKeyPair.privateKey);

            const identityBundle = {
                username: username.trim(),
                privateKey: JSON.stringify(exportedPrivKeyArray),
                identityPublicKey: base64PublicKey,
                kyberPrivateKey: kyberKeyPair.privateKey,
                pqcPublicKey: kyberKeyPair.publicKey,
                dilithiumPrivateKey: dilithiumKeyPair.privateKey,
                dilithiumPublicKey: dilithiumKeyPair.publicKey
            };
            await storeEncryptedIdentity(identityBundle, passphrase);

            // 6. Store user and privateKey in Context (pass token so AuthContext persists it)
            login(loggedInUser, keyPair.privateKey, kyberKeyPair.privateKey, dilithiumKeyPair.privateKey, token);

            navigate('/chat');
        } catch (err) {
            console.error(err);
            setError('Failed to login. Please try again.');
        }
    };

    return (
        <div className="login-page">
            <div className="login-card">
                <MessageCircle size={64} color="var(--wa-primary-color)" style={{ marginBottom: '20px' }} />
                <h1>ChatApp</h1>
                <p style={{ marginBottom: '8px', color: 'var(--wa-text-secondary)' }}>Private chat with encrypted messages and files.</p>
                <p style={{ marginBottom: '20px', color: '#4b5563', fontSize: '13px', lineHeight: '1.5' }}>
                    Use the same passphrase each time to unlock your saved secure identity on this device.
                </p>
                <form onSubmit={handleSubmit}>
                    <input
                        type="text"
                        className="login-input"
                        placeholder="Enter your username"
                        value={username}
                        onChange={(e) => setUsername(e.target.value)}
                        autoFocus
                    />
                    <input
                        type="password"
                        className="login-input"
                        placeholder="Enter your passphrase"
                        value={passphrase}
                        onChange={(e) => setPassphrase(e.target.value)}
                    />
                    {error && <p style={{ color: 'red', marginBottom: '10px' }}>{error}</p>}
                    <button type="submit" className="login-button">
                        Enter Chat
                    </button>
                </form>
            </div>
        </div>
    );
};

export default Login;
