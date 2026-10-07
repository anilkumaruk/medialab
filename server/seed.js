// Seeds approvers, a demo student and the starting inventory on first run.
// `npm run reset` drops every table and seeds again.
const config = require('./config');
const bcrypt = require('bcryptjs');
const { db, now } = require('./db');

const domain = config.allowedDomains[0] || 'alliance.edu.in';

const ADMINS = [
  { name: 'Ganesh', email: `ganesh@${domain}`, level: 1 },
  { name: 'Akash', email: `akash@${domain}`, level: 1 },
  { name: 'Sanjay', email: `sanjay@${domain}`, level: 1 },
  { name: 'Pritha', email: `pritha@${domain}`, level: 2 },
];

// [name, category, subtype, code, units, isAccessory, accessoryCodes, maintenanceUnits]
const EQUIPMENT = [
  ['Battery LP-E6NH', 'Accessories', 'Battery', 'ACC-112', 8, 1],
  ['Charger LC-E6', 'Accessories', 'Charger', 'ACC-113', 4, 1],
  ['Memory card SD 128GB', 'Accessories', 'Storage', 'ACC-120', 12, 1],
  ['Battery NP-FZ100', 'Accessories', 'Battery', 'ACC-130', 6, 1],
  ['Charger BC-QZ1', 'Accessories', 'Charger', 'ACC-131', 4, 1],
  ['GoPro Enduro Battery', 'Accessories', 'Battery', 'ACC-140', 6, 1],
  ['microSD 128GB', 'Accessories', 'Storage', 'ACC-141', 8, 1],
  ['DJI Ronin RS3 Gimbal', 'Accessories', 'Stabilizer', 'ACC-200', 3, 0],
  ['Manfrotto Tripod', 'Accessories', 'Support', 'ACC-210', 6, 0],

  ['Canon EOS R6', 'Cameras', 'Mirrorless', 'CAM-014', 10, 0, ['ACC-112', 'ACC-113', 'ACC-120']],
  ['Sony A7 III', 'Cameras', 'Mirrorless', 'CAM-021', 5, 0, ['ACC-130', 'ACC-131', 'ACC-120']],
  ['Blackmagic 6K', 'Cameras', 'Cinema', 'CAM-030', 2, 0, ['ACC-120']],
  ['Canon 80D', 'Cameras', 'DSLR', 'CAM-008', 6, 0, ['ACC-112', 'ACC-113', 'ACC-120']],
  ['Sony FX3', 'Cameras', 'Cinema', 'CAM-025', 2, 0, ['ACC-130', 'ACC-131', 'ACC-120']],
  ['GoPro Hero 12', 'Cameras', 'Action', 'CAM-040', 5, 0, ['ACC-140', 'ACC-141']],

  ['50mm f/1.8', 'Lenses', 'Prime', 'LNS-009', 1, 0, [], 1],
  ['24-70mm f/2.8', 'Lenses', 'Zoom', 'LNS-012', 3, 0],
  ['70-200mm f/4', 'Lenses', 'Telephoto', 'LNS-015', 2, 0],
  ['16-35mm f/4', 'Lenses', 'Wide zoom', 'LNS-018', 2, 0],

  ['Aputure 300d', 'Lights', 'LED COB', 'LGT-003', 2, 0],
  ['Godox SL60W', 'Lights', 'LED COB', 'LGT-006', 4, 0],
  ['LED Panel Kit', 'Lights', 'Panel', 'LGT-010', 6, 0],

  ['Rode Wireless GO II', 'Audio', 'Wireless mic', 'AUD-007', 4, 0],
  ['Zoom H6 Recorder', 'Audio', 'Recorder', 'AUD-010', 3, 0],
  ['Rode NTG4+ Shotgun', 'Audio', 'Shotgun mic', 'AUD-012', 2, 0],
];

async function seed(tx) {
  const t = now();
  const adminHash = await bcrypt.hash(config.seedPasswords.admin, 10);
  const userHash = await bcrypt.hash(config.seedPasswords.user, 10);
  const insUser = `INSERT INTO users (name, email, phone, profession, batch, department, school, password_hash, role, approval_level,
       email_verified, phone_verified, terms_accepted_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 1, ?, ?)`;
  for (const [i, a] of ADMINS.entries()) {
    await tx.run(insUser, [a.name, a.email, `+9190000000${i + 1}`, 'faculty', null, 'Media Lab', 'Media Studies', adminHash, 'admin', a.level, t, t]);
  }
  await tx.run(insUser, ['Anil Kumar', `anil.kumar@${domain}`, '+919800000010', 'student', '2024-2028', 'CSE', 'Advanced Computing', userHash, 'user', 0, t, t]);

  const ids = {};
  for (const [name, category, subtype, code, count, isAcc, , maint = 0] of EQUIPMENT) {
    const { id } = await tx.get('INSERT INTO equipment (name, category, subtype, code, is_accessory, created_at) VALUES (?, ?, ?, ?, ?, ?) RETURNING id', [name, category, subtype, code, isAcc, t]);
    ids[code] = id;
    const barcodes = Array.from({ length: count }, (_, i) => `${code}-${String(i + 1).padStart(2, '0')}`);
    const statuses = barcodes.map((_, i) => (i < maint ? 'maintenance' : 'available'));
    const notes = barcodes.map((_, i) => (i < maint ? 'Aperture ring sticking - sent for service' : ''));
    await tx.run(
      'INSERT INTO units (equipment_id, barcode, status, notes, created_at) SELECT ?, unnest(?::text[]), unnest(?::text[]), unnest(?::text[]), ?',
      [id, barcodes, statuses, notes, t]
    );
  }
  for (const [, , , code, , , acc = []] of EQUIPMENT) {
    for (const a of acc) await tx.run('INSERT INTO accessory_links (equipment_id, accessory_id) VALUES (?, ?)', [ids[code], ids[a]]);
  }

  console.log(`
  Seeded MediaLab database.
    Level 1 approvers : ${ADMINS.filter((a) => a.level === 1).map((a) => a.email).join(', ')}
    Level 2 approver  : ${ADMINS.find((a) => a.level === 2).email}
    Admin password    : ${config.seedPasswords.admin}
    Demo student      : anil.kumar@${domain} / ${config.seedPasswords.user}
  Change these passwords (or set SEED_* before first run) for real use.
`);
}

async function seedIfEmpty() {
  return db.tx(async (tx) => {
    await tx.raw('SELECT pg_advisory_xact_lock(724002)'); // only one instance seeds
    const { c } = await tx.get('SELECT COUNT(*) AS c FROM users');
    if (c > 0) return false;
    await seed(tx);
    return true;
  });
}

if (require.main === module) {
  (async () => {
    const { dropAll, ensureReady, pool } = require('./db');
    if (process.argv.includes('--reset')) {
      await dropAll();
      console.log('All tables dropped.');
    }
    await ensureReady();
    await pool.end();
  })().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}

module.exports = { seedIfEmpty };
