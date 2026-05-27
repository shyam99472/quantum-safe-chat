import { KeyRatchet } from "./keyRatchet";
import { buildAssociatedData, encryptMessage, decryptMessage } from "./crypto";
import { TreeKemState } from "./treeKemState";
import { NO_HEAL, recommendHealing } from "./adaptiveScheduler";

const webCrypto = typeof window !== 'undefined' ? window.crypto : globalThis.crypto;
const GROUP_EPOCH_STORAGE_KEY = "chatGroupEpochKeys";

// Constants
export const MAX_GROUP_RATCHET_ADVANCE = 50;
export const MAX_GROUP_SIZE = 100;
export const MIN_REKEY_INTERVAL = 2000;
export const TREE_INIT_MESSAGE = "TREE_INIT";
export const TREE_HEAL_CLASSICAL_MESSAGE = "TREE_HEAL_CLASSICAL";
export const TREE_HEAL_PQ_BATCH_MESSAGE = "TREE_HEAL_PQ_BATCH";
export const TREE_CONTROL_MESSAGES = [
    TREE_INIT_MESSAGE,
    TREE_HEAL_CLASSICAL_MESSAGE,
    TREE_HEAL_PQ_BATCH_MESSAGE,
    "[GROUP_KEY_UPDATE]"
];

class GroupSessionManager {
    constructor() {
        this.groups = new Map(); // groupId -> State Details
    }

    persistEpochState(groupId, epochState) {
        if (typeof window === 'undefined') return;
        const stored = JSON.parse(localStorage.getItem(GROUP_EPOCH_STORAGE_KEY) || "{}");
        if (!stored[groupId]) stored[groupId] = {};
        stored[groupId][epochState.groupEpoch] = {
            adminId: epochState.adminId,
            members: epochState.members,
            groupEpoch: epochState.groupEpoch,
            groupMembershipVersion: epochState.groupMembershipVersion,
            rootKeyRaw: Array.from(new Uint8Array(epochState.rootKeyRaw)),
            treeSnapshot: epochState.treeSnapshot || null
        };
        localStorage.setItem(GROUP_EPOCH_STORAGE_KEY, JSON.stringify(stored));
    }

    async loadPersistedEpochStates(groupId) {
        if (typeof window === 'undefined') return new Map();
        const stored = JSON.parse(localStorage.getItem(GROUP_EPOCH_STORAGE_KEY) || "{}");
        const groupEntries = stored[groupId] || {};
        const result = new Map();

        for (const [epochKey, value] of Object.entries(groupEntries)) {
            const rootKeyRaw = new Uint8Array(value.rootKeyRaw).buffer;
            const rootHkdfKey = await webCrypto.subtle.importKey(
                "raw",
                rootKeyRaw,
                { name: "HKDF" },
                false,
                ["deriveKey"]
            );
            result.set(Number(epochKey), {
                ...value,
                groupEpoch: Number(epochKey),
                rootKeyRaw,
                rootHkdfKey,
                treeKemState: value.treeSnapshot ? TreeKemState.fromSnapshot(value.treeSnapshot) : null
            });
        }

        return result;
    }

    async initGroup(groupId, adminId, members, groupRootKeyRaw) {
        if (members.length > MAX_GROUP_SIZE) {
            throw new Error(`Exceeded MAX_GROUP_SIZE of ${MAX_GROUP_SIZE}`);
        }

        const groupState = {
            groupId,
            adminId,
            groupState: "ACTIVE", // "ACTIVE" | "REKEYING"
            groupEpoch: 1,
            groupMembershipVersion: 1,
            currentHealMode: TREE_INIT_MESSAGE,
            lastHealAt: Date.now(),
            lastPqHealAt: Date.now(),
            messagesSinceLastHeal: 0,
            messagesSinceLastPqHeal: 0,
            membershipChangesSinceLastHeal: 0,
            suspectedCompromise: false,
            lastSchedulerReason: "Group initialized.",
            lastRekeyTime: Date.now(),
            members: [...members], // Array of userIds
            treeKemState: TreeKemState.createInitial(groupId, members, 1),
            groupRootKey: groupRootKeyRaw, // Raw ArrayBuffer or CryptoKey

            sendRatchet: new KeyRatchet(),
            sendIndex: 0,

            receiveRatchets: new Map(), // senderId -> KeyRatchet
            receiveIndexes: new Map(), // senderId -> expectedIndex

            acknowledgedMembers: new Set()
        };

        // Convert raw key to a CryptoKey for HKDF extraction
        const rootHkdfKey = await webCrypto.subtle.importKey(
            "raw",
            groupRootKeyRaw,
            { name: "HKDF" },
            false,
            ["deriveKey"]
        );
        groupState.rootHkdfKey = rootHkdfKey;

        this.groups.set(groupId, groupState);
        this.persistEpochState(groupId, {
            adminId,
            members: [...members],
            groupEpoch: groupState.groupEpoch,
            groupMembershipVersion: groupState.groupMembershipVersion,
            rootKeyRaw: groupRootKeyRaw,
            treeSnapshot: groupState.treeKemState.serialize()
        });
        return groupState;
    }

