import { Router } from 'express';
import { body } from 'express-validator';
import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import User from '../models/User.js';
import PasswordResetToken from '../models/PasswordResetToken.js';
import { validate } from '../middleware/validate.js';
import { protect } from '../middleware/auth.js';
import { sendActivationEmail, sendPasswordResetEmail } from '../services/emailService.js';

const router = Router();

const signToken = (id) =>
  jwt.sign({ id }, process.env.JWT_SECRET, {
    expiresIn: process.env.JWT_EXPIRES_IN || '7d',
  });

router.post(
  '/register',
  [
    body('email').isEmail().normalizeEmail().withMessage('Valid email is required'),
    body('firstName').trim().notEmpty().withMessage('First name is required'),
    body('lastName').trim().notEmpty().withMessage('Last name is required'),
    body('password')
      .isLength({ min: 8 })
      .withMessage('Password must be at least 8 characters'),
  ],
  validate,
  async (req, res) => {
    try {
      const { email, firstName, lastName, password } = req.body;
      const existing = await User.findOne({ email });
      if (existing) {
        return res.status(400).json({ message: 'An account with this email already exists.' });
      }
      const activationToken = crypto.randomBytes(32).toString('hex');
      const activationTokenExpires = new Date(Date.now() + 24 * 60 * 60 * 1000);
      const user = await User.create({
        email,
        firstName,
        lastName,
        password,
        isActive: false,
        activationToken,
        activationTokenExpires,
      });
      const baseUrl = process.env.FRONTEND_URL || 'http://localhost:5173';
      const activationLink = `${baseUrl}/activate/${activationToken}`;

      try {
        await sendActivationEmail(email, firstName, activationLink);
      } catch (emailErr) {
        console.error('[Register] Activation email failed:', emailErr.message);
      }

      const payload = {
        message: 'Account created. Please check your email to activate your account.',
        userId: user._id,
      };
      if (process.env.NODE_ENV !== 'production') {
        payload.activationLink = activationLink;
      }
      res.status(201).json(payload);
    } catch (err) {
      console.error('[Register] Error:', err.message);
      res.status(500).json({ message: 'Registration failed. Please try again.' });
    }
  }
);

router.get('/activate/:token', async (req, res) => {
  try {
    const user = await User.findOne({
      activationToken: req.params.token,
      activationTokenExpires: { $gt: Date.now() },
    }).select('+activationToken +activationTokenExpires');
    if (!user) {
      return res.status(400).json({ message: 'Invalid or expired activation link.' });
    }
    user.isActive = true;
    user.activationToken = undefined;
    user.activationTokenExpires = undefined;
    await user.save({ validateBeforeSave: false });
    res.json({ message: 'Account activated. You can now log in.' });
  } catch (err) {
    res.status(500).json({ message: 'Activation failed.' });
  }
});

router.post(
  '/login',
  [
    body('email').isEmail().normalizeEmail(),
    body('password').notEmpty(),
  ],
  validate,
  async (req, res) => {
    try {
      const user = await User.findOne({ email: req.body.email }).select('+password');
      if (!user) {
        return res.status(401).json({ message: 'Invalid email or password.' });
      }
      if (!user.isActive) {
        return res.status(403).json({
          message: 'Account not activated. Please check your email for the activation link.',
        });
      }
      const match = await user.comparePassword(req.body.password);
      if (!match) {
        return res.status(401).json({ message: 'Invalid email or password.' });
      }
      const token = signToken(user._id);
      res.json({
        token,
        user: {
          id: user._id,
          email: user.email,
          firstName: user.firstName,
          lastName: user.lastName,
        },
      });
    } catch (err) {
      res.status(500).json({ message: 'Login failed.' });
    }
  }
);

router.post(
  '/forgot-password',
  [body('email').isEmail().normalizeEmail()],
  validate,
  async (req, res) => {
    try {
      const user = await User.findOne({ email: req.body.email });
      if (!user) {
        return res.status(404).json({ message: 'No account found with this email address.' });
      }
      const token = crypto.randomBytes(32).toString('hex');
      const expiresAt = new Date(Date.now() + 60 * 60 * 1000);
      await PasswordResetToken.create({
        userId: user._id,
        token,
        expiresAt,
      });
      const baseUrl = process.env.FRONTEND_URL || 'http://localhost:5173';
      const resetLink = `${baseUrl}/reset-password/${token}`;
      await sendPasswordResetEmail(user.email, user.firstName, resetLink);
      res.json({
        message: 'If an account exists with this email, you will receive a password reset link.',
      });
    } catch (err) {
      res.status(500).json({ message: 'Request failed. Please try again.' });
    }
  }
);

router.post(
  '/reset-password/:token',
  [
    body('password')
      .isLength({ min: 8 })
      .withMessage('Password must be at least 8 characters'),
  ],
  validate,
  async (req, res) => {
    try {
      const resetRecord = await PasswordResetToken.findOne({
        token: req.params.token,
        used: false,
        expiresAt: { $gt: Date.now() },
      });
      if (!resetRecord) {
        return res.status(400).json({ message: 'Invalid or expired reset link.' });
      }
      const user = await User.findById(resetRecord.userId).select('+password');
      if (!user) {
        return res.status(400).json({ message: 'User not found.' });
      }
      user.password = req.body.password;
      await user.save();
      resetRecord.used = true;
      await resetRecord.save();
      res.json({ message: 'Password updated successfully. You can now log in.' });
    } catch (err) {
      res.status(500).json({ message: 'Password reset failed.' });
    }
  }
);

router.get('/me', protect, (req, res) => {
  res.json({ user: req.user });
});

export default router;
