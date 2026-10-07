const express = require('express');
const { db, now } = require('../db');
const { fail, str, parseDate, intId, fmtDateTime } = require('../util');
const { requireAdmin } = require('../auth');
const { notifyUser, notifyAdmins, addLog } = require('../notify');
const S = require('../services');

const router = express.Router();
router.use(requireAdmin);

const requireLevel2 = (req) => {
  if (req.user.approvalLevel !== 2) fail(403, 'Only Level 2 admins can manage users');
};

function loadRequest(id) {
  const r = S.getRequest(intId(id));
  if (!r) fail(404, 'Request not found');
  return r;
}

const approvedBy = (r) => [r.l1?.by, r.l2?.by].filter(Boolean).join(' / ');

// ---------------- Dashboard ----------------

router.get('/dashboard', (req, res) => {
  const units = db.prepare(
    `SELECT COUNT(*) AS total,
       SUM(status = 'available') AS available, SUM(status = 'in_use') AS inUse, SUM(status = 'maintenance') AS maintenance
     FROM units WHERE status <> 'retired'`
  ).get();
  const t = now();
  const c = (sql, ...p) => db.prepare(sql).get(...p).c;
  res.json({
    units: { total: units.total || 0, available: units.available || 0, inUse: units.inUse || 0, maintenance: units.maintenance || 0 },
    counts: {
      pendingL1: c("SELECT COUNT(*) AS c FROM requests WHERE status = 'pending_l1'"),
      pendingL2: c("SELECT COUNT(*) AS c FROM requests WHERE status = 'pending_l2'"),
      toIssue: c("SELECT COUNT(*) AS c FROM requests WHERE status = 'approved'"),
      issued: c("SELECT COUNT(*) AS c FROM requests WHERE status = 'issued'"),
      overdue: c("SELECT COUNT(*) AS c FROM requests WHERE status = 'issued' AND to_at < ?", t),
      renewals: c("SELECT COUNT(*) AS c FROM requests WHERE renew_status = 'pending'"),
      users: c("SELECT COUNT(*) AS c FROM users WHERE role = 'user'"),
    },
    overdue: S.listRequests("r.status = 'issued' AND r.to_at < ?", [t], 'r.to_at ASC', 20),
    dueSoon: S.listRequests("r.status = 'issued' AND r.to_at >= ? AND r.to_at <= ?", [t, new Date(Date.now() + 864e5).toISOString()], 'r.to_at ASC', 20),
    recent: db
      .prepare(
        `SELECT l.*, su.name AS user_name, rq.code AS request_code FROM logs l
         LEFT JOIN users su ON su.id = l.subject_user_id LEFT JOIN requests rq ON rq.id = l.request_id
         ORDER BY l.id DESC LIMIT 10`
      )
      .all()
      .map(fmtLog),
  });
});

// ---------------- Approvals ----------------

router.get('/approvals', (req, res) => {
  res.json({
    requests: S.listRequests("r.status IN ('pending_l1', 'pending_l2') OR r.renew_status = 'pending'", [], 'r.submitted_at ASC'),
  });
});

