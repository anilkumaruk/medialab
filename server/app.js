// Express app shared by local `npm start` (server/index.js) and Vercel (api/index.js).
const path = require('path');
const express = require('express');
const config = require('./config');
const { HttpError } = require('./util');
const { ensureReady } = require('./db');
const { loadUser } = require('./auth');
const { runAlerts } = require('./jobs');

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);

app.use((req, res, next) => {
  res.set({
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'same-origin',
  });
  next();
});

// Vercel Cron calls this with "Authorization: Bearer <CRON_SECRET>".
app.get('/api/cron/alerts', async (req, res) => {
  if (!config.cronSecret || req.get('Authorization') !== `Bearer ${config.cronSecret}`) throw new HttpError(401, 'Unauthorized');
  await ensureReady();
  await runAlerts();
  res.json({ ok: true });
});

app.use(express.json({ limit: '100kb' }));
app.use((req, res, next) => {
  if (!req.body) req.body = {};
  next();
});

// CSRF guard: state-changing API calls must carry a custom header, which
// browsers will not send cross-origin without a CORS preflight we never allow.
app.use('/api', async (req, res, next) => {
  if (req.method !== 'GET' && req.get('X-Requested-With') !== 'medialab') return next(new HttpError(403, 'Bad request origin'));
  res.set('Cache-Control', 'no-store');
  await ensureReady();
  next();
});

app.use('/api', loadUser);
app.use('/api/auth', require('./routes/auth'));
app.use('/api/admin', require('./routes/admin'));
app.use('/api', require('./routes/user'));
app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));

// Locally Express serves the front end; on Vercel the CDN serves public/.
app.use(express.static(path.join(__dirname, '..', 'public'), { extensions: ['html'] }));

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  if (err instanceof HttpError) return res.status(err.status).json({ error: err.message, ...(err.extra || {}) });
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Invalid JSON' });
  console.error(err);
  res.status(500).json({ error: 'Something went wrong. Please try again.' });
});

module.exports = app;
