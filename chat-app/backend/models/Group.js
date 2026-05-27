const mongoose = require('mongoose');

const GroupSchema = new mongoose.Schema({
    groupId: {
        type: String,
        required: true,
        unique: true
    },
    name: {
        type: String,
        required: true
    },
    adminId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true
    },
    members: [{
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User'
    }],
    groupMembershipVersion: {
        type: Number,
        default: 1
    },
    currentEpoch: {
        type: Number,
        default: 1
    }
}, { timestamps: true });

module.exports = mongoose.model('Group', GroupSchema);
