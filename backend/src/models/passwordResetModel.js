const crypto = require('crypto');
const pool = require('../db');

const hashToken = (token) => crypto.createHash('sha256').update(token).digest('hex');

async function initialize() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS password_resets (
      id BIGSERIAL PRIMARY KEY,
      user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      token_hash TEXT NOT NULL UNIQUE,
      expires_at TIMESTAMPTZ NOT NULL,
      used BOOLEAN NOT NULL DEFAULT FALSE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
}

// returns the raw token (emailed to the user); only its hash is stored
async function createToken(userId, minutesValid = 15) {
  const token = crypto.randomBytes(32).toString('hex');
  await pool.query('DELETE FROM password_resets WHERE user_id = $1 AND used = FALSE', [userId]);
  await pool.query(
    `INSERT INTO password_resets (user_id, token_hash, expires_at)
     VALUES ($1, $2, NOW() + ($3 || ' minutes')::interval)`,
    [userId, hashToken(token), String(minutesValid)],
  );
  return token;
}

// marks the token used and updates the password in one transaction
async function consumeAndSetPassword(token, passwordHash) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await client.query(
      `UPDATE password_resets SET used = TRUE
       WHERE token_hash = $1 AND used = FALSE AND expires_at > NOW()
       RETURNING user_id`,
      [hashToken(token)],
    );
    if (!result.rows.length) {
      await client.query('ROLLBACK');
      return false;
    }
    await client.query('UPDATE users SET password_hash = $1 WHERE id = $2', [
      passwordHash,
      result.rows[0].user_id,
    ]);
    await client.query('COMMIT');
    return true;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { initialize, createToken, consumeAndSetPassword };