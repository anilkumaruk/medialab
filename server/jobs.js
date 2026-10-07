// Duration alerts: warn borrowers shortly before the due time and flag overdue kits to admins.
const config = require('./config');
const { db, now } = require('./db');
const { fmtDateTime } = require('./util');
const { notifyUser, notifyAdmins } = require('./notify');
const S = require('./services');

function runAlerts() {
  const t = now();
  const soon = new Date(Date.now() + config.dueSoonHours * 3600e3).toISOString();

  for (const r of S.listRequests("r.status = 'issued' AND r.due_soon_alerted_at IS NULL AND r.to_at > ? AND r.to_at <= ?", [t, soon])) {
    notifyUser(r.user.id, {
      title: `Duration alert: ${r.summary} is due soon`,
      body: `Return to the Media Lab by ${fmtDateTime(r.toAt)} or apply to renew in the portal.`,
      link: `/requests/${r.id}`,
    });
    db.prepare('UPDATE requests SET due_soon_alerted_at = ? WHERE id = ?').run(t, r.id);
  }

  for (const r of S.listRequests("r.status = 'issued' AND r.overdue_alerted_at IS NULL AND r.to_at <= ?", [t])) {
    notifyUser(r.user.id, {
      title: `Overdue: ${r.summary} (${r.code})`,
      body: `This equipment was due back at ${fmtDateTime(r.toAt)}. Return it to the Media Lab as soon as possible.`,
      link: `/requests/${r.id}`,
    });
    notifyAdmins({
      title: `Overdue return: ${r.code}`,
      body: `${r.user.name} (${r.user.phone}) has not returned ${r.equipmentList.join(', ')}. Due ${fmtDateTime(r.toAt)}.`,
      link: '/admin/returns',
    });
    db.prepare('UPDATE requests SET overdue_alerted_at = ? WHERE id = ?').run(t, r.id);
  }

  db.prepare('DELETE FROM captchas WHERE expires_at < ?').run(t);
  db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(t);
  db.prepare('DELETE FROM otps WHERE expires_at < ?').run(new Date(Date.now() - 864e5).toISOString());
}

function startJobs() {
  const tick = () => {
    try {
      runAlerts();
    } catch (e) {
      console.error('[jobs] alert run failed:', e);
    }
  };
  tick();
  setInterval(tick, 60e3).unref();
}

module.exports = { startJobs, runAlerts };
