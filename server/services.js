// Shared queries for equipment availability and requests.
const config = require('./config');
const { db, now } = require('./db');
const { fmtDateTime } = require('./util');
const { notifyUser } = require('./notify');

const CATEGORIES = ['Cameras', 'Lenses', 'Lights', 'Audio', 'Accessories'];

// "reserved" = items in approved requests that have not been collected yet.
const COUNT_COLS = `
  (SELECT COUNT(*) FROM units u WHERE u.equipment_id = e.id AND u.status <> 'retired') AS total,
  (SELECT COUNT(*) FROM units u WHERE u.equipment_id = e.id AND u.status = 'available') AS on_shelf,
  (SELECT COUNT(*) FROM units u WHERE u.equipment_id = e.id AND u.status = 'in_use') AS in_use,
  (SELECT COUNT(*) FROM units u WHERE u.equipment_id = e.id AND u.status = 'maintenance') AS maintenance,
  (SELECT COUNT(*) FROM request_items ri JOIN requests r ON r.id = ri.request_id
     WHERE ri.equipment_id = e.id AND r.status = 'approved') AS reserved`;

const NOTIFYING_COL = `EXISTS (SELECT 1 FROM notify_requests n WHERE n.equipment_id = e.id AND n.user_id = ? AND n.notified_at IS NULL) AS notifying`;

function fmtEquipment(e) {
  return {
    id: e.id,
    name: e.name,
    category: e.category,
    subtype: e.subtype,
    code: e.code,
    description: e.description,
    isAccessory: !!e.is_accessory,
    active: !!e.active,
    total: e.total,
    available: Math.max(0, e.on_shelf - e.reserved),
    onShelf: e.on_shelf,
    inUse: e.in_use,
    maintenance: e.maintenance,
    reserved: e.reserved,
    notifying: !!e.notifying,
  };
}

async function listEquipment({ category = null, q = null, userId = 0, includeInactive = false } = {}) {
  const where = [];
  const params = [userId];
  if (!includeInactive) where.push('e.active = 1');
  if (category) {
    where.push('e.category = ?');
    params.push(category);
  }
  if (q) {
    where.push('(e.name ILIKE ? OR e.code ILIKE ? OR e.subtype ILIKE ? OR e.category ILIKE ?)');
    const like = `%${q}%`;
    params.push(like, like, like, like);
  }
  const sql = `SELECT e.*, ${COUNT_COLS}, ${NOTIFYING_COL} FROM equipment e
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY e.is_accessory, lower(e.name)`;
  return (await db.all(sql, params)).map(fmtEquipment);
}

async function getEquipment(id, userId = 0) {
  const row = await db.get(`SELECT e.*, ${COUNT_COLS}, ${NOTIFYING_COL} FROM equipment e WHERE e.id = ?`, [userId, id]);
  return row ? fmtEquipment(row) : null;
}

async function accessoriesOf(id, userId = 0) {
  const rows = await db.all(
    `SELECT e.*, ${COUNT_COLS}, ${NOTIFYING_COL} FROM accessory_links a JOIN equipment e ON e.id = a.accessory_id
     WHERE a.equipment_id = ? AND e.active = 1 ORDER BY e.name`,
    [userId, id]
  );
  return rows.map(fmtEquipment);
}

// Tell users who asked "Notify when available" once stock is back.
async function processNotifyRequests(equipmentIds) {
  for (const id of new Set(equipmentIds)) {
    const e = await getEquipment(id);
    if (!e || e.available < 1) continue;
    const subs = await db.all('SELECT * FROM notify_requests WHERE equipment_id = ? AND notified_at IS NULL', [id]);
    for (const s of subs) {
      await notifyUser(s.user_id, {
        title: `${e.name} is available again`,
        body: `${e.available} of ${e.total} ${e.name} are now available at the Media Lab. Request it before it's taken.`,
        link: `/inventory/${e.category}`,
      });
      await db.run('UPDATE notify_requests SET notified_at = ? WHERE id = ?', [now(), s.id]);
    }
  }
}

// ---------------- Requests ----------------

const REQUEST_BASE = `
  SELECT r.*, u.name AS user_name, u.email AS user_email, u.phone AS user_phone, u.profession AS user_profession,
         u.department AS user_department, u.batch AS user_batch, u.school AS user_school,
         a1.name AS l1_name, a2.name AS l2_name, iu.name AS issued_by_name, rv.name AS verified_by_name, rn.name AS renew_by_name
  FROM requests r
  JOIN users u ON u.id = r.user_id
  LEFT JOIN users a1 ON a1.id = r.l1_by
  LEFT JOIN users a2 ON a2.id = r.l2_by
  LEFT JOIN users iu ON iu.id = r.issued_by
  LEFT JOIN users rv ON rv.id = r.return_verified_by
  LEFT JOIN users rn ON rn.id = r.renew_by`;

