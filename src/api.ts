import { assertProductionSafety, config } from './config.js';
import { buildApp } from './http/app.js';
import { closePool } from './db/pool.js';
import { log } from './util/log.js';

async function main(): Promise<void> {
  assertProductionSafety();
  const app = await buildApp({ logger: true });
  await app.listen({ port: config.port, host: '0.0.0.0' });
  log.info('api listening', { port: config.port, devMode: config.devMode });

  const shutdown = async (signal: string): Promise<void> => {
    log.info('shutting down api', { signal });
    await app.close().catch(() => undefined);
    await closePool().catch(() => undefined);
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((err) => {
  log.error('api failed to start', { error: (err as Error).message });
  process.exit(1);
});
