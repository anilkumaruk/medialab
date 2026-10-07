const crypto = require('crypto');
const config = require('./config');

class HttpError extends Error {
  constructor(status, message, extra) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

const fail = (status, message, extra) => {
  throw new HttpError(status, message, extra);
};

const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');

const str = (v, max = 500) => (v == null ? '' : String(v)).trim().slice(0, max);

const isEmail = (e) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);

function emailDomainAllowed(email) {
  if (!config.allowedDomains.length) return true;
  const domain = String(email).split('@')[1]?.toLowerCase() || '';
  return config.allowedDomains.some((d) => domain === d || domain.endsWith('.' + d));
}

function normalizePhone(p) {
  let s = String(p || '').replace(/[\s\-()]/g, '');
  if (/^\d{10}$/.test(s)) s = config.defaultCountryCode + s;
  return /^\+\d{10,15}$/.test(s) ? s : null;
}

function parseDate(v) {
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

function intId(v) {
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) fail(400, 'Invalid id');
  return n;
}

const fmtDateTime = (iso) =>
  iso
    ? new Date(iso).toLocaleString('en-IN', {
        timeZone: config.timeZone,
        day: '2-digit',
        month: 'short',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        hour12: true,
      })
    : '-';

module.exports = { HttpError, fail, sha256, str, isEmail, emailDomainAllowed, normalizePhone, parseDate, intId, fmtDateTime };
