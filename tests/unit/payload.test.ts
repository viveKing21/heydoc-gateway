import { describe, expect, it } from 'vitest';
import { buildWebhookPayload, parseWebhookPayload } from '../../src/whatsapp/payload.js';

describe('webhook payload parsing', () => {
  it('extracts a text message with contact name', () => {
    const payload = buildWebhookPayload({
      phone: '919800000001',
      text: 'Book a CBC',
      waMessageId: 'wamid.1',
      displayName: 'Asha',
    });
    const events = parseWebhookPayload(payload);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      waMessageId: 'wamid.1',
      phone: '919800000001',
      type: 'text',
      text: 'Book a CBC',
      displayName: 'Asha',
    });
  });

  it('returns nothing for status-only events', () => {
    const payload = {
      object: 'whatsapp_business_account',
      entry: [
        {
          id: 'WABA',
          changes: [
            {
              field: 'messages',
              value: {
                messaging_product: 'whatsapp',
                statuses: [{ id: 'wamid.x', status: 'delivered', timestamp: '1', recipient_id: '1' }],
              },
            },
          ],
        },
      ],
    };
    expect(parseWebhookPayload(payload)).toEqual([]);
  });

  it('marks non-text messages with a null body', () => {
    const payload = {
      entry: [
        {
          changes: [
            {
              value: {
                messages: [{ from: '9198', id: 'wamid.img', type: 'image', image: { id: 'x' } }],
              },
            },
          ],
        },
      ],
    };
    const events = parseWebhookPayload(payload);
    expect(events[0]).toMatchObject({ type: 'image', text: null });
  });

  it('ignores malformed input instead of throwing', () => {
    expect(parseWebhookPayload(null)).toEqual([]);
    expect(parseWebhookPayload({})).toEqual([]);
    expect(parseWebhookPayload({ entry: 'nope' })).toEqual([]);
    expect(parseWebhookPayload({ entry: [{ changes: [{ value: { messages: [{ id: 'no-from' }] } }] }] })).toEqual([]);
  });

  it('parses multiple messages in one delivery', () => {
    const payload = {
      entry: [
        {
          changes: [
            {
              value: {
                messages: [
                  { from: '1', id: 'a', type: 'text', text: { body: 'one' } },
                  { from: '1', id: 'b', type: 'text', text: { body: 'two' } },
                ],
              },
            },
          ],
        },
      ],
    };
    expect(parseWebhookPayload(payload).map((m) => m.text)).toEqual(['one', 'two']);
  });
});