router.post('/requests/:id/decision', (req, res) => {
  const r = loadRequest(req.params.id);
  const accept = req.body.decision === 'accept';
  if (!accept && req.body.decision !== 'reject') fail(400, 'Choose accept or reject');
  const remarks = str(req.body.remarks, 500);
  const me = req.user;
  const t = now();
  const equipment = r.equipmentList.join(', ');

  if (r.status === 'pending_l1') {
    if (me.approvalLevel !== 1) fail(403, 'Only Level 1 approvers can act on this request');
    if (remarks.length < 2) fail(400, 'Remarks are compulsory at Level 1', { field: 'remarks' });
    db.prepare(`UPDATE requests SET status = ?, l1_by = ?, l1_at = ?, l1_decision = ?, l1_remarks = ?, updated_at = ? WHERE id = ?`).run(
      accept ? 'pending_l2' : 'rejected', me.id, t, accept ? 'accepted' : 'rejected', remarks, t, r.id
    );
    addLog({ actorId: me.id, subjectUserId: r.user.id, requestId: r.id, equipment, action: accept ? 'L1 accepted' : 'L1 rejected', approvedBy: me.name, status: accept ? 'PENDING L2' : 'REJECTED', details: remarks });
    const updated = S.getRequest(r.id);
    if (accept) {
      notifyUser(r.user.id, { title: `${r.code} accepted at Level 1`, body: `${me.name}: ${remarks}\nYour request now awaits final (Level 2) approval.`, link: `/requests/${r.id}` });
      notifyAdmins({ level: 2, title: `${r.code} awaits your final approval`, body: `${S.requestDetailsText(updated)}\n\nLevel 1 (${me.name}): ${remarks}`, link: `/admin/approvals/${r.id}` });
    } else {
      notifyUser(r.user.id, { title: `${r.code} was rejected`, body: `Rejected at Level 1 by ${me.name}.\nRemarks: ${remarks}`, link: `/requests/${r.id}` });
    }
    return res.json({ request: updated });
  }

  if (r.status === 'pending_l2') {
    if (me.approvalLevel !== 2) fail(403, 'Only the Level 2 approver can give final approval');
    db.prepare(`UPDATE requests SET status = ?, l2_by = ?, l2_at = ?, l2_decision = ?, l2_remarks = ?, updated_at = ? WHERE id = ?`).run(
      accept ? 'approved' : 'rejected', me.id, t, accept ? 'accepted' : 'rejected', remarks || null, t, r.id
    );
    addLog({ actorId: me.id, subjectUserId: r.user.id, requestId: r.id, equipment, action: accept ? 'L2 approved' : 'L2 rejected', approvedBy: [r.l1?.by, me.name].filter(Boolean).join(' / '), status: accept ? 'APPROVED' : 'REJECTED', details: remarks });
    notifyUser(r.user.id, accept
      ? { title: `${r.code} approved - collect from the Media Lab`, body: `Final approval by ${me.name}.${remarks ? `\nRemarks: ${remarks}` : ''}\nPickup from ${fmtDateTime(r.fromAt)}. Barcodes are scanned at issue. Handle with care - damage may result in a fine.`, link: `/requests/${r.id}` }
      : { title: `${r.code} was rejected`, body: `Rejected at Level 2 by ${me.name}.${remarks ? `\nRemarks: ${remarks}` : ''}`, link: `/requests/${r.id}` });
    return res.json({ request: S.getRequest(r.id) });
  }

  fail(409, 'This request is no longer awaiting approval');
});

router.post('/requests/:id/renewal', (req, res) => {
  const r = loadRequest(req.params.id);
  if (r.renewal?.status !== 'pending') fail(409, 'No renewal is awaiting approval');
  const accept = req.body.decision === 'accept';
  const remarks = str(req.body.remarks, 300);
  const t = now();
  if (accept && r.status !== 'issued') fail(409, 'This equipment has already been returned');
  db.transaction(() => {
    db.prepare('UPDATE requests SET renew_status = ?, renew_by = ?, renew_at = ?, renew_remarks = ?, updated_at = ? WHERE id = ?').run(
      accept ? 'approved' : 'rejected', req.user.id, t, remarks || null, t, r.id
    );
    if (accept) {
      db.prepare('UPDATE requests SET to_at = ?, due_soon_alerted_at = NULL, overdue_alerted_at = NULL, alert_dismissed_at = NULL WHERE id = ?').run(r.renewal.to, r.id);
    }
  })();
  addLog({ actorId: req.user.id, subjectUserId: r.user.id, requestId: r.id, equipment: r.equipmentList.join(', '), action: accept ? 'Renewal approved' : 'Renewal rejected', approvedBy: req.user.name, status: 'IN USE', details: accept ? `New due ${fmtDateTime(r.renewal.to)}` : remarks });
  notifyUser(r.user.id, accept
    ? { title: `Renewal approved for ${r.code}`, body: `Return by ${fmtDateTime(r.renewal.to)}.${remarks ? `\nRemarks: ${remarks}` : ''}`, link: `/requests/${r.id}` }
    : { title: `Renewal rejected for ${r.code}`, body: `Please return the equipment by ${fmtDateTime(r.toAt)}.${remarks ? `\nRemarks: ${remarks}` : ''}`, link: `/requests/${r.id}` });
  res.json({ request: S.getRequest(r.id) });
});

