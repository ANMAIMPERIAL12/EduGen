const pool = require('../db');

async function initialize() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id BIGSERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('student', 'teacher')),
      department TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`
    ALTER TABLE users
      ADD COLUMN IF NOT EXISTS totp_secret_encrypted TEXT,
      ADD COLUMN IF NOT EXISTS totp_pending_secret_encrypted TEXT,
      ADD COLUMN IF NOT EXISTS totp_enabled BOOLEAN NOT NULL DEFAULT FALSE,
      ADD COLUMN IF NOT EXISTS totp_last_used_step BIGINT,
      ADD COLUMN IF NOT EXISTS totp_recovery_code_hashes TEXT[] NOT NULL DEFAULT '{}'
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS totp_login_challenges (
      jti TEXT PRIMARY KEY,
      user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at TIMESTAMPTZ NOT NULL,
      consumed_at TIMESTAMPTZ
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS totp_login_challenges_expiry_idx ON totp_login_challenges (expires_at)`);
}

const USER_FIELDS = `id, name, email, password_hash AS "passwordHash", role, department,
  totp_secret_encrypted AS "totpSecretEncrypted",
  totp_pending_secret_encrypted AS "totpPendingSecretEncrypted",
  totp_enabled AS "totpEnabled",
  totp_last_used_step AS "totpLastUsedStep"`;

async function findByEmail(email) {
  const result = await pool.query(
    `SELECT ${USER_FIELDS} FROM users WHERE email = $1`,
    [email],
  );
  return result.rows[0] || null;
}

async function findById(id) {
  const result = await pool.query(
    `SELECT ${USER_FIELDS} FROM users WHERE id = $1`,
    [id],
  );
  return result.rows[0] || null;
}

async function create({ name, email, passwordHash, role, department }) {
  const result = await pool.query(
    `INSERT INTO users (name, email, password_hash, role, department)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING ${USER_FIELDS}`,
    [name, email, passwordHash, role, department],
  );
  return result.rows[0];
}

async function savePendingTotpSecret(id, secret) {
  await pool.query(
    'UPDATE users SET totp_pending_secret_encrypted = $1 WHERE id = $2',
    [secret, id],
  );
}

async function enableTotp(id, secret, step, recoveryCodeHashes) {
  await pool.query(
    `UPDATE users SET totp_secret_encrypted = $1,
      totp_pending_secret_encrypted = NULL, totp_enabled = TRUE, totp_last_used_step = $2,
      totp_recovery_code_hashes = $3
     WHERE id = $4`,
    [secret, step, recoveryCodeHashes, id],
  );
}

async function consumeRecoveryChallenge(jti, userId, codeHash) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const challenge = await client.query(
      `UPDATE totp_login_challenges SET consumed_at = NOW()
       WHERE jti = $1 AND user_id = $2 AND consumed_at IS NULL AND expires_at > NOW()
       RETURNING jti`,
      [jti, userId],
    );
    const recoveryCode = challenge.rowCount === 1
      ? await client.query(
        `UPDATE users SET totp_recovery_code_hashes = array_remove(totp_recovery_code_hashes, $2)
         WHERE id = $1 AND $2 = ANY(totp_recovery_code_hashes) RETURNING id`,
        [userId, codeHash],
      )
      : { rowCount: 0 };
    if (challenge.rowCount !== 1 || recoveryCode.rowCount !== 1) {
      await client.query('ROLLBACK');
      return false;
    }
    await client.query('COMMIT');
    return true;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function createTotpChallenge(jti, userId) {
  await pool.query(`
    DELETE FROM totp_login_challenges
    WHERE expires_at < NOW() - INTERVAL '1 day'
       OR consumed_at < NOW() - INTERVAL '1 day'
  `);
  await pool.query(
    `INSERT INTO totp_login_challenges (jti, user_id, expires_at)
     VALUES ($1, $2, NOW() + INTERVAL '5 minutes')`,
    [jti, userId],
  );
}

async function consumeTotpChallengeAndStep(jti, userId, step) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const challenge = await client.query(
      `UPDATE totp_login_challenges SET consumed_at = NOW()
       WHERE jti = $1 AND user_id = $2 AND consumed_at IS NULL AND expires_at > NOW()
       RETURNING jti`,
      [jti, userId],
    );
    if (challenge.rowCount !== 1) {
      await client.query('ROLLBACK');
      return false;
    }
    const acceptedStep = await client.query(
      `UPDATE users SET totp_last_used_step = $1
       WHERE id = $2 AND totp_enabled = TRUE
         AND (totp_last_used_step IS NULL OR totp_last_used_step < $1)
       RETURNING id`,
      [step, userId],
    );
    if (acceptedStep.rowCount !== 1) {
      await client.query('ROLLBACK');
      return false;
    }
    await client.query('COMMIT');
    return true;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

module.exports = { initialize, findByEmail, findById, create, savePendingTotpSecret, enableTotp, consumeRecoveryChallenge, createTotpChallenge, consumeTotpChallengeAndStep };
