import { chatEndpoint, isAIConfigured } from "./config";
import type {
  AIConfig,
  AIErrorKind,
  ChatMessage,
  ChatResult,
  ChatUsage,
  TestConnectionResult,
} from "./types";
import { AIError } from "./types";
import type { CancelToken } from "./cancel";

export interface ChatOptions {
  timeoutMs?: number;
  maxTokens?: number;
  temperature?: number;
}

export interface ChatStreamOptions extends ChatOptions {
  /** Receives the accumulated answer after every streamed chunk. */
  onText?: (text: string) => void;
  /** UI-owned cancellation token; cancelling aborts the underlying XHR. */
  cancelToken?: CancelToken;
}

function parseJSON(text: unknown): any {
  if (!text) {
    return null;
  }
  if (typeof text === "object") {
    return text;
  }
  try {
    return JSON.parse(String(text));
  }
  catch (e) {
    return null;
  }
}

function errorText(data: any): string {
  if (!data) {
    return "";
  }
  return String(
    data?.error?.message
    || data?.message
    || data?.error?.type
    || data?.error?.code
    || ""
  );
}

function classifyHTTP(status: number, data: any): AIError {
  const detail = errorText(data);
  const lower = detail.toLowerCase();
  const options = { status, detail };

  if (!status) {
    return new AIError("network", "网络错误：无法连接 AI 服务", options);
  }
  if (status === 401 || status === 403) {
    return new AIError("auth", "鉴权失败：请检查 API Key 是否正确、是否已过期", options);
  }
  if (status === 404) {
    return new AIError("model", "接口或模型不存在：请检查 Base URL 与模型名", options);
  }
  if (status === 429) {
    return new AIError("rate_limit", "请求被限流或额度不足，请稍后重试", options);
  }
  if (
    status === 400
    && /context|token|length|too long|maximum/.test(lower)
  ) {
    return new AIError("context_length", "输入超过模型上下文长度，请缩短选区或上下文", options);
  }
  if (status >= 500) {
    return new AIError("server", `AI 服务端错误（HTTP ${status}）`, options);
  }
  return new AIError("unknown", detail || `AI 请求失败（HTTP ${status}）`, options);
}

function classifyException(error: any): AIError {
  const name = String(error?.name || "");
  const message = String(error?.message || error || "");
  const lower = message.toLowerCase();
  const status = Number(error?.status ?? error?.xhr?.status ?? error?.xmlhttp?.status ?? 0) || null;
  const detail = String(
    error?.responseText
    || error?.xmlhttp?.responseText
    || error?.detail
    || ""
  );

  if (name === "AbortError" || /abort|cancel/.test(lower)) {
    return new AIError("cancelled", "请求已取消", { status, detail });
  }
  if (/timeout|timed out|ns_error_net_timeout/.test(lower)) {
    return new AIError("timeout", "请求超时，请检查网络或稍后重试", { status, detail });
  }
  if (
    /network|ns_error|connection|failed to fetch|offline|dns|refused|unreachable/.test(lower)
    || status === 0
  ) {
    return new AIError("network", "网络错误：无法连接 AI 服务", { status, detail });
  }
  return new AIError("unknown", message || "AI 请求失败", { status, detail });
}

function usageOf(data: any): ChatUsage | null {
  const usage = data?.usage;
  if (!usage || typeof usage !== "object") {
    return null;
  }
  return {
    prompt_tokens: Number(usage.prompt_tokens) || undefined,
    completion_tokens: Number(usage.completion_tokens) || undefined,
    total_tokens: Number(usage.total_tokens) || undefined,
  };
}

/**
 * One non-streaming OpenAI-compatible chat completion.
 *
 * Streaming is intentionally not used yet: the reader popup only needs a
 * final answer, and non-streaming keeps the HTTP path compatible with every
 * gateway (DeepSeek / Qwen compatible mode / MiMo / Agnes). The UI still
 * guards against late responses with a per-request id.
 */
