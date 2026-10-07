const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env'), quiet: true });

const port = Number(process.env.PORT) || 3000;
const isProd = process.env.NODE_ENV === 'production';
const list = (v) => String(v || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);

module.exports = {
  isProd,
  port,
  appUrl: (
    process.env.APP_URL ||
    (process.env.VERCEL_PROJECT_PRODUCTION_URL && `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`) ||
    `http://localhost:${port}`
  ).replace(/\/$/, ''),
  // Supabase Postgres connection string (the Vercel Supabase integration sets POSTGRES_URL).
  databaseUrl: process.env.DATABASE_URL || process.env.POSTGRES_URL || '',
  cronSecret: process.env.CRON_SECRET || '',
  timeZone: process.env.TIME_ZONE || 'Asia/Kolkata',

  // Only these email domains (and their subdomains) may register. Empty = any domain.
  allowedDomains: list(process.env.ALLOWED_EMAIL_DOMAINS ?? 'alliance.edu.in'),
  defaultCountryCode: process.env.DEFAULT_COUNTRY_CODE || '+91',

  // Demo mode: OTP codes are shown in the browser (and demo logins on the login page).
  // On by default in development, or in production until SMTP is configured; DEV_SHOW_OTP overrides.
  devShowOtp: process.env.DEV_SHOW_OTP ? process.env.DEV_SHOW_OTP === 'true' : !isProd || !process.env.SMTP_HOST,

  sessionDays: Number(process.env.SESSION_DAYS) || 7,
  maxRequestDays: Number(process.env.MAX_REQUEST_DAYS) || 14,
  dueSoonHours: Number(process.env.DUE_SOON_HOURS) || 2,

  smtp: {
    host: process.env.SMTP_HOST || '',
    port: Number(process.env.SMTP_PORT) || 587,
    user: process.env.SMTP_USER || '',
    pass: process.env.SMTP_PASS || '',
  },
  mailFrom: process.env.MAIL_FROM || 'MediaLab <no-reply@medialab.local>',

  twilio: {
    sid: process.env.TWILIO_ACCOUNT_SID || '',
    token: process.env.TWILIO_AUTH_TOKEN || '',
    from: process.env.TWILIO_FROM || '',
  },

  seedPasswords: {
    admin: process.env.SEED_ADMIN_PASSWORD || 'Admin@1234',
    user: process.env.SEED_USER_PASSWORD || 'Student@1234',
  },
};
