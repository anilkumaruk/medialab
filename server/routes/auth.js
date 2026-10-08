const express = require('express');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const config = require('../config');
const { db, now } = require('../db');
const { fail, str, sha256, isEmail, emailDomainAllowed, normalizePhone } = require('../util');
const { createSession, destroySession, publicUser } = require('../auth');
const { sendEmail, sendSms, addLog } = require('../notify');

const router = express.Router();

const OTP_TTL_MS = 10 * 60e3;
const OTP_RESEND_S = 30;
const OTP_MAX_ATTEMPTS = 5;
const CAPTCHA_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const loginFailures = new Map(); // email -> { count, until }

router.get('/config', (req, res) => {
  res.json({
    allowedDomains: config.allowedDomains,
    devMode: config.devShowOtp,
    phoneOtp: config.phoneOtpRequired,
    maxRequestDays: config.maxRequestDays,
  });
});

router.get('/me', (req, res) => res.json({ user: req.user || null }));

// ---------------- Captcha ----------------

function captchaSvg(text) {
  const W = 168, H = 48;
  const r = (a, b) => a + Math.random() * (b - a);
  let s = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}"><rect width="${W}" height="${H}" rx="8" fill="#EEF2F8"/>`;
  for (let i = 0; i < 6; i++) {
    s += `<path d="M${r(0, W).toFixed(0)} ${r(0, H).toFixed(0)} Q${r(0, W).toFixed(0)} ${r(0, H).toFixed(0)} ${r(0, W).toFixed(0)} ${r(0, H).toFixed(0)}" stroke="hsl(${r(200, 240) | 0},40%,${r(55, 75) | 0}%)" stroke-width="${r(1, 2).toFixed(1)}" fill="none"/>`;
  }
  [...text].forEach((ch, i) => {
    const x = (16 + i * 25 + r(-2, 2)).toFixed(1);
    const y = (32 + r(-4, 4)).toFixed(1);
    s += `<text x="${x}" y="${y}" transform="rotate(${r(-22, 22).toFixed(1)} ${x} ${y})" font-family="Menlo,Consolas,monospace" font-size="${r(22, 27).toFixed(0)}" font-weight="700" fill="hsl(${r(210, 230) | 0},${r(40, 70) | 0}%,${r(18, 35) | 0}%)">${ch}</text>`;
  });
  for (let i = 0; i < 30; i++) s += `<circle cx="${r(0, W).toFixed(1)}" cy="${r(0, H).toFixed(1)}" r="${r(0.5, 1.4).toFixed(1)}" fill="#94A3B8"/>`;
  return s + '</svg>';
}

router.get('/captcha', async (req, res) => {
  await db.run('DELETE FROM captchas WHERE expires_at < ?', [now()]);
  const text = Array.from({ length: 6 }, () => CAPTCHA_CHARS[crypto.randomInt(CAPTCHA_CHARS.length)]).join('');
  const id = crypto.randomBytes(16).toString('hex');
  await db.run('INSERT INTO captchas (id, answer, expires_at) VALUES (?, ?, ?)', [id, text, new Date(Date.now() + 10 * 60e3).toISOString()]);
  res.set('Cache-Control', 'no-store').json({ id, image: 'data:image/svg+xml;base64,' + Buffer.from(captchaSvg(text)).toString('base64') });
});

// ---------------- OTP ----------------

const otpHash = (target, code) => sha256(`${target}:${code}`);

