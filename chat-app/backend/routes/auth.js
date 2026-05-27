const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const User = require('../models/User');
const authMiddleware = require('../middleware/auth');

const JWT_SECRET = process.env.JWT_SECRET;

if (!JWT_SECRET) {
    throw new Error('JWT_SECRET environment variable is required');
}

const normalizeUsername = (value) => value.trim().replace(/\s+/g, ' ');

const serializeUser = (user) => ({
    _id: user._id,
    username: user.username,
    isOnline: user.isOnline,
    identityPublicKey: user.identityPublicKey,
    pqcPublicKey: user.pqcPublicKey,
    dilithiumPublicKey: user.dilithiumPublicKey,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
});

// @route   POST /api/auth/login
// @desc    Register or login user by username
// @access  Public
router.post('/login', async (req, res) => {
    try {
        const { username } = req.body;

        if (!username || username.trim() === '') {
            return res.status(400).json({ error: 'Username is required' });
        }

        const normalizedUsername = normalizeUsername(username);
        if (normalizedUsername.length < 3 || normalizedUsername.length > 32) {
            return res.status(400).json({ error: 'Username must be between 3 and 32 characters' });
        }

        let user = await User.findOne({ username: normalizedUsername });

        if (!user) {
            user = new User({ username: normalizedUsername });
            await user.save();
        }

        // Fix 7: Issue a JWT token so clients can authenticate future requests
        const token = jwt.sign({ userId: user._id }, JWT_SECRET, { expiresIn: '12h' });

        res.status(200).json({ ...serializeUser(user), token });
    } catch (err) {
        console.error(err.message);
        res.status(500).send('Server Error');
    }
});

// @route   GET /api/auth/users
// @desc    Get all users (excluding requesting user optionally)
// @access  Public
router.get('/users', authMiddleware, async (req, res) => {
    try {
        // Ensure identityPublicKey, pqcPublicKey, and dilithiumPublicKey are included so hybrid key derivation and auth works
        // We explicitly select ONLY the necessary fields, never the private keys.
        const users = await User.find().select('_id username isOnline identityPublicKey pqcPublicKey dilithiumPublicKey');
        res.status(200).json(users);
    } catch (err) {
        console.error(err.message);
        res.status(500).send('Server Error');
    }
});

// @route   PUT /api/auth/public-key
// @desc    Update user identity public key
// @access  Protected
router.put('/public-key', authMiddleware, async (req, res) => {
    try {
        const { publicKey, pqcPublicKey, dilithiumPublicKey } = req.body;

        if (!publicKey || typeof publicKey !== 'string') {
            return res.status(400).json({ error: 'Identity public key is required' });
        }

        if (pqcPublicKey && typeof pqcPublicKey !== 'string') {
            return res.status(400).json({ error: 'Invalid PQC public key' });
        }

        if (dilithiumPublicKey && typeof dilithiumPublicKey !== 'string') {
            return res.status(400).json({ error: 'Invalid Dilithium public key' });
        }

        const user = await User.findById(req.userId);
        if (!user) {
            return res.status(404).json({ error: 'User not found' });
        }

        user.identityPublicKey = publicKey;
        if (pqcPublicKey) {
            user.pqcPublicKey = pqcPublicKey;
        }
        if (dilithiumPublicKey) {
            user.dilithiumPublicKey = dilithiumPublicKey;
        }
        await user.save();

        res.status(200).json({ message: 'Public key updated successfully', user: serializeUser(user) });
    } catch (err) {
        console.error(err.message);
        res.status(500).send('Server Error');
    }
});

module.exports = router;
