const { Pool } = require('pg');
require('dotenv').config();

const connectionString = process.env.DATABASE_URL?.trim();
if (!connectionString || /<[^>]+>|replace-with|YOUR_/i.test(connectionString)) {
  throw new Error(
    'DATABASE_URL is missing or still contains placeholders. Set a valid PostgreSQL connection string in backend/.env.',
  );
}

const pool = new Pool({ connectionString });

module.exports = pool;
