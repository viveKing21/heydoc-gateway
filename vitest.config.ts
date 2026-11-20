import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    testTimeout: 120_000,
    hookTimeout: 60_000,
    pool: 'forks',
    env: {
      NODE_ENV: 'test',
      DATABASE_URL:
        process.env.TEST_DATABASE_URL ?? 'postgres://heydoc:heydoc@localhost:5433/heydoc_test',
      WHATSAPP_APP_SECRET: 'test-secret',
      WHATSAPP_VERIFY_TOKEN: 'test-verify-token',
      DEV_MODE: 'true',
      MOCK_WHATSAPP: 'true',
      LLM_PROVIDER: 'mock',
      LAB_FAIL_RATE: '0',
      LAB_FAIL_MODE: 'none',
      LAB_MIN_LATENCY_MS: '0',
      LAB_MAX_LATENCY_MS: '0',
      RATE_LIMIT_PER_MINUTE: '1000',
      WORKER_CONCURRENCY: '4',
      POLL_INTERVAL_MS: '20',
      OUTBOX_POLL_INTERVAL_MS: '20',
      JOB_BACKOFF_BASE_MS: '50',
      JOB_MAX_ATTEMPTS: '3',
      LOG_LEVEL: 'error',
    },
  },
});
