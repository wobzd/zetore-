/**
 * Shared types for the OpenAI-compatible AI provider.
 *
 * The plugin deliberately speaks only the OpenAI `/chat/completions` shape.
 * DeepSeek, Qwen (DashScope compatible mode), MiMo and other compatible
 * gateways all accept it; provider-specific fields are not required.
 */

export interface AIConfig {
  providerName: string;
  baseURL: string;
  apiKey: string;
  model: string;
  temperature: number;
  maxTokens: number;
  autoTranslate: boolean;
}

export type AIErrorKind =
  | "not_configured"
  | "auth"
  | "model"
  | "rate_limit"
  | "context_length"
  | "network"
  | "timeout"
  | "parse"
  | "cancelled"
  | "server"
  | "unknown";

export class AIError extends Error {
  kind: AIErrorKind;
  status: number | null;
  detail: string;

  constructor(
    kind: AIErrorKind,
    message: string,
    options: { status?: number | null; detail?: string } = {}
  ) {
    super(message);
    this.name = "AIError";
    this.kind = kind;
    this.status = options.status ?? null;
    this.detail = options.detail ?? "";
  }
}

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ChatUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
}

export interface ChatResult {
  text: string;
  model: string | null;
  usage: ChatUsage | null;
}

export interface TestConnectionResult {
  ok: boolean;
  message: string;
  kind?: AIErrorKind;
  status?: number | null;
  model?: string | null;
  reply?: string;
  elapsedMs?: number;
}
