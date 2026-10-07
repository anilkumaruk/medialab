// Postgres (Supabase) access. Queries use `?` placeholders, converted to $1, $2 … here.
const { Pool, types } = require('pg');
const config = require('./config');
const { HttpError } = require('./util');

types.setTypeParser(20, (v) => parseInt(v, 10)); // COUNT(*) returns bigint

function poolConfig(url) {
  const u = new URL(url);
  const local = ['localhost', '127.0.0.1', '::1'].includes(u.hostname);
  u.searchParams.delete('sslmode');
  u.searchParams.delete('supa');
  return {
    connectionString: u.toString(),
    ssl: local ? false : { rejectUnauthorized: false },
    max: Number(process.env.PG_POOL_MAX) || (process.env.VERCEL ? 3 : 10),
    idleTimeoutMillis: 10_000,
    connectionTimeoutMillis: 15_000,
  };
}

const MISSING_DB = 'Database is not configured: set DATABASE_URL (or connect Supabase in Vercel > Storage) and redeploy.';
if (!config.databaseUrl) console.error(MISSING_DB);
const pool = new Pool(config.databaseUrl ? poolConfig(config.databaseUrl) : {});
pool.on('error', (e) => console.error('[db] idle client error:', e.message));

const toPg = (sql) => {
  let i = 0;
  return sql.replace(/\?/g, () => `$${++i}`);
};

function wrap(runner) {
  const query = (sql, params = []) => runner.query(toPg(sql), params);
  return {
    raw: (sql) => runner.query(sql),
    query,
    all: async (sql, params) => (await query(sql, params)).rows,
    get: async (sql, params) => (await query(sql, params)).rows[0],
    run: async (sql, params) => {
      const r = await query(sql, params);
      return { changes: r.rowCount, rows: r.rows };
    },
  };
}

const db = wrap(pool);

// Runs fn inside a transaction; fn receives the same query helpers bound to one connection.
db.tx = async (fn) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(wrap(client));
    await client.query('COMMIT');
    return result;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
};