router.post('/requests/:id/cancel', (req, res) => {
  const r = loadRequest(req.params.id);
  if (!['pending_l1', 'pending_l2', 'approved'].includes(r.status)) fail(409, 'Only requests that have not been issued can be cancelled');
  const remarks = str(req.body.remarks, 300);
  if (remarks.length < 3) fail(400, 'Give a reason for cancelling', { field: 'remarks' });
  db.prepare("UPDATE requests SET status = 'cancelled', cancelled_at = ?, updated_at = ? WHERE id = ?").run(now(), now(), r.id);
  addLog({ actorId: req.user.id, subjectUserId: r.user.id, requestId: r.id, equipment: r.equipmentList.join(', '), action: 'Cancelled by admin', approvedBy: approvedBy(r), status: 'CANCELLED', details: remarks });
  notifyUser(r.user.id, { title: `${r.code} was cancelled`, body: `Cancelled by ${req.user.name}.\nReason: ${remarks}`, link: `/requests/${r.id}` });
  res.json({ request: S.getRequest(r.id) });
});

// ---------------- Issue (barcode) ----------------

router.get('/issue-queue', (req, res) => {
  const requests = S.listRequests("r.status = 'approved'", [], 'r.from_at ASC');
  const eqIds = [...new Set(requests.flatMap((r) => r.items.map((i) => i.equipmentId)))];
  const availableUnits = {};
  for (const id of eqIds) {
    availableUnits[id] = db.prepare("SELECT barcode FROM units WHERE equipment_id = ? AND status = 'available' ORDER BY barcode").all(id).map((u) => u.barcode);
  }
  res.json({ requests, availableUnits });
});

router.post('/requests/:id/issue', (req, res) => {
  const r = loadRequest(req.params.id);
  if (r.status !== 'approved') fail(409, 'Only fully approved requests can be issued');
  const assignments = new Map((Array.isArray(req.body.assignments) ? req.body.assignments : []).map((a) => [Number(a.itemId), str(a.barcode, 40).toUpperCase()]));
  const used = new Set();
  const plan = r.items.map((item) => {
    const barcode = assignments.get(item.id);
    if (!barcode) fail(400, `Scan a barcode for ${item.name}`, { itemId: item.id });
    if (used.has(barcode)) fail(400, `Barcode ${barcode} was scanned twice`, { itemId: item.id });
    used.add(barcode);
    const unit = db.prepare('SELECT * FROM units WHERE barcode = ?').get(barcode);
    if (!unit) fail(400, `Barcode ${barcode} is not in the inventory`, { itemId: item.id });
    if (unit.equipment_id !== item.equipmentId) fail(400, `${barcode} is not a ${item.name}`, { itemId: item.id });
    if (unit.status !== 'available') fail(409, `${barcode} is not available (${unit.status.replace('_', ' ')})`, { itemId: item.id });
    return { item, unit };
  });
  const t = now();
  db.transaction(() => {
    for (const { item, unit } of plan) {
      db.prepare("UPDATE units SET status = 'in_use' WHERE id = ?").run(unit.id);
      db.prepare('UPDATE request_items SET unit_id = ? WHERE id = ?').run(unit.id, item.id);
    }
    db.prepare("UPDATE requests SET status = 'issued', issued_by = ?, issued_at = ?, updated_at = ? WHERE id = ?").run(req.user.id, t, t, r.id);
  })();
  const updated = S.getRequest(r.id);
  addLog({ actorId: req.user.id, subjectUserId: r.user.id, requestId: r.id, equipment: r.equipmentList.join(', '), action: 'Issued (barcode)', approvedBy: approvedBy(r), status: 'IN USE', details: updated.items.map((i) => i.barcode).join(', ') });
  notifyUser(r.user.id, { title: `${r.code} issued to you`, body: `${updated.items.map((i) => `${i.name} (${i.barcode})`).join('\n')}\n\nReturn by ${fmtDateTime(r.toAt)}. Handle with care - damage may result in a fine.`, link: `/requests/${r.id}` });
  res.json({ request: updated });
});

