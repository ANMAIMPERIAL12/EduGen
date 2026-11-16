const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const User = require('../models/userModel');
const PasswordReset = require('../models/passwordResetModel');
const { sendResetEmail } = require('../utils/mailer');
const QRCode = require('qrcode');
const crypto = require('crypto');
const { encryptSecret, decryptSecret } = require('../utils/totpCrypto');

const SALT_ROUNDS = 10;
const ALLOWED_SIGNUP_ROLES = ['student', 'teacher'];
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DUMMY_HASH = bcrypt.hashSync('dummy-password', SALT_ROUNDS);

function signToken(user) {
  // payload shape matches middleware/auth.js and roleCheck: req.user.id, req.user.role
  return jwt.sign({ id: user.id, role: user.role }, process.env.JWT_SECRET, {
    algorithm: 'HS256',
    expiresIn: '1d',
  });
}

function toUserDTO(u) {
  return { id: u.id, name: u.name, email: u.email, role: u.role, department: u.department, totpEnabled: Boolean(u.totpEnabled) };
}

async function register(req, res) {
  const { name, email, password, role = 'student', department } = req.body || {};

  if (
    typeof name !== 'string' ||
    typeof email !== 'string' ||
    typeof password !== 'string' ||
    !name.trim() ||
    !email.trim() ||
    !password
  ) {
    return res.status(400).json({ error: 'name, email and password are required' });
  }
  const normalizedEmail = email.trim().toLowerCase();
  if (!EMAIL_RE.test(normalizedEmail)) {
    return res.status(400).json({ error: 'invalid email format' });
  }
  if (password.length < 8 || password.length > 72) {
    return res.status(400).json({ error: 'password must be 8-72 characters' });
  }
  if (!ALLOWED_SIGNUP_ROLES.includes(role)) {
    return res.status(400).json({ error: 'role must be student or teacher' });
  }
  try {
    if (await User.findByEmail(normalizedEmail)) {
      return res.status(409).json({ error: 'email already registered' });
    }

    const passwordHash = await bcrypt.hash(password, SALT_ROUNDS);
    const user = await User.create({
      name: name.trim(),
      email: normalizedEmail,
      passwordHash,
      role,
      department: department || null,
    });

    return res.status(201).json({ token: signToken(user), user: toUserDTO(user) });
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({ error: 'email already registered' });
    }
    console.error(err);
    return res.status(500).json({ error: 'server error' });
  }
}

async function login(req, res) {
  const { email, password } = req.body || {};

  if (
    typeof email !== 'string' ||
    typeof password !== 'string' ||
    !email.trim() ||
    !password
  ) {
    return res.status(400).json({ error: 'email and password are required' });
  }

  try {
    const user = await User.findByEmail(email.trim().toLowerCase());

    // compare against a dummy hash when the user doesn't exist, so timing doesn't leak which emails exist
    const ok = await bcrypt.compare(password, user ? user.passwordHash : DUMMY_HASH);
    if (!user || !ok) {
      return res.status(401).json({ error: 'invalid email or password' });
    }

    if (user.totpEnabled) {
      const jti = crypto.randomUUID();
      await User.createTotpChallenge(jti, user.id);
      const challengeToken = jwt.sign(
        { id: user.id, purpose: 'totp_login', jti },
        process.env.JWT_SECRET,
        { algorithm: 'HS256', expiresIn: '5m' },
      );
      return res.json({ mfaRequired: true, challengeToken });
    }

    return res.json({ token: signToken(user), user: toUserDTO(user) });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'server error' });
  }
}

async function setupTotp(req, res) {
  try {
    const user = await User.findById(req.user.id);
    if (!user) return res.status(404).json({ error: 'User not found' });
    if (user.totpEnabled) return res.status(409).json({ error: 'Authenticator already enabled' });

    const { generateSecret, generateURI } = await import('otplib');
    const secret = generateSecret();
    const uri = generateURI({ issuer: 'EduGen AI', label: user.email, secret });
    const qrCode = await QRCode.toDataURL(uri);
    await User.savePendingTotpSecret(user.id, encryptSecret(secret));
    return res.json({ qrCode });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Unable to generate QR code' });
  }
}

