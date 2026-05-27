const User = require('../models/User');
const Message = require('../models/Message');
const Group = require('../models/Group');
const TREE_CONTROL_MESSAGES = new Set([
    'TREE_INIT',
    'TREE_HEAL_CLASSICAL',
    'TREE_HEAL_PQ_BATCH',
    '[GROUP_KEY_UPDATE]'
]);

// Helper to generate a consistent room ID for 1-1 chat
const getRoomId = (userId1, userId2) => {
    return [userId1, userId2].sort().join('_');
};

const normalizeMemberIds = (memberIds, adminId) => {
    const uniqueIds = new Set([adminId, ...(Array.isArray(memberIds) ? memberIds : [])].filter(Boolean));
    return [...uniqueIds];
};

module.exports = function (io) {
    io.on('connection', (socket) => {
        console.log(`User connected: ${socket.id}`);

        socket.on('user_connected', async () => {
            // Use the JWT-verified userId from the socket middleware, not the client-supplied one
            const userId = socket.userId;
            if (userId) {
                await User.findByIdAndUpdate(userId, { isOnline: true, socketId: socket.id });
                // Broadcast to everyone that this user is online
                io.emit('user_status_change', { userId, isOnline: true });
            }
        });

        // Join a 1-to-1 chat room
        socket.on('join_room', ({ senderId, receiverId }) => {
            if (!socket.userId || socket.userId !== senderId || !receiverId) {
                return;
            }
            const roomId = getRoomId(senderId, receiverId);
            socket.join(roomId);
            console.log(`Socket ${socket.id} joined room ${roomId}`);
        });

        // Leave a room
        socket.on('leave_room', ({ senderId, receiverId }) => {
            if (!socket.userId || socket.userId !== senderId || !receiverId) {
                return;
            }
            const roomId = getRoomId(senderId, receiverId);
            socket.leave(roomId);
            console.log(`Socket ${socket.id} left room ${roomId}`);
        });

        // Handle sending messages
        socket.on('send_message', async (data) => {
            try {
                const { receiverId, text, fileUrl, fileType, originalFileName, originalFileType, isEncrypted, nonce, fileNonce, authTag, payload, messageIndex, sessionId, expiresAt } = data;
                const senderId = socket.userId;

                if (!senderId || !receiverId) {
                    return;
                }

                // Sender Identity Validation (Anti-Spoofing)
                const authenticatedContext = await User.findOne({ socketId: socket.id });
                if (!authenticatedContext || authenticatedContext._id.toString() !== senderId) {
                    console.warn(`Sender identity validation failed! Socket ${socket.id} attempted to spoof sender ${senderId}. Rejecting message.`);
                    return; // Drop message completely
                }

                // Fix 5: Skip persisting KEY_EXCHANGE handshake messages to MongoDB
                // They are ephemeral signals and should not be stored.
                // But we MUST include the sender's dilithiumPublicKey so the receiver can verify the signature.
                if (text === '[KEY_EXCHANGE]') {
                    const roomId = getRoomId(senderId, receiverId);
                    const senderUser = await User.findById(senderId).select('_id username identityPublicKey pqcPublicKey dilithiumPublicKey');
                    io.to(roomId).emit('receive_message', {
                        sender: senderUser || { _id: senderId },
                        receiver: receiverId,
                        text,
                        nonce,
                        fileNonce,
                        payload,
                        sessionId, // Proxy safely
                        isEncrypted: false
                    });
                    return;
                }

                // Save message to DB
                // Notice: sessionId is strictly absent here intentionally
                const newMessage = new Message({
                    sender: senderId,
                    receiver: receiverId,
                    text,
                    fileUrl,
                    fileType,
                    originalFileName,
                    originalFileType,
                    isEncrypted: isEncrypted || false,
                    nonce,
                    fileNonce,
                    authTag,
                    payload,
                    sessionId,
                    messageIndex,
                    expiresAt: expiresAt ? new Date(expiresAt) : null
                });

                await newMessage.save();

                const roomId = getRoomId(senderId, receiverId);

                // Construct payload to send back
                const populatedPayloadRaw = await newMessage.populate('sender', 'username identityPublicKey pqcPublicKey dilithiumPublicKey');

                // Manually inject Ephemeral Session ID into the live transit object
                const populatedPayload = populatedPayloadRaw.toObject();
                populatedPayload.sessionId = sessionId;
                populatedPayload.senderId = senderId;
                populatedPayload.receiverId = receiverId;

                // Emit to the specific room
                io.to(roomId).emit('receive_message', populatedPayload);

                // If receiver is not in the room yet (e.g., they are in another screen), 
                // we might want to also notify them specifically.
                // We find their socketId.
                const receiverUser = await User.findById(receiverId);
                if (receiverUser && receiverUser.socketId) {
                    // Send a notification event directly to the receiver's socket
                    io.to(receiverUser.socketId).emit('new_message_notification', populatedPayload);
                }

            } catch (err) {
                console.error('Error sending message via Socket.io:', err);
            }
        });

        // Group Handlers
        socket.on('create_group', async (data, callback) => {
            try {
                const { groupId, name, members } = data;
                const adminId = socket.userId;
                const normalizedMembers = normalizeMemberIds(members, adminId);

                if (!groupId || !name || !adminId || normalizedMembers.length < 2) {
                    callback?.({ ok: false, error: 'Invalid group payload' });
                    return;
                }

                const validUsers = await User.find({ _id: { $in: normalizedMembers } }).select('_id socketId');
                if (validUsers.length !== normalizedMembers.length) {
                    callback?.({ ok: false, error: 'Invalid group members' });
                    return;
                }

                const newGroup = new Group({
                    groupId,
                    name,
                    adminId,
                    members: normalizedMembers,
                    groupMembershipVersion: 1,
                    currentEpoch: 1
                });
                await newGroup.save();

                socket.join(groupId);
                console.log(`Socket ${socket.id} created and joined group ${groupId}`);

                for (const memberId of normalizedMembers) {
                    if (memberId !== adminId) {
                        const memberUser = validUsers.find((user) => user._id.toString() === memberId.toString());
                        if (memberUser && memberUser.socketId) {
                            io.to(memberUser.socketId).emit('group_created', newGroup);
                        }
                    }
                }
                callback?.({ ok: true, group: newGroup });
            } catch (err) {
                console.error('Error creating group:', err);
                callback?.({ ok: false, error: 'Failed to create group' });
            }
        });

        socket.on('join_group', async ({ groupId }) => {
            const userId = socket.userId;
            const group = await Group.findOne({ groupId });
            if (group && group.members.some(m => m.toString() === userId.toString())) {
                socket.join(groupId);
                console.log(`Socket ${socket.id} joined group ${groupId}`);
            } else {
                console.warn(`User ${userId} attempted to join unassociated group ${groupId}.`);
            }
        });

        socket.on('leave_group_room', async ({ groupId }) => {
            try {
                const userId = socket.userId;
                const group = await Group.findOne({ groupId });
                if (!group || !group.members.some(m => m.toString() === userId.toString())) {
                    console.warn(`User ${userId} is not a member of group ${groupId}. Cannot leave.`);
                    return;
                }
                socket.leave(groupId);
                console.log(`Socket ${socket.id} left group room ${groupId}.`);
            } catch (err) {
                console.error('Error leaving group:', err);
            }
        });

        socket.on('leave_group', async ({ groupId }, callback) => {
            try {
                const userId = socket.userId;
                const group = await Group.findOne({ groupId });
                if (!group || !group.members.some(m => m.toString() === userId.toString())) {
                    callback?.({ ok: false, error: 'Not a group member' });
                    return;
                }

                if (group.adminId.toString() === userId.toString()) {
                    callback?.({ ok: false, error: 'Admin must delete the group instead of leaving it' });
                    return;
                }

                group.members = group.members.filter((memberId) => memberId.toString() !== userId.toString());
                group.groupMembershipVersion += 1;
                await group.save();
                socket.leave(groupId);

                io.to(groupId).emit('group_member_left', { groupId, userId });
                callback?.({ ok: true });
            } catch (err) {
                console.error('Error removing member from group:', err);
                callback?.({ ok: false, error: 'Failed to leave group' });
            }
        });

        socket.on('delete_group', async ({ groupId }, callback) => {
            try {
                const userId = socket.userId;
                const group = await Group.findOne({ groupId });
                if (!group) {
                    callback?.({ ok: false, error: 'Group not found' });
                    return;
                }

                if (group.adminId.toString() !== userId.toString()) {
                    callback?.({ ok: false, error: 'Only the admin can delete the group' });
                    return;
                }

                const memberUsers = await User.find({ _id: { $in: group.members } }).select('_id socketId');
                await Message.deleteMany({ receiver: groupId });
                await Group.deleteOne({ _id: group._id });

                io.to(groupId).emit('group_deleted', { groupId });
                for (const memberUser of memberUsers) {
                    if (memberUser.socketId) {
                        io.to(memberUser.socketId).emit('group_deleted', { groupId });
                    }
                }

                callback?.({ ok: true });
            } catch (err) {
                console.error('Error deleting group:', err);
                callback?.({ ok: false, error: 'Failed to delete group' });
            }
        });

        socket.on('group_message', async (data) => {
            try {
                const { groupId, text, isEncrypted, nonce, payload, messageIndex, groupEpoch, groupMembershipVersion, sessionId } = data;
                const senderId = socket.userId;

                const group = await Group.findOne({ groupId });
                if (!group) return;

                if (!group.members.some(m => m.toString() === senderId)) {
                    console.warn(`Sender ${senderId} not in group ${groupId}. Spoof attempt dropped.`);
                    return;
                }

                const authenticatedContext = await User.findOne({ socketId: socket.id });
                if (!authenticatedContext || authenticatedContext._id.toString() !== senderId) {
                    console.warn(`Socket spoof attempt for sender ${senderId}. Dropping group message.`);
                    return;
                }

                if (TREE_CONTROL_MESSAGES.has(text)) {
                    if (group.adminId.toString() !== senderId) {
                        console.warn(`Non-admin ${senderId} attempted to send TreeKEM control ${text} for ${groupId}`);
                        return;
                    }

                    if (groupEpoch > group.currentEpoch) {
                        group.currentEpoch = groupEpoch;
                        group.groupMembershipVersion = groupMembershipVersion;
                        await group.save();
                    }
                }

                const newMessage = new Message({
                    sender: senderId,
                    receiver: groupId,
                    text: text,
                    isEncrypted: isEncrypted || false,
                    nonce: nonce || null,
                    payload: payload || null,
                    messageIndex: messageIndex || 0,
                    groupEpoch: groupEpoch || null,
                    groupMembershipVersion: groupMembershipVersion || null
                });
                await newMessage.save();

                const populatedPayloadRaw = await newMessage.populate('sender', 'username identityPublicKey pqcPublicKey dilithiumPublicKey');
                const populatedPayload = populatedPayloadRaw.toObject();
                populatedPayload.sessionId = sessionId;
                populatedPayload.groupId = groupId;
                populatedPayload.senderId = senderId;
                populatedPayload.groupEpoch = groupEpoch;
                populatedPayload.groupMembershipVersion = groupMembershipVersion;

                io.to(groupId).emit('receive_group_message', populatedPayload);

                if (TREE_CONTROL_MESSAGES.has(text)) {
                    const memberUsers = await User.find({ _id: { $in: group.members } }).select('_id socketId');
                    for (const memberUser of memberUsers) {
                        if (memberUser.socketId && memberUser._id.toString() !== senderId.toString()) {
                            io.to(memberUser.socketId).emit('receive_group_message', populatedPayload);
                        }
                    }
                }
            } catch (err) {
                console.error('Error handling group_message:', err);
            }
        });

        socket.on('group_key_update_ack', async (data) => {
            try {
                const { groupId, groupEpoch } = data;
                const userId = socket.userId;

                const group = await Group.findOne({ groupId });
                if (!group || !group.members.some(m => m.toString() === userId.toString())) return;

                if (groupEpoch !== group.currentEpoch) {
                    console.warn(`Stale ACK dropped for group ${groupId}. Expected ${group.currentEpoch}, got ${groupEpoch}`);
                    return;
                }

                const adminUser = await User.findById(group.adminId);
                if (adminUser && adminUser.socketId) {
                    io.to(adminUser.socketId).emit('receive_group_key_update_ack', { groupId, groupEpoch, userId });
                }
            } catch (err) {
                console.error('Error handling group_key_update_ack:', err);
            }
        });

        socket.on('disconnect', async () => {
            console.log(`User disconnected: ${socket.id}`);
            const user = await User.findOneAndUpdate({ socketId: socket.id }, { isOnline: false, socketId: null });

            if (user) {
                io.emit('user_status_change', { userId: user._id, isOnline: false });
            }
        });
    });
};
