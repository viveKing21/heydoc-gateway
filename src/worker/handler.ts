import {
  appendMessage,
  completeJob,
  createHandoff,
  getConversationById,
  getInboundMessage,
  insertOutbox,
  type JobRow,
} from '../db/repo.js';
import type { Agent } from '../agent/agent.js';
import type { WhatsAppSender } from '../whatsapp/sender.js';
import { log } from '../util/log.js';
import { maskPhone } from '../util/ids.js';

export interface HandlerDeps {
  agent: Agent;
  sender: WhatsAppSender;
}

export async function handleJob(job: JobRow, deps: HandlerDeps): Promise<void> {
  const rawInboundId = job.payload.inbound_id;
  const inboundId =
    typeof rawInboundId === 'string'
      ? rawInboundId
      : typeof rawInboundId === 'number'
        ? String(rawInboundId)
        : null;
  if (!inboundId) {
    log.warn('job has no inbound id', { jobId: job.id });
    await completeJob(job.id);
    return;
  }

  const [inbound, conversation] = await Promise.all([
    getInboundMessage(inboundId),
    job.conversation_id ? getConversationById(job.conversation_id) : Promise.resolve(null),
  ]);

  if (!inbound || !conversation) {
    log.warn('job references missing rows', { jobId: job.id, inboundId });
    await completeJob(job.id);
    return;
  }

  if (conversation.status === 'human') {
    // A human owns this thread now. Store the message, do not spend tokens.
    await appendMessage({
      conversationId: conversation.id,
      direction: 'in',
      role: 'user',
      content: typeof inbound.text_body === 'string' ? inbound.text_body : `[${String(inbound.type)}]`,
      dedupeKey: `in:${inboundId}`,
    });
    await completeJob(job.id);
    return;
  }

  await deps.agent.handle({
    conversation,
    inboundId,
    text: typeof inbound.text_body === 'string' ? inbound.text_body : null,
    type: typeof inbound.type === 'string' ? inbound.type : 'unknown',
  });

  await completeJob(job.id);
  log.info('job done', { jobId: job.id, phone: maskPhone(conversation.phone) });
}

/** A dead job is never silent: the patient gets an apology and a human gets it. */
export async function onDeadJob(job: JobRow, error: string): Promise<void> {
  if (!job.conversation_id) return;
  const conversation = await getConversationById(job.conversation_id);
  if (!conversation) return;

  if (conversation.status !== 'human') {
    await createHandoff({
      conversationId: conversation.id,
      reason: `job ${job.id} failed after ${job.attempts} attempts: ${error}`.slice(0, 900),
      source: 'retry_exhausted',
    });
  }

  const body =
    "Sorry — I couldn't complete that just now. A colleague from the lab will follow up here shortly.";
  await appendMessage({
    conversationId: conversation.id,
    direction: 'out',
    role: 'assistant',
    content: body,
    dedupeKey: `dead-message:${job.id}`,
  });
  await insertOutbox({
    conversationId: conversation.id,
    toPhone: conversation.phone,
    body,
    dedupeKey: `dead-outbox:${job.id}`,
  });
}