export async function chat(
  config: AIConfig,
  messages: ChatMessage[],
  options: ChatOptions = {}
): Promise<ChatResult> {
  if (!isAIConfigured(config)) {
    throw new AIError("not_configured", "尚未配置 AI 服务：请在 Zotero 设置 → 文献阅读助手中填写 API Key");
  }
  const endpoint = chatEndpoint(config.baseURL);
  if (!endpoint) {
    throw new AIError("not_configured", "Base URL 为空");
  }
  if (!messages.length) {
    throw new AIError("unknown", "消息为空");
  }

  const body = {
    model: config.model,
    messages,
    temperature: options.temperature ?? config.temperature,
    max_tokens: options.maxTokens ?? config.maxTokens,
    stream: false,
  };

  let xhr: any;
  try {
    xhr = await Zotero.HTTP.request("POST", endpoint, {
      headers: {
        "Content-Type": "application/json",
        "Authorization": "Bearer " + config.apiKey,
      },
      body: JSON.stringify(body),
      timeout: options.timeoutMs ?? 60000,
      responseType: "json",
      // Resolve every HTTP status so 401/404/429/400 can be classified with
      // the provider's JSON error body instead of a generic rejection.
      successCodes: false,
      // Do not let Zotero's HTTP helper silently retry a failed AI call for
      // minutes; the popup shows the error and the user decides.
      errorDelayMax: 0,
    });
  }
  catch (e) {
    const error = e as any;
    const err = classifyException(error);
    // Zotero.HTTP can reject with UnexpectedStatusException, which exposes
    // the XHR as `.xmlhttp` (not `.xhr`).
    const status = Number(error?.status ?? error?.xmlhttp?.status ?? 0);
    if (status >= 400) {
      const data = parseJSON(
        error?.response
        ?? error?.xmlhttp?.response
        ?? error?.responseText
        ?? error?.xmlhttp?.responseText
      );
      throw classifyHTTP(status, data);
    }
    throw err;
  }

  const status = Number(xhr?.status ?? 0);
  const data = parseJSON(xhr?.response ?? xhr?.responseText);
  if (status < 200 || status >= 300) {
    throw classifyHTTP(status || 0, data);
  }
  if (!data) {
    throw new AIError("parse", "AI 返回的不是有效 JSON", { status });
  }

  const choice = data?.choices?.[0];
  const content = choice?.message?.content ?? choice?.text ?? "";
  const text = typeof content === "string" ? content.trim() : "";
  if (!text) {
    throw new AIError("parse", "AI 响应中没有文本内容", { status });
  }

  return {
    text,
    model: typeof data?.model === "string" ? data.model : null,
    usage: usageOf(data),
  };
}

function contentText(value: any): string {
  if (typeof value === "string") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((part) => {
      if (typeof part === "string") {
        return part;
      }
      return typeof part?.text === "string" ? part.text : "";
    }).join("");
  }
  return "";
}

interface StreamState {
  text: string;
  buffer: string;
  offset: number;
  model: string | null;
  usage: ChatUsage | null;
  sawEvent: boolean;
  error: any;
}

function notifyStreamText(state: StreamState, onText?: (text: string) => void): void {
  if (!onText) {
    return;
  }
  try {
    onText(state.text);
  }
  catch (e) {
    // The HTTP stream must not fail because a UI repaint threw. The final
    // result is still returned and the panel renders it on completion.
  }
}

function consumeStreamLine(
  state: StreamState,
  rawLine: string,
  onText?: (text: string) => void
): void {
  const line = String(rawLine || "").trim();
  if (
    !line
    || line.startsWith(":")
    || line.startsWith("event:")
    || line.startsWith("id:")
    || line.startsWith("retry:")
  ) {
    return;
  }
  if (!line.startsWith("data:")) {
    return;
  }

  state.sawEvent = true;
  const payload = line.slice(5).trim();
  if (!payload || payload === "[DONE]") {
    return;
  }
  const data = parseJSON(payload);
  if (!data || typeof data !== "object") {
    return;
  }
  if (data.error) {
    state.error = data;
    return;
  }
  if (typeof data.model === "string") {
    state.model = data.model;
  }
  const usage = usageOf(data);
  if (usage) {
    state.usage = usage;
  }
  const choice = data?.choices?.[0];
  const piece = contentText(
    choice?.delta?.content
    ?? choice?.delta?.text
    ?? choice?.message?.content
    ?? choice?.text
  );
  if (!piece) {
    return;
  }
  state.text += piece;
  notifyStreamText(state, onText);
}

function consumeStream(
  state: StreamState,
  responseText: unknown,
  onText?: (text: string) => void
): void {
  const full = String(responseText || "");
  if (full.length < state.offset) {
    // Defensive: if the XHR response is replaced rather than appended,
    // restart from the beginning instead of dropping the new body.
    state.offset = 0;
    state.buffer = "";
  }
  if (full.length === state.offset) {
    return;
  }
  state.buffer += full.slice(state.offset);
  state.offset = full.length;

  let newline = state.buffer.indexOf("\n");
  while (newline >= 0) {
    const line = state.buffer.slice(0, newline);
    state.buffer = state.buffer.slice(newline + 1);
    consumeStreamLine(state, line, onText);
    newline = state.buffer.indexOf("\n");
  }
}

/**
 * One streaming OpenAI-compatible chat completion.
 *
 * Uses the SSE shape emitted by OpenAI-compatible gateways:
 *   data: {"choices":[{"delta":{"content":"..."}}]}
 *   data: [DONE]
 *
 * The XHR is kept as text and `onprogress` parses only the newly appended
 * bytes. Cancelling the token calls Zotero's XHR canceller, so "stop" closes
 * the network request instead of merely hiding a late response.
 */
