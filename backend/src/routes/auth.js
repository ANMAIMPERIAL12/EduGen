const express = require('express');
const rateLimit = require('express-rate-limit');
const router = express.Router();
const authMiddleware = require('../middleware/auth');
const {
  register,
  login,
  me,
  forgotPassword,
  resetPassword,
  setupTotp,
  enableTotp,
  verifyTotpLogin,
} = require('../controllers/authController');

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'too many attempts, try again later' },
});
const resetLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'too many attempts, try again later' },
});
const totpLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'too many attempts, try again later' },
});

router.post('/register', register);
router.post('/login', loginLimiter, login);
router.get('/me', authMiddleware, me);
router.post('/forgot-password', resetLimiter, forgotPassword);
router.post('/reset-password', resetLimiter, resetPassword);
router.post('/totp/setup', authMiddleware, setupTotp);
router.post('/totp/enable', authMiddleware, totpLimiter, enableTotp);
router.post('/totp/verify-login', totpLimiter, verifyTotpLogin);

module.exports = router;
