const express = require('express');
const { db, now } = require('../db');
const { fail, str, parseDate, intId, fmtDateTime } = require('../util');
const { requireAdmin } = require('../auth');
const { notifyUser, notifyAdmins, addLog, sendEmail, emailSettings } = require('../notify');
const { maybeRunAlerts } = require('../jobs');
const S = require('../services');

const router = express.Router();
router.use(requireAdmin);

const requireLevel2 = (req) => {
  if (req.user.approvalLevel !== 2) fail(403, 'Only Level 2 admins can manage users');
};

async function loadRequest(id) {
  const r = await S.getRequest(intId(id));
  if (!r) fail(404, 'Request not found');
  return r;
}

const approvedBy = (r) => [r.l1?.by, r.l2?.by].filter(Boolean).join(' / ');

// ---------------- Dashboard ----------------

router.get('/dashboard', async (req, res) => {
  await maybeRunAlerts();
  const units = await db.get(
    `SELECT COUNT(*) AS total,
       COUNT(*) FILTER (WHERE status = 'available') AS available,
       COUNT(*) FILTER (WHERE status = 'in_use') AS in_use,
       COUNT(*) FILTER (WHERE status = 'maintenance') AS maintenance
     FROM units WHERE status <> 'retired'`
  );
  const t = now();
  const c = await db.get(
    `SELECT
       COUNT(*) FILTER (WHERE status = 'pending_l1') AS pending_l1,
       COUNT(*) FILTER (WHERE status = 'pending_l2') AS pending_l2,
       COUNT(*) FILTER (WHERE status = 'approved') AS to_issue,
       COUNT(*) FILTER (WHERE status = 'issued') AS issued,
       COUNT(*) FILTER (WHERE status = 'issued' AND to_at < ?) AS overdue,
       COUNT(*) FILTER (WHERE renew_status = 'pending') AS renewals
     FROM requests`,
    [t]
  );
  const { c: userCount } = await db.get("SELECT COUNT(*) AS c FROM users WHERE role = 'user'");
  const recent = await db.all(
    `SELECT l.*, su.name AS user_name, rq.code AS request_code FROM logs l
     LEFT JOIN users su ON su.id = l.subject_user_id LEFT JOIN requests rq ON rq.id = l.request_id
     ORDER BY l.id DESC LIMIT 10`
  );
  res.json({
    units: { total: units.total, available: units.available, inUse: units.in_use, maintenance: units.maintenance },
    counts: {
      pendingL1: c.pending_l1,
      pendingL2: c.pending_l2,
      toIssue: c.to_issue,
      issued: c.issued,
      overdue: c.overdue,
      renewals: c.renewals,
      users: userCount,
    },
    overdue: await S.listRequests("r.status = 'issued' AND r.to_at < ?", [t], 'r.to_at ASC', 20),
    dueSoon: await S.listRequests("r.status = 'issued' AND r.to_at >= ? AND r.to_at <= ?", [t, new Date(Date.now() + 864e5).toISOString()], 'r.to_at ASC', 20),
    recent: recent.map(fmtLog),
  });
});

// ---------------- Approvals ----------------

router.get('/approvals', async (req, res) => {
  res.json({
    requests: await S.listRequests("r.status IN ('pending_l1', 'pending_l2') OR r.renew_status = 'pending'", [], 'r.submitted_at ASC'),
  });
});

