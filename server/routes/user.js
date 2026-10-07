const express = require('express');
const config = require('../config');
const { db, now } = require('../db');
const { fail, str, parseDate, intId, fmtDateTime } = require('../util');
const { requireAuth } = require('../auth');
const { notifyAdmins, addLog } = require('../notify');
const S = require('../services');

const router = express.Router();
router.use(requireAuth);

router.get('/approvers', (req, res) => {
  res.json({ l1: S.approverNames(1), l2: S.approverNames(2) });
});

// ---------------- Inventory ----------------

router.get('/equipment', (req, res) => {
  const category = S.CATEGORIES.includes(req.query.category) ? req.query.category : null;
  res.json({ equipment: S.listEquipment({ category, q: str(req.query.q, 80) || null, userId: req.user.id }) });
});

router.get('/equipment/:id', (req, res) => {
  const e = S.getEquipment(intId(req.params.id), req.user.id);
  if (!e || !e.active) fail(404, 'Equipment not found');
  res.json({ equipment: e, accessories: S.accessoriesOf(e.id, req.user.id) });
});

router.post('/equipment/:id/notify', (req, res) => {
  const e = S.getEquipment(intId(req.params.id));
  if (!e) fail(404, 'Equipment not found');
  const exists = db.prepare('SELECT 1 FROM notify_requests WHERE user_id = ? AND equipment_id = ? AND notified_at IS NULL').get(req.user.id, e.id);
  if (!exists) db.prepare('INSERT INTO notify_requests (user_id, equipment_id, created_at) VALUES (?, ?, ?)').run(req.user.id, e.id, now());
  res.json({ ok: true });
});

router.delete('/equipment/:id/notify', (req, res) => {
  db.prepare('DELETE FROM notify_requests WHERE user_id = ? AND equipment_id = ? AND notified_at IS NULL').run(req.user.id, intId(req.params.id));
  res.json({ ok: true });
});

// ---------------- Requests ----------------

function ownRequest(req) {
  const r = S.getRequest(intId(req.params.id));
  if (!r || (r.user.id !== req.user.id && req.user.role !== 'admin')) fail(404, 'Request not found');
  return r;
}

