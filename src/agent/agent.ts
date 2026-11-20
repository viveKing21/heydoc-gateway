import { config } from '../config.js';
import {
  appendMessage,
  createHandoff,
  getHistory,
  insertOutbox,
  recordLlmUsage,
  updateConversation,
  type ConversationRow,
  type ConversationState,
} from '../db/repo.js';
import type { BookingService } from '../booking/service.js';
import type { LabClient } from '../lab/client.js';
import { LlmBudgetError, type LlmClient, type LlmMessage, type LlmResponse } from '../llm/types.js';
import { newId } from '../util/ids.js';
import { log } from '../util/log.js';
import { systemPrompt } from './prompt.js';
import { runTool, TOOL_DEFS } from './tools.js';

const HANDOFF_TEXT =
  "I'm connecting you with a colleague from the lab — they'll pick this up shortly. Thanks for your patience.";

const SUPPORTED_TEXT_REPLY =
  'I can only read text messages right now. Could you type your request? For example: "Book a CBC tomorrow".';

export interface AgentDeps {
  llm: LlmClient;
  fallback: LlmClient;
  lab: LabClient;
  booking: BookingService;
}

export interface AgentInput {
  conversation: ConversationRow;
  inboundId: string;
  text: string | null;
  type: string;
}

export class Agent {
  constructor(private readonly deps: AgentDeps) {}

