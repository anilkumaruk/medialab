const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env'), quiet: true });

const port = Number(process.env.PORT) || 3000;
const isProd = process.env.NODE_ENV === 'production';
const list = (v) => String(v || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);

module.exports = {
  isProd,
  port,
  appUrl: (process.env.APP_URL || process.env.RENDER_EXTERNAL_URL || `http://localhost:${port}`).replace(/\/$/, ''),
  dataDir: process.env.DATA_DIR || path.join(__dirname, '..', 'data'),
  timeZone: process.env.TIME_ZONE || 'Asia/Kolkata',

  // Only these email domains (and their subdomains) may register. Empty = any domain.
  allowedDomains: list(process.env.ALLOWED_EMAIL_DOMAINS ?? 'alliance.edu.in'),
  defaultCountryCode: process.env.DEFAULT_COUNTRY_CODE || '+91',

  // OTP codes are returned to the browser so you can test without SMTP/SMS: on by default in
  // development, and in production only when DEV_SHOW_OTP=true (e.g. a team demo).
  devShowOtp: process.env.DEV_SHOW_OTP === 'true' || (!isProd && process.env.DEV_SHOW_OTP !== 'false'),

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