router.post('/requests/:id/decision', async (req, res) => {
  const r = await loadRequest(req.params.id);
  const accept = req.body.decision === 'accept';
  if (!accept && req.body.decision !== 'reject') fail(400, 'Choose accept or reject');
  const remarks = str(req.body.remarks, 500);
  const me = req.user;
  const t = now();
  const equipment = r.equipmentList.join(', ');

  if (r.status === 'pending_l1') {
    if (me.approvalLevel !== 1) fail(403, 'Only Level 1 approvers can act on this request');
    if (remarks.length < 2) fail(400, 'Remarks are compulsory at Level 1', { field: 'remarks' });
    const done = await db.run(
      "UPDATE requests SET status = ?, l1_by = ?, l1_at = ?, l1_decision = ?, l1_remarks = ?, updated_at = ? WHERE id = ? AND status = 'pending_l1'",
      [accept ? 'pending_l2' : 'rejected', me.id, t, accept ? 'accepted' : 'rejected', remarks, t, r.id]
    );
    if (!done.changes) fail(409, 'Another approver already decided this request');
    await addLog({ actorId: me.id, subjectUserId: r.user.id, requestId: r.id, equipment, action: accept ? 'L1 accepted' : 'L1 rejected', approvedBy: me.name, status: accept ? 'PENDING L2' : 'REJECTED', details: remarks });
    const updated = await S.getRequest(r.id);
    if (accept) {
      await notifyUser(r.user.id, { title: `${r.code} accepted at Level 1`, body: `${me.name}: ${remarks}\nYour request now awaits final (Level 2) approval.`, link: `/requests/${r.id}` });
      await notifyAdmins({ level: 2, title: `${r.code} awaits your final approval`, body: `${S.requestDetailsText(updated)}\n\nLevel 1 (${me.name}): ${remarks}`, link: `/admin/approvals/${r.id}` });
    } else {
      await notifyUser(r.user.id, { title: `${r.code} was rejected`, body: `Rejected at Level 1 by ${me.name}.\nRemarks: ${remarks}`, link: `/requests/${r.id}` });
    }
    return res.json({ request: updated });
  }

  if (r.status === 'pending_l2') {
    if (me.approvalLevel !== 2) fail(403, 'Only the Level 2 approver can give final approval');
    const done = await db.run(
      "UPDATE requests SET status = ?, l2_by = ?, l2_at = ?, l2_decision = ?, l2_remarks = ?, updated_at = ? WHERE id = ? AND status = 'pending_l2'",
      [accept ? 'approved' : 'rejected', me.id, t, accept ? 'accepted' : 'rejected', remarks || null, t, r.id]
    );
    if (!done.changes) fail(409, 'This request was already decided');
    await addLog({ actorId: me.id, subjectUserId: r.user.id, requestId: r.id, equipment, action: accept ? 'L2 approved' : 'L2 rejected', approvedBy: [r.l1?.by, me.name].filter(Boolean).join(' / '), status: accept ? 'APPROVED' : 'REJECTED', details: remarks });
    await notifyUser(r.user.id, accept
      ? { title: `${r.code} approved - collect from the Media Lab`, body: `Final approval by ${me.name}.${remarks ? `\nRemarks: ${remarks}` : ''}\nPickup from ${fmtDateTime(r.fromAt)}. Barcodes are scanned at issue. Handle with care - damage may result in a fine.`, link: `/requests/${r.id}` }
      : { title: `${r.code} was rejected`, body: `Rejected at Level 2 by ${me.name}.${remarks ? `\nRemarks: ${remarks}` : ''}`, link: `/requests/${r.id}` });
    return res.json({ request: await S.getRequest(r.id) });
  }

  fail(409, 'This request is no longer awaiting approval');
});

router.post('/requests/:id/renewal', async (req, res) => {
  const r = await loadRequest(req.params.id);
  if (r.renewal?.status !== 'pending') fail(409, 'No renewal is awaiting approval');
  const accept = req.body.decision === 'accept';
  const remarks = str(req.body.remarks, 300);
  const t = now();
  if (accept && r.status !== 'issued') fail(409, 'This equipment has already been returned');
  await db.tx(async (tx) => {
    await tx.run('UPDATE requests SET renew_status = ?, renew_by = ?, renew_at = ?, renew_remarks = ?, updated_at = ? WHERE id = ?', [
      accept ? 'approved' : 'rejected', req.user.id, t, remarks || null, t, r.id,
    ]);
    if (accept) {
      await tx.run('UPDATE requests SET to_at = ?, due_soon_alerted_at = NULL, overdue_alerted_at = NULL, alert_dismissed_at = NULL WHERE id = ?', [r.renewal.to, r.id]);
    }
  });
  await addLog({ actorId: req.user.id, subjectUserId: r.user.id, requestId: r.id, equipment: r.equipmentList.join(', '), action: accept ? 'Renewal approved' : 'Renewal rejected', approvedBy: req.user.name, status: 'IN USE', details: accept ? `New due ${fmtDateTime(r.renewal.to)}` : remarks });
  await notifyUser(r.user.id, accept
    ? { title: `Renewal approved for ${r.code}`, body: `Return by ${fmtDateTime(r.renewal.to)}.${remarks ? `\nRemarks: ${remarks}` : ''}`, link: `/requests/${r.id}` }
    : { title: `Renewal rejected for ${r.code}`, body: `Please return the equipment by ${fmtDateTime(r.toAt)}.${remarks ? `\nRemarks: ${remarks}` : ''}`, link: `/requests/${r.id}` });
  res.json({ request: await S.getRequest(r.id) });
});

