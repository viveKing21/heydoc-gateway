import { config } from '../config.js';
import { llmBudget } from './budget.js';
import { estimateCostUsd } from './pricing.js';
import type {
  ChatRequest,
  LlmClient,
  LlmMessage,
  LlmResponse,
  ToolCall,
} from './types.js';
import { LlmBudgetError, LlmUnavailableError } from './types.js';
import { backoffMs, sleep } from '../util/backoff.js';
import { log } from '../util/log.js';

interface ApiToolCall {
  id?: string;
  type?: string;
  function?: { name?: string; arguments?: string };
}

interface ApiChoice {
  message?: {
    content?: string | null;
    tool_calls?: ApiToolCall[];
  };
}

interface ApiResponse {
  choices?: ApiChoice[];
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    cached_tokens?: number;
    prompt_tokens_details?: { cached_tokens?: number };
  };
  error?: { message?: string; code?: number };
}

function parseArgs(raw: string | undefined): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : { _raw: raw };
  } catch {
    return { _raw: raw };
  }
}

function toApiMessage(message: LlmMessage): Record<string, unknown> {
  if (message.role === 'assistant' && message.toolCalls?.length) {
    return {
      role: 'assistant',
      content: message.content || null,
      tool_calls: message.toolCalls.map((tc) => ({
        id: tc.id,
        type: 'function',
        function: { name: tc.name, arguments: JSON.stringify(tc.args) },
      })),
    };
  }
  if (message.role === 'tool') {
    return { role: 'tool', tool_call_id: message.toolCallId, content: message.content };
  }
  return { role: message.role, content: message.content };
}

/**
 * OpenRouter (OpenAI-compatible) client with a model fallback chain and a
 * hard per-process budget. Free models are the default for the demo; the
 * deterministic provider is the fallback of last resort in the agent.
 */
export class OpenRouterClient implements LlmClient {
  readonly provider = 'openrouter';
  readonly modelChain: string[];

  constructor(
    private readonly options: {
      apiKey?: string;
      baseUrl?: string;
      models?: string[];
      timeoutMs?: number;
      attemptsPerModel?: number;
    } = {},
  ) {
    const primary = config.llm.model;
    const models = options.models ?? [primary, ...config.llm.fallbacks];
    this.modelChain = [...new Set(models.filter(Boolean))];
  }

  async chat(request: ChatRequest): Promise<LlmResponse> {
    const apiKey = this.options.apiKey ?? config.llm.apiKey;
    if (!apiKey) throw new LlmUnavailableError('OPENROUTER_API_KEY is not configured');
    const budget = llmBudget.canCall();
    if (!budget.ok) {
      llmBudget.block();
      throw new LlmBudgetError(budget.reason ?? 'LLM budget exhausted');
    }

    const timeoutMs = this.options.timeoutMs ?? config.llm.timeoutMs;
    const attemptsPerModel = this.options.attemptsPerModel ?? 2;
    let lastError: unknown;

    for (const model of this.modelChain) {
      for (let attempt = 1; attempt <= attemptsPerModel; attempt++) {
        try {
          const response = await this.callModel(model, request, apiKey, timeoutMs);
          llmBudget.record(response.costUsd);
          return response;
        } catch (err) {
          lastError = err;
          const status = (err as { status?: number }).status;
          const retryable = status === undefined || status === 429 || status === 408 || status >= 500;

          log.warn('llm call failed', {
            model,
            attempt,
            status: status ?? null,
            error: (err as Error).message,
          });
          if (!retryable || attempt === attemptsPerModel) break;
          await sleep(backoffMs(attempt, 500, 2, 4_000, 0.5));
        }
      }
    }

    throw new LlmUnavailableError((lastError as Error)?.message ?? 'all models failed');
  }

  private async callModel(
    model: string,
    request: ChatRequest,
    apiKey: string,
    timeoutMs: number,
  ): Promise<LlmResponse> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const started = Date.now();
    try {
      const res = await fetch(`${(this.options.baseUrl ?? config.llm.baseUrl).replace(/\/$/, '')}/chat/completions`, {
        method: 'POST',
        signal: controller.signal,
        headers: {
          authorization: `Bearer ${apiKey}`,
          'content-type': 'application/json',
          'http-referer': 'https://github.com/viveKing21/heydoc-gateway',
          'x-title': 'HeyDoc WhatsApp Gateway',
        },
        body: JSON.stringify({
          model,
          messages: request.messages.map(toApiMessage),
          tools: request.tools.map((t) => ({
            type: 'function',
            function: { name: t.name, description: t.description, parameters: t.parameters },
          })),
          tool_choice: 'auto',
          temperature: 0.2,
          max_tokens: config.llm.maxTokens,
        }),
      });

      if (!res.ok) {
        const text = await res.text().catch(() => '');
        const error = new Error(`OpenRouter ${res.status}: ${text.slice(0, 300)}`) as Error & {
          status?: number;
        };
        error.status = res.status;
        throw error;
      }

      const data = (await res.json()) as ApiResponse;
      if (data.error) throw new Error(data.error.message ?? 'OpenRouter returned an error');
      const choice = data.choices?.[0];
      if (!choice?.message) throw new Error('OpenRouter returned no choices');

      const promptTokens = Number(data.usage?.prompt_tokens ?? 0);
      const completionTokens = Number(data.usage?.completion_tokens ?? 0);
      const cachedTokens = Number(
        data.usage?.cached_tokens ?? data.usage?.prompt_tokens_details?.cached_tokens ?? 0,
      );
      const costUsd = estimateCostUsd(model, promptTokens, completionTokens, cachedTokens);

      const toolCalls: ToolCall[] = (choice.message.tool_calls ?? []).map((tc, index) => ({
        id: tc.id ?? `call_${index}`,
        name: tc.function?.name ?? '',
        args: parseArgs(tc.function?.arguments),
      }));

      const text = typeof choice.message.content === 'string' ? choice.message.content : '';

      // Success metrics are recorded by the agent (provider-agnostic), so the
      // deterministic provider is visible in /metrics too.
      log.info('llm call', {
        model,
        promptTokens,
        completionTokens,
        cachedTokens,
        costUsd,
        latencyMs: Date.now() - started,
        toolCalls: toolCalls.map((t) => t.name),
      });

      return {
        text,
        toolCalls,
        usage: { promptTokens, completionTokens, cachedTokens },
        model,
        provider: this.provider,
        costUsd,
        latencyMs: Date.now() - started,
      };
    } finally {
      clearTimeout(timer);
    }
  }
}
