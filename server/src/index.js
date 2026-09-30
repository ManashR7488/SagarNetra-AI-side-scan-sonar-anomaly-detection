import { createApp } from './app.js';
import { connectDB, disconnectDB } from './config/db.js';
import { config } from './config/env.js';
import { logger } from './utils/logger.js';

async function main() {
  await connectDB();
  const server = createApp().listen(config.port, () => {
    logger.info(`SonarScan API on http://localhost:${config.port} (AI service: ${config.ai.url}, storage: ${config.storage.provider})`);
    if (config.storage.provider !== config.storage.requestedProvider) {
      logger.warn('Cloudinary credentials are not set in server/.env; files are stored on local disk (server/uploads).');
    }
  });
  // Analyses of long survey strips can take minutes on CPU.
  server.requestTimeout = config.ai.timeoutMs + 60_000;
  server.headersTimeout = config.ai.timeoutMs + 65_000;

  const shutdown = (signal) => {
    logger.info(`${signal} received, shutting down`);
    server.close(async () => {
      await disconnectDB();
      process.exit(0);
    });
    setTimeout(() => process.exit(1), 10_000).unref();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  logger.error('Failed to start server:', err);
  process.exit(1);
});