// ---------------- Returns ----------------

router.get('/returns', (req, res) => {
  res.json({ requests: S.listRequests("r.status = 'issued'", [], 'r.to_at ASC') });
});

router.post('/requests/:id/return', (req, res) => {
  const r = loadRequest(req.params.id);
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
  const touched = [];
  db.transaction(() => {
    for (const item of r.items) {
      const ok = okIds.has(item.id);
      db.prepare('UPDATE request_items SET return_ok = ?, damaged = ? WHERE id = ?').run(ok ? 1 : 0, ok ? 0 : 1, item.id);
      const unit = db.prepare('SELECT u.id FROM units u JOIN request_items ri ON ri.unit_id = u.id WHERE ri.id = ?').get(item.id);
      if (unit) {
        if (ok) db.prepare("UPDATE units SET status = 'available' WHERE id = ?").run(unit.id);
        else db.prepare("UPDATE units SET status = 'maintenance', notes = ? WHERE id = ?").run(`${r.code}: ${notes}`.slice(0, 500), unit.id);
      }
      touched.push(item.equipmentId);
    }
    db.prepare("UPDATE requests SET status = 'returned', returned_at = ?, return_verified_by = ?, return_notes = ?, damage_reported = ?, renew_status = CASE WHEN renew_status = 'pending' THEN 'rejected' ELSE renew_status END, updated_at = ? WHERE id = ?")
      .run(t, req.user.id, notes || null, damage ? 1 : 0, t, r.id);
  })();

  const updated = S.getRequest(r.id);
  const late = r.toAt < t;
  addLog({
    actorId: req.user.id, subjectUserId: r.user.id, requestId: r.id, equipment: r.equipmentList.join(', '),
    action: damage ? 'Returned (damage reported)' : late ? 'Returned (OK, late)' : 'Returned (OK)',
    approvedBy: approvedBy(r), status: damage ? 'DAMAGED' : 'CLOSED', details: notes,
  });
  notifyUser(r.user.id, damage
    ? { title: `Return of ${r.code} recorded with damage`, body: `${req.user.name} verified the return and reported an issue:\n${notes}\n\nThe Media Lab will contact you about the damage policy.`, link: `/requests/${r.id}` }
    : { title: `Return verified for ${r.code}`, body: `${req.user.name} confirmed the return checklist. Thank you for handling the equipment with care.`, link: `/requests/${r.id}` });
  S.processNotifyRequests(touched);
  res.json({ request: updated });
});

// ---------------- Inventory ----------------

function inventoryItem(e) {
  const units = db.prepare('SELECT * FROM units WHERE equipment_id = ? ORDER BY barcode').all(e.id);
  const accessoryIds = db.prepare('SELECT accessory_id FROM accessory_links WHERE equipment_id = ?').all(e.id).map((a) => a.accessory_id);
  return {
    ...e,
    accessoryIds,
    units: units.map((u) => ({ id: u.id, barcode: u.barcode, status: u.status, notes: u.notes })),
  };
}

router.get('/inventory', (req, res) => {
  const category = S.CATEGORIES.includes(req.query.category) ? req.query.category : null;
  const equipment = S.listEquipment({ category, q: str(req.query.q, 80) || null, includeInactive: true }).map(inventoryItem);
  res.json({ equipment });
});

