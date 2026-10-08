const express = require('express');
const config = require('../config');
const { db, now } = require('../db');
const { fail, str, parseDate, intId, fmtDateTime } = require('../util');
const { requireAuth } = require('../auth');
const { notifyAdmins, addLog } = require('../notify');
const { maybeRunAlerts } = require('../jobs');
const S = require('../services');

const router = express.Router();
router.use(requireAuth);

router.get('/approvers', async (req, res) => {
  res.json({ l1: await S.approverNames(1), l2: await S.approverNames(2) });
});

// ---------------- Inventory ----------------

router.get('/equipment', async (req, res) => {
  const category = S.CATEGORIES.includes(req.query.category) ? req.query.category : null;
  res.json({ equipment: await S.listEquipment({ category, q: str(req.query.q, 80) || null, userId: req.user.id }) });
});

router.get('/equipment/:id', async (req, res) => {
  const e = await S.getEquipment(intId(req.params.id), req.user.id);
  if (!e || !e.active) fail(404, 'Equipment not found');
  res.json({ equipment: e, accessories: await S.accessoriesOf(e.id, req.user.id) });
});

router.post('/equipment/:id/notify', async (req, res) => {
  const e = await S.getEquipment(intId(req.params.id));
  if (!e) fail(404, 'Equipment not found');
  const exists = await db.get('SELECT 1 FROM notify_requests WHERE user_id = ? AND equipment_id = ? AND notified_at IS NULL', [req.user.id, e.id]);
  if (!exists) await db.run('INSERT INTO notify_requests (user_id, equipment_id, created_at) VALUES (?, ?, ?)', [req.user.id, e.id, now()]);
  res.json({ ok: true });
});

router.delete('/equipment/:id/notify', async (req, res) => {
  await db.run('DELETE FROM notify_requests WHERE user_id = ? AND equipment_id = ? AND notified_at IS NULL', [req.user.id, intId(req.params.id)]);
  res.json({ ok: true });
});

// ---------------- Requests ----------------

async function ownRequest(req) {
  const r = await S.getRequest(intId(req.params.id));
  if (!r || (r.user.id !== req.user.id && req.user.role !== 'admin')) fail(404, 'Request not found');
  return r;
}

router.get('/requests/mine', async (req, res) => {
  const requests = await S.listRequests('r.user_id = ?', [req.user.id]);
  const by = (...st) => requests.filter((r) => st.includes(r.status)).length;
  res.json({
    requests,
    counts: {
      active: by('approved', 'issued'),
      pending: by('pending_l1', 'pending_l2'),
      rejected: by('rejected'),
      returned: by('returned'),
      drafts: by('draft'),
    },
  });
});

router.get('/requests/:id', async (req, res) => res.json({ request: await ownRequest(req) }));

