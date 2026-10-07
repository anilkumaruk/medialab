// Duration alerts: warn borrowers shortly before the due time and flag overdue kits to admins.
// Runs every minute locally; on Vercel it runs from the daily cron and, at most once a minute,
// whenever someone loads alerts/notifications/dashboard (see maybeRunAlerts).
const config = require('./config');
const { db, now } = require('./db');
const { fmtDateTime } = require('./util');
const { notifyUser, notifyAdmins } = require('./notify');

async function runAlerts() {
  const S = require('./services');
  const t = now();
  const soon = new Date(Date.now() + config.dueSoonHours * 3600e3).toISOString();

  for (const r of await S.listRequests("r.status = 'issued' AND r.due_soon_alerted_at IS NULL AND r.to_at > ? AND r.to_at <= ?", [t, soon])) {
    const claimed = await db.run('UPDATE requests SET due_soon_alerted_at = ? WHERE id = ? AND due_soon_alerted_at IS NULL', [t, r.id]);
    if (!claimed.changes) continue;
    await notifyUser(r.user.id, {
      title: `Duration alert: ${r.summary} is due soon`,
      body: `Return to the Media Lab by ${fmtDateTime(r.toAt)} or apply to renew in the portal.`,
      link: `/requests/${r.id}`,
    });
  }

  for (const r of await S.listRequests("r.status = 'issued' AND r.overdue_alerted_at IS NULL AND r.to_at <= ?", [t])) {
    const claimed = await db.run('UPDATE requests SET overdue_alerted_at = ? WHERE id = ? AND overdue_alerted_at IS NULL', [t, r.id]);
    if (!claimed.changes) continue;
    await notifyUser(r.user.id, {
      title: `Overdue: ${r.summary} (${r.code})`,
      body: `This equipment was due back at ${fmtDateTime(r.toAt)}. Return it to the Media Lab as soon as possible.`,
      link: `/requests/${r.id}`,
    });
    await notifyAdmins({
      title: `Overdue return: ${r.code}`,
      body: `${r.user.name} (${r.user.phone}) has not returned ${r.equipmentList.join(', ')}. Due ${fmtDateTime(r.toAt)}.`,
      link: '/admin/returns',
    });
  }

  await db.run('DELETE FROM captchas WHERE expires_at < ?', [t]);
  await db.run('DELETE FROM sessions WHERE expires_at < ?', [t]);
  await db.run('DELETE FROM otps WHERE expires_at < ?', [new Date(Date.now() - 864e5).toISOString()]);
}

// Runs the alert pass if no instance has run it in the last minute.
async function maybeRunAlerts() {
  const t = new Date();
  const claimed = await db.get(
    `INSERT INTO meta (key, value) VALUES ('alerts_run', ?)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value WHERE meta.value < ?
     RETURNING key`,
    [t.toISOString(), new Date(t - 60e3).toISOString()]
  );
  if (!claimed) return;
  try {
    await runAlerts();
  } catch (e) {
    console.error('[jobs] alert run failed:', e);
  }
}

function startJobs() {
  const tick = () => runAlerts().catch((e) => console.error('[jobs] alert run failed:', e));
  tick();
  setInterval(tick, 60e3).unref();
}

module.exports = { startJobs, runAlerts, maybeRunAlerts };
