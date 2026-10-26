import { dataPath, readJson, writeJsonAtomic } from "../adapter/paths";
import { nowIso } from "../util";

/**
 * Local translation cache.
 *
 * Cache identity follows the spec: attachment fingerprint + selection text and
 * position + context hash + source/target language + provider/model + prompt
 * version + glossary version. A hit is only accepted when the stored selection
 * and the full context text still match, so a hash collision cannot return the
 * wrong translation.
 */
export const TRANSLATION_CACHE_SCHEMA_VERSION = 2;
const MAX_ENTRIES = 500;

export interface TranslationCacheInput {
  attachmentFingerprint: string;
  selectionText: string;
  positionHash: string;
  contextText: string;
  sourceLanguage: string;
  targetLanguage: string;
  providerName: string;
  baseURL: string;
  model: string;
  promptVersion: number;
  glossaryVersion: string;
}

export interface TranslationCacheEntry {
  key: string;
  createdAt: string;
  providerName: string;
  model: string;
  sourceLanguage: string;
  targetLanguage: string;
  attachmentFingerprint: string;
  selectionText: string;
  positionHash: string;
  contextHash: string;
  /** Full context is stored for exact-hit verification (the key only has its hash). */
  contextText: string;
  translation: string;
  usage: Record<string, unknown> | null;
}

export interface TranslationCacheFile {
  schemaVersion: number;
  entries: TranslationCacheEntry[];
}

export interface TranslationCacheKey {
  key: string;
  contextHash: string;
  material: string;
}

/** FNV-1a 32-bit over UTF-16 code units. Cache keys only, not security. */
function fnv1a(value: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

function clean(value: unknown): string {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

export function buildTranslationCacheKey(input: TranslationCacheInput): TranslationCacheKey {
  const contextHash = fnv1a(clean(input.contextText));
  const material = JSON.stringify({
    v: TRANSLATION_CACHE_SCHEMA_VERSION,
    attachmentFingerprint: clean(input.attachmentFingerprint),
    selectionText: clean(input.selectionText),
    positionHash: clean(input.positionHash),
    contextHash,
    sourceLanguage: clean(input.sourceLanguage),
    targetLanguage: clean(input.targetLanguage),
    providerName: clean(input.providerName),
    baseURL: clean(input.baseURL).replace(/\/+$/, ""),
    model: clean(input.model),
    promptVersion: Number(input.promptVersion) || 0,
    glossaryVersion: clean(input.glossaryVersion),
  });
  return {
    key: "t1_" + fnv1a(material) + "_" + material.length.toString(16),
    contextHash,
    material,
  };
}

export class TranslationCache {
  private loaded = false;
  private entries = new Map<string, TranslationCacheEntry>();
  private path = dataPath("cache", "translations.json");
  private saveChain: Promise<void> = Promise.resolve();

  private async load(): Promise<void> {
    if (this.loaded) {
      return;
    }
    const file = await readJson<TranslationCacheFile>(this.path, {
      schemaVersion: TRANSLATION_CACHE_SCHEMA_VERSION,
      entries: [],
    });
    if (file.schemaVersion === TRANSLATION_CACHE_SCHEMA_VERSION && Array.isArray(file.entries)) {
      for (const entry of file.entries) {
        if (entry && typeof entry.key === "string" && typeof entry.translation === "string") {
          this.entries.set(entry.key, entry);
        }
      }
    }
    this.loaded = true;
  }

  async get(
    key: string,
    expected: { selectionText: string; contextHash: string; contextText?: string }
  ): Promise<TranslationCacheEntry | null> {
    await this.load();
    const entry = this.entries.get(key);
    if (!entry) {
      return null;
    }
    if (
      clean(entry.selectionText) !== clean(expected.selectionText)
      || entry.contextHash !== expected.contextHash
    ) {
      return null;
    }
    if (
      expected.contextText !== undefined
      && clean(entry.contextText) !== clean(expected.contextText)
    ) {
      return null;
    }
    return entry;
  }

  async put(entry: TranslationCacheEntry): Promise<void> {
    await this.load();
    this.entries.set(entry.key, entry);
    this.evict();
    this.scheduleSave();
  }

  private evict(): void {
    if (this.entries.size <= MAX_ENTRIES) {
      return;
    }
    const sorted = Array.from(this.entries.values()).sort((a, b) =>
      String(a.createdAt).localeCompare(String(b.createdAt))
    );
    const remove = sorted.length - MAX_ENTRIES;
    for (let i = 0; i < remove; i++) {
      this.entries.delete(sorted[i].key);
    }
  }

  private scheduleSave(): void {
    this.saveChain = this.saveChain.then(
      () => this.saveNow(),
      () => this.saveNow()
    );
  }

  private async saveNow(): Promise<void> {
    const file: TranslationCacheFile = {
      schemaVersion: TRANSLATION_CACHE_SCHEMA_VERSION,
      entries: Array.from(this.entries.values()),
    };
    try {
      await writeJsonAtomic(this.path, file);
    }
    catch (e) {
      // A cache write failure must never break translation; the caller already
      // has the result.
    }
  }

  async flush(): Promise<void> {
    await this.saveChain;
  }

  async stats(): Promise<Record<string, unknown>> {
    await this.load();
    return {
      entries: this.entries.size,
      path: this.path,
      schemaVersion: TRANSLATION_CACHE_SCHEMA_VERSION,
    };
  }

  static entryFrom(
    key: TranslationCacheKey,
    input: TranslationCacheInput,
    translation: string,
    usage: Record<string, unknown> | null
  ): TranslationCacheEntry {
    return {
      key: key.key,
      createdAt: nowIso(),
      providerName: clean(input.providerName),
      model: clean(input.model),
      sourceLanguage: clean(input.sourceLanguage),
      targetLanguage: clean(input.targetLanguage),
      attachmentFingerprint: clean(input.attachmentFingerprint),
      selectionText: clean(input.selectionText),
      positionHash: clean(input.positionHash),
      contextHash: key.contextHash,
      contextText: clean(input.contextText),
      translation,
      usage,
    };
  }
}
