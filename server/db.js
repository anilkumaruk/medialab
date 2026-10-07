const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const config = require('./config');

fs.mkdirSync(config.dataDir, { recursive: true });
const dbFile = path.join(config.dataDir, 'medialab.db');
const db = new Database(dbFile);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.pragma('busy_timeout = 5000');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  phone TEXT NOT NULL,
  profession TEXT NOT NULL DEFAULT 'student',      -- student | faculty
  batch TEXT,
  department TEXT,
  school TEXT,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'user',               -- user | admin
  approval_level INTEGER NOT NULL DEFAULT 0,       -- 0 none, 1 = Level 1, 2 = Level 2
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
  id INTEGER PRIMARY KEY AUTOINCREMENT,
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

CREATE TABLE IF NOT EXISTS captchas (
  id TEXT PRIMARY KEY,
  answer TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS equipment (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  category TEXT NOT NULL,                           -- Cameras | Lenses | Lights | Audio | Accessories
  subtype TEXT NOT NULL DEFAULT '',
  code TEXT NOT NULL UNIQUE COLLATE NOCASE,         -- model code, e.g. CAM-014
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
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  equipment_id INTEGER NOT NULL REFERENCES equipment(id) ON DELETE CASCADE,
  barcode TEXT NOT NULL UNIQUE COLLATE NOCASE,
  status TEXT NOT NULL DEFAULT 'available',         -- available | in_use | maintenance | retired
  notes TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_units_eq ON units(equipment_id, status);

CREATE TABLE IF NOT EXISTS requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
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
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  request_id INTEGER NOT NULL REFERENCES requests(id) ON DELETE CASCADE,
  equipment_id INTEGER NOT NULL REFERENCES equipment(id),
  unit_id INTEGER REFERENCES units(id),
  return_ok INTEGER,
  damaged INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_items_request ON request_items(request_id);

CREATE TABLE IF NOT EXISTS notify_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  equipment_id INTEGER NOT NULL REFERENCES equipment(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  notified_at TEXT
);

CREATE TABLE IF NOT EXISTS notifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  link TEXT,
  read_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id, read_at);

CREATE TABLE IF NOT EXISTS logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL,
  actor_id INTEGER REFERENCES users(id),
  subject_user_id INTEGER REFERENCES users(id),
  request_id INTEGER REFERENCES requests(id),
  equipment TEXT NOT NULL DEFAULT '',
  action TEXT NOT NULL,
  approved_by TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT '',
  details TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_logs_at ON logs(at);
`);

const now = () => new Date().toISOString();

module.exports = { db, now, dbFile };