// Create or update a draft; with submit=true it goes to Level 1 approval.
router.post('/requests', async (req, res) => {
  const b = req.body;
  const submit = b.submit === true;

  const qtyBy = new Map();
  for (const it of Array.isArray(b.items) ? b.items : []) {
    const id = Number(it?.equipmentId);
    const q = Number(it?.qty ?? 1);
    if (!Number.isInteger(id) || id <= 0 || !Number.isInteger(q) || q < 1 || q > 10) fail(400, 'Invalid equipment selection');
    qtyBy.set(id, (qtyBy.get(id) || 0) + q);
  }
  if (!qtyBy.size) fail(400, 'Add at least one item to your request');
  if ([...qtyBy.values()].reduce((a, n) => a + n, 0) > 20) fail(400, 'A request can include at most 20 items');

  const equipment = [];
  for (const id of qtyBy.keys()) {
    const e = await S.getEquipment(id);
    if (!e || !e.active) fail(400, 'Some selected equipment is no longer offered');
    equipment.push(e);
  }

  const from = parseDate(b.fromAt);
  const to = parseDate(b.toAt);
  if ((b.fromAt && !from) || (b.toAt && !to)) fail(400, 'Invalid date');
  const purpose = str(b.purpose, 500);

  if (submit) {
    if (!from || !to) fail(400, 'Choose both a start and an end date & time', { field: 'dates' });
    if (to <= from) fail(400, 'The return time must be after the pickup time', { field: 'dates' });
    if (from.getTime() < Date.now() - 15 * 60e3) fail(400, 'The pickup time cannot be in the past', { field: 'dates' });
    if (to - from > config.maxRequestDays * 864e5) fail(400, `Requests can be for at most ${config.maxRequestDays} days`, { field: 'dates' });
    if (purpose.length < 5) fail(400, 'Describe the purpose of this request', { field: 'purpose' });
    for (const e of equipment) {
      const want = qtyBy.get(e.id);
      if (want > e.available) fail(409, e.available === 0 ? `${e.name} is not available right now` : `Only ${e.available} x ${e.name} available right now`);
    }
  }

  let existing = null;
  if (b.id) {
    existing = await db.get('SELECT * FROM requests WHERE id = ?', [intId(b.id)]);
    if (!existing || existing.user_id !== req.user.id) fail(404, 'Request not found');
    if (existing.status !== 'draft') fail(409, 'Only drafts can be edited');
  }

  const t = now();
  const fromIso = from?.toISOString() ?? null;
  const toIso = to?.toISOString() ?? null;
  const id = await db.tx(async (tx) => {
    let rid;
    if (existing) {
      rid = existing.id;
      await tx.run('UPDATE requests SET from_at = ?, to_at = ?, purpose = ?, updated_at = ? WHERE id = ?', [fromIso, toIso, purpose, t, rid]);
      await tx.run('DELETE FROM request_items WHERE request_id = ?', [rid]);
    } else {
      rid = (
        await tx.get(
          "INSERT INTO requests (user_id, from_at, to_at, purpose, status, created_at, updated_at) VALUES (?, ?, ?, ?, 'draft', ?, ?) RETURNING id",
          [req.user.id, fromIso, toIso, purpose, t, t]
        )
      ).id;
      await tx.run('UPDATE requests SET code = ? WHERE id = ?', [`REQ-${1000 + rid}`, rid]);
    }
    const eqIds = [];
    for (const [eid, q] of qtyBy) for (let i = 0; i < q; i++) eqIds.push(eid);
    await tx.run('INSERT INTO request_items (request_id, equipment_id) SELECT ?, unnest(?::int[])', [rid, eqIds]);
    if (submit) await tx.run("UPDATE requests SET status = 'pending_l1', submitted_at = ? WHERE id = ?", [t, rid]);
    return rid;
  });

  const r = await S.getRequest(id);
  if (submit) {
    await addLog({ actorId: req.user.id, subjectUserId: req.user.id, requestId: id, equipment: r.equipmentList.join(', '), action: 'Requested', status: 'PENDING L1' });
    const l1Names = (await S.approverNames(1)).join(' / ');
    await Promise.all([
      notifyAdmins({
        level: 1,
        title: `New equipment request ${r.code} from ${r.user.name}`,
        body: `${S.requestDetailsText(r)}\n\nPlease accept or reject this request (remarks are compulsory at Level 1).`,
        link: `/admin/approvals/${id}`,
      }),
      notifyAdmins({
        level: 2,
        title: `New equipment request ${r.code} from ${r.user.name} (for your information)`,
        body: `${S.requestDetailsText(r)}\n\nThis request is now with Level 1 (${l1Names}). You will get another email when it is ready for your final approval.`,
        link: `/admin/approvals/${id}?all=1`,
      }),
    ]);
  }
  res.status(existing ? 200 : 201).json({ request: r });
});

router.post('/requests/:id/cancel', async (req, res) => {
  const r = await ownRequest(req);
  if (r.user.id !== req.user.id) fail(403, 'You can only cancel your own requests');
  if (!['draft', 'pending_l1', 'pending_l2', 'approved'].includes(r.status)) fail(409, 'This request can no longer be cancelled');
  await db.run("UPDATE requests SET status = 'cancelled', cancelled_at = ?, updated_at = ? WHERE id = ?", [now(), now(), r.id]);
  if (r.status !== 'draft') {
    await addLog({ actorId: req.user.id, subjectUserId: req.user.id, requestId: r.id, equipment: r.equipmentList.join(', '), action: 'Cancelled by requester', status: 'CANCELLED' });
  }
  res.json({ request: await S.getRequest(r.id) });
});

