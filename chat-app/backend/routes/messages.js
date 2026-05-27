const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const Message = require('../models/Message');
const authMiddleware = require('../middleware/auth');

const uploadsDir = path.join(__dirname, '..', 'uploads');
const allowedMimeTypes = new Set([
    'image/jpeg',
    'image/jpg',
    'image/png',
    'image/gif',
    'image/webp',
    'application/pdf',
    'application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.ms-excel',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'text/plain',
    'application/zip',
    'application/x-zip-compressed',
    'video/mp4',
    'audio/mpeg',
]);

// Configure Multer for file uploads
const storage = multer.diskStorage({
    destination: function (req, file, cb) {
        cb(null, uploadsDir);
    },
    filename: function (req, file, cb) {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        cb(null, file.fieldname + '-' + uniqueSuffix + path.extname(file.originalname));
    }
});

const upload = multer({
    storage: storage,
    limits: { fileSize: 10 * 1024 * 1024 }, // 10MB max
    fileFilter: function (req, file, cb) {
        if (allowedMimeTypes.has(file.mimetype)) {
            cb(null, true);
        } else {
            cb(new Error('File type not allowed'), false);
        }
    }
});

// @route   GET /api/messages/:userId1/:userId2
// @desc    Get message history between two users
// @access  Protected
router.get('/:userId1/:userId2', authMiddleware, async (req, res) => {
    try {
        const { userId1, userId2 } = req.params;
        const now = new Date();

        if (req.userId !== userId1 && req.userId !== userId2) {
            return res.status(403).json({ error: 'Not authorized to access these messages' });
        }

        const messages = await Message.find({
            $and: [
                {
                    $or: [
                        { expiresAt: null },
                        { expiresAt: { $gt: now } }
                    ]
                },
                {
                    $or: [
                        { sender: userId1, receiver: userId2 },
                        { sender: userId2, receiver: userId1 }
                    ]
                }
            ]
        })
            .populate('sender', 'username identityPublicKey pqcPublicKey dilithiumPublicKey')
            .sort({ createdAt: 1 }); // Oldest first

        res.status(200).json(messages);
    } catch (err) {
        console.error(err.message);
        res.status(500).send('Server Error');
    }
});

// @route   POST /api/messages/upload
// @desc    Upload a file
// @access  Protected
router.post('/upload', authMiddleware, upload.single('file'), (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ error: 'No file uploaded' });
        }
        res.status(200).json({
            filePath: `/uploads/${req.file.filename}`,
            originalName: req.file.originalname,
            fileType: req.file.mimetype,
            size: req.file.size
        });
    } catch (err) {
        console.error(err.message);
        res.status(500).send('Server Error');
    }
});

// Multer error handler — catches fileFilter rejections and oversized files
// eslint-disable-next-line no-unused-vars
router.use((err, req, res, next) => {
    if (err && (err.code === 'LIMIT_FILE_SIZE' || err.message === 'File type not allowed')) {
        return res.status(400).json({ error: err.message || 'File upload error' });
    }
    next(err);
});

module.exports = router;
