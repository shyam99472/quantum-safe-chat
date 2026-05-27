const express = require('express');
const router = express.Router();
const Group = require('../models/Group');
const Message = require('../models/Message');
const authMiddleware = require('../middleware/auth');

// @route   GET /api/groups
// @desc    Get all groups a user is part of
// @access  Protected
router.get('/', authMiddleware, async (req, res) => {
    try {
        const groups = await Group.find({ members: req.userId })
            .populate('members', 'username')
            .populate('adminId', 'username');
        res.status(200).json(groups);
    } catch (err) {
        console.error(err.message);
        res.status(500).send('Server Error');
    }
});

// @route   GET /api/groups/:groupId/messages
// @desc    Get message history for a group
// @access  Protected
router.get('/:groupId/messages', authMiddleware, async (req, res) => {
    try {
        const { groupId } = req.params;

        // Ensure user is part of the group
        const group = await Group.findOne({ groupId, members: req.userId });
        if (!group) {
            return res.status(403).json({ error: 'Not authorized for this group' });
        }

        const messages = await Message.find({ receiver: groupId })
            .populate('sender', 'username identityPublicKey pqcPublicKey dilithiumPublicKey')
            .sort({ createdAt: 1 }); // Oldest first

        res.status(200).json(messages);
    } catch (err) {
        console.error(err.message);
        res.status(500).send('Server Error');
    }
});

// @route   DELETE /api/groups/:groupId
// @desc    Delete a group (admin only)
// @access  Protected
router.delete('/:groupId', authMiddleware, async (req, res) => {
    try {
        const { groupId } = req.params;
        const group = await Group.findOne({ groupId });

        if (!group) {
            return res.status(404).json({ error: 'Group not found' });
        }

        if (group.adminId.toString() !== req.userId) {
            return res.status(403).json({ error: 'Only the group admin can delete the group' });
        }

        await Message.deleteMany({ receiver: groupId });
        await Group.deleteOne({ _id: group._id });

        res.status(200).json({ message: 'Group deleted successfully' });
    } catch (err) {
        console.error(err.message);
        res.status(500).send('Server Error');
    }
});

// @route   DELETE /api/groups/:groupId/members/me
// @desc    Leave a group (non-admin members only)
// @access  Protected
router.delete('/:groupId/members/me', authMiddleware, async (req, res) => {
    try {
        const { groupId } = req.params;
        const group = await Group.findOne({ groupId });

        if (!group) {
            return res.status(404).json({ error: 'Group not found' });
        }

        if (!group.members.some(memberId => memberId.toString() === req.userId)) {
            return res.status(403).json({ error: 'Not a group member' });
        }

        if (group.adminId.toString() === req.userId) {
            return res.status(400).json({ error: 'Admin cannot leave the group. Delete it instead.' });
        }

        group.members = group.members.filter(memberId => memberId.toString() !== req.userId);
        group.groupMembershipVersion += 1;
        await group.save();

        res.status(200).json({ message: 'Left group successfully' });
    } catch (err) {
        console.error(err.message);
        res.status(500).send('Server Error');
    }
});

module.exports = router;
