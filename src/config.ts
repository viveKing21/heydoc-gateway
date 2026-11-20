import 'dotenv/config';

function str(name: string, fallback: string): string {
  const v = process.env[name];
  return v !== undefined && v.trim() !== '' ? v.trim() : fallback;
}

function num(name: string, fallback: number): number {
  const v = process.env[name];
  if (v === undefined || v.trim() === '') return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function bool(name: string, fallback: boolean): boolean {
  const v = process.env[name];
  if (v === undefined) return fallback;
  return ['1', 'true', 'yes', 'on'].includes(v.trim().toLowerCase());
}

export type LlmProvider = 'mock' | 'openrouter';

export const config = {
  nodeEnv: str('NODE_ENV', 'development'),
  port: num('PORT', 3000),
  logLevel: str('LOG_LEVEL', 'info'),
  databaseUrl: str('DATABASE_URL', 'postgres://heydoc:heydoc@localhost:5433/heydoc'),
  pgPoolMax: num('PG_POOL_MAX', 20),
  workerId: str('WORKER_ID', `worker-${process.pid}`),

  appSecret: str('WHATSAPP_APP_SECRET', 'dev-app-secret'),
  verifyToken: str('WHATSAPP_VERIFY_TOKEN', 'dev-verify-token'),
  mockWhatsApp: bool('MOCK_WHATSAPP', true),
  whatsappToken: str('WHATSAPP_TOKEN', ''),
  whatsappPhoneNumberId: str('WHATSAPP_PHONE_NUMBER_ID', ''),

  lab: {
    url: str('LAB_URL', 'http://localhost:4000'),
    timeoutMs: num('LAB_TIMEOUT_MS', 2000),
    slotsTimeoutMs: num('LAB_SLOTS_TIMEOUT_MS', 3000),
    maxAttempts: num('LAB_MAX_ATTEMPTS', 3),
    backoffBaseMs: num('LAB_BACKOFF_BASE_MS', 250),
  },

  llm: {
    provider: str('LLM_PROVIDER', 'mock') as LlmProvider,
    model: str('LLM_MODEL', 'nvidia/nemotron-3.5-lightning:free'),
    fallbacks: str(
      'LLM_FALLBACKS',
      'inclusionai/ling-3.2-flash:free,google/gemma-4-31b-it:free,openrouter/free',
    )
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    apiKey: str('OPENROUTER_API_KEY', ''),
    baseUrl: str('LLM_BASE_URL', 'https://openrouter.ai/api/v1'),
    maxCallsPerDay: num('MAX_LLM_CALLS_PER_DAY', 45),
    maxSpendUsd: num('MAX_SPEND_USD', 2),
    maxSteps: num('MAX_AGENT_STEPS', 6),
    maxConversationTokens: num('MAX_CONVERSATION_TOKENS', 20_000),
    timeoutMs: num('LLM_TIMEOUT_MS', 30_000),
    maxTokens: num('LLM_MAX_TOKENS', 300),
    priceInPerM: num('LLM_PRICE_IN_PER_M', 0),
    priceOutPerM: num('LLM_PRICE_OUT_PER_M', 0),
  },

  rateLimitPerMinute: num('RATE_LIMIT_PER_MINUTE', 20),
  jobMaxAttempts: num('JOB_MAX_ATTEMPTS', 6),
  jobBackoffBaseMs: num('JOB_BACKOFF_BASE_MS', 500),
  jobLeaseSeconds: num('JOB_LEASE_SECONDS', 90),
  workerConcurrency: num('WORKER_CONCURRENCY', 8),
  pollIntervalMs: num('POLL_INTERVAL_MS', 100),
  outboxPollIntervalMs: num('OUTBOX_POLL_INTERVAL_MS', 150),

  devMode: bool('DEV_MODE', true),
  adminToken: str('ADMIN_TOKEN', ''),
} as const;

export function assertProductionSafety(): void {
  if (config.nodeEnv !== 'production') return;
  if (config.appSecret === 'dev-app-secret' && !config.devMode) {
    throw new Error('WHATSAPP_APP_SECRET must be set in production');
  }
  if (!config.mockWhatsApp && !config.whatsappToken) {
    throw new Error('WHATSAPP_TOKEN is required when MOCK_WHATSAPP=false');
  }
  if (config.llm.provider === 'openrouter' && !config.llm.apiKey) {
    throw new Error('OPENROUTER_API_KEY is required when LLM_PROVIDER=openrouter');
  }
}
