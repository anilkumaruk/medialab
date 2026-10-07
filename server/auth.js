const crypto = require('crypto');
const config = require('./config');
const { db, now } = require('./db');
const { HttpError, sha256 } = require('./util');

const COOKIE = 'ml_session';

function readCookie(req, name) {
  const header = req.headers.cookie;
  if (!header) return null;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return null;
}

function createSession(res, userId) {
  const token = crypto.randomBytes(32).toString('base64url');
  const expires = new Date(Date.now() + config.sessionDays * 864e5);
  db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(now());
  db.prepare('INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)').run(sha256(token), userId, now(), expires.toISOString());
  res.cookie(COOKIE, token, { httpOnly: true, sameSite: 'lax', secure: config.isProd, expires, path: '/' });
}

function destroySession(req, res) {
  const token = readCookie(req, COOKIE);
  if (token) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha256(token));
  res.clearCookie(COOKIE, { path: '/' });
}

function publicUser(u) {
  return {
    id: u.id,
    name: u.name,
    email: u.email,
    phone: u.phone,
    profession: u.profession,
    batch: u.batch,
    department: u.department,
    school: u.school,
    role: u.role,
    approvalLevel: u.approval_level,
    createdAt: u.created_at,
  };
}

function loadUser(req, res, next) {
  const token = readCookie(req, COOKIE);
  if (token) {
    const row = db
      .prepare('SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ? AND s.expires_at > ? AND u.active = 1')
      .get(sha256(token), now());
    if (row) req.user = publicUser(row);
  }
  next();
}

const requireAuth = (req, res, next) => (req.user ? next() : next(new HttpError(401, 'Please log in')));

const requireAdmin = (req, res, next) => {
  if (!req.user) return next(new HttpError(401, 'Please log in'));
  if (req.user.role !== 'admin') return next(new HttpError(403, 'Admins only'));
  next();
};

module.exports = { createSession, destroySession, publicUser, loadUser, requireAuth, requireAdmin };