const SCHEMA_VERSION = '1';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,                       -- always stored lowercase
  phone TEXT NOT NULL,
  profession TEXT NOT NULL DEFAULT 'student',       -- student | faculty
  batch TEXT,
  department TEXT,
  school TEXT,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'user',                -- user | admin
  approval_level INTEGER NOT NULL DEFAULT 0,        -- 0 none, 1 = Level 1, 2 = Level 2
  active INTEGER NOT NULL DEFAULT 1,
  email_verified INTEGER NOT NULL DEFAULT 0,
  phone_verified INTEGER NOT NULL DEFAULT 0,
  terms_accepted_at TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS otps (
  id SERIAL PRIMARY KEY,
  channel TEXT NOT NULL,                            -- email | phone
  target TEXT NOT NULL,
  purpose TEXT NOT NULL,                            -- register | reset
  code_hash TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  consumed_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_otps_target ON otps(target, purpose, channel);

CREATE TABLE IF NOT EXISTS captchas (id TEXT PRIMARY KEY, answer TEXT NOT NULL, expires_at TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS equipment (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  category TEXT NOT NULL,                           -- Cameras | Lenses | Lights | Audio | Accessories
  subtype TEXT NOT NULL DEFAULT '',
  code TEXT NOT NULL UNIQUE,                        -- model code, uppercase, e.g. CAM-014
  description TEXT NOT NULL DEFAULT '',
  is_accessory INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);

-- "Selecting a camera prompts for its battery, charger and memory card"
CREATE TABLE IF NOT EXISTS accessory_links (
  equipment_id INTEGER NOT NULL REFERENCES equipment(id) ON DELETE CASCADE,
  accessory_id INTEGER NOT NULL REFERENCES equipment(id) ON DELETE CASCADE,
  PRIMARY KEY (equipment_id, accessory_id)
);

-- One row per physical item, each with its own barcode label
CREATE TABLE IF NOT EXISTS units (
  id SERIAL PRIMARY KEY,
  equipment_id INTEGER NOT NULL REFERENCES equipment(id) ON DELETE CASCADE,
  barcode TEXT NOT NULL UNIQUE,                     -- uppercase
  status TEXT NOT NULL DEFAULT 'available',         -- available | in_use | maintenance | retired
  notes TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_units_eq ON units(equipment_id, status);

CREATE TABLE IF NOT EXISTS requests (
  id SERIAL PRIMARY KEY,
  code TEXT UNIQUE,
  user_id INTEGER NOT NULL REFERENCES users(id),
  from_at TEXT,
  to_at TEXT,
  purpose TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'draft',  -- draft | pending_l1 | pending_l2 | approved | rejected | issued | returned | cancelled
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  submitted_at TEXT,
  l1_by INTEGER REFERENCES users(id), l1_at TEXT, l1_decision TEXT, l1_remarks TEXT,
  l2_by INTEGER REFERENCES users(id), l2_at TEXT, l2_decision TEXT, l2_remarks TEXT,
  issued_by INTEGER REFERENCES users(id), issued_at TEXT,
  returned_at TEXT, return_verified_by INTEGER REFERENCES users(id), return_notes TEXT,
  damage_reported INTEGER NOT NULL DEFAULT 0,
  cancelled_at TEXT,
  renew_to TEXT, renew_reason TEXT, renew_status TEXT, renew_by INTEGER REFERENCES users(id), renew_at TEXT, renew_remarks TEXT,
  due_soon_alerted_at TEXT, overdue_alerted_at TEXT, alert_dismissed_at TEXT, return_ack_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_requests_user ON requests(user_id, status);
CREATE INDEX IF NOT EXISTS idx_requests_status ON requests(status);

CREATE TABLE IF NOT EXISTS request_items (
  id SERIAL PRIMARY KEY,
  request_id INTEGER NOT NULL REFERENCES requests(id) ON DELETE CASCADE,
  equipment_id INTEGER NOT NULL REFERENCES equipment(id),
  unit_id INTEGER REFERENCES units(id),
  return_ok INTEGER,
  damaged INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_items_request ON request_items(request_id);

CREATE TABLE IF NOT EXISTS notify_requests (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  equipment_id INTEGER NOT NULL REFERENCES equipment(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  notified_at TEXT
);

CREATE TABLE IF NOT EXISTS notifications (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  link TEXT,
  read_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id, read_at);

CREATE TABLE IF NOT EXISTS logs (
  id SERIAL PRIMARY KEY,
  at TEXT NOT NULL,
  actor_id INTEGER REFERENCES users(id),
  subject_user_id INTEGER REFERENCES users(id),
  request_id INTEGER REFERENCES requests(id) ON DELETE SET NULL,
  equipment TEXT NOT NULL DEFAULT '',
  action TEXT NOT NULL,
  approved_by TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT '',
  details TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_logs_at ON logs(at);
`;

const TABLES = ['logs', 'notifications', 'notify_requests', 'request_items', 'requests', 'units', 'accessory_links', 'equipment', 'captchas', 'otps', 'sessions', 'users', 'meta'];

const now = () => new Date().toISOString();

// Creates tables (and seeds on first run) once per process / serverless instance.
let readyPromise = null;
function ensureReady() {
  if (!config.databaseUrl) return Promise.reject(new HttpError(503, MISSING_DB));
  if (!readyPromise) {
    readyPromise = (async () => {
      const current = await pool.query("SELECT value FROM meta WHERE key = 'schema_version'").then((r) => r.rows[0]?.value, () => null);
      if (current !== SCHEMA_VERSION) {
        await db.tx(async (t) => {
          await t.raw('SELECT pg_advisory_xact_lock(724001)'); // one instance migrates at a time
          await t.raw(SCHEMA);
          await t.query("INSERT INTO meta (key, value) VALUES ('schema_version', ?) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value", [SCHEMA_VERSION]);
        });
      }
      await require('./seed').seedIfEmpty();
    })().catch((e) => {
      readyPromise = null;
      throw e;
    });
  }
  return readyPromise;
}

async function dropAll() {
  await pool.query(`DROP TABLE IF EXISTS ${TABLES.join(', ')} CASCADE`);
  readyPromise = null;
}

module.exports = { db, pool, now, ensureReady, dropAll };
