import { describe, expect, it } from 'vitest';
import { MockLlmClient } from '../../src/llm/mock.js';
import type { ConversationState } from '../../src/db/repo.js';
import type { LlmMessage } from '../../src/llm/types.js';

const llm = new MockLlmClient();

function request(text: string, state: ConversationState) {
  const messages: LlmMessage[] = [
    { role: 'system', content: 'system' },
    { role: 'user', content: text },
  ];
  return llm.chat({ messages, tools: [], state });
}

describe('deterministic agent policy', () => {
  it('asks which test when none is mentioned', async () => {
    const res = await request('hello', {});
    expect(res.toolCalls).toEqual([]);
    expect(res.text).toMatch(/which test/i);
  });

  it('checks slots for a recognised test and date', async () => {
    const res = await request('I want a CBC on 2026-12-01', {});
    expect(res.toolCalls[0]).toMatchObject({
      name: 'check_slots',
      args: { test_id: 'cbc', date: '2026-12-01' },
    });
  });

  it('books a numbered slot once slots are offered', async () => {
    const state: ConversationState = {
      test_id: 'cbc',
      offered_slots: [
        { slot_id: 'cbc-2026-12-01-0900', label: '9:00 am' },
        { slot_id: 'cbc-2026-12-01-1000', label: '10:00 am' },
      ],
    };
    const res = await request('2', state);
    expect(res.toolCalls[0]).toMatchObject({
      name: 'book_test',
      args: { slot_id: 'cbc-2026-12-01-1000' },
    });
  });

  it('hands off when the patient asks for a human', async () => {
    const res = await request('can I talk to a person?', {});
    expect(res.toolCalls[0]?.name).toBe('handoff_to_human');
  });

  it('reports the confirmation and never books twice', async () => {
    const state: ConversationState = {
      test_id: 'cbc',
      offered_slots: [{ slot_id: 'slot-1', label: '9:00 am' }],
      booking: { id: 'b1', status: 'confirmed', lab_booking_id: 'lab_1', slot_id: 'slot-1' },
    };
    const res = await request('1', state);
    expect(res.toolCalls).toEqual([]);
    expect(res.text).toContain('confirmed');
    expect(res.text).toContain('lab_1');
  });
});
