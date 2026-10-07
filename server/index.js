// Local / long-running server. On Vercel, api/index.js is used instead.
const config = require('./config');
const app = require('./app');
const { ensureReady } = require('./db');
const { startJobs } = require('./jobs');

ensureReady()
  .then(() => {
    startJobs();
    app.listen(config.port, () => {
      console.log(`MediaLab running at ${config.appUrl}`);
      if (config.devShowOtp) console.log('Demo mode: OTP codes are shown in the browser and printed here.');
    });
  })
  .catch((e) => {
    console.error('Could not connect to the database:', e.message);
    process.exit(1);
  });