export async function chatStream(
  config: AIConfig,
  messages: ChatMessage[],
  options: ChatStreamOptions = {}
): Promise<ChatResult> {
  if (!isAIConfigured(config)) {
    throw new AIError("not_configured", "尚未配置 AI 服务：请在 Zotero 设置 → 文献阅读助手中填写 API Key");
  }
  const endpoint = chatEndpoint(config.baseURL);
  if (!endpoint) {
    throw new AIError("not_configured", "Base URL 为空");
  }
  if (!messages.length) {
    throw new AIError("unknown", "消息为空");
  }
  if (options.cancelToken?.cancelled) {
    throw new AIError("cancelled", "请求已取消");
  }

  const body = {
    model: config.model,
    messages,
    temperature: options.temperature ?? config.temperature,
    max_tokens: options.maxTokens ?? config.maxTokens,
    stream: true,
  };
  const state: StreamState = {
    text: "",
    buffer: "",
    offset: 0,
    model: null,
    usage: null,
    sawEvent: false,
    error: null,
  };
  let cancelRequest: (() => void) | null = null;
  let cancelled = false;
  const stop = (): void => {
    cancelled = true;
    if (cancelRequest) {
      cancelRequest();
    }
  };
  const unsubscribe = options.cancelToken?.onCancel(stop);

  try {
    if (cancelled || options.cancelToken?.cancelled) {
      throw new AIError("cancelled", "请求已取消");
    }

    let xhr: any;
    try {
      xhr = await Zotero.HTTP.request("POST", endpoint, {
        headers: {
          "Content-Type": "application/json",
          "Authorization": "Bearer " + config.apiKey,
          "Accept": "text/event-stream",
        },
        body: JSON.stringify(body),
        timeout: options.timeoutMs ?? 120000,
        responseType: "text",
        successCodes: false,
        errorDelayMax: 0,
        requestObserver: (xmlhttp: any) => {
          xmlhttp.onprogress = () => consumeStream(state, xmlhttp.responseText, options.onText);
        },
        cancellerReceiver: (cancel: () => void) => {
          cancelRequest = cancel;
          if (cancelled || options.cancelToken?.cancelled) {
            cancel();
          }
        },
      });
    }
    catch (e) {
      if (cancelled || options.cancelToken?.cancelled) {
        throw new AIError("cancelled", "请求已取消");
      }
      const error = e as any;
      const status = Number(error?.status ?? error?.xmlhttp?.status ?? 0);
      if (status >= 400) {
        const data = parseJSON(
          error?.response
          ?? error?.xmlhttp?.response
          ?? error?.responseText
          ?? error?.xmlhttp?.responseText
        );
        throw classifyHTTP(status, data);
      }
      throw classifyException(error);
    }

    // `onprogress` can miss the final chunk; consume the complete body once
    // more. Offset tracking makes this idempotent.
    consumeStream(state, xhr?.responseText, options.onText);
    if (state.buffer.trim()) {
      const leftover = state.buffer;
      state.buffer = "";
      consumeStreamLine(state, leftover, options.onText);
    }

    if (cancelled || options.cancelToken?.cancelled) {
      throw new AIError("cancelled", "请求已取消");
    }

    const status = Number(xhr?.status ?? 0);
    const raw = String(xhr?.responseText ?? "");
    if (status < 200 || status >= 300) {
      throw classifyHTTP(status || 0, parseJSON(raw));
    }
    if (state.error) {
      throw classifyHTTP(status, state.error);
    }

    if (!state.sawEvent) {
      // Some compatible gateways ignore `stream: true` and return one JSON
      // body. Accept that shape instead of showing an empty answer.
      const data = parseJSON(raw);
      if (!data) {
        throw new AIError("parse", "AI 返回的不是有效 JSON", { status });
      }
      if (data?.error) {
        throw classifyHTTP(status, data);
      }
      const choice = data?.choices?.[0];
      const text = contentText(choice?.message?.content ?? choice?.text);
      if (text) {
        state.text = text;
        notifyStreamText(state, options.onText);
      }
      if (typeof data?.model === "string") {
        state.model = data.model;
      }
      state.usage = usageOf(data) || state.usage;
    }

    const text = state.text.trim();
    if (!text) {
      throw new AIError("parse", "AI 响应中没有文本内容", { status });
    }
    return {
      text,
      model: state.model,
      usage: state.usage,
    };
  }
  finally {
    unsubscribe?.();
  }
}

/**
 * Settings-pane connection test. Uses the values currently in the form, not
 * the saved prefs, so the user can test before saving.
 */
export async function testConnection(config: AIConfig): Promise<TestConnectionResult> {
  const started = Date.now();
  try {
    const result = await chat(
      config,
      [
        {
          role: "user",
          content: "Reply with exactly: OK",
        },
      ],
      { timeoutMs: 20000, maxTokens: 8, temperature: 0 }
    );
    return {
      ok: true,
      message: `连接成功（${Date.now() - started} ms）`,
      model: result.model || config.model,
      reply: result.text.slice(0, 120),
      elapsedMs: Date.now() - started,
    };
  }
  catch (e) {
    const err = e instanceof AIError
      ? e
      : new AIError("unknown", String((e as any)?.message || e));
    return {
      ok: false,
      message: err.message,
      kind: err.kind as AIErrorKind,
      status: err.status,
      model: config.model,
      elapsedMs: Date.now() - started,
    };
  }
}
