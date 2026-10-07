const config = require('./config');
const { db, now } = require('./db');

let transporter = null;
if (config.smtp.host) {
  const nodemailer = require('nodemailer');
  transporter = nodemailer.createTransport({
    host: config.smtp.host,
    port: config.smtp.port,
    secure: config.smtp.port === 465,
    auth: config.smtp.user ? { user: config.smtp.user, pass: config.smtp.pass } : undefined,
  });
}

const escapeHtml = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

function emailHtml(title, text, link) {
  return `<div style="font-family:Inter,Helvetica,Arial,sans-serif;background:#F3F6FB;padding:24px">
  <div style="max-width:560px;margin:auto;background:#fff;border:1px solid #E2E8F0;border-radius:12px;overflow:hidden">
    <div style="background:#121F38;color:#fff;padding:16px 24px;font-weight:700;font-size:18px">MediaLab</div>
    <div style="padding:24px;color:#121F38">
      <h2 style="margin:0 0 12px;font-size:18px">${escapeHtml(title)}</h2>
      <div style="white-space:pre-line;font-size:14px;line-height:1.6;color:#334155">${escapeHtml(text)}</div>
      ${link ? `<p style="margin-top:20px"><a href="${escapeHtml(link)}" style="background:#2563EB;color:#fff;padding:10px 18px;border-radius:8px;text-decoration:none;font-weight:600">Open in MediaLab</a></p>` : ''}
    </div>
  </div></div>`;
}

async function sendEmail(to, subject, text, link) {
  if (!to) return;
  if (!transporter) {
    console.log(`\n[email -> ${to}] ${subject}\n${text}${link ? `\n${link}` : ''}\n`);
    return;
  }
  try {
    await transporter.sendMail({
      from: config.mailFrom,
      to,
      subject,
      text: link ? `${text}\n\n${link}` : text,
      html: emailHtml(subject, text, link),
    });
  } catch (e) {
    console.error('[email] failed:', e.message);
  }
}

async function sendSms(to, text) {
  const t = config.twilio;
  if (!t.sid) {
    console.log(`\n[sms -> ${to}] ${text}\n`);
    return;
  }
  try {
    const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${t.sid}/Messages.json`, {
      method: 'POST',
      headers: {
        Authorization: 'Basic ' + Buffer.from(`${t.sid}:${t.token}`).toString('base64'),
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({ To: to, From: t.from, Body: text }),
    });
    if (!res.ok) console.error('[sms] failed:', res.status, await res.text());
  } catch (e) {
    console.error('[sms] failed:', e.message);
  }
}

// In-app notification + email. `link` is an in-app route such as /requests/12.
function notifyUser(userId, { title, body = '', link = null, email = true }) {
  db.prepare('INSERT INTO notifications (user_id, title, body, link, created_at) VALUES (?, ?, ?, ?, ?)').run(userId, title, body, link, now());
  if (email) {
    const u = db.prepare('SELECT email FROM users WHERE id = ?').get(userId);
    if (u) sendEmail(u.email, title, body, link ? `${config.appUrl}/#${link}` : null);
  }
}

function notifyAdmins({ level = null, ...msg }) {
  const rows = level
    ? db.prepare("SELECT id FROM users WHERE role = 'admin' AND active = 1 AND approval_level = ?").all(level)
    : db.prepare("SELECT id FROM users WHERE role = 'admin' AND active = 1").all();
  for (const r of rows) notifyUser(r.id, msg);
}

function addLog({ actorId = null, subjectUserId = null, requestId = null, equipment = '', action, approvedBy = '', status = '', details = '' }) {
  db.prepare(
    `INSERT INTO logs (at, actor_id, subject_user_id, request_id, equipment, action, approved_by, status, details)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(now(), actorId, subjectUserId, requestId, equipment, action, approvedBy, status, details);
}

module.exports = { sendEmail, sendSms, notifyUser, notifyAdmins, addLog };
