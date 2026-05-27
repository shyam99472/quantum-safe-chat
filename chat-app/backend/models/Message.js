const mongoose = require('mongoose');

const messageSchema = new mongoose.Schema({
    sender: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true,
    },
    receiver: {
        type: String,
        required: true,
    },
    text: {
        type: String,
        default: '',
    },
    fileUrl: {
        type: String,
        default: null,
    },
    fileType: {
        type: String, // e.g., 'image/png', 'application/pdf'
        default: null,
    },
    originalFileName: {
        type: String,
        default: null,
    },
    originalFileType: {
        type: String, // Original MIME type before encryption (e.g. 'image/png')
        default: null,
    },
    isEncrypted: {
        type: Boolean,
        default: false,
    },
    nonce: {
        type: String, // Future: Initialization vector or nonce for encryption
        default: null,
    },
    fileNonce: {
        type: String,
        default: null,
    },
    authTag: {
        type: String, // Future: Authentication tag for Authenticated Encryption
        default: null,
    },
    payload: {
        type: Object, // Stores ecdhPublicKey, kyberPublicKey, signature, timestamp
        default: {},
    },
    sessionId: {
        type: String,
        default: null,
    },
    messageIndex: {
        type: Number,
        default: 0
    },
    groupEpoch: {
        type: Number,
        default: null
    },
    groupMembershipVersion: {
        type: Number,
        default: null
    },
    expiresAt: {
        type: Date,
        default: null
    }
}, { timestamps: true });

const Message = mongoose.model('Message', messageSchema);

module.exports = Message;
