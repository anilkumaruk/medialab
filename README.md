# MediaLab – Media Equipment Management Platform

One platform for equipment **Request → Approve (L1, L2) → Barcode Issue → Alert → Verify Return → Log**.

## Run it locally

1. Create a free project at [supabase.com](https://supabase.com) (region: Mumbai).
2. Copy `.env.example` to `.env` and set `DATABASE_URL`. In Supabase, open **Connect → Transaction pooler** and copy that string.
3. Start the app:

```bash
npm install
npm run dev        # http://localhost:3000
```

On first start, the tables are created in Supabase and seeded:

| Role | Login | Password |
|---|---|---|
| Level 1 approvers | ganesh@ / akash@ / sanjay@alliance.edu.in | `Admin@1234` |
| Level 2 approver | pritha@alliance.edu.in | `Admin@1234` |
| Demo student | anil.kumar@alliance.edu.in | `Student@1234` |

`npm run reset` drops all tables and seeds again. **This deletes all data.**

## Deploy on Vercel

1. In Vercel, click **Add New → Project** and import this GitHub repo. Leave the defaults: framework "Other", no build command.
2. Under **Settings → Environment Variables**, add `DATABASE_URL` (the Supabase transaction-pooler string). Instead, you can connect Supabase under **Storage**, which sets `POSTGRES_URL` for you.
3. Optionally add `CRON_SECRET` (any long random string) so the daily alert cron runs. Add SMTP and Twilio settings to send real emails and SMS.
4. Redeploy. The first request creates the tables and seeds the demo data.

While SMTP isn't configured, demo mode is on: OTP codes appear on screen. Overdue and due-soon alerts run whenever someone uses the app, and also once a day from Vercel Cron.

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

Node.js + Express 5, Postgres (Supabase, via `pg`), and a vanilla JS front end with no build step. Hosted on Vercel.

- `server/app.js`: the Express app. `server/index.js` runs it locally; `api/index.js` runs it as the Vercel function.
- `server/`: API routes (`routes/auth.js`, `routes/user.js`, `routes/admin.js`), schema (`db.js`), alerts (`jobs.js`), seed data (`seed.js`)
- `public/`: single-page app (`js/pages/*`) and design system (`css/app.css`), served by Vercel's CDN