router.post('/requests/:id/cancel', async (req, res) => {
  const r = await loadRequest(req.params.id);
  if (!['pending_l1', 'pending_l2', 'approved'].includes(r.status)) fail(409, 'Only requests that have not been issued can be cancelled');
  const remarks = str(req.body.remarks, 300);
  if (remarks.length < 3) fail(400, 'Give a reason for cancelling', { field: 'remarks' });
  await db.run("UPDATE requests SET status = 'cancelled', cancelled_at = ?, updated_at = ? WHERE id = ?", [now(), now(), r.id]);
  await addLog({ actorId: req.user.id, subjectUserId: r.user.id, requestId: r.id, equipment: r.equipmentList.join(', '), action: 'Cancelled by admin', approvedBy: approvedBy(r), status: 'CANCELLED', details: remarks });
  await notifyUser(r.user.id, { title: `${r.code} was cancelled`, body: `Cancelled by ${req.user.name}.\nReason: ${remarks}`, link: `/requests/${r.id}` });
  res.json({ request: await S.getRequest(r.id) });
});

// ---------------- Issue (barcode) ----------------

router.get('/issue-queue', async (req, res) => {
  const requests = await S.listRequests("r.status = 'approved'", [], 'r.from_at ASC');
  const eqIds = [...new Set(requests.flatMap((r) => r.items.map((i) => i.equipmentId)))];
  const availableUnits = {};
  if (eqIds.length) {
    const rows = await db.all("SELECT equipment_id, barcode FROM units WHERE equipment_id = ANY(?) AND status = 'available' ORDER BY barcode", [eqIds]);
    for (const id of eqIds) availableUnits[id] = [];
    for (const u of rows) availableUnits[u.equipment_id].push(u.barcode);
  }
  res.json({ requests, availableUnits });
});

router.post('/requests/:id/issue', async (req, res) => {
  const r = await loadRequest(req.params.id);
  if (r.status !== 'approved') fail(409, 'Only fully approved requests can be issued');
  const assignments = new Map((Array.isArray(req.body.assignments) ? req.body.assignments : []).map((a) => [Number(a.itemId), str(a.barcode, 40).toUpperCase()]));
  const used = new Set();
  const plan = [];
  for (const item of r.items) {
    const barcode = assignments.get(item.id);
    if (!barcode) fail(400, `Scan a barcode for ${item.name}`, { itemId: item.id });
    if (used.has(barcode)) fail(400, `Barcode ${barcode} was scanned twice`, { itemId: item.id });
    used.add(barcode);
    const unit = await db.get('SELECT * FROM units WHERE barcode = ?', [barcode]);
    if (!unit) fail(400, `Barcode ${barcode} is not in the inventory`, { itemId: item.id });
    if (unit.equipment_id !== item.equipmentId) fail(400, `${barcode} is not a ${item.name}`, { itemId: item.id });
    if (unit.status !== 'available') fail(409, `${barcode} is not available (${unit.status.replace('_', ' ')})`, { itemId: item.id });
    plan.push({ item, unit });
  }
  const t = now();
  await db.tx(async (tx) => {
    for (const { item, unit } of plan) {
      const done = await tx.run("UPDATE units SET status = 'in_use' WHERE id = ? AND status = 'available'", [unit.id]);
      if (!done.changes) fail(409, `${unit.barcode} was just issued elsewhere`, { itemId: item.id });
      await tx.run('UPDATE request_items SET unit_id = ? WHERE id = ?', [unit.id, item.id]);
    }
    const done = await tx.run("UPDATE requests SET status = 'issued', issued_by = ?, issued_at = ?, updated_at = ? WHERE id = ? AND status = 'approved'", [req.user.id, t, t, r.id]);
    if (!done.changes) fail(409, 'This request was already issued');
  });
  const updated = await S.getRequest(r.id);
  await addLog({ actorId: req.user.id, subjectUserId: r.user.id, requestId: r.id, equipment: r.equipmentList.join(', '), action: 'Issued (barcode)', approvedBy: approvedBy(r), status: 'IN USE', details: updated.items.map((i) => i.barcode).join(', ') });
  await notifyUser(r.user.id, { title: `${r.code} issued to you`, body: `${updated.items.map((i) => `${i.name} (${i.barcode})`).join('\n')}\n\nReturn by ${fmtDateTime(r.toAt)}. Handle with care - damage may result in a fine.`, link: `/requests/${r.id}` });
  res.json({ request: updated });
});