router.get('/inventory/:id', (req, res) => {
  const e = S.getEquipment(intId(req.params.id));
  if (!e) fail(404, 'Equipment not found');
  res.json({ equipment: inventoryItem(e) });
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

function setAccessories(equipmentId, ids) {
  if (!Array.isArray(ids)) return;
  db.prepare('DELETE FROM accessory_links WHERE equipment_id = ?').run(equipmentId);
  const ins = db.prepare('INSERT OR IGNORE INTO accessory_links (equipment_id, accessory_id) VALUES (?, ?)');
  for (const raw of ids) {
    const id = Number(raw);
    if (Number.isInteger(id) && id !== equipmentId && db.prepare('SELECT 1 FROM equipment WHERE id = ?').get(id)) ins.run(equipmentId, id);
  }
}

function addUnits(equipmentId, code, count) {
  const existing = db.prepare('SELECT barcode FROM units WHERE equipment_id = ?').all(equipmentId).map((u) => u.barcode);
  let n = existing.reduce((m, b) => Math.max(m, Number(b.split('-').pop()) || 0), 0);
  const ins = db.prepare("INSERT INTO units (equipment_id, barcode, status, created_at) VALUES (?, ?, 'available', ?)");
  const created = [];
  for (let i = 0; i < count; i++) {
    let barcode;
    do {
      n += 1;
      barcode = `${code}-${String(n).padStart(2, '0')}`;
    } while (db.prepare('SELECT 1 FROM units WHERE barcode = ?').get(barcode));
    ins.run(equipmentId, barcode, now());
    created.push(barcode);
  }
  return created;
}

router.post('/equipment', (req, res) => {
  const b = req.body;
  const data = validateEquipmentBody(b);
  const code = str(b.code, 20).toUpperCase();
  if (!/^[A-Z0-9][A-Z0-9-]{1,19}$/.test(code)) fail(400, 'Code must be letters, digits and dashes, e.g. CAM-014', { field: 'code' });
  if (db.prepare('SELECT 1 FROM equipment WHERE code = ?').get(code)) fail(409, `Code ${code} is already used`, { field: 'code' });
  const qty = Number(b.quantity ?? 1);
  if (!Number.isInteger(qty) || qty < 0 || qty > 200) fail(400, 'Quantity must be between 0 and 200', { field: 'quantity' });

  const id = db.transaction(() => {
    const eid = Number(
      db.prepare('INSERT INTO equipment (name, category, subtype, code, description, is_accessory, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(data.name, data.category, data.subtype || '', code, data.description || '', data.is_accessory || 0, now()).lastInsertRowid
    );
    addUnits(eid, code, qty);
    setAccessories(eid, b.accessoryIds);
    return eid;
  })();
  addLog({ actorId: req.user.id, equipment: data.name, action: 'Equipment added', details: `${code} x${qty}` });
  res.status(201).json({ equipment: inventoryItem(S.getEquipment(id)) });
});

router.patch('/equipment/:id', (req, res) => {
  const e = S.getEquipment(intId(req.params.id));
  if (!e) fail(404, 'Equipment not found');
  const data = validateEquipmentBody(req.body, true);
  db.transaction(() => {
    const keys = Object.keys(data);
    if (keys.length) db.prepare(`UPDATE equipment SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`).run(...keys.map((k) => data[k]), e.id);
    setAccessories(e.id, req.body.accessoryIds);
  })();
  addLog({ actorId: req.user.id, equipment: data.name || e.name, action: 'Equipment updated' });
  res.json({ equipment: inventoryItem(S.getEquipment(e.id)) });
});

router.post('/equipment/:id/units', (req, res) => {
  const e = S.getEquipment(intId(req.params.id));
  if (!e) fail(404, 'Equipment not found');
  const count = Number(req.body.count);
  if (!Number.isInteger(count) || count < 1 || count > 100) fail(400, 'Add between 1 and 100 units');
  const created = db.transaction(() => addUnits(e.id, e.code, count))();
  addLog({ actorId: req.user.id, equipment: e.name, action: 'Units added', details: created.join(', ') });
  S.processNotifyRequests([e.id]);
  res.json({ equipment: inventoryItem(S.getEquipment(e.id)), created });
});

router.patch('/units/:id', (req, res) => {
  const unit = db.prepare('SELECT u.*, e.name FROM units u JOIN equipment e ON e.id = u.equipment_id WHERE u.id = ?').get(intId(req.params.id));
  if (!unit) fail(404, 'Unit not found');
  const status = req.body.status;
  if (status !== undefined) {
    if (!['available', 'maintenance', 'retired'].includes(status)) fail(400, 'Invalid status');
    if (unit.status === 'in_use') fail(409, 'This unit is issued. Verify its return first.');
  }
  const notes = req.body.notes !== undefined ? str(req.body.notes, 500) : unit.notes;
  db.prepare('UPDATE units SET status = ?, notes = ? WHERE id = ?').run(status ?? unit.status, notes, unit.id);
  if (status && status !== unit.status) {
    addLog({ actorId: req.user.id, equipment: `${unit.name} (${unit.barcode})`, action: `Unit marked ${status}`, status: status.toUpperCase(), details: notes });
    if (status === 'available') S.processNotifyRequests([unit.equipment_id]);
  }
  res.json({ ok: true });
});

router.get('/units/lookup', (req, res) => {
  const barcode = str(req.query.barcode, 40).toUpperCase();
  const unit = db.prepare('SELECT * FROM units WHERE barcode = ?').get(barcode);
  if (!unit) fail(404, `No item with barcode ${barcode}`);
  const holder = db
    .prepare("SELECT ri.request_id FROM request_items ri JOIN requests r ON r.id = ri.request_id WHERE ri.unit_id = ? AND r.status = 'issued'")
    .get(unit.id);
  res.json({
    unit: { id: unit.id, barcode: unit.barcode, status: unit.status, notes: unit.notes },
    equipment: S.getEquipment(unit.equipment_id),
    request: holder ? S.getRequest(holder.request_id) : null,
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

function queryLogs(q) {
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
    where.push('(su.name LIKE ? OR l.equipment LIKE ? OR l.action LIKE ? OR rq.code LIKE ?)');
    p.push(...Array(4).fill(`%${search}%`));
  }
  return db
    .prepare(
      `SELECT l.*, su.name AS user_name, su.profession AS user_profession, ac.name AS actor_name, rq.code AS request_code
       FROM logs l
       LEFT JOIN users su ON su.id = l.subject_user_id
       LEFT JOIN users ac ON ac.id = l.actor_id
       LEFT JOIN requests rq ON rq.id = l.request_id
       ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
       ORDER BY l.at DESC LIMIT 2000`
    )
    .all(...p)
    .map(fmtLog);
}

router.get('/logs', (req, res) => {
  const logs = queryLogs(req.query);
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

// ---------------- Users ----------------

router.get('/users', (req, res) => {
  const where = [];
  const p = [];
  const q = str(req.query.q, 80);
  if (q) {
    where.push('(name LIKE ? OR email LIKE ? OR department LIKE ?)');
    p.push(`%${q}%`, `%${q}%`, `%${q}%`);
  }
  if (req.query.type === 'student') where.push("profession = 'student' AND role = 'user'");
  else if (req.query.type === 'staff') where.push("profession IN ('faculty', 'staff') AND role = 'user'");
  const users = db
    .prepare(
      `SELECT u.*, (SELECT COUNT(*) FROM requests r WHERE r.user_id = u.id AND r.status <> 'draft') AS request_count
       FROM users u ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY u.role DESC, u.name COLLATE NOCASE LIMIT 1000`
    )
    .all(...p);
  res.json({
    users: users.map((u) => ({
      id: u.id, name: u.name, email: u.email, phone: u.phone, profession: u.profession, batch: u.batch,
      department: u.department, school: u.school, role: u.role, approvalLevel: u.approval_level,
      active: !!u.active, createdAt: u.created_at, requestCount: u.request_count,
    })),
  });
});

router.patch('/users/:id', (req, res) => {
  requireLevel2(req);
  const id = intId(req.params.id);
  const u = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
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
  db.prepare('UPDATE users SET role = ?, approval_level = ?, active = ? WHERE id = ?').run(role, level, active, id);
  if (!active) db.prepare('DELETE FROM sessions WHERE user_id = ?').run(id);
  addLog({ actorId: req.user.id, subjectUserId: id, action: 'Access changed', details: `${role}${level ? ` L${level}` : ''}${active ? '' : ', disabled'}` });
  res.json({ ok: true });
});

module.exports = router;