    async deriveSenderBaseKey(rootHkdfKey, senderId) {
        // Compute senderBaseKey = HKDF(inputKey = groupRootKey, info = "group-sender-ratchet-" + senderId)
        const info = new TextEncoder().encode("group-sender-ratchet-" + senderId);

        // Derive AES-GCM base key
        const senderBaseKey = await webCrypto.subtle.deriveKey(
            {
                name: "HKDF",
                hash: "SHA-256",
                salt: new Uint8Array(),
                info: info
            },
            rootHkdfKey,
            { name: "AES-GCM", length: 256 },
            true,
            ["encrypt", "decrypt"]
        );
        return senderBaseKey;
    }

    async setupLocalSender(groupId, localUserId) {
        const group = this.groups.get(groupId);
        if (!group) throw new Error("Group not initialized");

        const senderBaseKey = await this.deriveSenderBaseKey(group.rootHkdfKey, localUserId);
        await group.sendRatchet.initializeRatchet(senderBaseKey);
        group.sendIndex = 0;
    }

    async getOrInitReceiveRatchet(groupId, senderId) {
        const group = this.groups.get(groupId);
        if (!group) throw new Error("Group not initialized");

        if (!group.receiveRatchets.has(senderId)) {
            const senderBaseKey = await this.deriveSenderBaseKey(group.rootHkdfKey, senderId);
            const ratchet = new KeyRatchet();
            await ratchet.initializeRatchet(senderBaseKey);
            group.receiveRatchets.set(senderId, ratchet);
            group.receiveIndexes.set(senderId, 0);
        }

        return group.receiveRatchets.get(senderId);
    }

    // Call when a group rekeys
    async rekeyGroup(groupId, newRootKeyRaw, newMembers) {
        const group = this.groups.get(groupId);
        if (!group) return;

        const now = Date.now();
        if (now - group.lastRekeyTime < MIN_REKEY_INTERVAL) {
            throw new Error("Rekey interval too short to prevent spam");
        }
        if (newMembers.length > MAX_GROUP_SIZE) {
            throw new Error(`Exceeded MAX_GROUP_SIZE of ${MAX_GROUP_SIZE}`);
        }

        group.lastRekeyTime = now;
        group.groupEpoch++;
        group.groupMembershipVersion++;
        group.membershipChangesSinceLastHeal++;
        group.members = [...newMembers];
        group.treeKemState = group.treeKemState
            ? group.treeKemState.advanceEpoch(newMembers)
            : TreeKemState.createInitial(groupId, newMembers, group.groupEpoch);
        group.groupRootKey = newRootKeyRaw;
        group.groupState = "REKEYING";
        group.acknowledgedMembers.clear();

        // Calculate treeHash simply based on members and epoch for now (since we use a flat struct representing tree paths)
        const treeStr = JSON.stringify({ members: group.members, epoch: group.groupEpoch });
        const treeHashBuffer = await webCrypto.subtle.digest("SHA-256", new TextEncoder().encode(treeStr));
        const treeHash = Array.from(new Uint8Array(treeHashBuffer)).map(b => b.toString(16).padStart(2, '0')).join('');
        console.log(`Tree recomputed. Hash: ${treeHash}, Epoch: ${group.groupEpoch}`);

        const rootHkdfKey = await webCrypto.subtle.importKey(
            "raw",
            newRootKeyRaw,
            { name: "HKDF" },
            false,
            ["deriveKey"]
        );
        group.rootHkdfKey = rootHkdfKey;
        this.persistEpochState(groupId, {
            adminId: group.adminId,
            members: [...group.members],
            groupEpoch: group.groupEpoch,
            groupMembershipVersion: group.groupMembershipVersion,
            rootKeyRaw: newRootKeyRaw,
            treeSnapshot: group.treeKemState.serialize()
        });

        // Reset all ratchets
        group.sendRatchet = new KeyRatchet();
        group.sendIndex = 0;
        group.receiveRatchets.clear();
        group.receiveIndexes.clear();
    }