  async handle(input: AgentInput): Promise<void> {
    const { conversation } = input;
    let state: ConversationState = conversation.state ?? {};

    await appendMessage({
      conversationId: conversation.id,
      direction: 'in',
      role: 'user',
      content: input.text ?? `[${input.type} message]`,
      dedupeKey: `in:${input.inboundId}`,
    });

    if (!input.text || input.text.trim() === '') {
      await this.reply(conversation, input.inboundId, SUPPORTED_TEXT_REPLY);
      return;
    }

    const history = await getHistory(conversation.id, 8);
    const llmMessages: LlmMessage[] = [
      { role: 'system', content: systemPrompt(state) },
      ...history.map<LlmMessage>((m) => ({
        role: m.direction === 'in' ? 'user' : 'assistant',
        content: m.content ?? '',
      })),
    ];

    const runId = newId();
    let client = this.deps.llm;
    let usedFallback = false;
    let toolErrors = 0;
    let spentIn = 0;
    let spentOut = 0;
    let reply: string | null = null;

    const saveState = async (patch: Partial<ConversationState>): Promise<void> => {
      state = { ...state, ...patch };
      await updateConversation({ id: conversation.id, state });
    };

    for (let step = 0; step < config.llm.maxSteps; step++) {
      // Refresh the dynamic tail so the model sees tool-driven state changes.
      llmMessages[0] = { role: 'system', content: systemPrompt(state) };

      if (
        conversation.tokens_in + conversation.tokens_out + spentIn + spentOut >
        config.llm.maxConversationTokens
      ) {
        await createHandoff({
          conversationId: conversation.id,
          reason: 'conversation token budget exhausted',
          source: 'budget',
        });
        reply = HANDOFF_TEXT;
        break;
      }

      let response: LlmResponse;
      try {
        response = await client.chat({ messages: llmMessages, tools: TOOL_DEFS, state });
      } catch (err) {
        void recordLlmUsage({
          conversationId: conversation.id,
          runId,
          provider: client.provider,
          model: client.provider === 'openrouter' ? config.llm.model : 'deterministic-policy',
          promptTokens: 0,
          completionTokens: 0,
          cachedTokens: 0,
          costUsd: 0,
          latencyMs: 0,
          outcome: 'error',
        }).catch(() => undefined);

        if (err instanceof LlmBudgetError) {
          log.warn('llm budget blocked, using deterministic fallback', { reason: err.message });
        }
        if (!usedFallback) {
          usedFallback = true;
          client = this.deps.fallback;
          continue;
        }
        log.error('llm unavailable after fallback', { error: (err as Error).message });
        await createHandoff({
          conversationId: conversation.id,
          reason: `llm unavailable: ${(err as Error).message}`,
          source: 'llm_unavailable',
        });
        reply = HANDOFF_TEXT;
        break;
      }

      spentIn += response.usage.promptTokens;
      spentOut += response.usage.completionTokens;
      await recordLlmUsage({
        conversationId: conversation.id,
        runId,
        provider: response.provider,
        model: response.model,
        promptTokens: response.usage.promptTokens,
        completionTokens: response.usage.completionTokens,
        cachedTokens: response.usage.cachedTokens,
        costUsd: response.costUsd,
        latencyMs: response.latencyMs,
        outcome: usedFallback ? 'fallback' : 'ok',
      });

      if (response.toolCalls.length > 0) {
        llmMessages.push({
          role: 'assistant',
          content: response.text ?? '',
          toolCalls: response.toolCalls,
        });

        for (const call of response.toolCalls) {
          let outcome;
          try {
            outcome = await runTool(call.name, call.args, {
              conversationId: conversation.id,
              state,
              lab: this.deps.lab,
              booking: this.deps.booking,
              userText: input.text ?? '',
            });
          } catch (err) {
            toolErrors += 1;
            log.warn('tool threw', { tool: call.name, error: (err as Error).message });
            outcome = { data: { ok: false, error: 'TOOL_FAILED' } };
          }

          const toolContent = JSON.stringify(outcome.data).slice(0, 2_000);
          llmMessages.push({ role: 'tool', toolCallId: call.id, content: toolContent });
          await appendMessage({
            conversationId: conversation.id,
            direction: 'out',
            role: 'tool',
            content: toolContent.slice(0, 1_000),
            toolName: call.name,
            toolPayload: outcome.data,
            dedupeKey: `tool:${input.inboundId}:${call.id}`,
          });

          const failedTransiently =
            outcome.data.ok === false &&
            (outcome.data.error === 'LAB_UNAVAILABLE' || outcome.data.error === 'TOOL_FAILED');
          if (failedTransiently) toolErrors += 1;

          if (outcome.statePatch && Object.keys(outcome.statePatch).length > 0) {
            await saveState(outcome.statePatch);
          }

          if (outcome.handoff) {
            await this.reply(conversation, input.inboundId, HANDOFF_TEXT);
            return;
          }
        }

        if (toolErrors >= 2) {
          await createHandoff({
            conversationId: conversation.id,
            reason: 'two transient tool failures in one turn',
            source: 'agent',
          });
          await this.reply(conversation, input.inboundId, HANDOFF_TEXT);
          return;
        }
        continue;
      }

      if (response.text.trim()) {
        reply = response.text.trim();
        break;
      }

      // Empty completion: one retry, then deterministic fallback.
      if (!usedFallback) {
        usedFallback = true;
        client = this.deps.fallback;
        continue;
      }
    }

    if (!reply) {
      await createHandoff({
        conversationId: conversation.id,
        reason: 'agent produced no reply',
        source: 'agent',
      });
      reply = HANDOFF_TEXT;
    }

    await this.reply(conversation, input.inboundId, reply);
    log.info('agent turn complete', {
      conversation: conversation.id,
      inbound: input.inboundId,
      tokensIn: spentIn,
      tokensOut: spentOut,
      fallback: usedFallback,
    });
  }

  /** One reply per inbound message, enforced by unique dedupe keys. */
  private async reply(conversation: ConversationRow, inboundId: string, body: string): Promise<void> {
    await appendMessage({
      conversationId: conversation.id,
      direction: 'out',
      role: 'assistant',
      content: body,
      dedupeKey: `out:${inboundId}`,
    });
    await insertOutbox({
      conversationId: conversation.id,
      toPhone: conversation.phone,
      body,
      dedupeKey: `outbox:${inboundId}`,
    });
  }
}
