# MediaLab – Media Equipment Management Platform

One platform for equipment **Request → Approve (L1, L2) → Barcode Issue → Alert → Verify Return → Log**.

## Run it

```bash
npm install
npm run dev        # http://localhost:3000  (auto-restarts on server changes)
```

On first start the database (`data/medialab.db`) is created and seeded:

| Role | Login | Password |
|---|---|---|
| Level 1 approvers | ganesh@ / akash@ / sanjay@alliance.edu.in | `Admin@1234` |
| Level 2 approver | pritha@alliance.edu.in | `Admin@1234` |
| Demo student | anil.kumar@alliance.edu.in | `Student@1234` |

`npm run reset` wipes the database and seeds again.

In development, OTP codes appear in a toast and in the server console, and emails are printed to the console. Add SMTP and Twilio settings in `.env` (see `.env.example`) to send them for real.

## Features

**Students / staff**
- Registration with institution-email check, separate email and phone OTPs (30s resend), terms and damage-policy gate
- Login with captcha, forgot-password by email code
- Live inventory by category with availability counts (e.g. 7/10), search, and "Notify when available"
- Smart accessory prompt: selecting a camera offers its battery, charger and memory card
- Request builder: quantities, date & time range with week strip, purpose, save draft / submit
- My Requests, request timeline, cancel, renewals, history
- Duration alerts (due within 2 hours / overdue) and "return verified" notices, in-app and by email

**Admins**
- Dashboard: pending L1/L2, ready to issue, in use, overdue, inventory stats, recent activity
- Two-level approval: L1 (remarks compulsory) → L2 (remarks optional); requests are emailed to approvers
- Barcode issue: scan each unit (USB scanners work like keyboards) and the server checks every unit
- Return checklist: scan to find the request, tick items, then OK to confirm or Report Damage (damaged items go to maintenance)
- Inventory: add equipment and units, link accessories, set unit status, barcode lookup, printable Code 128 labels
- Logs filtered by student, staff, person and date range; export as CSV or PDF (print)
- Users: Level 2 admins assign roles and approval levels, or disable accounts

## Stack

Node.js + Express 5, SQLite (better-sqlite3), vanilla JS front end with no build step.

- `server/`: API (`routes/auth.js`, `routes/user.js`, `routes/admin.js`), schema (`db.js`), alerts job (`jobs.js`), seed data (`seed.js`)
- `public/`: single-page app (`js/pages/*`), design system (`css/app.css`)

## Deploying

Set `NODE_ENV=production`, `APP_URL`, SMTP and Twilio, and new `SEED_*` passwords before first start. Serve it over HTTPS (session cookies are `Secure` in production) behind a proxy with `TRUST_PROXY=1`, and back up `data/medialab.db`.

> Tip: this folder is inside iCloud Drive. iCloud can slow down or corrupt `node_modules` and the live SQLite file. For real use, keep the project outside iCloud, or set `DATA_DIR` to a local path.
# medialab
