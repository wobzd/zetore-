import { readGlossary } from "./glossary";
import type { AIConfig } from "./types";

/**
 * AI settings live in Zotero's own pref branch so they survive plugin
 * upgrades. The API key is stored locally in prefs (plaintext, same as most
 * Zotero plugins); it is never written to the plugin data folder, debug log
 * or self-check report.
 */
const PREFIX = "extensions.zotero.zotero-reading-assistant.ai.";

export const AI_PREF_KEYS = {
  providerName: PREFIX + "providerName",
  baseURL: PREFIX + "baseURL",
  apiKey: PREFIX + "apiKey",
  model: PREFIX + "model",
  temperature: PREFIX + "temperature",
  maxTokens: PREFIX + "maxTokens",
  autoTranslate: PREFIX + "autoTranslate",
} as const;

export const DEFAULT_AI_CONFIG: AIConfig = {
  providerName: "DeepSeek",
  baseURL: "https://api.deepseek.com/v1",
  apiKey: "",
  model: "deepseek-flash",
  temperature: 0.3,
  maxTokens: 1200,
  autoTranslate: true,
};

function readString(key: string, fallback: string): string {
  try {
    const value = Zotero.Prefs.get(key, true);
    return typeof value === "string" && value.trim() ? value.trim() : fallback;
  }
  catch (e) {
    return fallback;
  }
}

function readNumber(key: string, fallback: number): number {
  try {
    const raw = Zotero.Prefs.get(key, true);
    if (raw === undefined || raw === null || raw === "") {
      return fallback;
    }
    const value = Number(raw);
    return Number.isFinite(value) ? value : fallback;
  }
  catch (e) {
    return fallback;
  }
}

function readBoolean(key: string, fallback: boolean): boolean {
  try {
    const value = Zotero.Prefs.get(key, true);
    if (typeof value === "boolean") {
      return value;
    }
    if (typeof value === "string") {
      return value === "true" || value === "1";
    }
    return fallback;
  }
  catch (e) {
    return fallback;
  }
}

export function readAIConfig(): AIConfig {
  return {
    providerName: readString(AI_PREF_KEYS.providerName, DEFAULT_AI_CONFIG.providerName),
    baseURL: normalizeBaseURL(readString(AI_PREF_KEYS.baseURL, DEFAULT_AI_CONFIG.baseURL)),
    apiKey: readString(AI_PREF_KEYS.apiKey, ""),
    model: readString(AI_PREF_KEYS.model, DEFAULT_AI_CONFIG.model),
    temperature: clamp(readNumber(AI_PREF_KEYS.temperature, DEFAULT_AI_CONFIG.temperature), 0, 2),
    maxTokens: Math.round(clamp(readNumber(AI_PREF_KEYS.maxTokens, DEFAULT_AI_CONFIG.maxTokens), 64, 32768)),
    autoTranslate: readBoolean(AI_PREF_KEYS.autoTranslate, DEFAULT_AI_CONFIG.autoTranslate),
  };
}

export function saveAIConfig(config: AIConfig): AIConfig {
  const normalized: AIConfig = {
    providerName: String(config.providerName || "").trim() || DEFAULT_AI_CONFIG.providerName,
    baseURL: normalizeBaseURL(String(config.baseURL || "")),
    apiKey: String(config.apiKey || "").trim(),
    model: String(config.model || "").trim(),
    temperature: clamp(Number(config.temperature), 0, 2),
    maxTokens: Math.round(clamp(Number(config.maxTokens), 64, 32768)),
    autoTranslate: !!config.autoTranslate,
  };
  Zotero.Prefs.set(AI_PREF_KEYS.providerName, normalized.providerName, true);
  Zotero.Prefs.set(AI_PREF_KEYS.baseURL, normalized.baseURL, true);
  Zotero.Prefs.set(AI_PREF_KEYS.apiKey, normalized.apiKey, true);
  Zotero.Prefs.set(AI_PREF_KEYS.model, normalized.model, true);
  Zotero.Prefs.set(AI_PREF_KEYS.temperature, normalized.temperature, true);
  Zotero.Prefs.set(AI_PREF_KEYS.maxTokens, normalized.maxTokens, true);
  Zotero.Prefs.set(AI_PREF_KEYS.autoTranslate, normalized.autoTranslate, true);
  return normalized;
}

export function isAIConfigured(config: AIConfig = readAIConfig()): boolean {
  return !!(config.baseURL && config.apiKey && config.model);
}

/** Strip trailing slashes; keep a full endpoint untouched. */
export function normalizeBaseURL(url: string): string {
  return String(url || "").trim().replace(/\/+$/, "");
}

/**
 * Accept either the service root (`https://api.deepseek.com/v1`) or a full
 * `/chat/completions` endpoint pasted from provider docs.
 */
export function chatEndpoint(baseURL: string): string {
  const base = normalizeBaseURL(baseURL);
  if (!base) {
    return "";
  }
  if (/\/chat\/completions$/i.test(base)) {
    return base;
  }
  return base + "/chat/completions";
}

/** Safe view for diagnostics: never includes the key itself. */
export function redactedAIConfig(config: AIConfig = readAIConfig()): Record<string, unknown> {
  return {
    providerName: config.providerName,
    baseURL: config.baseURL,
    endpoint: chatEndpoint(config.baseURL),
    model: config.model,
    hasAPIKey: !!config.apiKey,
    temperature: config.temperature,
    maxTokens: config.maxTokens,
    autoTranslate: config.autoTranslate,
    glossaryCount: readGlossary().length,
  };
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) {
    return min;
  }
  return Math.min(max, Math.max(min, value));
}
