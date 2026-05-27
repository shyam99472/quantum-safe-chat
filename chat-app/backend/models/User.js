const mongoose = require('mongoose');

const userSchema = new mongoose.Schema({
    username: {
        type: String,
        required: true,
        unique: true,
        trim: true,
    },
    isOnline: {
        type: Boolean,
        default: false,
    },
    socketId: {
        type: String,
        default: null,
    },
    identityPublicKey: {
        type: String, // Future: base64 encoded identity key
        default: null,
    },
    pqcPublicKey: {
        type: String, // Future: base64 encoded PQC key
        default: null,
    },
    dilithiumPublicKey: {
        type: String, // Future: base64 encoded Dilithium key
        default: null,
    }
}, { timestamps: true });

const User = mongoose.model('User', userSchema);

module.exports = User;
