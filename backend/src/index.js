require('dotenv').config();

const validateEnv = require('./utils/validateEnv');
validateEnv();

const webpush = require('web-push');
if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) {
  webpush.setVapidDetails(
    `mailto:${process.env.VAPID_EMAIL || 'admin@afripay.app'}`,
    process.env.VAPID_PUBLIC_KEY,
    process.env.VAPID_PRIVATE_KEY
  );
}

const app = require('./app');
const db = require('./db');
const logger = require('./utils/logger');
const { initStreams } = require('./services/horizonWorker');

const PORT = process.env.PORT || 5000;

const server = app.listen(PORT, () => {
  logger.info(`Server running on port ${PORT}`, { port: PORT });
  initStreams();
});

const SHUTDOWN_TIMEOUT_MS = 30_000;

async function shutdown(signal) {
  logger.info(`${signal} received — shutting down gracefully`);

  const forceExit = setTimeout(() => {
    logger.error('Shutdown timeout exceeded — forcing exit');
    process.exit(1);
  }, SHUTDOWN_TIMEOUT_MS).unref();

  server.close(async () => {
    clearTimeout(forceExit);
    try {
      await db.pool.end();
      logger.info('DB pool closed');
    } catch (err) {
      logger.error('Error closing DB pool', { message: err.message });
    }
    process.exit(0);
  });
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

module.exports = { app, server, shutdown };