router.post('/otp', async (req, res) => {
  const b = req.body;
  const channel = b.channel;
  const purpose = b.purpose || 'register';
  if (!['email', 'phone'].includes(channel)) fail(400, 'Invalid channel');
  if (!['register', 'reset'].includes(purpose)) fail(400, 'Invalid purpose');

  let target;
  if (channel === 'email') {
    target = str(b.target, 200).toLowerCase();
    if (!isEmail(target)) fail(400, 'Enter a valid email address', { field: 'email' });
  } else {
    target = normalizePhone(b.target);
    if (!target) fail(400, 'Enter a valid phone number', { field: 'phone' });
  }

  let deliver = true;
  if (purpose === 'register') {
    if (channel === 'email') {
      if (!emailDomainAllowed(target)) fail(400, `Use your institution email (@${config.allowedDomains[0]})`, { field: 'email' });
      if (await db.get('SELECT 1 FROM users WHERE email = ?', [target])) fail(409, 'An account with this email already exists. Log in instead.', { field: 'email' });
    }
  } else {
    if (channel !== 'email') fail(400, 'Password reset codes are sent by email');
    // Don't reveal whether the account exists.
    deliver = !!(await db.get('SELECT 1 FROM users WHERE email = ? AND active = 1', [target]));
  }

  const last = await db.get('SELECT created_at FROM otps WHERE channel = ? AND target = ? AND purpose = ? ORDER BY id DESC LIMIT 1', [channel, target, purpose]);
  if (last) {
    const wait = Math.ceil(OTP_RESEND_S - (Date.now() - Date.parse(last.created_at)) / 1000);
    if (wait > 0) fail(429, `Please wait ${wait}s before requesting another code`, { retryAfter: wait });
  }

  const code = String(crypto.randomInt(0, 1e6)).padStart(6, '0');
  await db.run('INSERT INTO otps (channel, target, purpose, code_hash, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)', [
    channel, target, purpose, otpHash(target, code), now(), new Date(Date.now() + OTP_TTL_MS).toISOString(),
  ]);

  if (deliver) {
    const text = `Your MediaLab ${purpose === 'reset' ? 'password reset' : 'verification'} code is ${code}. It expires in 10 minutes.`;
    if (channel === 'email') {
      const sent = await sendEmail(target, 'Your MediaLab verification code', text);
      if (!sent.ok) fail(502, 'We could not send the email right now. Please try again shortly or contact the Media Lab.');
    }
    else await sendSms(target, text);
  }

  // Demo mode may show registration codes, but never password-reset codes:
  // that would let anyone reset any account's password.
  const showCode = config.devShowOtp && deliver && purpose === 'register';
  res.json({ ok: true, resendIn: OTP_RESEND_S, ...(showCode ? { devCode: code } : {}) });
});

async function findValidOtp(channel, target, purpose, code) {
  const label = channel === 'email' ? 'Email' : 'Phone';
  const field = channel + 'Otp';
  const row = await db.get(
    'SELECT * FROM otps WHERE channel = ? AND target = ? AND purpose = ? AND consumed_at IS NULL ORDER BY id DESC LIMIT 1',
    [channel, target, purpose]
  );
  if (!row || row.expires_at < now()) fail(400, `${label} code has expired or was not requested. Send a new code.`, { field });
  if (row.attempts >= OTP_MAX_ATTEMPTS) fail(429, `Too many wrong ${label.toLowerCase()} codes. Send a new code.`, { field });
  if (!/^\d{6}$/.test(code) || otpHash(target, code) !== row.code_hash) {
    await db.run('UPDATE otps SET attempts = attempts + 1 WHERE id = ?', [row.id]);
    fail(400, `${label} code is incorrect`, { field });
  }
  return row.id;
}

const consumeOtps = (t, ids) => t.run('UPDATE otps SET consumed_at = ? WHERE id = ANY(?)', [now(), ids]);

// ---------------- Register / login ----------------