router.delete('/requests/:id', async (req, res) => {
  const r = await ownRequest(req);
  if (r.user.id !== req.user.id || r.status !== 'draft') fail(409, 'Only your drafts can be deleted');
  await db.run('DELETE FROM requests WHERE id = ?', [r.id]);
  res.json({ ok: true });
});

router.post('/requests/:id/renew', async (req, res) => {
  const r = await ownRequest(req);
  if (r.user.id !== req.user.id) fail(403, 'You can only renew your own requests');
  if (r.status !== 'issued') fail(409, 'Only equipment currently with you can be renewed');
  if (r.renewal?.status === 'pending') fail(409, 'A renewal is already awaiting approval');
  const renewTo = parseDate(req.body.renewTo);
  const reason = str(req.body.reason, 300);
  if (!renewTo || renewTo.toISOString() <= r.toAt) fail(400, 'Choose a new return time after the current due time', { field: 'renewTo' });
  if (renewTo - new Date(r.fromAt) > config.maxRequestDays * 2 * 864e5) fail(400, 'That extension is too long. Return the kit and submit a new request.');
  if (reason.length < 3) fail(400, 'Give a reason for the renewal', { field: 'reason' });
  await db.run(
    "UPDATE requests SET renew_to = ?, renew_reason = ?, renew_status = 'pending', renew_by = NULL, renew_at = NULL, renew_remarks = NULL, updated_at = ? WHERE id = ?",
    [renewTo.toISOString(), reason, now(), r.id]
  );
  await addLog({ actorId: req.user.id, subjectUserId: req.user.id, requestId: r.id, equipment: r.equipmentList.join(', '), action: 'Renewal requested', status: 'IN USE', details: `Until ${fmtDateTime(renewTo.toISOString())}` });
  await notifyAdmins({
    level: 1,
    title: `Renewal request for ${r.code}`,
    body: `${r.user.name} asked to keep ${r.equipmentList.join(', ')} until ${fmtDateTime(renewTo.toISOString())}.\nReason: ${reason}`,
    link: `/admin/approvals/${r.id}`,
  });
  res.json({ request: await S.getRequest(r.id) });
});

router.post('/requests/:id/dismiss', async (req, res) => {
  const r = await ownRequest(req);
  if (r.status === 'issued') await db.run('UPDATE requests SET alert_dismissed_at = ? WHERE id = ?', [now(), r.id]);
  else if (r.status === 'returned') await db.run('UPDATE requests SET return_ack_at = ? WHERE id = ?', [now(), r.id]);
  res.json({ ok: true });
});

// Duration alerts: due within N hours (or overdue) and recently verified returns.
router.get('/alerts', async (req, res) => {
  await maybeRunAlerts();
  const t = now();
  const soon = new Date(Date.now() + config.dueSoonHours * 3600e3).toISOString();
  const due = await S.listRequests(
    `r.user_id = ? AND r.status = 'issued' AND r.to_at <= ?
     AND (r.alert_dismissed_at IS NULL OR (r.to_at < ? AND r.alert_dismissed_at < r.to_at))`,
    [req.user.id, soon, t],
    'r.to_at ASC'
  );
  const returned = await S.listRequests(
    "r.user_id = ? AND r.status = 'returned' AND r.return_ack_at IS NULL AND r.returned_at > ?",
    [req.user.id, new Date(Date.now() - 3 * 864e5).toISOString()],
    'r.returned_at DESC',
    5
  );
  res.json({ due, returned });
});

// ---------------- Notifications ----------------

router.get('/notifications', async (req, res) => {
  await maybeRunAlerts();
  const items = await db.all('SELECT * FROM notifications WHERE user_id = ? ORDER BY id DESC LIMIT 30', [req.user.id]);
  const { c: unread } = await db.get('SELECT COUNT(*) AS c FROM notifications WHERE user_id = ? AND read_at IS NULL', [req.user.id]);
  res.json({
    unread,
    notifications: items.map((n) => ({ id: n.id, title: n.title, body: n.body, link: n.link, read: !!n.read_at, createdAt: n.created_at })),
  });
});

router.post('/notifications/read', async (req, res) => {
  await db.run('UPDATE notifications SET read_at = ? WHERE user_id = ? AND read_at IS NULL', [now(), req.user.id]);
  res.json({ ok: true });
});

module.exports = router;
