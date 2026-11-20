import { randomUUID } from 'node:crypto';
import type { ConversationState } from '../db/repo.js';
import { istDate, testName } from '../lab/tests.js';
import { estimateTokens } from '../util/ids.js';
import type { ChatRequest, LlmClient, LlmResponse, LlmUsage } from './types.js';

function lastUserText(request: ChatRequest): string {
  for (let i = request.messages.length - 1; i >= 0; i--) {
    const message = request.messages[i];
    if (message?.role === 'user' && typeof message.content === 'string') return message.content;
  }
  return '';
}

function detectDate(text: string): string | null {
  const iso = text.match(/\b(20\d{2}-\d{2}-\d{2})\b/);
  return iso?.[1] ?? null;
}

function detectTest(text: string): string | null {
  if (/cbc|complete blood|blood count/i.test(text)) return 'cbc';
  if (/lipid|cholesterol/i.test(text)) return 'lipid';
  if (/thyroid|tsh|t3|t4/i.test(text)) return 'thyroid';
  if (/vitamin\s*d|vit\s*d/i.test(text)) return 'vitamin_d';
  if (/hba1c|sugar|diabet/i.test(text)) return 'hba1c';
  return null;
}

function parseChoice(text: string, count: number): number | null {
  const numeric = text.match(/\b([1-9])\b/);
  if (numeric) {
    const n = Number(numeric[1]);
    if (n >= 1 && n <= count) return n;
  }
  const words: Record<string, number> = { first: 1, second: 2, third: 3, fourth: 4, fifth: 5 };
  for (const [word, value] of Object.entries(words)) {
    if (new RegExp(`\\b${word}\\b`, 'i').test(text) && value <= count) return value;
  }
  return null;
}

function slotList(state: ConversationState): string {
  return (state.offered_slots ?? [])
    .map((slot, i) => `${i + 1}. ${slot.label}`)
    .join('\n');
}

/**
 * Deterministic agent policy implementing the same LlmClient contract.
 *
 * It exists for three reasons:
 *  - tests and the 1,000-message load run must be free and reproducible;
 *  - free-tier quotas (50 requests/day) must never block a demo;
 *  - when a real model/API fails, the booking flow still completes.
 */
export class MockLlmClient implements LlmClient {
  readonly provider = 'mock';

  async chat(request: ChatRequest): Promise<LlmResponse> {
    const text = lastUserText(request);
    const state = request.state ?? {};
    const usage = this.usage(request);
    const call = (name: string, args: Record<string, unknown>): LlmResponse => ({
      text: '',
      toolCalls: [{ id: `call_${randomUUID()}`, name, args }],
      usage,
      model: 'deterministic-policy',
      provider: this.provider,
      costUsd: 0,
      latencyMs: 0,
    });

    if (/human|agent|someone|person|call me|talk to/i.test(text)) {
      return call('handoff_to_human', { reason: 'patient asked for a human' });
    }

    if (!state.test_id) {
      const testId = detectTest(text);
      if (testId) {
        const date = detectDate(text);
        return call('check_slots', { test_id: testId, ...(date ? { date } : {}) });
      }
      return {
        text: `Hi! I can book ${['CBC', 'lipid profile', 'thyroid', 'vitamin D', 'HbA1c'].join(', ')}. Which test would you like?`,
        toolCalls: [],
        usage,
        model: 'deterministic-policy',
        provider: this.provider,
        costUsd: 0,
        latencyMs: 0,
      };
    }

    if (state.booking?.status === 'confirmed') {
      const slot = state.offered_slots?.find((s) => s.slot_id === state.booking?.slot_id);
      return {
        text: `Your ${testName(state.test_id)} is confirmed${slot ? ` for ${slot.label}` : ''}. Booking ID: ${state.booking.lab_booking_id ?? state.booking.id}. See you at the lab!`,
        toolCalls: [],
        usage,
        model: 'deterministic-policy',
        provider: this.provider,
        costUsd: 0,
        latencyMs: 0,
      };
    }

    if (state.offered_slots?.length) {
      const choice = parseChoice(text, state.offered_slots.length);
      if (choice) {
        const slot = state.offered_slots[choice - 1]!;
        return call('book_test', {
          slot_id: slot.slot_id,
          ...(state.patient_name ? { patient_name: state.patient_name } : {}),
        });
      }
      return {
        text: `Here are the next available slots for ${testName(state.test_id)}:\n${slotList(state)}\n\nReply with a number to confirm.`,
        toolCalls: [],
        usage,
        model: 'deterministic-policy',
        provider: this.provider,
        costUsd: 0,
        latencyMs: 0,
      };
    }

    return {
      text: 'Which test would you like to book?',
      toolCalls: [],
      usage,
      model: 'deterministic-policy',
      provider: this.provider,
      costUsd: 0,
      latencyMs: 0,
    };
  }

  private usage(request: ChatRequest): LlmUsage {
    const prompt = request.messages.reduce((sum, m) => sum + estimateTokens(m.content ?? ''), 0);
    return { promptTokens: prompt, completionTokens: 40, cachedTokens: 0 };
  }
}

/** Small helper so the agent can suggest a date without importing the lab. */
export function defaultSlotDate(): string {
  return istDate(1);
}