// ---------------- Returns ----------------

router.get('/returns', async (req, res) => {
  res.json({ requests: await S.listRequests("r.status = 'issued'", [], 'r.to_at ASC') });
});

router.post('/requests/:id/return', async (req, res) => {
  const r = await loadRequest(req.params.id);
  if (r.status !== 'issued') fail(409, 'This request is not currently issued');
  const damage = req.body.damage === true;
  const notes = str(req.body.notes, 1000);
  const okIds = new Set((Array.isArray(req.body.okItemIds) ? req.body.okItemIds : []).map(Number));
  const extrasOk = req.body.extrasOk === true;

  if (!damage) {
    if (r.items.some((i) => !okIds.has(i.id)) || !extrasOk) {
      fail(400, 'Tick every checklist item to confirm the return. Use Report Damage for damaged or missing items.');
    }
  } else if (notes.length < 3) {
    fail(400, 'Describe the damage or missing items in the condition notes', { field: 'notes' });
  }

  const t = now();
  await db.tx(async (tx) => {
    const done = await tx.run(
      `UPDATE requests SET status = 'returned', returned_at = ?, return_verified_by = ?, return_notes = ?, damage_reported = ?,
         renew_status = CASE WHEN renew_status = 'pending' THEN 'rejected' ELSE renew_status END, updated_at = ?
       WHERE id = ? AND status = 'issued'`,
      [t, req.user.id, notes || null, damage ? 1 : 0, t, r.id]
    );
    if (!done.changes) fail(409, 'This return was already verified');
    for (const item of r.items) {
      const ok = okIds.has(item.id);
      const row = await tx.get('UPDATE request_items SET return_ok = ?, damaged = ? WHERE id = ? RETURNING unit_id', [ok ? 1 : 0, ok ? 0 : 1, item.id]);
      if (row?.unit_id) {
        if (ok) await tx.run("UPDATE units SET status = 'available' WHERE id = ?", [row.unit_id]);
        else await tx.run("UPDATE units SET status = 'maintenance', notes = ? WHERE id = ?", [`${r.code}: ${notes}`.slice(0, 500), row.unit_id]);
      }
    }
  });

  const updated = await S.getRequest(r.id);
  const late = r.toAt < t;
  await addLog({
    actorId: req.user.id, subjectUserId: r.user.id, requestId: r.id, equipment: r.equipmentList.join(', '),
    action: damage ? 'Returned (damage reported)' : late ? 'Returned (OK, late)' : 'Returned (OK)',
    approvedBy: approvedBy(r), status: damage ? 'DAMAGED' : 'CLOSED', details: notes,
  });
  await notifyUser(r.user.id, damage
    ? { title: `Return of ${r.code} recorded with damage`, body: `${req.user.name} verified the return and reported an issue:\n${notes}\n\nThe Media Lab will contact you about the damage policy.`, link: `/requests/${r.id}` }
    : { title: `Return verified for ${r.code}`, body: `${req.user.name} confirmed the return checklist. Thank you for handling the equipment with care.`, link: `/requests/${r.id}` });
  await S.processNotifyRequests(r.items.map((i) => i.equipmentId));
  res.json({ request: updated });
});

// ---------------- Inventory ----------------

async function inventoryItems(equipment) {
  if (!equipment.length) return [];
  const ids = equipment.map((e) => e.id);
  const units = await db.all('SELECT * FROM units WHERE equipment_id = ANY(?) ORDER BY barcode', [ids]);
  const links = await db.all('SELECT * FROM accessory_links WHERE equipment_id = ANY(?)', [ids]);
  return equipment.map((e) => ({
    ...e,
    accessoryIds: links.filter((l) => l.equipment_id === e.id).map((l) => l.accessory_id),
    units: units.filter((u) => u.equipment_id === e.id).map((u) => ({ id: u.id, barcode: u.barcode, status: u.status, notes: u.notes })),
  }));
}
const inventoryItem = async (e) => (await inventoryItems([e]))[0];

