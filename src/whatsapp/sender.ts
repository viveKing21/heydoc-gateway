import { config } from '../config.js';
import { newId } from '../util/ids.js';
import { log } from '../util/log.js';
import { maskPhone } from '../util/ids.js';

export interface SendResult {
  id: string;
  mocked: boolean;
}

/**
 * Outbound delivery boundary. The default is a mock: this repo has no
 * WhatsApp credentials, and the brief forbids committing any. The real path
 * is implemented but requires MOCK_WHATSAPP=false plus a token.
 */
export class WhatsAppSender {
  async send(toPhone: string, body: string): Promise<SendResult> {
    if (config.mockWhatsApp) {
      log.info('mock whatsapp send', { to: maskPhone(toPhone), chars: body.length, preview: body.slice(0, 80) });
      return { id: `mock_${newId()}`, mocked: true };
    }

    if (!config.whatsappToken || !config.whatsappPhoneNumberId) {
      throw new Error('WHATSAPP_TOKEN and WHATSAPP_PHONE_NUMBER_ID are required');
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10_000);
    try {
      const res = await fetch(
        `https://graph.facebook.com/v21.0/${config.whatsappPhoneNumberId}/messages`,
        {
          method: 'POST',
          signal: controller.signal,
          headers: {
            authorization: `Bearer ${config.whatsappToken}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            messaging_product: 'whatsapp',
            to: toPhone,
            type: 'text',
            text: { preview_url: false, body },
          }),
        },
      );
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`WhatsApp send failed ${res.status}: ${text.slice(0, 300)}`);
      }
      const data = (await res.json()) as { messages?: Array<{ id?: string }> };
      return { id: data.messages?.[0]?.id ?? 'unknown', mocked: false };
    } finally {
      clearTimeout(timer);
    }
  }
}