function summarize(items) {
  const counts = new Map();
  for (const it of items) counts.set(it.name, (counts.get(it.name) || 0) + 1);
  return [...counts].map(([name, n]) => (n > 1 ? `${name} x${n}` : name));
}

async function hydrate(rows) {
  if (!rows.length) return [];
  const ids = rows.map((r) => r.id);
  const items = await db.all(
    `SELECT ri.*, e.name, e.code, e.category, e.is_accessory, un.barcode
     FROM request_items ri JOIN equipment e ON e.id = ri.equipment_id LEFT JOIN units un ON un.id = ri.unit_id
     WHERE ri.request_id = ANY(?) ORDER BY e.is_accessory, ri.id`,
    [ids]
  );
  const byReq = new Map();
  for (const it of items) {
    if (!byReq.has(it.request_id)) byReq.set(it.request_id, []);
    byReq.get(it.request_id).push({
      id: it.id,
      equipmentId: it.equipment_id,
      name: it.name,
      code: it.code,
      category: it.category,
      isAccessory: !!it.is_accessory,
      barcode: it.barcode,
      returnOk: it.return_ok == null ? null : !!it.return_ok,
      damaged: !!it.damaged,
    });
  }
  const t = now();
  return rows.map((r) => {
    const its = byReq.get(r.id) || [];
    const names = summarize(its);
    return {
      id: r.id,
      code: r.code,
      status: r.status,
      fromAt: r.from_at,
      toAt: r.to_at,
      purpose: r.purpose,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
      submittedAt: r.submitted_at,
      user: {
        id: r.user_id,
        name: r.user_name,
        email: r.user_email,
        phone: r.user_phone,
        profession: r.user_profession,
        department: r.user_department,
        batch: r.user_batch,
        school: r.user_school,
      },
      l1: r.l1_decision ? { by: r.l1_name, at: r.l1_at, decision: r.l1_decision, remarks: r.l1_remarks } : null,
      l2: r.l2_decision ? { by: r.l2_name, at: r.l2_at, decision: r.l2_decision, remarks: r.l2_remarks } : null,
      issuedBy: r.issued_by_name,
      issuedAt: r.issued_at,
      returnedAt: r.returned_at,
      verifiedBy: r.verified_by_name,
      returnNotes: r.return_notes,
      damageReported: !!r.damage_reported,
      cancelledAt: r.cancelled_at,
      renewal: r.renew_status
        ? { to: r.renew_to, reason: r.renew_reason, status: r.renew_status, by: r.renew_by_name, at: r.renew_at, remarks: r.renew_remarks }
        : null,
      overdue: r.status === 'issued' && r.to_at < t,
      items: its,
      equipmentList: names,
      summary: names.length ? names[0] + (names.length > 1 ? ` + ${names.length - 1} more` : '') : 'No items',
    };
  });
}

async function listRequests(where = '1=1', params = [], order = 'r.id DESC', limit = 500) {
  return hydrate(await db.all(`${REQUEST_BASE} WHERE (${where}) ORDER BY ${order} LIMIT ${Number(limit)}`, params));
}

async function getRequest(id) {
  return (await listRequests('r.id = ?', [id]))[0] || null;
}

async function approverNames(level) {
  const rows = await db.all("SELECT name FROM users WHERE role = 'admin' AND active = 1 AND approval_level = ? ORDER BY name", [level]);
  return rows.map((r) => r.name);
}

function requestDetailsText(r) {
  return [
    `Request: ${r.code}`,
    `Requested by: ${r.user.name} (${r.user.profession}${r.user.department ? ', ' + r.user.department : ''}${r.user.batch ? ', ' + r.user.batch : ''})`,
    `Email / phone: ${r.user.email} / ${r.user.phone}`,
    `Equipment: ${r.equipmentList.join(', ')}`,
    `Duration: ${fmtDateTime(r.fromAt)} to ${fmtDateTime(r.toAt)}`,
    `Purpose: ${r.purpose}`,
  ].join('\n');
}

module.exports = {
  CATEGORIES,
  listEquipment,
  getEquipment,
  accessoriesOf,
  processNotifyRequests,
  listRequests,
  getRequest,
  approverNames,
  requestDetailsText,
  maxDays: config.maxRequestDays,
};
