const crypto = require('crypto');

function getKey() {
  const key = Buffer.from(process.env.TOTP_ENCRYPTION_KEY || '', 'hex');
  if (key.length !== 32) throw new Error('Invalid TOTP encryption key');
  return key;
}

function encryptSecret(secret) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', getKey(), iv);
  const encrypted = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()]);
  return [iv.toString('hex'), cipher.getAuthTag().toString('hex'), encrypted.toString('hex')].join(':');
}

function decryptSecret(value) {
  const parts = typeof value === 'string' ? value.split(':') : [];
  if (parts.length !== 3 || parts.some((part) => !/^[a-f\d]+$/i.test(part))) {
    throw new Error('Invalid encrypted TOTP secret');
  }
  const [iv, tag, data] = parts;
  if (Buffer.from(iv, 'hex').length !== 12 || Buffer.from(tag, 'hex').length !== 16) {
    throw new Error('Invalid encrypted TOTP secret');
  }
  const decipher = crypto.createDecipheriv('aes-256-gcm', getKey(), Buffer.from(iv, 'hex'));
  decipher.setAuthTag(Buffer.from(tag, 'hex'));
  return Buffer.concat([decipher.update(Buffer.from(data, 'hex')), decipher.final()]).toString('utf8');
}

module.exports = { encryptSecret, decryptSecret };