async function enableTotp(req, res) {
  const { code } = req.body || {};
  if (typeof code !== 'string' || !/^\d{6}$/.test(code)) {
    return res.status(400).json({ error: 'Enter a valid six-digit code' });
  }
  try {
    const user = await User.findById(req.user.id);
    if (!user) return res.status(404).json({ error: 'User not found' });
    if (user.totpEnabled) return res.status(409).json({ error: 'Authenticator already enabled' });
    if (!user.totpPendingSecretEncrypted) return res.status(400).json({ error: 'Set up the authenticator first' });

    const { verify } = await import('otplib');
    const secret = decryptSecret(user.totpPendingSecretEncrypted);
    const result = await verify({ secret, token: code, epochTolerance: 0 });
    if (!result.valid) return res.status(400).json({ error: 'Invalid verification code' });
    const step = Math.floor(Date.now() / 30000);
    const recoveryCodes = Array.from({ length: 10 }, () => crypto.randomBytes(12).toString('hex').toUpperCase().match(/.{4}/g).join('-'));
    const recoveryCodeHashes = recoveryCodes.map((value) => crypto.createHash('sha256').update(value.replace(/-/g, '').toLowerCase()).digest('hex'));
    await User.enableTotp(user.id, user.totpPendingSecretEncrypted, step, recoveryCodeHashes);
    return res.json({ message: 'Two-factor authentication enabled', totpEnabled: true, recoveryCodes });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Unable to enable authentication' });
  }
}

async function verifyTotpLogin(req, res) {
  const { challengeToken, code } = req.body || {};
  if (typeof code !== 'string' || !(/^[0-9]{6}$/.test(code) || /^[a-f\d]{4}(?:-[a-f\d]{4}){5}$/i.test(code)) || typeof challengeToken !== 'string') {
    return res.status(400).json({ error: 'Invalid verification request' });
  }
  try {
    const payload = jwt.verify(challengeToken, process.env.JWT_SECRET, { algorithms: ['HS256'] });
    if (payload.purpose !== 'totp_login' || !payload.id || !payload.jti) {
      return res.status(401).json({ error: 'Invalid login challenge' });
    }
    const user = await User.findById(payload.id);
    if (!user?.totpEnabled || !user.totpSecretEncrypted) {
      return res.status(401).json({ error: 'Authentication failed' });
    }
    let authenticated = false;
    if (/^[0-9]{6}$/.test(code)) {
      const { verify } = await import('otplib');
      const secret = decryptSecret(user.totpSecretEncrypted);
      const result = await verify({ secret, token: code, epochTolerance: 0 });
      if (result.valid) {
        const step = Math.floor(Date.now() / 30000);
        authenticated = await User.consumeTotpChallengeAndStep(payload.jti, user.id, step);
      }
    } else {
      const codeHash = crypto.createHash('sha256').update(code.replace(/-/g, '').toLowerCase()).digest('hex');
      authenticated = await User.consumeRecoveryChallenge(payload.jti, user.id, codeHash);
    }
    if (!authenticated) return res.status(401).json({ error: 'Invalid, expired, or already used authentication code or challenge' });
    return res.json({ token: signToken(user), user: toUserDTO(user) });
  } catch (err) {
    if (err.name === 'TokenExpiredError' || err.name === 'JsonWebTokenError') {
      return res.status(401).json({ error: 'Invalid or expired login challenge' });
    }
    console.error(err);
    return res.status(500).json({ error: 'Unable to verify authentication code' });
  }
}

async function me(req, res) {
  try {
    const user = await User.findById(req.user.id);
    if (!user) return res.status(404).json({ error: 'user not found' });
    return res.json(toUserDTO(user));
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'server error' });
  }
}

async function forgotPassword(req, res) {
  const { email } = req.body || {};
  if (typeof email !== 'string' || !EMAIL_RE.test(email.trim().toLowerCase())) {
    return res.status(400).json({ error: 'a valid email is required' });
  }

  // same response whether or not the account exists, so emails can't be enumerated
  const generic = { message: 'If that email is registered, a reset link has been sent.' };

  try {
    const user = await User.findByEmail(email.trim().toLowerCase());
    if (user) {
      try {
        const token = await PasswordReset.createToken(user.id, 15);
        const base = process.env.FRONTEND_URL || 'http://localhost:5173';
        await sendResetEmail(user.email, `${base}/reset-password?token=${token}`);
      } catch (mailErr) {
        console.error('forgot-password failed:', mailErr);
      }
    }
    return res.json(generic);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'server error' });
  }
}

async function resetPassword(req, res) {
  const { token, password } = req.body || {};
  if (typeof token !== 'string' || !/^[a-f0-9]{64}$/.test(token)) {
    return res.status(400).json({ error: 'invalid or expired reset link' });
  }
  if (typeof password !== 'string' || password.length < 8 || password.length > 72) {
    return res.status(400).json({ error: 'password must be 8-72 characters' });
  }

  try {
    const passwordHash = await bcrypt.hash(password, SALT_ROUNDS);
    const ok = await PasswordReset.consumeAndSetPassword(token, passwordHash);
    if (!ok) return res.status(400).json({ error: 'invalid or expired reset link' });
    return res.json({ message: 'password updated, you can now log in' });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'server error' });
  }
}

module.exports = { register, login, me, forgotPassword, resetPassword, setupTotp, enableTotp, verifyTotpLogin };