router.get('/inventory', async (req, res) => {
  const category = S.CATEGORIES.includes(req.query.category) ? req.query.category : null;
  const equipment = await S.listEquipment({ category, q: str(req.query.q, 80) || null, includeInactive: true });
  res.json({ equipment: await inventoryItems(equipment) });
});

router.get('/inventory/:id', async (req, res) => {
  const e = await S.getEquipment(intId(req.params.id));
  if (!e) fail(404, 'Equipment not found');
  res.json({ equipment: await inventoryItem(e) });
});

function validateEquipmentBody(b, partial = false) {
  const out = {};
  if (!partial || b.name !== undefined) {
    out.name = str(b.name, 80);
    if (out.name.length < 2) fail(400, 'Enter the equipment name', { field: 'name' });
  }
  if (!partial || b.category !== undefined) {
    if (!S.CATEGORIES.includes(b.category)) fail(400, 'Choose a category', { field: 'category' });
    out.category = b.category;
  }
  if (b.subtype !== undefined) out.subtype = str(b.subtype, 60);
  if (b.description !== undefined) out.description = str(b.description, 500);
  if (b.isAccessory !== undefined) out.is_accessory = b.isAccessory ? 1 : 0;
  if (b.active !== undefined) out.active = b.active ? 1 : 0;
  return out;
}

async function setAccessories(tx, equipmentId, ids) {
  if (!Array.isArray(ids)) return;
  await tx.run('DELETE FROM accessory_links WHERE equipment_id = ?', [equipmentId]);
  const clean = [...new Set(ids.map(Number))].filter((id) => Number.isInteger(id) && id !== equipmentId);
  if (!clean.length) return;
  await tx.run(
    `INSERT INTO accessory_links (equipment_id, accessory_id)
     SELECT ?, id FROM equipment WHERE id = ANY(?) ON CONFLICT DO NOTHING`,
    [equipmentId, clean]
  );
}

async function addUnits(tx, equipmentId, code, count) {
  const existing = new Set((await tx.all('SELECT barcode FROM units WHERE barcode LIKE ?', [`${code}-%`])).map((u) => u.barcode));
  let n = [...existing].reduce((m, b) => Math.max(m, Number(b.split('-').pop()) || 0), 0);
  const created = [];
  for (let i = 0; i < count; i++) {
    let barcode;
    do {
      n += 1;
      barcode = `${code}-${String(n).padStart(2, '0')}`;
    } while (existing.has(barcode));
    created.push(barcode);
  }
  if (created.length) {
    await tx.run(
      "INSERT INTO units (equipment_id, barcode, status, created_at) SELECT ?, unnest(?::text[]), 'available', ?",
      [equipmentId, created, now()]
    );
  }
  return created;
}

router.post('/equipment', async (req, res) => {
  const b = req.body;
  const data = validateEquipmentBody(b);
  const code = str(b.code, 20).toUpperCase();
  if (!/^[A-Z0-9][A-Z0-9-]{1,19}$/.test(code)) fail(400, 'Code must be letters, digits and dashes, e.g. CAM-014', { field: 'code' });
  if (await db.get('SELECT 1 FROM equipment WHERE code = ?', [code])) fail(409, `Code ${code} is already used`, { field: 'code' });
  const qty = Number(b.quantity ?? 1);
  if (!Number.isInteger(qty) || qty < 0 || qty > 200) fail(400, 'Quantity must be between 0 and 200', { field: 'quantity' });

  const id = await db.tx(async (tx) => {
    const { id: eid } = await tx.get(
      'INSERT INTO equipment (name, category, subtype, code, description, is_accessory, created_at) VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id',
      [data.name, data.category, data.subtype || '', code, data.description || '', data.is_accessory || 0, now()]
    );
    await addUnits(tx, eid, code, qty);
    await setAccessories(tx, eid, b.accessoryIds);
    return eid;
  });
  await addLog({ actorId: req.user.id, equipment: data.name, action: 'Equipment added', details: `${code} x${qty}` });
  res.status(201).json({ equipment: await inventoryItem(await S.getEquipment(id)) });
});

