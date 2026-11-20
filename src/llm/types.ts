import type { ConversationState } from '../db/repo.js';

export interface ToolDef {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface ToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

export type LlmRole = 'system' | 'user' | 'assistant' | 'tool';

export interface LlmMessage {
  role: LlmRole;
  content: string;
  toolCalls?: ToolCall[];
  toolCallId?: string;
}

export interface LlmUsage {
  promptTokens: number;
  completionTokens: number;
  cachedTokens: number;
}

export interface LlmResponse {
  text: string;
  toolCalls: ToolCall[];
  usage: LlmUsage;
  model: string;
  provider: string;
  costUsd: number;
  latencyMs: number;
}

export interface ChatRequest {
  messages: LlmMessage[];
  tools: ToolDef[];
  state: ConversationState;
}

export interface LlmClient {
  readonly provider: string;
  chat(request: ChatRequest): Promise<LlmResponse>;
}

export class LlmUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LlmUnavailableError';
  }
}

export class LlmBudgetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LlmBudgetError';
  }
}
