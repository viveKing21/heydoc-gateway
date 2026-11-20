import { config } from '../config.js';

function utcDay(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Local spend guard. The DB is the source of truth for reporting, but this
 * stops a runaway loop before it costs anything. Multi-process deployments
 * should move this counter into Postgres; documented as a known limitation.
 */
class LlmBudget {
  private day = utcDay();
  private calls = 0;
  private costUsd = 0;
  private blocked = 0;

  private roll(): void {
    const today = utcDay();
    if (today !== this.day) {
      this.day = today;
      this.calls = 0;
      this.costUsd = 0;
      this.blocked = 0;
    }
  }

  canCall(): { ok: boolean; reason?: string } {
    this.roll();
    if (this.calls >= config.llm.maxCallsPerDay) {
      return { ok: false, reason: `daily call cap ${config.llm.maxCallsPerDay} reached` };
    }
    if (this.costUsd >= config.llm.maxSpendUsd) {
      return { ok: false, reason: `spend cap $${config.llm.maxSpendUsd} reached` };
    }
    return { ok: true };
  }

  record(costUsd: number): void {
    this.roll();
    this.calls += 1;
    this.costUsd += costUsd;
  }

  block(): void {
    this.blocked += 1;
  }

  state(): { day: string; calls: number; costUsd: number; blocked: number; maxCalls: number; maxSpendUsd: number } {
    this.roll();
    return {
      day: this.day,
      calls: this.calls,
      costUsd: Number(this.costUsd.toFixed(8)),
      blocked: this.blocked,
      maxCalls: config.llm.maxCallsPerDay,
      maxSpendUsd: config.llm.maxSpendUsd,
    };
  }
}

export const llmBudget = new LlmBudget();