router.patch('/equipment/:id', async (req, res) => {
  const e = await S.getEquipment(intId(req.params.id));
  if (!e) fail(404, 'Equipment not found');
  const data = validateEquipmentBody(req.body, true);
  await db.tx(async (tx) => {
    const keys = Object.keys(data);
    if (keys.length) await tx.run(`UPDATE equipment SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`, [...keys.map((k) => data[k]), e.id]);
    await setAccessories(tx, e.id, req.body.accessoryIds);
  });
  await addLog({ actorId: req.user.id, equipment: data.name || e.name, action: 'Equipment updated' });
  res.json({ equipment: await inventoryItem(await S.getEquipment(e.id)) });
});

router.post('/equipment/:id/units', async (req, res) => {
  const e = await S.getEquipment(intId(req.params.id));
  if (!e) fail(404, 'Equipment not found');
  const count = Number(req.body.count);
  if (!Number.isInteger(count) || count < 1 || count > 100) fail(400, 'Add between 1 and 100 units');
  const created = await db.tx((tx) => addUnits(tx, e.id, e.code, count));
  await addLog({ actorId: req.user.id, equipment: e.name, action: 'Units added', details: created.join(', ') });
  await S.processNotifyRequests([e.id]);
  res.json({ equipment: await inventoryItem(await S.getEquipment(e.id)), created });
});

router.patch('/units/:id', async (req, res) => {
  const unit = await db.get('SELECT u.*, e.name FROM units u JOIN equipment e ON e.id = u.equipment_id WHERE u.id = ?', [intId(req.params.id)]);
  if (!unit) fail(404, 'Unit not found');
  const status = req.body.status;
  if (status !== undefined) {
    if (!['available', 'maintenance', 'retired'].includes(status)) fail(400, 'Invalid status');
    if (unit.status === 'in_use') fail(409, 'This unit is issued. Verify its return first.');
  }
  const notes = req.body.notes !== undefined ? str(req.body.notes, 500) : unit.notes;
  await db.run('UPDATE units SET status = ?, notes = ? WHERE id = ?', [status ?? unit.status, notes, unit.id]);
  if (status && status !== unit.status) {
    await addLog({ actorId: req.user.id, equipment: `${unit.name} (${unit.barcode})`, action: `Unit marked ${status}`, status: status.toUpperCase(), details: notes });
    if (status === 'available') await S.processNotifyRequests([unit.equipment_id]);
  }
  res.json({ ok: true });
});

router.get('/units/lookup', async (req, res) => {
  const barcode = str(req.query.barcode, 40).toUpperCase();
  const unit = await db.get('SELECT * FROM units WHERE barcode = ?', [barcode]);
  if (!unit) fail(404, `No item with barcode ${barcode}`);
  const holder = await db.get(
    "SELECT ri.request_id FROM request_items ri JOIN requests r ON r.id = ri.request_id WHERE ri.unit_id = ? AND r.status = 'issued'",
    [unit.id]
  );
  res.json({
    unit: { id: unit.id, barcode: unit.barcode, status: unit.status, notes: unit.notes },
    equipment: await S.getEquipment(unit.equipment_id),
    request: holder ? await S.getRequest(holder.request_id) : null,
  });
});

// ---------------- Logs ----------------

function fmtLog(l) {
  return {
    id: l.id,
    at: l.at,
    user: l.user_name || '',
    userProfession: l.user_profession || '',
    actor: l.actor_name || '',
    requestId: l.request_id,
    requestCode: l.request_code || '',
    equipment: l.equipment,
    action: l.action,
    approvedBy: l.approved_by,
    status: l.status,
    details: l.details,
  };
}

async function queryLogs(q) {
  const where = [];
  const p = [];
  if (q.type === 'student') where.push("su.profession = 'student'");
  else if (q.type === 'staff') where.push("su.profession IN ('faculty', 'staff')");
  if (q.userId) {
    where.push('l.subject_user_id = ?');
    p.push(intId(q.userId));
  }
  const from = parseDate(q.from);
  const to = parseDate(q.to);
  if (from) { where.push('l.at >= ?'); p.push(from.toISOString()); }
  if (to) { where.push('l.at <= ?'); p.push(to.toISOString()); }
  const search = str(q.q, 80);
  if (search) {
    where.push('(su.name ILIKE ? OR l.equipment ILIKE ? OR l.action ILIKE ? OR rq.code ILIKE ?)');
    p.push(...Array(4).fill(`%${search}%`));
  }
  const rows = await db.all(
    `SELECT l.*, su.name AS user_name, su.profession AS user_profession, ac.name AS actor_name, rq.code AS request_code
     FROM logs l
     LEFT JOIN users su ON su.id = l.subject_user_id
     LEFT JOIN users ac ON ac.id = l.actor_id
     LEFT JOIN requests rq ON rq.id = l.request_id
     ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
     ORDER BY l.at DESC, l.id DESC LIMIT 2000`,
    p
  );
  return rows.map(fmtLog);
}

