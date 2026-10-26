import { dataPath, readJson, writeJsonAtomic } from "../adapter/paths";
import { nowIso } from "../util";
import type {
  AttemptRecord,
  ImportTable,
  JournalIdentity,
  MetricSnapshot,
  MetricsStoreFile,
  MetricStatus,
  PaperBinding,
} from "./types";
import { SNAPSHOT_PRIORITY } from "./types";

export const METRICS_SCHEMA_VERSION = 1;

/** 1 min, 5 min, 30 min, then stay at 30 min. */
export const RETRY_DELAYS_MS = [60_000, 5 * 60_000, 30 * 60_000];

export function emptyStore(): MetricsStoreFile {
  return {
    schemaVersion: METRICS_SCHEMA_VERSION,
    identities: {},
    snapshots: {},
    bindings: {},
    attempts: {},
    importTable: null,
  };
}

function isObject(value: unknown): value is Record<string, any> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function normalizeStore(raw: Partial<MetricsStoreFile> | null | undefined): MetricsStoreFile {
  const base = emptyStore();
  if (!isObject(raw)) {
    return base;
  }
  return {
    schemaVersion: METRICS_SCHEMA_VERSION,
    identities: isObject(raw.identities) ? raw.identities : {},
    snapshots: isObject(raw.snapshots) ? raw.snapshots : {},
    bindings: isObject(raw.bindings) ? raw.bindings : {},
    attempts: isObject(raw.attempts) ? raw.attempts : {},
    importTable: raw.importTable && Array.isArray(raw.importTable.records) ? raw.importTable : null,
  };
}

/**
 * Single-file JSON store. Writes are serialized and atomic; in-memory state is
 * authoritative while the plugin runs, so failed writes never corrupt reads.
 */
export class MetricsStore {
  data: MetricsStoreFile = emptyStore();
  private loaded = false;
  private chain: Promise<void> = Promise.resolve();

  // Lazy: the store object is constructed before Zotero.DataDirectory is
  // guaranteed to be initialized, but every read/write happens after startup.
  private get path(): string {
    return dataPath("metrics.json");
  }

  async load(): Promise<void> {
    if (this.loaded) {
      return;
    }
    const raw = await readJson<Partial<MetricsStoreFile>>(this.path, {});
    this.data = normalizeStore(raw);
    this.loaded = true;
  }

  save(): Promise<void> {
    const write = (): Promise<void> => writeJsonAtomic(this.path, this.data);
    this.chain = this.chain.then(write, write);
    return this.chain;
  }

  snapshotKey(identityId: string, provider: string): string {
    return `${identityId}|${provider}`;
  }

  getSnapshot(identityId: string, provider?: string | null): MetricSnapshot | null {
    if (provider) {
      return this.data.snapshots[this.snapshotKey(identityId, provider)] ?? null;
    }
    for (const candidate of SNAPSHOT_PRIORITY) {
      const snapshot = this.data.snapshots[this.snapshotKey(identityId, candidate)];
      if (snapshot) {
        return snapshot;
      }
    }
    return null;
  }

  putSnapshot(snapshot: MetricSnapshot): void {
    this.data.snapshots[this.snapshotKey(snapshot.journalIdentityId, snapshot.provider)] = snapshot;
  }

  rememberIdentity(identity: JournalIdentity): void {
    this.data.identities[identity.id] = identity;
  }

  getBinding(paperKey: string): PaperBinding | null {
    return this.data.bindings[paperKey] ?? null;
  }

  setBinding(paperKey: string, binding: PaperBinding): void {
    this.data.bindings[paperKey] = binding;
  }

  recordAttempt(
    identityId: string,
    provider: string,
    status: MetricStatus,
    message: string | null
  ): AttemptRecord {
    const key = this.snapshotKey(identityId, provider);
    const previous = this.data.attempts[key];
    const attempts = (previous?.attempts ?? 0) + 1;
    const delay = RETRY_DELAYS_MS[Math.min(attempts - 1, RETRY_DELAYS_MS.length - 1)];
    const record: AttemptRecord = {
      key,
      provider,
      status,
      attempts,
      lastAttemptAt: nowIso(),
      nextRetryAt: new Date(Date.now() + delay).toISOString(),
      message,
    };
    this.data.attempts[key] = record;
    return record;
  }

  clearAttempts(identityId: string): void {
    const prefix = `${identityId}|`;
    for (const key of Object.keys(this.data.attempts)) {
      if (key.startsWith(prefix)) {
        delete this.data.attempts[key];
      }
    }
  }

  latestAttempt(identityId: string): AttemptRecord | null {
    let latest: AttemptRecord | null = null;
    const prefix = `${identityId}|`;
    for (const record of Object.values(this.data.attempts)) {
      if (!record.key.startsWith(prefix)) {
        continue;
      }
      if (!latest || record.lastAttemptAt > latest.lastAttemptAt) {
        latest = record;
      }
    }
    return latest;
  }

  setImportTable(table: ImportTable | null): void {
    this.data.importTable = table;
  }
}