    async beginHealingEpoch(groupId, options = {}) {
        const group = this.groups.get(groupId);
        if (!group) {
            throw new Error("Group not initialized");
        }

        const {
            mode = TREE_HEAL_CLASSICAL_MESSAGE,
            actorId = group.adminId,
            members = group.members
        } = options;

        if (![TREE_HEAL_CLASSICAL_MESSAGE, TREE_HEAL_PQ_BATCH_MESSAGE].includes(mode)) {
            throw new Error("Unsupported heal mode");
        }

        const newRootKeyRaw = webCrypto.getRandomValues(new Uint8Array(32)).buffer;
        await this.rekeyGroup(groupId, newRootKeyRaw, members);
        group.currentHealMode = mode;
        group.lastHealAt = Date.now();
        group.messagesSinceLastHeal = 0;
        group.membershipChangesSinceLastHeal = 0;
        group.suspectedCompromise = false;
        group.lastSchedulerReason = `Applied ${mode}.`;
        if (mode === TREE_HEAL_PQ_BATCH_MESSAGE) {
            group.lastPqHealAt = Date.now();
            group.messagesSinceLastPqHeal = 0;
        }
        await this.setupLocalSender(groupId, actorId);

        for (const memberId of members) {
            if (memberId !== actorId) {
                await this.getOrInitReceiveRatchet(groupId, memberId);
            }
        }

        return {
            mode,
            rootKeyRaw: newRootKeyRaw,
            groupEpoch: group.groupEpoch,
            groupMembershipVersion: group.groupMembershipVersion,
            members: [...group.members],
            treeSnapshot: group.treeKemState?.serialize() || null
        };
    }

    async ackRekey(groupId, userId) {
        const group = this.groups.get(groupId);
        if (!group) return false;
        if (!group.members.some(m => m.toString() === userId.toString())) return false;

        group.acknowledgedMembers.add(userId);

        // Exclude admin themselves (who doesn't send an ACK to themselves)
        const expectedCount = group.members.length - 1;
        if (group.acknowledgedMembers.size >= expectedCount) {
            group.groupState = "ACTIVE";
            return true; // Synchronized completely
        }
        return false;
    }

    async forceActiveState(groupId) {
        const group = this.groups.get(groupId);
        if (group && group.groupState === "REKEYING") {
            group.groupState = "ACTIVE";
        }
    }

    recordGroupMessageActivity(groupId) {
        const group = this.groups.get(groupId);
        if (!group) {
            return { action: NO_HEAL, reason: "Group not initialized." };
        }

        group.messagesSinceLastHeal += 1;
        group.messagesSinceLastPqHeal += 1;
        group.lastMessageAt = Date.now();

        const recommendation = this.evaluateGroupProtection(groupId);

        return recommendation;
    }

    evaluateGroupProtection(groupId) {
        const group = this.groups.get(groupId);
        if (!group) {
            return { action: NO_HEAL, reason: "Group not initialized." };
        }

        const recommendation = recommendHealing({
            groupSize: group.members.length,
            messagesSinceLastHeal: group.messagesSinceLastHeal,
            messagesSinceLastPqHeal: group.messagesSinceLastPqHeal,
            msSinceLastHeal: Date.now() - group.lastHealAt,
            msSinceLastPqHeal: Date.now() - group.lastPqHealAt,
            membershipChanges: group.membershipChangesSinceLastHeal,
            suspectedCompromise: group.suspectedCompromise,
            lastHealMode: group.currentHealMode
        });

        group.lastSchedulerReason = recommendation.reason;
        return recommendation;
    }