router.get('/logs', async (req, res) => {
  const logs = await queryLogs(req.query);
  if (req.query.format === 'csv') {
    const cell = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const rows = [['Date', 'Request', 'User', 'Equipment', 'Action', 'Approved by', 'Status', 'Recorded by', 'Details']];
    for (const l of logs) rows.push([fmtDateTime(l.at), l.requestCode, l.user, l.equipment, l.action, l.approvedBy, l.status, l.actor, l.details]);
    res.set('Content-Type', 'text/csv; charset=utf-8');
    res.set('Content-Disposition', `attachment; filename="medialab-logs-${new Date().toISOString().slice(0, 10)}.csv"`);
    return res.send('﻿' + rows.map((r) => r.map(cell).join(',')).join('\r\n'));
  }
  res.json({ logs });
});

// ---------------- Email diagnostics ----------------

// Sends a test email to the signed-in admin and reports the exact SMTP result.
router.post('/test-email', async (req, res) => {
  const settings = emailSettings();
  if (!settings.configured) return res.json({ settings, result: { ok: false, error: 'SMTP_HOST is not set, so emails are only written to the server log.' } });
  const result = await sendEmail(req.user.email, 'MediaLab test email', `This is a test email from MediaLab sent at ${fmtDateTime(now())}. Email delivery is working.`);
  res.json({ settings, result });
});

// ---------------- Users ----------------

router.get('/users', async (req, res) => {
  const where = [];
  const p = [];
  const q = str(req.query.q, 80);
  if (q) {
    where.push('(name ILIKE ? OR email ILIKE ? OR department ILIKE ?)');
    p.push(`%${q}%`, `%${q}%`, `%${q}%`);
  }
  if (req.query.type === 'student') where.push("profession = 'student' AND role = 'user'");
  else if (req.query.type === 'staff') where.push("profession IN ('faculty', 'staff') AND role = 'user'");
  const users = await db.all(
    `SELECT u.*, (SELECT COUNT(*) FROM requests r WHERE r.user_id = u.id AND r.status <> 'draft') AS request_count
     FROM users u ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY u.role DESC, lower(u.name) LIMIT 1000`,
    p
  );
  res.json({
    users: users.map((u) => ({
      id: u.id, name: u.name, email: u.email, phone: u.phone, profession: u.profession, batch: u.batch,
      department: u.department, school: u.school, role: u.role, approvalLevel: u.approval_level,
      active: !!u.active, createdAt: u.created_at, requestCount: u.request_count,
    })),
  });
});

router.patch('/users/:id', async (req, res) => {
  requireLevel2(req);
  const id = intId(req.params.id);
  const u = await db.get('SELECT * FROM users WHERE id = ?', [id]);
  if (!u) fail(404, 'User not found');
  if (id === req.user.id) fail(400, 'You cannot change your own access');
  let role = u.role;
  let level = u.approval_level;
  let active = u.active;
  if (req.body.access !== undefined) {
    const map = { user: ['user', 0], admin: ['admin', 0], l1: ['admin', 1], l2: ['admin', 2] };
    if (!map[req.body.access]) fail(400, 'Invalid access level');
    [role, level] = map[req.body.access];
  }
  if (req.body.active !== undefined) active = req.body.active ? 1 : 0;
  await db.run('UPDATE users SET role = ?, approval_level = ?, active = ? WHERE id = ?', [role, level, active, id]);
  if (!active) await db.run('DELETE FROM sessions WHERE user_id = ?', [id]);
  await addLog({ actorId: req.user.id, subjectUserId: id, action: 'Access changed', details: `${role}${level ? ` L${level}` : ''}${active ? '' : ', disabled'}` });
  res.json({ ok: true });
});

module.exports = router;