router.get('/requests/mine', (req, res) => {
  const requests = S.listRequests('r.user_id = ?', [req.user.id]);
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

router.get('/requests/:id', (req, res) => res.json({ request: ownRequest(req) }));

// Create or update a draft; with submit=true it goes to Level 1 approval.
router.post('/requests', (req, res) => {
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

  const equipment = [...qtyBy.keys()].map((id) => {
    const e = S.getEquipment(id);
    if (!e || !e.active) fail(400, 'Some selected equipment is no longer offered');
    return e;
  });

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
    existing = db.prepare('SELECT * FROM requests WHERE id = ?').get(intId(b.id));
    if (!existing || existing.user_id !== req.user.id) fail(404, 'Request not found');
    if (existing.status !== 'draft') fail(409, 'Only drafts can be edited');
  }

  const t = now();
  const id = db.transaction(() => {
    let rid;
    if (existing) {
      rid = existing.id;
      db.prepare('UPDATE requests SET from_at = ?, to_at = ?, purpose = ?, updated_at = ? WHERE id = ?').run(
        from?.toISOString() ?? null, to?.toISOString() ?? null, purpose, t, rid
      );
      db.prepare('DELETE FROM request_items WHERE request_id = ?').run(rid);
    } else {
      rid = Number(
        db.prepare("INSERT INTO requests (user_id, from_at, to_at, purpose, status, created_at, updated_at) VALUES (?, ?, ?, ?, 'draft', ?, ?)")
          .run(req.user.id, from?.toISOString() ?? null, to?.toISOString() ?? null, purpose, t, t).lastInsertRowid
      );
      db.prepare('UPDATE requests SET code = ? WHERE id = ?').run(`REQ-${1000 + rid}`, rid);
    }
    const ins = db.prepare('INSERT INTO request_items (request_id, equipment_id) VALUES (?, ?)');
    for (const [eid, q] of qtyBy) for (let i = 0; i < q; i++) ins.run(rid, eid);
    if (submit) db.prepare("UPDATE requests SET status = 'pending_l1', submitted_at = ? WHERE id = ?").run(t, rid);
    return rid;
  })();

  const r = S.getRequest(id);
  if (submit) {
    addLog({ actorId: req.user.id, subjectUserId: req.user.id, requestId: id, equipment: r.equipmentList.join(', '), action: 'Requested', status: 'PENDING L1' });
    notifyAdmins({
      level: 1,
      title: `New equipment request ${r.code} from ${r.user.name}`,
      body: `${S.requestDetailsText(r)}\n\nPlease accept or reject this request (remarks are compulsory at Level 1).`,
      link: `/admin/approvals/${id}`,
    });
  }
  res.status(existing ? 200 : 201).json({ request: r });
});

router.post('/requests/:id/cancel', (req, res) => {
  const r = ownRequest(req);
  if (r.user.id !== req.user.id) fail(403, 'You can only cancel your own requests');
  if (!['draft', 'pending_l1', 'pending_l2', 'approved'].includes(r.status)) fail(409, 'This request can no longer be cancelled');
  db.prepare("UPDATE requests SET status = 'cancelled', cancelled_at = ?, updated_at = ? WHERE id = ?").run(now(), now(), r.id);
  if (r.status !== 'draft') {
    addLog({ actorId: req.user.id, subjectUserId: req.user.id, requestId: r.id, equipment: r.equipmentList.join(', '), action: 'Cancelled by requester', status: 'CANCELLED' });
  }
  res.json({ request: S.getRequest(r.id) });
});

router.delete('/requests/:id', (req, res) => {
  const r = ownRequest(req);
  if (r.user.id !== req.user.id || r.status !== 'draft') fail(409, 'Only your drafts can be deleted');
  db.prepare('DELETE FROM requests WHERE id = ?').run(r.id);
  res.json({ ok: true });
});

router.post('/requests/:id/renew', (req, res) => {
  const r = ownRequest(req);
  if (r.user.id !== req.user.id) fail(403, 'You can only renew your own requests');
  if (r.status !== 'issued') fail(409, 'Only equipment currently with you can be renewed');
  if (r.renewal?.status === 'pending') fail(409, 'A renewal is already awaiting approval');
  const renewTo = parseDate(req.body.renewTo);
  const reason = str(req.body.reason, 300);
  if (!renewTo || renewTo.toISOString() <= r.toAt) fail(400, 'Choose a new return time after the current due time', { field: 'renewTo' });
  if (renewTo - new Date(r.fromAt) > config.maxRequestDays * 2 * 864e5) fail(400, 'That extension is too long. Return the kit and submit a new request.');
  if (reason.length < 3) fail(400, 'Give a reason for the renewal', { field: 'reason' });
  db.prepare("UPDATE requests SET renew_to = ?, renew_reason = ?, renew_status = 'pending', renew_by = NULL, renew_at = NULL, renew_remarks = NULL, updated_at = ? WHERE id = ?")
    .run(renewTo.toISOString(), reason, now(), r.id);
  addLog({ actorId: req.user.id, subjectUserId: req.user.id, requestId: r.id, equipment: r.equipmentList.join(', '), action: 'Renewal requested', status: 'IN USE', details: `Until ${fmtDateTime(renewTo.toISOString())}` });
  notifyAdmins({
    level: 1,
    title: `Renewal request for ${r.code}`,
    body: `${r.user.name} asked to keep ${r.equipmentList.join(', ')} until ${fmtDateTime(renewTo.toISOString())}.\nReason: ${reason}`,
    link: `/admin/approvals/${r.id}`,
  });
  res.json({ request: S.getRequest(r.id) });
});

router.post('/requests/:id/dismiss', (req, res) => {
  const r = ownRequest(req);
  if (r.status === 'issued') db.prepare('UPDATE requests SET alert_dismissed_at = ? WHERE id = ?').run(now(), r.id);
  else if (r.status === 'returned') db.prepare('UPDATE requests SET return_ack_at = ? WHERE id = ?').run(now(), r.id);
  res.json({ ok: true });
});

// Duration alerts: due within N hours (or overdue) and recently verified returns.
router.get('/alerts', (req, res) => {
  const t = now();
  const soon = new Date(Date.now() + config.dueSoonHours * 3600e3).toISOString();
  const due = S.listRequests(
    `r.user_id = ? AND r.status = 'issued' AND r.to_at <= ?
     AND (r.alert_dismissed_at IS NULL OR (r.to_at < ? AND r.alert_dismissed_at < r.to_at))`,
    [req.user.id, soon, t],
    'r.to_at ASC'
  );
  const returned = S.listRequests(
    "r.user_id = ? AND r.status = 'returned' AND r.return_ack_at IS NULL AND r.returned_at > ?",
    [req.user.id, new Date(Date.now() - 3 * 864e5).toISOString()],
    'r.returned_at DESC',
    5
  );
  res.json({ due, returned });
});

// ---------------- Notifications ----------------

router.get('/notifications', (req, res) => {
  const items = db.prepare('SELECT * FROM notifications WHERE user_id = ? ORDER BY id DESC LIMIT 30').all(req.user.id);
  const unread = db.prepare('SELECT COUNT(*) AS c FROM notifications WHERE user_id = ? AND read_at IS NULL').get(req.user.id).c;
  res.json({
    unread,
    notifications: items.map((n) => ({ id: n.id, title: n.title, body: n.body, link: n.link, read: !!n.read_at, createdAt: n.created_at })),
  });
});

router.post('/notifications/read', (req, res) => {
  db.prepare('UPDATE notifications SET read_at = ? WHERE user_id = ? AND read_at IS NULL').run(now(), req.user.id);
  res.json({ ok: true });
});

module.exports = router;