router.post('/register', async (req, res) => {
  const b = req.body;
  const name = str(b.name, 80);
  const email = str(b.email, 200).toLowerCase();
  const phone = normalizePhone(b.phone);
  const profession = b.profession === 'faculty' ? 'faculty' : 'student';
  const batch = str(b.batch, 20);
  const department = str(b.department, 80);
  const school = str(b.school, 120);
  const password = String(b.password || '');

  if (name.length < 2) fail(400, 'Enter your full name', { field: 'name' });
  if (!phone) fail(400, 'Enter a valid phone number', { field: 'phone' });
  if (!isEmail(email)) fail(400, 'Enter a valid email address', { field: 'email' });
  if (!emailDomainAllowed(email)) fail(400, `Use your institution email (@${config.allowedDomains[0]})`, { field: 'email' });
  if (profession === 'student' && !batch) fail(400, 'Enter your batch', { field: 'batch' });
  if (!department) fail(400, 'Enter your department', { field: 'department' });
  if (!school) fail(400, 'Enter your school', { field: 'school' });
  if (password.length < 8) fail(400, 'Password must be at least 8 characters', { field: 'password' });
  if (password !== String(b.confirmPassword || '')) fail(400, 'Passwords do not match', { field: 'confirmPassword' });
  if (b.acceptTerms !== true) fail(400, 'Accept the Terms & Equipment Damage Policy to continue', { field: 'acceptTerms' });
  if (await db.get('SELECT 1 FROM users WHERE email = ?', [email])) fail(409, 'An account with this email already exists', { field: 'email' });

  const emailOtpId = await findValidOtp('email', email, 'register', str(b.emailOtp, 6));
  const phoneOtpId = config.phoneOtpRequired ? await findValidOtp('phone', phone, 'register', str(b.phoneOtp, 6)) : null;

  const t = now();
  const hash = await bcrypt.hash(password, 10);
  const user = await db.tx(async (tx) => {
    await consumeOtps(tx, [emailOtpId, phoneOtpId].filter(Boolean));
    return tx.get(
      `INSERT INTO users (name, email, phone, profession, batch, department, school, password_hash,
         email_verified, phone_verified, terms_accepted_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?) RETURNING *`,
      [name, email, phone, profession, profession === 'student' ? batch : null, department, school, hash, phoneOtpId ? 1 : 0, t, t]
    );
  });

  await addLog({ actorId: user.id, subjectUserId: user.id, action: 'Account created', status: 'ACTIVE' });
  await createSession(res, user.id);
  res.status(201).json({ user: publicUser(user) });
});

router.post('/login', async (req, res) => {
  const email = str(req.body.email, 200).toLowerCase();
  const password = String(req.body.password || '');

  const cap = await db.get('DELETE FROM captchas WHERE id = ? RETURNING *', [str(req.body.captchaId, 64)]);
  const answer = str(req.body.captcha, 12).replace(/\s/g, '').toUpperCase();
  if (!cap || cap.expires_at < now() || cap.answer !== answer) fail(400, 'Captcha did not match. Try the new one.', { field: 'captcha' });

  const lock = loginFailures.get(email);
  if (lock?.until > Date.now()) fail(429, 'Too many failed attempts. Try again in a few minutes.');

  const user = await db.get('SELECT * FROM users WHERE email = ?', [email]);
  if (!user || !(await bcrypt.compare(password, user.password_hash))) {
    const f = loginFailures.get(email) || { count: 0, until: 0 };
    f.count += 1;
    if (f.count >= 5) Object.assign(f, { count: 0, until: Date.now() + 5 * 60e3 });
    loginFailures.set(email, f);
    fail(401, 'Incorrect email or password');
  }
  if (!user.active) fail(403, 'This account is disabled. Contact the Media Lab.');

  loginFailures.delete(email);
  await createSession(res, user.id);
  res.json({ user: publicUser(user) });
});

router.post('/logout', async (req, res) => {
  await destroySession(req, res);
  res.json({ ok: true });
});

router.post('/reset', async (req, res) => {
  const email = str(req.body.email, 200).toLowerCase();
  const password = String(req.body.password || '');
  if (!isEmail(email)) fail(400, 'Enter a valid email address', { field: 'email' });
  if (password.length < 8) fail(400, 'Password must be at least 8 characters', { field: 'password' });
  if (password !== String(req.body.confirmPassword || '')) fail(400, 'Passwords do not match', { field: 'confirmPassword' });
  const otpId = await findValidOtp('email', email, 'reset', str(req.body.otp, 6));
  const user = await db.get('SELECT id FROM users WHERE email = ? AND active = 1', [email]);
  if (!user) fail(400, 'Email code is incorrect', { field: 'emailOtp' });
  const hash = await bcrypt.hash(password, 10);
  await db.tx(async (tx) => {
    await consumeOtps(tx, [otpId]);
    await tx.run('UPDATE users SET password_hash = ? WHERE id = ?', [hash, user.id]);
    await tx.run('DELETE FROM sessions WHERE user_id = ?', [user.id]);
  });
  await addLog({ actorId: user.id, subjectUserId: user.id, action: 'Password reset' });
  res.json({ ok: true });
});

module.exports = router;