    noteMembershipChange(groupId, nextMembers = null) {
        const group = this.groups.get(groupId);
        if (!group) {
            return { action: NO_HEAL, reason: "Group not initialized." };
        }

        group.membershipChangesSinceLastHeal += 1;
        if (Array.isArray(nextMembers)) {
            group.members = [...nextMembers];
        }

        return this.evaluateGroupProtection(groupId);
    }

    markSuspectedCompromise(groupId, reason = "Suspicious decryption behavior detected.") {
        const group = this.groups.get(groupId);
        if (!group) {
            return { action: NO_HEAL, reason: "Group not initialized." };
        }

        group.suspectedCompromise = true;
        group.lastSchedulerReason = reason;
        const recommendation = this.evaluateGroupProtection(groupId);
        if (recommendation.action !== NO_HEAL) {
            recommendation.reason = reason;
        }
        return recommendation;
    }

    async encryptGroupMessage(groupId, localUserId, plaintext) {
        const group = this.groups.get(groupId);
        if (!group) throw new Error("Group not found");
        if (group.groupState === "REKEYING") {
            throw new Error("Cannot send messages while group is REKEYING");
        }

        const currentKey = group.sendRatchet.getCurrentKey();
        if (!currentKey) {
            throw new Error("Local sender ratchet not initialized");
        }

        const messageIndex = group.sendIndex++;

        // Advance ratchet for next time
        await group.sendRatchet.advanceRatchet();

        const associatedData = buildAssociatedData({
            type: "group-message",
            groupId,
            groupEpoch: group.groupEpoch,
            groupMembershipVersion: group.groupMembershipVersion,
            senderId: localUserId,
            messageIndex
        });
        const { ciphertext, nonce } = await encryptMessage(plaintext, currentKey, associatedData);

        return {
            ciphertext,
            nonce,
            envelope: {
                groupId,
                groupEpoch: group.groupEpoch,
                groupMembershipVersion: group.groupMembershipVersion,
                senderId: localUserId,
                messageIndex,
                treeSnapshot: group.treeKemState?.serialize() || null
            }
        };
    }

    async decryptGroupMessage(groupId, senderId, ciphertext, nonce, incomingEnvelope) {
        const group = this.groups.get(groupId);
        if (!group) throw new Error("Group not found");

        // Exact epoch equality check
        if (incomingEnvelope.groupEpoch !== group.groupEpoch) {
            throw new Error(`Epoch mismatch. Local: ${group.groupEpoch}, Incoming: ${incomingEnvelope.groupEpoch}. Dropping message.`);
        }

        // Validate membership for version
        if (!group.members.some(m => m.toString() === senderId.toString())) {
            throw new Error("Sender not in group members list");
        }

        const ratchet = await this.getOrInitReceiveRatchet(groupId, senderId);
        const expectedIndex = group.receiveIndexes.get(senderId);

        if (incomingEnvelope.messageIndex < expectedIndex) {
            throw new Error(`Message replay detected or out of order. Expected >= ${expectedIndex}, got ${incomingEnvelope.messageIndex}`);
        }

        // Fast forward ratchet if needed
        let catchups = incomingEnvelope.messageIndex - expectedIndex;
        if (catchups > MAX_GROUP_RATCHET_ADVANCE) {
            throw new Error(`Message index too far ahead (difference ${catchups} > MAX_GROUP_RATCHET_ADVANCE)`);
        }

        for (let i = 0; i < catchups; i++) {
            await ratchet.advanceRatchet();
        }

        const decryptionKey = ratchet.getCurrentKey();

        // Advance for next time
        await ratchet.advanceRatchet();
        group.receiveIndexes.set(senderId, incomingEnvelope.messageIndex + 1);

        const associatedData = buildAssociatedData({
            type: "group-message",
            groupId: incomingEnvelope.groupId,
            groupEpoch: incomingEnvelope.groupEpoch,
            groupMembershipVersion: incomingEnvelope.groupMembershipVersion,
            senderId: incomingEnvelope.senderId,
            messageIndex: incomingEnvelope.messageIndex
        });
        const plaintext = await decryptMessage(ciphertext, decryptionKey, nonce, associatedData);
        return plaintext;
    }
}

export const groupSessionManager = new GroupSessionManager();
