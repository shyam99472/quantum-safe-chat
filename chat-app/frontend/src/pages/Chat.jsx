import React, { useState, useEffect, useContext, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import api from '../services/api';
import { AuthContext } from '../context/AuthContext';
import { SocketContext } from '../context/SocketContext';
import { AIContext } from '../context/AIContext';
import { Paperclip, Send, LogOut, Download, ArrowLeft, MessageCircle, Trash2, X, LoaderCircle } from 'lucide-react';
import { buildAssociatedData, deriveAESKey, encryptMessage, decryptMessage, encryptFile, decryptFile } from '../utils/crypto';
import { encapsulateKyber, decapsulateKyber } from '../utils/pqc';
import { buildHandshakeTranscript, signHandshake, verifyHandshake } from '../utils/pqcSignature';
import { TreeKemState } from '../utils/treeKemState';
import { buildPqBatchPlan } from '../utils/mkyberBatch';
import { exportGroupMetric, exportMetrics, recordGroupMetric } from '../utils/performanceLogger';
import {
    TranslationToggle,
    NSFWFileBlock,
    CalendarPopup,
    TranscriptionView,
    AIToolbar,
    PrivacyModal,
    SummaryModal,
} from '../components/AIFeatures';

import { sessionManager } from '../utils/sessionManager';
import {
    groupSessionManager,
    TREE_INIT_MESSAGE,
    TREE_HEAL_CLASSICAL_MESSAGE,
    TREE_HEAL_PQ_BATCH_MESSAGE,
    TREE_CONTROL_MESSAGES
} from '../utils/groupSessionManager';
import { NO_HEAL } from '../utils/adaptiveScheduler';

const webCrypto = typeof window !== 'undefined' ? window.crypto : globalThis.crypto;
const HANDSHAKE_VERSION = 'pqc-chat-handshake-v2';
const HANDSHAKE_TTL_MS = 5 * 60 * 1000;
const AUTO_DELETE_MS = 5 * 60 * 1000;
const BACKEND_ORIGIN = (import.meta.env.VITE_API_BASE_URL || 'http://localhost:5000/api').replace(/\/api\/?$/, '');

const buildDirectMessageAAD = (message) => buildAssociatedData({
    type: 'direct-message',
    sessionId: message.sessionId || '',
    senderId: message.senderId,
    receiverId: message.receiverId,
    messageIndex: message.messageIndex ?? 0,
    originalFileName: message.originalFileName || '',
    originalFileType: message.originalFileType || '',
    isEncrypted: Boolean(message.isEncrypted),
    hasFile: Boolean(message.fileUrl || message.originalFileName),
});

const isGroupAdmin = (group, userId) => {
    const adminId = typeof group?.adminId === 'object' ? group?.adminId?._id : group?.adminId;
    return adminId?.toString() === userId?.toString();
};

const isTreeControlMessage = (text) => TREE_CONTROL_MESSAGES.includes(text);
const getHealModeLabel = (mode) => {
    if (mode === TREE_HEAL_CLASSICAL_MESSAGE) return 'Classical';
    if (mode === TREE_HEAL_PQ_BATCH_MESSAGE) return 'PQ Batch';
    if (mode === TREE_INIT_MESSAGE) return 'Init';
    return 'Unknown';
};

const approximatePayloadBytes = (value) => new TextEncoder().encode(JSON.stringify(value || {})).length;
const isMessageExpired = (message) => Boolean(message?.expiresAt) && new Date(message.expiresAt).getTime() <= Date.now();

const Chat = () => {
    // Note: privateKey is obtained from AuthContext (memory only, lost on refresh)
    const { user, privateKey, kyberPrivateKey, dilithiumPrivateKey, logout } = useContext(AuthContext);
    const { socket } = useContext(SocketContext);
    const {
        aiAvailable,
        requestNsfwCheck,
        requestFileNsfwCheck,
        requestCalendarExtract,
        requestTranscription,
        requestPrivacyCheck,
        clearResults,
    } = useContext(AIContext);
    const navigate = useNavigate();

    const [users, setUsers] = useState([]);
    const [selectedUser, setSelectedUser] = useState(null);
    const [messages, setMessages] = useState([]);
    const [inputText, setInputText] = useState('');
    const [file, setFile] = useState(null);
    const [isSending, setIsSending] = useState(false);
    const [uiNotice, setUiNotice] = useState(null);
    const [isMobileListView, setIsMobileListView] = useState(true);
    const [groups, setGroups] = useState([]);
    const [selectedGroup, setSelectedGroup] = useState(null);
    const [showGroupModal, setShowGroupModal] = useState(false);
    const [newGroupName, setNewGroupName] = useState('');
    const [selectedMembers, setSelectedMembers] = useState([]);
    const [groupHealStatus, setGroupHealStatus] = useState('');
    const [groupHealBusy, setGroupHealBusy] = useState(false);
    const [groupMetricsView, setGroupMetricsView] = useState(null);
    const selectedGroupRef = useRef(selectedGroup);
    useEffect(() => { selectedGroupRef.current = selectedGroup; }, [selectedGroup]);

    // E2EE
    const [activeSessionKey, setActiveSessionKey] = useState(null);
    const [activeSessionId, setActiveSessionId] = useState(null);

    const messagesEndRef = useRef(null);
    const fileInputRef = useRef(null); // Bug Fix: reset file input element after send

    // Refs for socket callbacks to access latest state
    const selectedUserRef = useRef(selectedUser);
    const activeSessionKeyRef = useRef(activeSessionKey);
    const activeSessionIdRef = useRef(activeSessionId);
    const lastHandshakeRef = useRef(new Map());
    const maybeTriggerAutomaticPqHealRef = useRef(null);

    useEffect(() => {
        selectedUserRef.current = selectedUser;
    }, [selectedUser]);

    useEffect(() => {
        activeSessionKeyRef.current = activeSessionKey;
    }, [activeSessionKey]);

    useEffect(() => {
        activeSessionIdRef.current = activeSessionId;
    }, [activeSessionId]);

    useEffect(() => {
        maybeTriggerAutomaticPqHealRef.current = maybeTriggerAutomaticPqHeal;
    });

    const syncSelectedGroupView = (groupId) => {
        const liveGroup = groupSessionManager.groups.get(groupId);
        if (!liveGroup) return;

        setSelectedGroup((prev) => {
            if (!prev || prev.groupId !== groupId) return prev;
            return {
                ...prev,
                currentHealMode: liveGroup.currentHealMode || prev.currentHealMode || TREE_INIT_MESSAGE,
                groupEpoch: liveGroup.groupEpoch,
                groupMembershipVersion: liveGroup.groupMembershipVersion,
                groupState: liveGroup.groupState
            };
        });
        setGroupMetricsView(exportGroupMetric(groupId));
    };

    const pushNotice = (message, tone = 'info') => {
        setUiNotice({ message, tone });
    };

    const clearNotice = () => {
        setUiNotice(null);
    };

    const formatFileSize = (size) => {
        if (!size) return '';
        if (size < 1024) return `${size} B`;
        if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
        return `${(size / (1024 * 1024)).toFixed(1)} MB`;
    };

    const requestFileAiAnalysis = (messageId, fileLike) => {
        if (!messageId || !fileLike || !aiAvailable) return;
        requestFileNsfwCheck(messageId, fileLike);
        requestTranscription(messageId, fileLike);
    };

    useEffect(() => {
        if (!user) {
            navigate('/');
            return;
        }

        // Fetch user list
        const fetchData = async () => {
            try {
                const res = await api.get('/auth/users');
                setUsers(res.data.filter(u => u._id !== user._id));
                const gRes = await api.get('/groups');
                setGroups(gRes.data);
            } catch (err) {
                console.error('Failed to fetch data', err);
            }
        };
        fetchData();
    }, [user, navigate]);

    useEffect(() => {
        if (socket) {
            const handleReceiveMessage = async (message) => {
                const currentlySelectedUser = selectedUserRef.current;
                // If the message belongs to the currently open chat room, append it
                const msgSenderId = message.senderId?.toString() || (typeof message.sender === 'object' ? message.sender._id?.toString() : message.sender?.toString());
                const msgReceiverId = message.receiverId?.toString() || (typeof message.receiver === 'object' ? message.receiver?._id?.toString() : message.receiver?.toString());
                const myId = user._id?.toString();
                const partnerId = currentlySelectedUser?._id?.toString();

                if (
                    currentlySelectedUser &&
                    ((msgSenderId === partnerId && msgReceiverId === myId) ||
                        (msgSenderId === myId && msgReceiverId === partnerId))
                ) {
                    // LIVE DECRYPTION FIX: Drop our own message echoes from the server completely.
                    // This prevents our own outbound messages from advancing the receiveRatchet incorrectly!
                    if (msgSenderId === myId) {
                        return; // Outbound messages are rendered locally inside handleSendMessage
                    }

                    let processedMsg = message;

                    // Handle Key Exchange messages silently
                    if (message.text === '[KEY_EXCHANGE]') {
                        if (msgSenderId === myId) {
                            return;
                        }

                        const payload = message.payload;
                        const handshakeTimestamp = Number(payload?.timestamp);

                        if (!payload?.signature || !payload?.senderEcdhPublicKey || !payload?.kyberCiphertext || !handshakeTimestamp) {
                            console.warn("Missing Dilithium signature. Rejecting handshake.");
                            return;
                        }

                        if (Math.abs(Date.now() - handshakeTimestamp) > HANDSHAKE_TTL_MS) {
                            console.warn("Stale handshake rejected.");
                            return;
                        }

                        const replayKey = `${msgSenderId}:${payload.kyberCiphertext}:${handshakeTimestamp}`;
                        if (lastHandshakeRef.current.has(replayKey)) {
                            return;
                        }

                        if (kyberPrivateKey && privateKey && typeof message.sender === 'object' && message.sender?.dilithiumPublicKey) {
                            try {
                                const transcript = buildHandshakeTranscript({
                                    version: payload.version,
                                    senderId: msgSenderId,
                                    receiverId: myId,
                                    senderEcdhPublicKey: payload.senderEcdhPublicKey,
                                    kyberCiphertext: payload.kyberCiphertext,
                                    timestamp: payload.timestamp
                                });
                                const isValid = verifyHandshake(transcript, payload.signature, message.sender.dilithiumPublicKey);

                                if (!isValid) {
                                    console.warn("PQC authentication failed");
                                    return;
                                }

                                const kyberSharedSecret = await decapsulateKyber(payload.kyberCiphertext, kyberPrivateKey);
                                const hybridSessionKey = await deriveAESKey(privateKey, payload.senderEcdhPublicKey, kyberSharedSecret);
                                const deterministicId = await sessionManager.deriveSessionIdFromSeed(transcript);
                                const session = await sessionManager.createSession(hybridSessionKey, deterministicId);
                                await sessionManager.persistSession(session.sessionId, hybridSessionKey, {
                                    participants: [msgSenderId, myId].sort()
                                });

                                setActiveSessionKey(hybridSessionKey);
                                activeSessionKeyRef.current = hybridSessionKey;
                                setActiveSessionId(session.sessionId);
                                activeSessionIdRef.current = session.sessionId;
                                lastHandshakeRef.current.set(replayKey, Date.now());
                            } catch (e) {
                                console.error("Hybrid Decapsulation/Auth failed", e);
                            }
                        } else {
                            console.warn("Missing local or remote PQC material. Rejecting handshake.");
                        }
                        return;
                    }

                    // Live Decryption using active session key ref
                    console.log("Live Receive Check - Validating Message payload:", message);
                    if (message.isEncrypted) {
                        const sk = activeSessionKeyRef.current;
                        const activeId = activeSessionIdRef.current;

                        if (sk) {
                            if (message.messageIndex === undefined || message.messageIndex === null) {
                                // Old message (no ratchet)
                                if (message.text) {
                                    try {
                                        const decText = await decryptMessage(
                                            message.text,
                                            sk,
                                            message.nonce,
                                            buildDirectMessageAAD({
                                                sessionId: activeId,
                                                senderId: msgSenderId,
                                                receiverId: msgReceiverId,
                                                messageIndex: message.messageIndex,
                                                originalFileName: message.originalFileName,
                                                originalFileType: message.originalFileType,
                                                fileUrl: message.fileUrl,
                                                isEncrypted: message.isEncrypted
                                            })
                                        );
                                        processedMsg = { ...message, text: decText };
                                    } catch {
                                        processedMsg = { ...message, text: '[Decryption Failed]' };
                                    }
                                }
                            } else {
                                // Enforce Session Mismatch Avoidance
                                if (message.sessionId !== activeId) {
                                    console.warn("Session mismatch detected. Ignoring message.");
                                    return;
                                }

                                const processResult = await sessionManager.prepareReceiveRatchet(message.messageIndex);
                                if (!processResult.isValid) return; // Dropped safely via Replay or DoS Threshold limits

                                const currentKey = processResult.key;

                                if (message.text) {
                                    try {
                                        const decText = await decryptMessage(
                                            message.text,
                                            currentKey,
                                            message.nonce,
                                            buildDirectMessageAAD({
                                                sessionId: message.sessionId,
                                                senderId: msgSenderId,
                                                receiverId: msgReceiverId,
                                                messageIndex: message.messageIndex,
                                                originalFileName: message.originalFileName,
                                                originalFileType: message.originalFileType,
                                                fileUrl: message.fileUrl,
                                                isEncrypted: message.isEncrypted
                                            })
                                        );
                                        processedMsg = { ...message, text: decText, ratchetKey: currentKey };

                                        // Finalize the sync to maintain exact ratchet states with sender
                                        await sessionManager.commitReceiveRatchet(message.messageIndex);
                                    } catch (e) {
                                        console.error('Live decryption failed', e);
                                        sessionManager.cancelReceiveRatchet();
                                        processedMsg = { ...message, text: '[Decryption Failed]', ratchetKey: currentKey };
                                    }
                                } else {
                                    processedMsg = { ...message, ratchetKey: currentKey };
                                    // File message: Commit the sync because the message itself acts as the indexing payload
                                    await sessionManager.commitReceiveRatchet(message.messageIndex);
                                }
                            }
                        }
                    }

                    if (!isMessageExpired(processedMsg)) {
                        setMessages((prev) => [...prev, processedMsg]);
                    }

                    // ── AI: Async background processing on received messages ──
                    // These are fire-and-forget. They NEVER block the message flow.
                    if (processedMsg.text && !processedMsg.text.startsWith('[')) {
                        const msgIdForAI = processedMsg._id || `temp_${Date.now()}`;
                        requestNsfwCheck(msgIdForAI, processedMsg.text);
                        requestCalendarExtract(msgIdForAI, processedMsg.text);
                    }
                }
            };

            socket.on('receive_message', handleReceiveMessage);

                    const handleReceiveGroupMessage = async (message) => {
                const currentlySelectedGroup = selectedGroupRef.current;
                const myId = user._id?.toString();

                if (message.senderId === myId || message.sender?._id?.toString() === myId || message.sender?.toString() === myId) return; // Self-sender protection

                if (isTreeControlMessage(message.text)) {
                    try {
                        const encryptedKeys = message.payload.encryptedKeys;
                        const myEncryptedKeyObj = encryptedKeys[myId];
                        if (!myEncryptedKeyObj) return;

                        const adminPubKey = message.payload.adminPublicKey;
                        let wrapKyberSecret = null;
                        if (myEncryptedKeyObj.kyberCiphertext) {
                            if (!myEncryptedKeyObj.kyberCiphertext || !kyberPrivateKey) {
                                throw new Error('Missing PQ unwrap material');
                            }
                            wrapKyberSecret = await decapsulateKyber(myEncryptedKeyObj.kyberCiphertext, kyberPrivateKey);
                        }
                        const wrapKey = await deriveAESKey(privateKey, adminPubKey, wrapKyberSecret);
                        const decText = await decryptMessage(myEncryptedKeyObj.ciphertext, wrapKey, myEncryptedKeyObj.nonce);

                        // Parse raw key (assuming it was encoded as comma-separated uint8 array string)
                        const newRootKeyRaw = new Uint8Array(decText.split(',').map(Number)).buffer;
                        const groupMembers = message.payload.members || [];

                        // Local rekey / init
                        if (groupSessionManager.groups.has(message.groupId)) {
                            // Rekey
                            await groupSessionManager.rekeyGroup(message.groupId, newRootKeyRaw, groupMembers);
                        } else {
                            // Init
                            await groupSessionManager.initGroup(message.groupId, message.senderId, groupMembers, newRootKeyRaw);
                        }

                        const group = groupSessionManager.groups.get(message.groupId);
                        group.groupEpoch = message.groupEpoch;
                        group.groupMembershipVersion = message.groupMembershipVersion;
                        group.currentHealMode = message.text;
                        group.lastHealAt = Date.now();
                        group.lastSchedulerReason = message.payload?.schedulerReason || `${getHealModeLabel(message.text)} heal received.`;
                        const previousMetrics = exportGroupMetric(message.groupId) || {};
                        recordGroupMetric(message.groupId, {
                            totalHeals: previousMetrics.totalHeals || 0,
                            classicalHeals: previousMetrics.classicalHeals || 0,
                            pqBatchHeals: previousMetrics.pqBatchHeals || 0,
                            initEvents: previousMetrics.initEvents || 0,
                            lastMode: message.text,
                            lastEpoch: message.groupEpoch,
                            lastBatchCount: message.payload?.batchPlan?.totalBatches || 0,
                            lastPayloadBytes: approximatePayloadBytes(message.payload),
                            lastWrapMode: message.payload?.wrapMode || null,
                            lastUpdatedAt: Date.now()
                        });
                        if (message.payload?.treeSnapshot) {
                            group.treeKemState = TreeKemState.fromSnapshot(message.payload.treeSnapshot);
                        }

                        await groupSessionManager.setupLocalSender(message.groupId, myId);
                        for (let mId of groupMembers) {
                            if (mId !== myId) await groupSessionManager.getOrInitReceiveRatchet(message.groupId, mId);
                        }
                        await groupSessionManager.forceActiveState(message.groupId);

                        socket.emit('group_key_update_ack', {
                            groupId: message.groupId,
                            groupEpoch: message.groupEpoch
                        });
                        syncSelectedGroupView(message.groupId);
                        setGroupHealBusy(false);
                        const batchSuffix = message.payload?.batchPlan?.totalBatches
                            ? ` across ${message.payload.batchPlan.totalBatches} batches`
                            : '';
                        setGroupHealStatus(message.payload?.schedulerReason || `${getHealModeLabel(message.text)} heal applied at epoch ${message.groupEpoch}${batchSuffix}`);
                        console.log(`${message.text} synced and ACKed`);
                    } catch (err) {
                        setGroupHealBusy(false);
                        console.error(`Failed to process ${message.text}`, err);
                    }
                    return;
                }

                if (currentlySelectedGroup && message.groupId === currentlySelectedGroup.groupId) {
                    if (message.isEncrypted) {
                        try {
                            const envelope = {
                                groupId: message.groupId,
                                groupEpoch: message.groupEpoch,
                                groupMembershipVersion: message.groupMembershipVersion,
                                senderId: message.senderId,
                                messageIndex: message.messageIndex
                            };
                            const decText = await groupSessionManager.decryptGroupMessage(
                                message.groupId, message.senderId, message.text, message.nonce, envelope
                            );
                            setMessages(prev => [...prev, { ...message, text: decText }]);
                        } catch (decryptErr) {
                            const recommendation = groupSessionManager.markSuspectedCompromise(
                                message.groupId,
                                `Suspicious group decrypt failure detected at epoch ${message.groupEpoch}; PQ recovery recommended.`
                            );
                            syncSelectedGroupView(message.groupId);
                            void maybeTriggerAutomaticPqHealRef.current?.(message.groupId, recommendation);
                            setMessages(prev => [...prev, { ...message, text: '[Decryption Failed]' }]);
                            console.warn('Group decryption failure triggered PCS recovery path', decryptErr);
                        }
                    } else {
                        setMessages(prev => [...prev, message]);
                    }
                }
            };

            const handleReceiveGroupAck = async ({ groupId, userId }) => {
                const synced = await groupSessionManager.ackRekey(groupId, userId);
                syncSelectedGroupView(groupId);
                if (synced) {
                    setGroupHealBusy(false);
                    setGroupHealStatus(groupSessionManager.groups.get(groupId)?.lastSchedulerReason || `Healing synchronized for epoch ${groupSessionManager.groups.get(groupId)?.groupEpoch ?? ''}`.trim());
                    console.log("Group fully synced!");
                }
            };

            const handleGroupCreated = (newGroup) => {
                setGroups(prev => {
                    if (prev.some(existing => existing.groupId === newGroup.groupId)) {
                        return prev;
                    }
                    return [...prev, newGroup];
                });
            };

            const handleGroupDeleted = ({ groupId }) => {
                setGroups(prev => prev.filter(group => group.groupId !== groupId));
                groupSessionManager.groups.delete(groupId);
                if (selectedGroupRef.current?.groupId === groupId) {
                    setSelectedGroup(null);
                    setMessages([]);
                    setIsMobileListView(true);
                }
            };

            const handleGroupMemberLeft = ({ groupId, userId }) => {
                let remainingMembers = null;
                setGroups(prev => prev.map(group => {
                    if (group.groupId !== groupId) {
                        return group;
                    }

                    const members = Array.isArray(group.members)
                        ? group.members.filter(member => {
                            const memberId = typeof member === 'object' ? member?._id : member;
                            return memberId?.toString() !== userId?.toString();
                        })
                        : group.members;
                    remainingMembers = Array.isArray(members)
                        ? members.map(member => typeof member === 'object' ? member?._id : member).filter(Boolean)
                        : null;
                    return { ...group, members };
                }));

                const recommendation = groupSessionManager.noteMembershipChange(groupId, remainingMembers);
                syncSelectedGroupView(groupId);
                void maybeTriggerAutomaticPqHealRef.current?.(groupId, recommendation);
            };

            socket.on('receive_group_message', handleReceiveGroupMessage);
            socket.on('receive_group_key_update_ack', handleReceiveGroupAck);
            socket.on('group_created', handleGroupCreated);
            socket.on('group_deleted', handleGroupDeleted);
            socket.on('group_member_left', handleGroupMemberLeft);

            socket.on('user_status_change', ({ userId, isOnline }) => {
                setUsers(prev => prev.map(u => u._id === userId ? { ...u, isOnline } : u));
                if (selectedUserRef.current && selectedUserRef.current._id === userId) {
                    setSelectedUser(prev => ({ ...prev, isOnline }));
                }
            });

            // Notification for messages from non-selected users could go here
            const handleNewMessageNotification = (message) => {
                const currentlySelectedUser = selectedUserRef.current;
                if (!currentlySelectedUser || (message.sender._id !== currentlySelectedUser._id && message.sender !== currentlySelectedUser._id)) {
                    // Could show an unread badge or toast notification here
                    console.log('New encrypted message received from', message.sender.username);
                }
            };

            socket.on('new_message_notification', handleNewMessageNotification);

            return () => {
                socket.off('receive_message', handleReceiveMessage);
                socket.off('receive_group_message', handleReceiveGroupMessage);
                socket.off('receive_group_key_update_ack', handleReceiveGroupAck);
                socket.off('group_created', handleGroupCreated);
                socket.off('group_deleted', handleGroupDeleted);
                socket.off('group_member_left', handleGroupMemberLeft);
                socket.off('user_status_change');
                socket.off('new_message_notification', handleNewMessageNotification);
            };
        }
    }, [socket, user, kyberPrivateKey, privateKey, requestCalendarExtract, requestNsfwCheck]);

    useEffect(() => {
        // Scroll to bottom when messages change
        messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }, [messages]);

    useEffect(() => {
        const intervalId = window.setInterval(() => {
            setMessages((prev) => prev.filter((message) => !isMessageExpired(message)));
        }, 1000);

        return () => window.clearInterval(intervalId);
    }, []);

    useEffect(() => {
        if (!uiNotice) return undefined;
        const timeoutId = window.setTimeout(() => {
            setUiNotice(null);
        }, 4000);

        return () => window.clearTimeout(timeoutId);
    }, [uiNotice]);

    const handleUserSelect = async (u) => {
        clearResults();
        clearNotice();
        if (selectedUser) {
            socket?.emit('leave_room', { senderId: user._id, receiverId: selectedUser._id });
        }
        if (selectedGroup) {
            socket?.emit('leave_group_room', { groupId: selectedGroup.groupId });
        }
        setSelectedUser(u);
        setSelectedGroup(null); // Fix: Ensure selections are mutually exclusive
        setIsMobileListView(false);

        // Fix 1: Reset ratchet instances entirely when switching conversation partners
        sessionManager.resetSession();
        setActiveSessionKey(null);
        activeSessionKeyRef.current = null;
        setActiveSessionId(null);
        activeSessionIdRef.current = null;

        // Join room
        socket?.emit('join_room', { senderId: user._id, receiverId: u._id });

        // Fetch chat history
        try {
            // Re-fetch users to guarantee we have the latest ephemeral public keys in case the remote user refreshed
            const usersRes = await api.get('/auth/users');
            setUsers(usersRes.data.filter(userObj => userObj._id !== user._id));
            const latestSelectedUser = usersRes.data.find(userObj => userObj._id === u._id);
            const latestPublicKey = latestSelectedUser ? latestSelectedUser.identityPublicKey : u.identityPublicKey;
            const latestPqcPublicKey = latestSelectedUser ? latestSelectedUser.pqcPublicKey : u.pqcPublicKey;

            const res = await api.get(`/messages/${user._id}/${u._id}`);
            const fetchedMessages = res.data.filter(m => m.text !== '[KEY_EXCHANGE]');

            // 1. Derive Session Key
            let sessionKey = null;

            console.log("Private key exists:", !!privateKey);
            console.log("Receiver latest public key:", latestPublicKey);

            if (privateKey && latestPublicKey && latestPqcPublicKey && dilithiumPrivateKey) {
                try {
                    const kyberResult = await encapsulateKyber(latestPqcPublicKey);
                    const timestamp = Date.now().toString();
                    const transcript = buildHandshakeTranscript({
                        version: HANDSHAKE_VERSION,
                        senderId: user._id,
                        receiverId: u._id,
                        senderEcdhPublicKey: user.identityPublicKey,
                        kyberCiphertext: kyberResult.ciphertext,
                        timestamp
                    });
                    const signature = signHandshake(transcript, dilithiumPrivateKey);
                    const deterministicId = await sessionManager.deriveSessionIdFromSeed(transcript);

                    socket?.emit('send_message', {
                        senderId: user._id,
                        receiverId: u._id,
                        text: '[KEY_EXCHANGE]',
                        isEncrypted: false,
                        payload: {
                            version: HANDSHAKE_VERSION,
                            senderEcdhPublicKey: user.identityPublicKey,
                            kyberCiphertext: kyberResult.ciphertext,
                            signature,
                            timestamp
                        }
                    });

                    sessionKey = await deriveAESKey(privateKey, latestPublicKey, kyberResult.sharedSecret);
                    console.log("Hybrid session key derived successfully.");
                    setActiveSessionKey(sessionKey);
                    activeSessionKeyRef.current = sessionKey;

                    const session = await sessionManager.createSession(sessionKey, deterministicId);
                    await sessionManager.persistSession(session.sessionId, sessionKey, {
                        participants: [user._id, u._id].sort()
                    });
                    setActiveSessionId(session.sessionId);
                    activeSessionIdRef.current = session.sessionId;
                } catch (err) {
                    console.error('Failed to derive session key', err);
                }
            } else {
                console.warn('Cannot derive session key: missing PQC or ECDH key material. Secure messaging disabled.');
                setActiveSessionKey(null);
            }

            // 2. Batch Decryption
            if (sessionKey) {
                const sessionKeyCaches = new Map();

                const getRatchetKey = async (baseSessionKey, sessionId, targetIndex) => {
                    if (targetIndex === undefined || targetIndex === null) return baseSessionKey;
                    if (!sessionKeyCaches.has(sessionId || "__default")) {
                        sessionKeyCaches.set(sessionId || "__default", { 0: baseSessionKey });
                    }

                    const keyCache = sessionKeyCaches.get(sessionId || "__default");
                    if (keyCache[targetIndex]) return keyCache[targetIndex];

                    let startingIndex = 0;
                    for (let i = targetIndex - 1; i >= 0; i--) {
                        if (keyCache[i]) {
                            startingIndex = i;
                            break;
                        }
                    }

                    const { KeyRatchet } = await import('../utils/keyRatchet');
                    const tempRatchet = new KeyRatchet();
                    await tempRatchet.initializeRatchet(keyCache[startingIndex]);
                    for (let i = startingIndex; i < targetIndex; i++) {
                        await tempRatchet.advanceRatchet();
                        keyCache[i + 1] = tempRatchet.getCurrentKey();
                    }
                    return keyCache[targetIndex];
                };

                const decryptedBatch = await Promise.all(fetchedMessages.map(async (m) => {
                    if (m.isEncrypted && (m.text || m.fileUrl)) {
                        try {
                            const historicalSessionKey = await sessionManager.loadPersistedSessionKey(m.sessionId) || sessionKey;
                            const decryptionKey = await getRatchetKey(historicalSessionKey, m.sessionId, m.messageIndex);
                            if (!m.text) {
                                return { ...m, ratchetKey: decryptionKey };
                            }
                            const decText = await decryptMessage(
                                m.text,
                                decryptionKey,
                                m.nonce,
                                buildDirectMessageAAD({
                                    sessionId: m.sessionId,
                                    senderId: typeof m.sender === 'object' ? m.sender._id : m.sender,
                                    receiverId: typeof m.receiver === 'object' ? m.receiver?._id : m.receiver,
                                    messageIndex: m.messageIndex,
                                    originalFileName: m.originalFileName,
                                    originalFileType: m.originalFileType,
                                    fileUrl: m.fileUrl,
                                    isEncrypted: m.isEncrypted
                                })
                            );
                            return { ...m, text: decText, ratchetKey: decryptionKey };
                        } catch {
                            return { ...m, text: '[Decryption Failed - Prior Session]' };
                        }
                    }
                    return m;
                }));
                setMessages(decryptedBatch.filter((message) => !isMessageExpired(message)));
            } else {
                setMessages(fetchedMessages.filter((message) => !isMessageExpired(message)));
            }

        } catch (err) {
            console.error('Failed to fetch messages', err);
        }
    };

    const handleLogout = () => {
        clearResults();
        clearNotice();
        if (selectedGroup) {
            socket?.emit('leave_group_room', { groupId: selectedGroup.groupId });
        }
        if (selectedUser) {
            socket?.emit('leave_room', { senderId: user._id, receiverId: selectedUser._id });
        }
        logout();
        navigate('/');
    };

    const handleLeaveSelectedGroup = async () => {
        if (!selectedGroup) return;
        if (isGroupAdmin(selectedGroup, user._id)) {
            alert('Admin cannot leave the group. Please delete it instead.');
            return;
        }

        try {
            await api.delete(`/groups/${selectedGroup.groupId}/members/me`);
        } catch (err) {
            alert(err.response?.data?.error || 'Failed to leave group');
            return;
        }

        socket?.emit('leave_group_room', { groupId: selectedGroup.groupId });

        groupSessionManager.groups.delete(selectedGroup.groupId);
        setGroups(prev => prev.filter(group => group.groupId !== selectedGroup.groupId));
        setSelectedGroup(null);
        setMessages([]);
        setIsMobileListView(true);
    };

    const handleDeleteSelectedGroup = async () => {
        if (!selectedGroup) return;
        if (!isGroupAdmin(selectedGroup, user._id)) {
            alert('Only the group admin can delete the group.');
            return;
        }

        const confirmed = window.confirm(`Delete group "${selectedGroup.name}"?`);
        if (!confirmed) return;

        try {
            await api.delete(`/groups/${selectedGroup.groupId}`);
        } catch (err) {
            alert(err.response?.data?.error || 'Failed to delete group');
            return;
        }

        socket?.emit('delete_group', { groupId: selectedGroup.groupId }, () => {});
        groupSessionManager.groups.delete(selectedGroup.groupId);
        setGroups(prev => prev.filter(group => group.groupId !== selectedGroup.groupId));
        setSelectedGroup(null);
        setMessages([]);
        setIsMobileListView(true);
    };

    const buildWrappedGroupKeys = async (memberIds, rootKeyRaw, controlType = TREE_INIT_MESSAGE, batchPlan = null) => {
        const encryptedKeys = {};
        const rootKeyArray = Array.from(new Uint8Array(rootKeyRaw)).join(',');
        const useHybridWrap = true;
        const usePqBatchWrap = controlType === TREE_HEAL_PQ_BATCH_MESSAGE;

        for (const memberId of memberIds) {
            if (memberId === user._id) continue;
            const memberUser = users.find(u => u._id === memberId);
            if (!memberUser?.identityPublicKey) continue;

            let kyberCiphertext = null;
            let kyberSharedSecret = null;
            if (useHybridWrap && memberUser.pqcPublicKey) {
                const kyberResult = await encapsulateKyber(memberUser.pqcPublicKey);
                kyberCiphertext = kyberResult.ciphertext;
                kyberSharedSecret = kyberResult.sharedSecret;
            }

            const wrapKey = await deriveAESKey(privateKey, memberUser.identityPublicKey, kyberSharedSecret);
            const { ciphertext, nonce } = await encryptMessage(rootKeyArray, wrapKey);
            encryptedKeys[memberId] = {
                ciphertext,
                nonce,
                wrapMode: kyberCiphertext
                    ? (usePqBatchWrap ? 'hybrid-pq-batch' : 'hybrid-baseline')
                    : 'classical-fallback',
                kyberCiphertext,
                batchId: batchPlan?.recipientToBatch?.[memberId] || null
            };
        }

        return encryptedKeys;
    };

    const dispatchTreeKemControlMessage = async (groupId, controlType, rootKeyRaw, memberIds, epoch, membershipVersion, treeSnapshot, extraPayload = {}) => {
        const batchPlan = controlType === TREE_HEAL_PQ_BATCH_MESSAGE
            ? buildPqBatchPlan(memberIds, user._id, groupSessionManager.groups.get(groupId)?.treeKemState)
            : null;
        const encryptedKeys = await buildWrappedGroupKeys(memberIds, rootKeyRaw, controlType, batchPlan);
        const payload = {
            encryptedKeys,
            adminPublicKey: user.identityPublicKey,
            members: memberIds,
            treeSnapshot,
            updateType: controlType,
            wrapMode: controlType === TREE_HEAL_PQ_BATCH_MESSAGE ? 'hybrid-pq-batch' : 'hybrid-baseline',
            batchPlan,
            ...extraPayload
        };

        const previousMetrics = exportGroupMetric(groupId) || {};
        recordGroupMetric(groupId, {
            totalHeals: (previousMetrics.totalHeals || 0) + (controlType === TREE_INIT_MESSAGE ? 0 : 1),
            classicalHeals: (previousMetrics.classicalHeals || 0) + (controlType === TREE_HEAL_CLASSICAL_MESSAGE ? 1 : 0),
            pqBatchHeals: (previousMetrics.pqBatchHeals || 0) + (controlType === TREE_HEAL_PQ_BATCH_MESSAGE ? 1 : 0),
            initEvents: (previousMetrics.initEvents || 0) + (controlType === TREE_INIT_MESSAGE ? 1 : 0),
            lastMode: controlType,
            lastEpoch: epoch,
            lastBatchCount: batchPlan?.totalBatches || 0,
            lastPayloadBytes: approximatePayloadBytes(payload),
            lastWrapMode: payload.wrapMode,
            lastUpdatedAt: Date.now()
        });
        setGroupMetricsView(exportGroupMetric(groupId));

        socket.emit('group_message', {
            groupId,
            senderId: user._id,
            text: controlType,
            isEncrypted: false,
            groupEpoch: epoch,
            groupMembershipVersion: membershipVersion,
            payload
        });
    };

    const handleTriggerGroupHeal = async (mode, schedulerReason = null) => {
        if (!selectedGroup) return;
        if (!isGroupAdmin(selectedGroup, user._id)) {
            alert('Only the group admin can trigger healing updates.');
            return;
        }

        try {
            setGroupHealBusy(true);
            const modeStatus = mode === TREE_HEAL_PQ_BATCH_MESSAGE
                ? 'PQ Batch heal in progress with hybrid ECDH + Kyber wrapping...'
                : `${getHealModeLabel(mode)} heal in progress...`;
            setGroupHealStatus(schedulerReason || modeStatus);
            const liveGroup = groupSessionManager.groups.get(selectedGroup.groupId);
            if (!liveGroup) {
                setGroupHealBusy(false);
                alert('Group state is not ready locally yet.');
                return;
            }

            const healUpdate = await groupSessionManager.beginHealingEpoch(selectedGroup.groupId, {
                mode,
                actorId: user._id,
                members: liveGroup.members
            });

            await dispatchTreeKemControlMessage(
                selectedGroup.groupId,
                mode,
                healUpdate.rootKeyRaw,
                healUpdate.members,
                healUpdate.groupEpoch,
                healUpdate.groupMembershipVersion,
                healUpdate.treeSnapshot,
                schedulerReason ? { schedulerReason } : {}
            );
            syncSelectedGroupView(selectedGroup.groupId);
            const sentStatus = mode === TREE_HEAL_PQ_BATCH_MESSAGE
                ? `PQ Batch heal sent for epoch ${healUpdate.groupEpoch} using hybrid ECDH + Kyber wraps`
                : `${getHealModeLabel(mode)} heal sent for epoch ${healUpdate.groupEpoch}`;
            const batchPlan = mode === TREE_HEAL_PQ_BATCH_MESSAGE
                ? buildPqBatchPlan(healUpdate.members, user._id, groupSessionManager.groups.get(selectedGroup.groupId)?.treeKemState)
                : null;
            const batchStatus = batchPlan?.totalBatches
                ? `${sentStatus} in ${batchPlan.totalBatches} batches`
                : sentStatus;
            setGroupHealStatus(schedulerReason || batchStatus);
        } catch (err) {
            setGroupHealBusy(false);
            console.error(`Failed to trigger ${mode}`, err);
            alert(`Failed to trigger ${mode}: ${err.message}`);
        }
    };

    const maybeTriggerAutomaticPqHeal = async (groupId, recommendation) => {
        if (!recommendation || recommendation.action === NO_HEAL) return;
        if (recommendation.action !== TREE_HEAL_PQ_BATCH_MESSAGE) return;
        if (groupHealBusy) return;

        const activeGroup = selectedGroupRef.current;
        if (!activeGroup || activeGroup.groupId !== groupId) {
            setGroupHealStatus(recommendation.reason);
            return;
        }

        if (!isGroupAdmin(activeGroup, user._id)) {
            setGroupHealStatus(recommendation.reason);
            return;
        }

        await handleTriggerGroupHeal(TREE_HEAL_PQ_BATCH_MESSAGE, recommendation.reason);
    };

    const handleCreateGroup = async () => {
        if (!newGroupName.trim() || selectedMembers.length === 0) return;
        const groupId = "group_" + Date.now();
        const allMembers = [user._id, ...selectedMembers];

        const newRootKeyRaw = webCrypto.getRandomValues(new Uint8Array(32)).buffer;
        const useTreeInitFlow = true;

        if (useTreeInitFlow) {
            const createGroupResult = await new Promise((resolve) => {
                socket.emit('create_group', {
                    groupId,
                    name: newGroupName,
                    members: allMembers
                }, resolve);
            });

            if (!createGroupResult?.ok) {
                alert(createGroupResult?.error || 'Failed to create group');
                return;
            }

            await groupSessionManager.initGroup(groupId, user._id, allMembers, newRootKeyRaw);
            await groupSessionManager.setupLocalSender(groupId, user._id);
            for (const memberId of allMembers) {
                if (memberId !== user._id) {
                    await groupSessionManager.getOrInitReceiveRatchet(groupId, memberId);
                }
            }

            await dispatchTreeKemControlMessage(
                groupId,
                TREE_INIT_MESSAGE,
                newRootKeyRaw,
                allMembers,
                1,
                1,
                groupSessionManager.groups.get(groupId)?.treeKemState?.serialize() || null
            );

            socket.emit('join_group', { groupId });
            setGroups(prev => prev.some(group => group.groupId === groupId)
                ? prev
                : [...prev, {
                    groupId,
                    name: newGroupName,
                    adminId: { _id: user._id, username: user.username },
                    members: allMembers.map(memberId => memberId === user._id ? { _id: user._id, username: user.username } : users.find(u => u._id === memberId)).filter(Boolean),
                    currentHealMode: TREE_INIT_MESSAGE,
                    groupEpoch: 1
                }]);

            setShowGroupModal(false);
            setNewGroupName('');
            setSelectedMembers([]);
            return;
        }

        const encryptedKeys = {};
        for (let mId of allMembers) {
            // Skip admin — their local session is initialized directly, not via GROUP_KEY_UPDATE
            if (mId === user._id) continue;
            const mUser = users.find(u => u._id === mId);
            if (mUser && mUser.identityPublicKey) {
                const wrapKey = await deriveAESKey(privateKey, mUser.identityPublicKey, null);
                const rootKeyArray = Array.from(new Uint8Array(newRootKeyRaw)).join(',');
                const { ciphertext, nonce } = await encryptMessage(rootKeyArray, wrapKey);
                encryptedKeys[mId] = { ciphertext, nonce };
            }
        }

        const createGroupResult = await new Promise((resolve) => {
            socket.emit('create_group', {
                groupId,
                name: newGroupName,
                members: allMembers
            }, resolve);
        });

        if (!createGroupResult?.ok) {
            alert(createGroupResult?.error || 'Failed to create group');
            return;
        }

        await groupSessionManager.initGroup(groupId, user._id, allMembers, newRootKeyRaw);
        await groupSessionManager.setupLocalSender(groupId, user._id);
        for (let mId of allMembers) {
            if (mId !== user._id) {
                await groupSessionManager.getOrInitReceiveRatchet(groupId, mId);
            }
        }

        socket.emit('group_message', {
            groupId,
            senderId: user._id,
            text: '[GROUP_KEY_UPDATE]',
            isEncrypted: false,
            groupEpoch: 1,
            groupMembershipVersion: 1,
            payload: {
                encryptedKeys,
                adminPublicKey: user.identityPublicKey,
                members: allMembers,
                treeSnapshot: groupSessionManager.groups.get(groupId)?.treeKemState?.serialize() || null
            }
        });

        socket.emit('join_group', { groupId });
        setGroups(prev => prev.some(group => group.groupId === groupId)
            ? prev
            : [...prev, { groupId, name: newGroupName, adminId: { _id: user._id, username: user.username }, members: allMembers.map(memberId => memberId === user._id ? { _id: user._id, username: user.username } : users.find(u => u._id === memberId)).filter(Boolean) }]);

        setShowGroupModal(false);
        setNewGroupName('');
        setSelectedMembers([]);
    };

    const handleGroupSelect = async (g) => {
        clearResults();
        clearNotice();
        if (selectedUser) socket?.emit('leave_room', { senderId: user._id, receiverId: selectedUser._id });
        if (selectedGroup) socket?.emit('leave_group_room', { groupId: selectedGroup.groupId });
        setSelectedUser(null);
        setSelectedGroup({
            ...g,
            currentHealMode: g.currentHealMode || TREE_INIT_MESSAGE,
            groupEpoch: g.groupEpoch || 1
        });
        setGroupHealBusy(false);
        setGroupHealStatus('');
        setIsMobileListView(false);
        socket?.emit('join_group', { groupId: g.groupId });

        try {
            const res = await api.get(`/groups/${g.groupId}/messages`);
            const history = res.data;
            const myId = user._id.toString();
            const keyUpdates = history.filter(m => isTreeControlMessage(m.text) && m.payload?.encryptedKeys);
            const epochStates = await groupSessionManager.loadPersistedEpochStates(g.groupId);

            for (const keyUpdate of keyUpdates) {
                try {
                    const encryptedKeys = keyUpdate.payload.encryptedKeys;
                    const myEncryptedKeyObj = encryptedKeys[myId];
                    if (!myEncryptedKeyObj) continue;

                    const adminPubKey = keyUpdate.payload.adminPublicKey;
                    const senderId = keyUpdate.sender._id || keyUpdate.sender;
                    let wrapKyberSecret = null;
                    if (myEncryptedKeyObj.kyberCiphertext) {
                        if (!myEncryptedKeyObj.kyberCiphertext || !kyberPrivateKey) {
                            throw new Error('Missing PQ unwrap material in history');
                        }
                        wrapKyberSecret = await decapsulateKyber(myEncryptedKeyObj.kyberCiphertext, kyberPrivateKey);
                    }
                    const wrapKey = await deriveAESKey(privateKey, adminPubKey, wrapKyberSecret);
                    const decText = await decryptMessage(myEncryptedKeyObj.ciphertext, wrapKey, myEncryptedKeyObj.nonce);
                    const rootKeyRaw = new Uint8Array(decText.split(',').map(Number)).buffer;
                    const rootHkdfKey = await webCrypto.subtle.importKey(
                        "raw",
                        rootKeyRaw,
                        { name: "HKDF" },
                        false,
                        ["deriveKey"]
                    );

                    epochStates.set(keyUpdate.groupEpoch || 1, {
                        adminId: senderId,
                        members: keyUpdate.payload.members || [],
                        rootKeyRaw,
                        rootHkdfKey,
                        groupEpoch: keyUpdate.groupEpoch || 1,
                        groupMembershipVersion: keyUpdate.groupMembershipVersion || 1,
                        treeKemState: keyUpdate.payload.treeSnapshot
                            ? TreeKemState.fromSnapshot(keyUpdate.payload.treeSnapshot)
                            : null
                    });
                } catch (initErr) {
                    console.warn('Failed to unwrap group epoch from history:', initErr);
                }
            }

            const latestEpochState = [...epochStates.values()].sort((a, b) => a.groupEpoch - b.groupEpoch).at(-1);

            if (latestEpochState && !groupSessionManager.groups.has(g.groupId)) {
                try {
                    await groupSessionManager.initGroup(g.groupId, latestEpochState.adminId, latestEpochState.members, latestEpochState.rootKeyRaw);
                    const group = groupSessionManager.groups.get(g.groupId);
                    group.groupEpoch = latestEpochState.groupEpoch;
                    group.groupMembershipVersion = latestEpochState.groupMembershipVersion;
                    if (latestEpochState.treeKemState) {
                        group.treeKemState = latestEpochState.treeKemState instanceof TreeKemState
                            ? latestEpochState.treeKemState
                            : TreeKemState.fromSnapshot(latestEpochState.treeKemState);
                    }
                    group.currentHealMode = latestEpochState.groupEpoch > 1
                        ? (g.currentHealMode || TREE_HEAL_CLASSICAL_MESSAGE)
                        : TREE_INIT_MESSAGE;

                    await groupSessionManager.setupLocalSender(g.groupId, myId);
                    for (const memberId of latestEpochState.members) {
                        if (memberId !== myId) await groupSessionManager.getOrInitReceiveRatchet(g.groupId, memberId);
                    }
                    console.log(`Group ${g.groupId} auto-initialized from history successfully.`);
                    syncSelectedGroupView(g.groupId);
                } catch (initErr) {
                    console.warn('Failed to auto-initialize group from history:', initErr);
                }
            }

            const decryptedBatch = await Promise.all(history.map(async (m) => {
                if (isTreeControlMessage(m.text)) {
                    return null;
                }

                if (!m.isEncrypted || !m.text) {
                    return m;
                }

                const senderId = m.sender._id || m.sender;
                const epochState = epochStates.get(m.groupEpoch) || latestEpochState;
                if (!epochState) {
                    return { ...m, text: '[Decryption Failed - Missing Group Key]' };
                }

                try {
                    const { KeyRatchet } = await import('../utils/keyRatchet');
                    const tempRatchet = new KeyRatchet();
                    const senderBaseKey = await groupSessionManager.deriveSenderBaseKey(epochState.rootHkdfKey, senderId);
                    await tempRatchet.initializeRatchet(senderBaseKey);

                    for (let i = 0; i < (m.messageIndex || 0); i++) {
                        await tempRatchet.advanceRatchet();
                    }

                    const decryptionKey = tempRatchet.getCurrentKey();
                    const decText = await decryptMessage(
                        m.text,
                        decryptionKey,
                        m.nonce,
                        buildAssociatedData({
                            type: "group-message",
                            groupId: g.groupId,
                            groupEpoch: m.groupEpoch,
                            groupMembershipVersion: m.groupMembershipVersion,
                            senderId,
                            messageIndex: m.messageIndex
                        })
                    );
                    return { ...m, text: decText };
                } catch {
                    return { ...m, text: '[Decryption Failed - Session Resynced]' };
                }
            }));

            setMessages(decryptedBatch.filter(Boolean));
        } catch (err) {
            console.error('Failed to fetch/process group history:', err);
        }
    };

    const handleFileChange = (e) => {
        if (e.target.files.length > 0) {
            setFile(e.target.files[0]);
            pushNotice(`Attached ${e.target.files[0].name}`, 'info');
        }
    };

    const handleSendMessage = async (e) => {
        try {
            e.preventDefault();
            setIsSending(true);

        if (!selectedUser && !selectedGroup) return;
        if (!inputText.trim() && !file) return;
        let expiresAt = null;

        // ── AI: Privacy guard (sender side, non-blocking with 3s timeout) ──
        // Only check text messages in 1-to-1 chats. Group messages skip this for now.
        if (inputText.trim() && selectedUser && aiAvailable) {
            const privacyDecision = await requestPrivacyCheck(inputText.trim());
            if (privacyDecision.action === 'cancel') {
                pushNotice('Message not sent.', 'warning');
                return; // User cancelled after seeing PII warning
            }
            // If 'auto-delete', we'll attach expiryTime (handled below)
            if (privacyDecision.action === 'auto-delete') {
                // Store the expiry flag — the message will be auto-deleted in 5 minutes
                // This is added to the message data below
                expiresAt = new Date(Date.now() + AUTO_DELETE_MS).toISOString();
            }
        }

        let fileUrl = null;
        let fileType = null;
        let originalFileName = null;
        let originalFileType = null; // Fix 6: Preserve original MIME type before encryption
        let fileNonceBase64 = null;
        let payloadNonce = null;
        let isEncrypted = false;
        let payloadText = inputText.trim();

        if (selectedGroup) {
            const groupId = selectedGroup.groupId;
            let groupState = groupSessionManager.groups.get(groupId);
            if (!groupState) {
                try {
                    const epochStates = await groupSessionManager.loadPersistedEpochStates(groupId);
                    const latestEpochState = [...epochStates.values()].sort((a, b) => a.groupEpoch - b.groupEpoch).at(-1);
                    if (latestEpochState) {
                        await groupSessionManager.initGroup(groupId, latestEpochState.adminId, latestEpochState.members, latestEpochState.rootKeyRaw);
                        groupState = groupSessionManager.groups.get(groupId);
                        groupState.groupEpoch = latestEpochState.groupEpoch;
                        groupState.groupMembershipVersion = latestEpochState.groupMembershipVersion;
                        if (latestEpochState.treeKemState) {
                            groupState.treeKemState = latestEpochState.treeKemState instanceof TreeKemState
                                ? latestEpochState.treeKemState
                                : TreeKemState.fromSnapshot(latestEpochState.treeKemState);
                        }
                        await groupSessionManager.setupLocalSender(groupId, user._id);
                        for (const memberId of latestEpochState.members) {
                            if (memberId !== user._id) {
                                await groupSessionManager.getOrInitReceiveRatchet(groupId, memberId);
                            }
                        }
                    }
                } catch (groupInitErr) {
                    console.warn('Failed to restore local group state before send:', groupInitErr);
                }
            }
            if (!groupState) return alert("Group not initialized locally");
            if (groupState.groupState === "REKEYING") {
                return alert("Keys are currently updating. Please wait a moment before sending.");
            }

            // Currently no group file encryption support, just text for prototype
            if (file) {
                return alert("File sending in groups not yet supported in this prototype.");
            }

            try {
                const { ciphertext, nonce, envelope } = await groupSessionManager.encryptGroupMessage(groupId, user._id, payloadText);

                const msgData = {
                    groupId,
                    senderId: user._id,
                    text: ciphertext,
                    isEncrypted: true,
                    nonce: nonce,
                    groupEpoch: envelope.groupEpoch,
                    groupMembershipVersion: envelope.groupMembershipVersion,
                    messageIndex: envelope.messageIndex
                };
                socket?.emit('group_message', msgData);

                const localRenderMsg = {
                    ...msgData,
                    sender: { _id: user._id, username: user.username },
                    text: payloadText, // pristine plaintext
                };
                setMessages((prev) => [...prev, localRenderMsg]);
                const recommendation = groupSessionManager.recordGroupMessageActivity(groupId);
                syncSelectedGroupView(groupId);
                if (isGroupAdmin(selectedGroup, user._id) && !groupHealBusy && recommendation.action !== NO_HEAL) {
                    await handleTriggerGroupHeal(recommendation.action, recommendation.reason);
                } else if (isGroupAdmin(selectedGroup, user._id) && recommendation.action === NO_HEAL) {
                    setGroupHealStatus(recommendation.reason);
                }
                setInputText('');
                setFile(null);
                if (fileInputRef.current) fileInputRef.current.value = '';
                pushNotice('Group message sent securely.', 'success');
            } catch (err) {
                console.error("Group encrypt error", err);
                pushNotice(`Failed to send group message: ${err.message}`, 'error');
            }
            return; // Always return after group branch — never fall through to 1-to-1 code
        }

        if (!activeSessionKey || !activeSessionId) {
            pushNotice('Secure session not ready yet. Reopen the chat and try again.', 'warning');
            return;
        }

        // Advance Ratchet ONCE per message, BEFORE ANY ENCRYPTION (1-1 logic)
        let msgIndex = 0;
        let exportId = activeSessionId;

        if (activeSessionKey) {
            isEncrypted = true;
            const res = await sessionManager.advanceSendRatchet();
            if (res) {
                msgIndex = res.index;
                exportId = sessionManager.getSession().sessionId;
                console.log("Ratchet sync index: (Send)", msgIndex);
            }
        }

        // E2E File Encryption
        if (file) {
            originalFileType = file.type; // Fix 6: Capture original MIME type before any transformation
            originalFileName = file.name;
            try {
                const arrayBuffer = await file.arrayBuffer();
                let blobToUpload = file;

                if (isEncrypted) {
                    const currentKey = sessionManager.getSendKey();
                    if (!currentKey) throw new Error("Missing active ratchet key for file encryption.");
                    const fileAAD = buildDirectMessageAAD({
                        sessionId: exportId,
                        senderId: user._id,
                        receiverId: selectedUser._id,
                        messageIndex: msgIndex,
                        originalFileName,
                        originalFileType,
                        fileUrl: null,
                        isEncrypted: true
                    });
                    // Encrypt raw ArrayBuffer
                    const { ciphertextBuffer, nonceBase64 } = await encryptFile(arrayBuffer, currentKey, fileAAD);
                    blobToUpload = new Blob([ciphertextBuffer], { type: originalFileType || file.type || 'application/octet-stream' });
                    fileNonceBase64 = nonceBase64;
                    payloadNonce = nonceBase64;
                }

                const formData = new FormData();
                formData.append('file', blobToUpload, file.name);

                const res = await api.post('/messages/upload', formData, {
                    headers: { 'Content-Type': 'multipart/form-data' }
                });

                fileUrl = res.data.filePath;
                fileType = res.data.fileType;
                originalFileName = res.data.originalName || originalFileName;
            } catch (err) {
                console.error('Error encrypting/uploading file', err);
                pushNotice(err.response?.data?.error || err.message || 'File upload failed.', 'error');
                return;
            }
        }

        console.log("Active Session Key:", !!activeSessionKey);

        // E2E Text Encryption
        if (isEncrypted) {
            const currentKey = sessionManager.getSendKey();
            if (payloadText && currentKey) {
                try {
                    const enc = await encryptMessage(
                        payloadText,
                        currentKey,
                        buildDirectMessageAAD({
                            sessionId: exportId,
                            senderId: user._id,
                            receiverId: selectedUser._id,
                            messageIndex: msgIndex,
                            originalFileName,
                            originalFileType,
                            fileUrl,
                            isEncrypted: true
                        })
                    );
                    payloadText = enc.ciphertext;
                    payloadNonce = enc.nonce;
                } catch (err) {
                    console.error('Error encrypting text', err);
                    return;
                }
            }
        }

        const clientMessageId = `local-${Date.now()}-${Math.random().toString(36).slice(2)}`;
        const msgData = {
            sessionId: exportId,
            senderId: user._id,
            receiverId: selectedUser._id,
            text: payloadText,
            fileUrl,
            fileType,
            originalFileName,
            originalFileType, // Fix 6: include true MIME type for receiver to reconstruct blob
            isEncrypted,
            nonce: payloadNonce,
            fileNonce: fileNonceBase64,
            messageIndex: msgIndex,
            expiresAt
        };

        socket?.emit('send_message', msgData);

        // LIVE DECRYPTION FIX: Render our own outbound message locally immediately,
        // using the pristine plaintext, rather than waiting for the server echo.
        const localRenderMsg = {
            ...msgData,
            clientMessageId,
            sender: { _id: user._id, username: user.username },
            receiver: selectedUser._id,
            text: inputText.trim(), // Original Plainttext
            ratchetKey: isEncrypted ? sessionManager.getSendKey() : null
        };

        setMessages((prev) => [...prev, localRenderMsg].filter((message) => !isMessageExpired(message)));
        if (inputText.trim()) {
            requestNsfwCheck(clientMessageId, inputText.trim());
            requestCalendarExtract(clientMessageId, inputText.trim());
        }
        if (file) {
            requestFileAiAnalysis(clientMessageId, file);
        }
        setInputText('');
        setFile(null);
        pushNotice(
            expiresAt
                ? 'Message sent with auto-delete enabled.'
                : file
                    ? 'File sent securely.'
                    : 'Message sent securely.',
            'success'
        );
        // Bug Fix: reset the file input element so user can re-select the same file
        if (fileInputRef.current) fileInputRef.current.value = '';
        } catch (err) {
            console.error("Critical sendMessage error", err);
            pushNotice(`Error sending message: ${err.message}`, 'error');
        } finally {
            setIsSending(false);
        }
    };

    const getFileUrl = (dbPath) => {
        return `${BACKEND_ORIGIN}${dbPath}`;
    };

    const triggerFileDownload = async (m) => {
        try {
            const fileRes = await fetch(getFileUrl(m.fileUrl));
            if (!fileRes.ok) {
                throw new Error(`Download failed with status ${fileRes.status}`);
            }
            let blob = await fileRes.blob();

            // Decrypt File binary if E2EE flag is set
            if (m.isEncrypted && (m.ratchetKey || activeSessionKey) && (m.fileNonce || m.nonce)) {
                const arrayBuffer = await blob.arrayBuffer();
                const decryptionKey = m.ratchetKey || activeSessionKey;
                const decryptedBuffer = await decryptFile(
                    arrayBuffer,
                    decryptionKey,
                    m.fileNonce || m.nonce,
                    buildDirectMessageAAD({
                        sessionId: m.sessionId,
                        senderId: m.senderId || m.sender?._id || m.sender,
                        receiverId: m.receiverId || m.receiver?._id || m.receiver,
                        messageIndex: m.messageIndex,
                        originalFileName: m.originalFileName,
                        originalFileType: m.originalFileType,
                        fileUrl: m.fileUrl,
                        isEncrypted: m.isEncrypted
                    })
                );
                // Fix 6: Use originalFileType so browser handles the file correctly after decryption
                blob = new Blob([decryptedBuffer], { type: m.originalFileType || m.fileType || 'application/octet-stream' });
            }

            const analysisId = m._id || m.clientMessageId;
            if (analysisId) {
                requestFileAiAnalysis(
                    analysisId,
                    new File([blob], m.originalFileName || 'attachment', { type: m.originalFileType || m.fileType || blob.type })
                );
            }

            const objectUrl = URL.createObjectURL(blob);

            // Trigger download mechanism
            const a = document.createElement('a');
            a.href = objectUrl;
            a.download = m.originalFileName || 'downloaded_file';
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(objectUrl);
        } catch (err) {
            console.error('Failed to download/decrypt file', err);
            alert('Failed to download or decrypt the file securely.');
        }
    };

    if (!user) return null;

    return (
        <div className="app-container">
            {/* Sidebar List */}
            <div className={`sidebar ${!isMobileListView ? 'hidden-mobile' : ''}`}>
                <div className="sidebar-header">
                    <div className="user-profile">
                        <div className="avatar">
                            {user?.username.charAt(0).toUpperCase()}
                        </div>
                        <span style={{ fontWeight: 'bold' }}>{user?.username}</span>
                    </div>
                    <button onClick={handleLogout} className="attachment-btn" title="Logout">
                        <LogOut size={20} />
                    </button>
                </div>
                <div className="user-list" style={{ overflowY: 'auto' }}>
                    <div style={{ padding: '10px' }}>
                        <h4 style={{ margin: '10px 0', color: 'var(--wa-text-secondary)', display: 'flex', justifyContent: 'space-between' }}>
                            Groups
                            <button onClick={() => setShowGroupModal(true)} style={{ background: 'none', border: 'none', color: 'var(--wa-primary-color)', cursor: 'pointer', fontSize: '18px' }}>+</button>
                        </h4>
                        {groups.map(g => (
                            <div key={g.groupId} className={`user-list-item ${selectedGroup?.groupId === g.groupId ? 'active' : ''}`} onClick={() => handleGroupSelect(g)}>
                                <div className="avatar" style={{ backgroundColor: '#128C7E' }}>{g.name.charAt(0).toUpperCase()}</div>
                                <div className="user-info">
                                    <div className="user-name">{g.name}</div>
                                </div>
                            </div>
                        ))}
                        <h4 style={{ margin: '15px 0 10px', color: 'var(--wa-text-secondary)' }}>Users</h4>
                        {users.map(u => (
                            <div key={u._id} className={`user-list-item ${selectedUser?._id === u._id && !selectedGroup ? 'active' : ''}`} onClick={() => handleUserSelect(u)}>
                                <div className="avatar">{u.username.charAt(0).toUpperCase()}</div>
                                <div className="user-info">
                                    <div className="user-name">{u.username}</div>
                                    <div className="user-status">{u.isOnline ? <span style={{ color: 'green' }}>Online</span> : 'Offline'}</div>
                                </div>
                            </div>
                        ))}
                    </div>
                </div>
            </div>

            {showGroupModal && (
                <div style={{ position: 'fixed', top: 0, left: 0, width: '100vw', height: '100vh', backgroundColor: 'rgba(0,0,0,0.5)', zIndex: 1000, display: 'flex', justifyContent: 'center', alignItems: 'center' }}>
                    <div style={{ backgroundColor: '#fff', padding: '20px', borderRadius: '8px', width: '400px', maxWidth: '90%' }}>
                        <h2>Create Group</h2>
                        <input type="text" placeholder="Group Name" value={newGroupName} onChange={(e) => setNewGroupName(e.target.value)} style={{ width: '100%', padding: '10px', margin: '10px 0', borderRadius: '4px', border: '1px solid #ccc' }} />
                        <h4 style={{ margin: '10px 0' }}>Select Members</h4>
                        <div style={{ maxHeight: '150px', overflowY: 'auto', border: '1px solid #eee', padding: '5px' }}>
                            {users.map(u => (
                                <div key={u._id} style={{ display: 'flex', alignItems: 'center', marginBottom: '5px' }}>
                                    <input type="checkbox" id={`chk-${u._id}`} checked={selectedMembers.includes(u._id)} onChange={(e) => {
                                        if (e.target.checked) setSelectedMembers(prev => [...prev, u._id]);
                                        else setSelectedMembers(prev => prev.filter(id => id !== u._id));
                                    }} style={{ marginRight: '10px' }} />
                                    <label htmlFor={`chk-${u._id}`}>{u.username}</label>
                                </div>
                            ))}
                        </div>
                        <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: '20px', gap: '10px' }}>
                            <button onClick={() => setShowGroupModal(false)} style={{ padding: '8px 15px', border: 'none', backgroundColor: '#ccc', borderRadius: '4px' }}>Cancel</button>
                            <button onClick={handleCreateGroup} style={{ padding: '8px 15px', border: 'none', backgroundColor: 'var(--wa-primary-color)', color: '#fff', borderRadius: '4px' }}>Create</button>
                        </div>
                    </div>
                </div>
            )}
            {/* Chat Area */}
            <div className={`chat-window ${isMobileListView ? 'hidden-mobile' : ''}`}>
                {selectedUser ? (
                    <>
                        {/* Chat Header */}
                        <div className="chat-header">
                            <button className="back-btn" onClick={() => setIsMobileListView(true)}>
                                <ArrowLeft size={24} />
                            </button>
                            <div className="avatar">
                                {selectedUser.username.charAt(0).toUpperCase()}
                            </div>
                            <div style={{ marginLeft: '15px' }}>
                                <div style={{ fontWeight: 'bold', fontSize: '16px' }}>{selectedUser.username}</div>
                                <div style={{ fontSize: '13px', color: 'var(--wa-text-secondary)' }}>
                                    {selectedUser.isOnline ? 'Online' : 'Offline'}
                                    {activeSessionKey ? ' • Secure channel ready' : ' • Waiting for secure channel'}
                                </div>
                            </div>
                        </div>

                        {/* AI Toolbar — translation language, summary button */}
                        <AIToolbar messages={messages} />

                        {uiNotice && (
                            <div className={`chat-notice ${uiNotice.tone}`}>
                                {uiNotice.message}
                            </div>
                        )}

                        {/* Chat Messages */}
                        <div className="chat-messages">
                            {messages.map((m, idx) => {
                                const isMe = (m.sender === user._id) || (m.sender?._id === user._id);
                                const messageAiId = m._id || m.clientMessageId || idx;
                                return (
                                    <div key={m._id || m.clientMessageId || idx} className={`message-bubble ${isMe ? 'message-sent' : 'message-received'}`}>
                                        {/* Text content — with AI enhancements */}
                                        {m.text && (
                                            <TranslationToggle
                                                messageId={messageAiId}
                                                originalText={m.text}
                                            />
                                        )}
                                        {/* AI: Calendar event extraction */}
                                        <CalendarPopup messageId={messageAiId} />

                                        {/* File content — with NSFW block check */}
                                        {m.fileUrl && (
                                            <>
                                                <NSFWFileBlock messageId={messageAiId} />
                                                <div className="file-preview">
                                                    <button onClick={() => triggerFileDownload(m)} className="file-download-btn" style={{ background: 'none', border: 'none', color: 'inherit', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '5px' }}>
                                                        <Download size={16} />
                                                        <span style={{ fontSize: '13px', wordBreak: 'break-all', textDecoration: 'underline' }}>
                                                            {m.originalFileName || 'Download File'}
                                                        </span>
                                                    </button>
                                                </div>
                                                {/* AI: Audio transcription view */}
                                                <TranscriptionView messageId={messageAiId} />
                                            </>
                                        )}

                                        <div className="message-time" style={{ display: 'flex', justifyContent: 'flex-end', gap: '5px' }}>
                                            {m.isEncrypted && <span title="End-to-End Encrypted">🔒</span>}
                                            {m.createdAt ? new Date(m.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                                        </div>
                                    </div>
                                );
                            })}
                            <div ref={messagesEndRef} />
                        </div>

                        {/* Input Area */}
                        <form className="chat-input-area" onSubmit={handleSendMessage}>
                            {file && (
                                <div className="composer-file-chip">
                                    <div>
                                        <div className="composer-file-name">{file.name}</div>
                                        <div className="composer-file-meta">{formatFileSize(file.size)} • Encrypted before upload</div>
                                    </div>
                                    <button
                                        type="button"
                                        className="composer-file-clear"
                                        onClick={() => {
                                            setFile(null);
                                            if (fileInputRef.current) fileInputRef.current.value = '';
                                            pushNotice('Attachment removed.', 'info');
                                        }}
                                    >
                                        <X size={16} />
                                    </button>
                                </div>
                            )}
                            <input
                                type="file"
                                id="file-upload"
                                ref={fileInputRef}
                                style={{ display: 'none' }}
                                onChange={handleFileChange}
                            />
                            <label htmlFor="file-upload" className="attachment-btn">
                                <Paperclip size={24} color={file ? "var(--wa-primary-color)" : "currentColor"} />
                            </label>

                            <input
                                type="text"
                                className="message-input"
                                placeholder={file ? "Add a note or send the file now" : "Write a secure message"}
                                value={inputText}
                                onChange={(e) => setInputText(e.target.value)}
                            />
                            <button type="submit" className="send-btn" disabled={isSending || (!inputText.trim() && !file)}>
                                {isSending ? (
                                    <LoaderCircle size={24} color="var(--wa-primary-dark)" className="spin-icon" />
                                ) : (
                                    <Send size={24} color={(inputText.trim() || file) ? "var(--wa-primary-dark)" : "currentColor"} />
                                )}
                            </button>
                        </form>
                    </>
                ) : selectedGroup ? (
                    <>
                        {/* Group Chat Header */}
                        <div className="chat-header">
                            <button className="back-btn" onClick={() => { socket?.emit('leave_group_room', { groupId: selectedGroup.groupId }); setIsMobileListView(true); setSelectedGroup(null); }}>
                                <ArrowLeft size={24} />
                            </button>
                            <div className="avatar" style={{ backgroundColor: '#128C7E' }}>
                                {selectedGroup.name.charAt(0).toUpperCase()}
                            </div>
                            <div style={{ marginLeft: '15px' }}>
                                <div style={{ fontWeight: 'bold', fontSize: '16px' }}>{selectedGroup.name}</div>
                                <div style={{ display: 'flex', gap: '8px', alignItems: 'center', marginTop: '4px', flexWrap: 'wrap' }}>
                                    <span style={{
                                        fontSize: '11px',
                                        padding: '2px 8px',
                                        borderRadius: '999px',
                                        backgroundColor: selectedGroup.currentHealMode === TREE_HEAL_PQ_BATCH_MESSAGE ? '#1d4ed8' : selectedGroup.currentHealMode === TREE_HEAL_CLASSICAL_MESSAGE ? '#166534' : '#475569',
                                        color: '#fff'
                                    }}>
                                        Mode: {getHealModeLabel(selectedGroup.currentHealMode || TREE_INIT_MESSAGE)}
                                    </span>
                                    <span style={{ fontSize: '11px', color: 'var(--wa-text-secondary)' }}>
                                        Epoch {selectedGroup.groupEpoch || groupSessionManager.groups.get(selectedGroup.groupId)?.groupEpoch || 1}
                                    </span>
                                    {groupHealStatus && (
                                        <span style={{ fontSize: '11px', color: groupHealBusy ? '#b45309' : '#128C7E' }}>
                                            {groupHealStatus}
                                        </span>
                                    )}
                                </div>
                                <div style={{ fontSize: '13px', color: 'var(--wa-text-secondary)' }}>
                                    {selectedGroup.members?.length || 0} members • Group encryption active
                                </div>
                                {groupMetricsView && (
                                    <div style={{
                                        marginTop: '6px',
                                        display: 'grid',
                                        gridTemplateColumns: 'repeat(3, minmax(0, 1fr))',
                                        gap: '6px',
                                        fontSize: '11px',
                                        color: '#334155',
                                        backgroundColor: '#f8fafc',
                                        border: '1px solid #e2e8f0',
                                        borderRadius: '8px',
                                        padding: '6px 8px'
                                    }}>
                                        <div>Heals: {groupMetricsView.totalHeals || 0}</div>
                                        <div>Batches: {groupMetricsView.lastBatchCount || 0}</div>
                                        <div>Payload: {groupMetricsView.lastPayloadBytes || 0} B</div>
                                        <div>Init: {groupMetricsView.initEvents || 0}</div>
                                        <div>Classical: {groupMetricsView.classicalHeals || 0}</div>
                                        <div>PQ: {groupMetricsView.pqBatchHeals || 0}</div>
                                        <div>Wrap: {groupMetricsView.lastWrapMode || 'n/a'}</div>
                                        <div>Enc Avg: {exportMetrics().encryptMessageAvg.toFixed(1)} ms</div>
                                        <div>Dec Avg: {exportMetrics().decryptMessageAvg.toFixed(1)} ms</div>
                                    </div>
                                )}
                            </div>
                            <div style={{ marginLeft: 'auto', display: 'flex', gap: '8px' }}>
                                {isGroupAdmin(selectedGroup, user._id) && (
                                    <button
                                        onClick={() => handleTriggerGroupHeal(TREE_HEAL_CLASSICAL_MESSAGE)}
                                        className="attachment-btn"
                                        title="Trigger classical TreeKEM heal"
                                        disabled={groupHealBusy}
                                        style={{
                                            opacity: groupHealBusy ? 0.6 : 1,
                                            border: selectedGroup.currentHealMode === TREE_HEAL_CLASSICAL_MESSAGE ? '1px solid #166534' : undefined,
                                            backgroundColor: selectedGroup.currentHealMode === TREE_HEAL_CLASSICAL_MESSAGE ? '#dcfce7' : undefined
                                        }}
                                    >
                                        C
                                    </button>
                                )}
                                {isGroupAdmin(selectedGroup, user._id) && (
                                    <button
                                        onClick={() => handleTriggerGroupHeal(TREE_HEAL_PQ_BATCH_MESSAGE)}
                                        className="attachment-btn"
                                        title="Trigger PQ batch TreeKEM heal"
                                        disabled={groupHealBusy}
                                        style={{
                                            opacity: groupHealBusy ? 0.6 : 1,
                                            border: selectedGroup.currentHealMode === TREE_HEAL_PQ_BATCH_MESSAGE ? '1px solid #1d4ed8' : undefined,
                                            backgroundColor: selectedGroup.currentHealMode === TREE_HEAL_PQ_BATCH_MESSAGE ? '#dbeafe' : undefined
                                        }}
                                    >
                                        PQ
                                    </button>
                                )}
                                {!isGroupAdmin(selectedGroup, user._id) && (
                                    <button onClick={handleLeaveSelectedGroup} className="attachment-btn" title="Leave group">
                                        <LogOut size={18} />
                                    </button>
                                )}
                                {isGroupAdmin(selectedGroup, user._id) && (
                                    <button onClick={handleDeleteSelectedGroup} className="attachment-btn" title="Delete group">
                                        <Trash2 size={18} />
                                    </button>
                                )}
                            </div>
                        </div>

                        {uiNotice && (
                            <div className={`chat-notice ${uiNotice.tone}`}>
                                {uiNotice.message}
                            </div>
                        )}

                        {/* Group Chat Messages */}
                        <div className="chat-messages">
                            {messages.map((m, idx) => {
                                const senderId = m.senderId || m.sender?._id || m.sender;
                                const isMe = senderId === user._id;
                                const senderName = m.sender?.username || (isMe ? user.username : 'Unknown');
                                return (
                                    <div key={m._id || idx} className={`message-bubble ${isMe ? 'message-sent' : 'message-received'}`}>
                                        {!isMe && <div style={{ fontSize: '12px', fontWeight: 'bold', color: '#128C7E', marginBottom: '2px' }}>{senderName}</div>}
                                        {m.text && (
                                            <TranslationToggle
                                                messageId={m._id || idx}
                                                originalText={m.text}
                                            />
                                        )}
                                        <CalendarPopup messageId={m._id || idx} />
                                        <div className="message-time" style={{ display: 'flex', justifyContent: 'flex-end', gap: '5px' }}>
                                            {m.isEncrypted && <span title="End-to-End Encrypted">🔒</span>}
                                            {m.createdAt ? new Date(m.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                                        </div>
                                    </div>
                                );
                            })}
                            <div ref={messagesEndRef} />
                        </div>
                        <form className="chat-input-area" onSubmit={handleSendMessage}>
                            <input
                                type="text"
                                className="message-input"
                                placeholder="Write to the group"
                                value={inputText}
                                onChange={(e) => setInputText(e.target.value)}
                            />
                            <button type="submit" className="send-btn" disabled={isSending || !inputText.trim()}>
                                {isSending ? (
                                    <LoaderCircle size={24} color="var(--wa-primary-dark)" className="spin-icon" />
                                ) : (
                                    <Send size={24} color={inputText.trim() ? "var(--wa-primary-dark)" : "currentColor"} />
                                )}
                            </button>
                        </form>
                    </>
                ) : (
                    <div className="empty-chat">
                        <MessageCircle size={100} color="#dfe5e7" style={{ marginBottom: '20px' }} />
                        <h2 style={{ color: 'var(--wa-text-secondary)', fontWeight: '300' }}>Select a chat to start messaging</h2>
                        <p style={{ color: '#8696a0', marginTop: '10px', fontSize: '14px' }}>
                            Messages and files are end-to-end encrypted.
                        </p>
                    </div>
                )}
            </div>

            {/* AI Modals (rendered at root level, always available) */}
            <PrivacyModal />
            <SummaryModal />
        </div>
    );
};

export default Chat;
