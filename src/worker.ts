import { Agent } from './agent/agent.js';
import { BookingService } from './booking/service.js';
import { assertProductionSafety, config } from './config.js';
import { closePool } from './db/pool.js';
import { LabClient } from './lab/client.js';
import { MockLlmClient } from './llm/mock.js';
import { OpenRouterClient } from './llm/openrouter.js';
import { WhatsAppSender } from './whatsapp/sender.js';
import { WorkerRuntime } from './worker/runtime.js';
import { log } from './util/log.js';

function buildRuntime(): WorkerRuntime {
  const lab = new LabClient();
  const booking = new BookingService(lab);
  const primary = config.llm.provider === 'openrouter' ? new OpenRouterClient() : new MockLlmClient();
  const fallback = new MockLlmClient();
  const agent = new Agent({ llm: primary, fallback, lab, booking });

  log.info('worker llm provider', {
    primary: primary.provider,
    model: config.llm.provider === 'openrouter' ? config.llm.model : 'deterministic-policy',
  });

  return new WorkerRuntime({ agent, sender: new WhatsAppSender() });
}

async function main(): Promise<void> {
  assertProductionSafety();
  const runtime = buildRuntime();
  runtime.start();

  const shutdown = async (signal: string): Promise<void> => {
    log.info('shutting down worker', { signal });
    await runtime.stop();
    await closePool().catch(() => undefined);
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((err) => {
  log.error('worker failed to start', { error: (err as Error).message });
  process.exit(1);
});
