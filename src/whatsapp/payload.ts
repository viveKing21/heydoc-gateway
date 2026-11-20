/** Minimal types for the WhatsApp Cloud API webhook payload. */

export interface InboundMessage {
  waMessageId: string;
  phone: string;
  type: string;
  text: string | null;
  displayName?: string;
  timestamp?: string;
}

interface RawMessage {
  id?: string;
  from?: string;
  type?: string;
  timestamp?: string;
  text?: { body?: string };
}

/**
 * Extract only message events. Delivery/read statuses and malformed entries
 * are ignored — Meta still expects a 200 for them.
 */
export function parseWebhookPayload(body: unknown): InboundMessage[] {
  if (!body || typeof body !== 'object') return [];
  const entries = (body as { entry?: unknown }).entry;
  if (!Array.isArray(entries)) return [];

  const out: InboundMessage[] = [];
  for (const entry of entries) {
    const changes = (entry as { changes?: unknown })?.changes;
    if (!Array.isArray(changes)) continue;
    for (const change of changes) {
      const value = (change as { value?: Record<string, unknown> })?.value;
      if (!value) continue;
      const contacts = value.contacts as Array<{ profile?: { name?: string } }> | undefined;
      const displayName = contacts?.[0]?.profile?.name;
      const messages = value.messages as RawMessage[] | undefined;
      if (!Array.isArray(messages)) continue;
      for (const m of messages) {
        if (!m?.id || !m?.from) continue;
        const type = typeof m.type === 'string' ? m.type : 'unknown';
        const text = type === 'text' && typeof m.text?.body === 'string' ? m.text.body : null;
        out.push({
          waMessageId: m.id,
          phone: String(m.from),
          type,
          text,
          ...(displayName ? { displayName } : {}),
          ...(m.timestamp ? { timestamp: m.timestamp } : {}),
        });
      }
    }
  }
  return out;
}

/** Build a Cloud-API-shaped payload (used by the demo console and load test). */
export function buildWebhookPayload(input: {
  phone: string;
  text: string;
  waMessageId: string;
  displayName?: string;
  timestamp?: number;
}): Record<string, unknown> {
  return {
    object: 'whatsapp_business_account',
    entry: [
      {
        id: 'DEMO_WABA',
        changes: [
          {
            field: 'messages',
            value: {
              messaging_product: 'whatsapp',
              metadata: { display_phone_number: '15550001111', phone_number_id: 'DEMO_PNID' },
              contacts: [{ profile: { name: input.displayName ?? 'Demo Patient' }, wa_id: input.phone }],
              messages: [
                {
                  from: input.phone,
                  id: input.waMessageId,
                  timestamp: String(input.timestamp ?? Math.floor(Date.now() / 1000)),
                  type: 'text',
                  text: { body: input.text },
                },
              ],
            },
          },
        ],
      },
    ],
  };
}
