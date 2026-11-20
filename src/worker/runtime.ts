import { config } from '../config.js';
import {
  claimJob,
  claimOutbox,
  failJob,
  markOutboxFailed,
  markOutboxSent,
  reapExpiredJobs,
} from '../db/repo.js';
import { backoffMs, sleep } from '../util/backoff.js';
import { newId } from '../util/ids.js';
import { log } from '../util/log.js';
import type { Agent } from '../agent/agent.js';
import type { WhatsAppSender } from '../whatsapp/sender.js';
import { handleJob, onDeadJob } from './handler.js';

export interface WorkerOptions {
  concurrency?: number;
  pollIntervalMs?: number;
  outboxPollIntervalMs?: number;
  leaseSeconds?: number;
  workerId?: string;
}

export class WorkerRuntime {
  private readonly controller = new AbortController();
  private readonly tasks: Promise<void>[] = [];
  private reaper: NodeJS.Timeout | null = null;
  private stopped = false;
  private readonly workerId: string;

  constructor(
    private readonly deps: { agent: Agent; sender: WhatsAppSender },
    private readonly options: WorkerOptions = {},
  ) {
    this.workerId = options.workerId ?? `${config.workerId}-${newId().slice(0, 8)}`;
  }

  start(): void {
    const concurrency = Math.max(1, this.options.concurrency ?? config.workerConcurrency);
    for (let i = 0; i < concurrency; i++) {
      this.tasks.push(this.jobLoop(`${this.workerId}-${i}`));
    }
    this.tasks.push(this.outboxLoop());
    this.reaper = setInterval(() => void this.reap(), 5_000);
    this.reaper.unref?.();
    log.info('worker started', { workerId: this.workerId, concurrency });
  }

  private async jobLoop(id: string): Promise<void> {
    const poll = this.options.pollIntervalMs ?? config.pollIntervalMs;
    while (!this.controller.signal.aborted) {
      let job;
      try {
        job = await claimJob(id);
      } catch (err) {
        log.error('claim failed', { error: (err as Error).message });
        await sleep(1_000, this.controller.signal);
        continue;
      }
      if (!job) {
        await sleep(poll, this.controller.signal);
        continue;
      }

      try {
        await handleJob(job, this.deps);
      } catch (err) {
        const message = (err as Error).message ?? 'unknown error';
        const delaySeconds =
          backoffMs(job.attempts, config.jobBackoffBaseMs, 2, 30_000, 0.3) / 1_000;
        const status = await failJob(job.id, message, delaySeconds);

        log.warn('job failed', {
          jobId: job.id,
          attempts: job.attempts,
          status,
          retryInSeconds: status === 'dead' ? null : Math.round(delaySeconds),
          error: message,
        });
        if (status === 'dead') {
          await onDeadJob(job, message).catch((e) =>
            log.error('dead-letter handling failed', { jobId: job.id, error: (e as Error).message }),
          );
        }
      }
    }
  }

  private async outboxLoop(): Promise<void> {
    const poll = this.options.outboxPollIntervalMs ?? config.outboxPollIntervalMs;
    while (!this.controller.signal.aborted) {
      let message;
      try {
        message = await claimOutbox();
      } catch (err) {
        log.error('outbox claim failed', { error: (err as Error).message });
        await sleep(1_000, this.controller.signal);
        continue;
      }
      if (!message) {
        await sleep(poll, this.controller.signal);
        continue;
      }
      try {
        await this.deps.sender.send(message.to_phone, message.body);
        await markOutboxSent(message.id);

      } catch (err) {
        await markOutboxFailed(message.id, (err as Error).message);

        log.warn('outbox send failed', {
          outboxId: message.id,
          attempts: message.attempts,
          error: (err as Error).message,
        });
        await sleep(2_000, this.controller.signal);
      }
    }
  }

  private async reap(): Promise<void> {
    if (this.stopped) return;
    try {
      const requeued = await reapExpiredJobs(this.options.leaseSeconds ?? config.jobLeaseSeconds);
      if (requeued.length > 0) {
        log.warn('requeued expired job leases', {
          count: requeued.length,
          dead: requeued.filter((j) => j.status === 'dead').length,
        });
      }
    } catch (err) {
      log.error('reaper failed', { error: (err as Error).message });
    }
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    this.controller.abort();
    if (this.reaper) clearInterval(this.reaper);
    await Promise.allSettled(this.tasks);
    log.info('worker stopped', { workerId: this.workerId });
  }
}
