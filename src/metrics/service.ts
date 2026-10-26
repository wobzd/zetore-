import { debug, errText, nowIso } from "../util";
import { hasMetrics, identifyJournal, paperKeyOf, parseExtraMetrics } from "./identity";
import { MetricsStore } from "./store";
import {
  emptyValue,
  lookupEasyScholar,
  lookupLocalImport,
  type LookupOutcome,
} from "./providers";
import type {
  ImportTable,
  JournalIdentity,
  MetricSnapshot,
  MetricStatus,
} from "./types";

const SNAPSHOT_SCHEMA_VERSION = 1;
const LOOKUP_TIMEOUT_MS = 12_000;
/** EasyScholar allows 2 requests/second. */
const EASYSCHOLAR_MIN_INTERVAL_MS = 600;
const EASYSCHOLAR_PREF = "extensions.zotero.zotero-reading-assistant.easyscholarKey";

export interface DisplayState {
  text: string;
  state: MetricStatus;
  configured: boolean;
}

export interface MetricDetails {
  identity: JournalIdentity | null;
  snapshot: MetricSnapshot | null;
  state: MetricStatus;
  message: string | null;
  configured: boolean;
  source: string | null;
  attemptStatus: MetricStatus | null;
}

export interface AnalyzeResult {
  status: MetricStatus;
  message?: string;
  snapshot?: MetricSnapshot | null;
}

interface QueueJob {
  item: any;
  paperKey: string;
  force: boolean;
}

function statusText(status: MetricStatus): string {
  switch (status) {
    case "queued":
      return "查询中…";
    case "not_found":
      return "未收录";
    case "ambiguous":
      return "待确认";
    case "network_error":
      return "失败";
    case "auth_error":
      return "待配置";
    case "rate_limited":
      return "限速";
    case "partial":
      return "部分";
    default:
      return "";
  }
}

function formatSnapshot(snapshot: MetricSnapshot): string {
  const parts: string[] = [];
  const quartile = typeof snapshot.quartile.value === "string"
    ? snapshot.quartile.value.trim()
    : "";
  if (quartile) {
    parts.push(quartile);
  }
  if (snapshot.jif.value != null) {
    parts.push(`IF ${snapshot.jif.value}`);
  }
  if (!parts.length && snapshot.cas.zone != null) {
    parts.push(`中科院${snapshot.cas.zone}区`);
  }
  if (!parts.length && snapshot.jci.value != null) {
    parts.push(`JCI ${snapshot.jci.value}`);
  }
  return parts.join(" · ");
}

function overallStatus(snapshot: MetricSnapshot): MetricStatus {
  const hasJif = snapshot.jif.value != null;
  const hasQuartile = snapshot.quartile.value != null;
  const hasCas = snapshot.cas.zone != null;
  if (hasJif && (hasQuartile || hasCas)) {
    return "success";
  }
  if (hasJif || hasQuartile || hasCas || snapshot.jci.value != null) {
    return "partial";
  }
  return snapshot.jif.status;
}

export class MetricsService {
  store = new MetricsStore();
  private queue: QueueJob[] = [];
  private queuedKeys = new Set<string>();
  private inFlight = new Set<string>();
  private running = false;
  private lastEasyscholarAt = 0;
  private updateHandler: (() => void) | null = null;
  private listeners = new Set<() => void>();
  private notifyTimer: number | null = null;
  private easyscholarKey: string | null = null;

  async initialize(): Promise<void> {
    await this.store.load();
    this.easyscholarKey = this.readKey();
  }

  setUpdateHandler(handler: () => void): void {
    this.updateHandler = handler;
  }

  /** Subscribe to cache changes (used by the item pane section). */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  getEasyscholarKey(): string | null {
    return this.easyscholarKey;
  }

  async setEasyscholarKey(key: string): Promise<void> {
    const value = key.trim();
    this.easyscholarKey = value || null;
    try {
      Zotero.Prefs.set(EASYSCHOLAR_PREF, value, true);
    }
    catch (e) {
      debug("set easyscholar key failed: " + errText(e));
    }
    this.notify();
  }

  isConfigured(): boolean {
    return !!this.store.data.importTable || !!this.easyscholarKey;
  }

  private readKey(): string | null {
    try {
      const value = Zotero.Prefs.get(EASYSCHOLAR_PREF, true);
      return value ? String(value) : null;
    }
    catch (e) {
      return null;
    }
  }

  /* ---------------------------------------------------------------- */
  /* Rendering (cache only — never performs network I/O)              */
  /* ---------------------------------------------------------------- */

  display(item: any): DisplayState {
    if (!item || (typeof item.isRegularItem === "function" && !item.isRegularItem())) {
      return { text: "", state: "not_applicable", configured: this.isConfigured() };
    }
    let identity: JournalIdentity | null = null;
    try {
      identity = identifyJournal(item);
    }
    catch (e) {
      return { text: "", state: "not_applicable", configured: this.isConfigured() };
    }
    if (!identity) {
      return { text: "", state: "not_applicable", configured: this.isConfigured() };
    }

    let paperKey = "";
    try {
      paperKey = paperKeyOf(item);
    }
    catch (e) {
      return { text: "", state: "not_applicable", configured: this.isConfigured() };
    }

    // Cache is keyed by the item's current identity. A binding from an older
    // identity must not override a corrected journal.
    const snapshot = this.store.getSnapshot(identity.id);

    if (snapshot) {
      return { text: formatSnapshot(snapshot), state: overallStatus(snapshot), configured: true };
    }
    if (this.queuedKeys.has(paperKey) || this.inFlight.has(paperKey)) {
      return { text: statusText("queued"), state: "queued", configured: true };
    }

    const attempt = this.store.latestAttempt(identity.id);
    if (attempt && attempt.status !== "success") {
      return { text: statusText(attempt.status), state: attempt.status, configured: true };
    }
    if (!this.isConfigured()) {
      return { text: "", state: "not_requested", configured: false };
    }
    return { text: "未查询", state: "not_requested", configured: true };
  }

  getDetails(item: any): MetricDetails {
    const base: MetricDetails = {
      identity: null,
      snapshot: null,
      state: "not_applicable",
      message: null,
      configured: this.isConfigured(),
      source: null,
      attemptStatus: null,
    };
    if (!item) {
      return base;
    }
    let identity: JournalIdentity | null = null;
    try {
      identity = identifyJournal(item);
    }
    catch (e) {
      return base;
    }
    if (!identity) {
      return base;
    }

    const paperKey = paperKeyOf(item);
    const snapshot = this.store.getSnapshot(identity.id);
    const attempt = this.store.latestAttempt(identity.id);

    if (snapshot) {
      const year = snapshot.metricsYear ? ` · ${snapshot.metricsYear}` : "";
      return {
        ...base,
        identity,
        snapshot,
        state: overallStatus(snapshot),
        message: `来源：${snapshot.source}${year}`,
        source: snapshot.source,
        attemptStatus: attempt?.status ?? null,
      };
    }
    return {
      ...base,
      identity,
      state: this.queuedKeys.has(paperKey) || this.inFlight.has(paperKey)
        ? "queued"
        : attempt?.status ?? "not_requested",
      message: attempt?.message ?? null,
      attemptStatus: attempt?.status ?? null,
    };
  }

  /* ---------------------------------------------------------------- */
  /* Queue                                                             */
  /* ---------------------------------------------------------------- */

  ensureQueued(item: any): void {
    if (!this.isConfigured()) {
      return;
    }
    let identity: JournalIdentity | null = null;
    try {
      identity = identifyJournal(item);
    }
    catch (e) {
      return;
    }
    if (!identity) {
      return;
    }

    const paperKey = paperKeyOf(item);
    if (this.queuedKeys.has(paperKey) || this.inFlight.has(paperKey)) {
      return;
    }

    if (this.store.getSnapshot(identity.id)) {
      return;
    }
    const attempt = this.store.latestAttempt(identity.id);
    if (attempt?.nextRetryAt && Date.parse(attempt.nextRetryAt) > Date.now()) {
      return;
    }

    this.queuedKeys.add(paperKey);
    this.queue.push({ item, paperKey, force: false });
    this.notify();
    void this.processQueue();
  }

  private async processQueue(): Promise<void> {
    if (this.running) {
      return;
    }
    this.running = true;
    try {
      while (this.queue.length) {
        const job = this.queue.shift()!;
        try {
          await this.analyzeItem(job.item, { force: job.force });
        }
        catch (e) {
          debug("metric lookup failed: " + errText(e));
        }
        finally {
          this.queuedKeys.delete(job.paperKey);
        }
      }
    }
    finally {
      this.running = false;
      this.notify();
    }
  }

  /* ---------------------------------------------------------------- */
  /* Lookup                                                            */
  /* ---------------------------------------------------------------- */

  async analyzeItem(item: any, opts: { force?: boolean } = {}): Promise<AnalyzeResult> {
    let identity: JournalIdentity | null = null;
    try {
      identity = identifyJournal(item);
    }
    catch (e) {
      return { status: "not_applicable", message: errText(e) };
    }
    if (!identity) {
      return { status: "not_applicable", message: "不是期刊论文或缺少刊名/ISSN" };
    }

    const paperKey = paperKeyOf(item);
    if (this.inFlight.has(paperKey)) {
      return { status: "queued", message: "已在查询中" };
    }
    this.inFlight.add(paperKey);

    try {
      this.store.rememberIdentity(identity);

      if (!opts.force) {
        const cached = this.store.getSnapshot(identity.id);
        if (cached) {
          return { status: overallStatus(cached), snapshot: cached };
        }
      }

      const outcome = await this.lookup(identity, item);
      if (outcome.status === "success" || outcome.status === "partial") {
        const snapshot = await this.saveOutcome(identity, paperKey, outcome);
        return { status: outcome.status, snapshot };
      }

      if (outcome.status !== "not_applicable") {
        this.store.recordAttempt(identity.id, outcome.provider, outcome.status, outcome.message ?? null);
        await this.store.save();
      }
      return { status: outcome.status, message: outcome.message };
    }
    finally {
      this.inFlight.delete(paperKey);
      this.notify();
    }
  }

  async analyzeItems(
    items: any[],
    opts: { force?: boolean } = {}
  ): Promise<{ processed: number; skipped: number }> {
    let processed = 0;
    let skipped = 0;
    for (const item of items) {
      if (!item || (typeof item.isRegularItem === "function" && !item.isRegularItem())) {
        skipped++;
        continue;
      }
      const result = await this.analyzeItem(item, opts);
      if (result.status === "not_applicable") {
        skipped++;
      }
      else {
        processed++;
      }
    }
    return { processed, skipped };
  }

  private async lookup(identity: JournalIdentity, item: any): Promise<LookupOutcome> {
    // 1. Item-level Extra overrides everything (user's own annotation).
    const extra = parseExtraMetrics(item);
    if (extra && hasMetrics(extra)) {
      return this.outcomeFromExtra(extra);
    }

    // 2. Local import table.
    const table = this.store.data.importTable;
    if (table) {
      const outcome = lookupLocalImport({
        identity,
        year: null,
        importTable: table,
        easyscholarKey: this.easyscholarKey,
        timeoutMs: LOOKUP_TIMEOUT_MS,
      });
      if (outcome.status === "success" || outcome.status === "partial" || outcome.status === "ambiguous") {
        return outcome;
      }
    }

    // 3. EasyScholar.
    if (this.easyscholarKey) {
      await this.waitForEasyscholarSlot();
      const outcome = await lookupEasyScholar({
        identity,
        year: null,
        importTable: table,
        easyscholarKey: this.easyscholarKey,
        timeoutMs: LOOKUP_TIMEOUT_MS,
      });
      return outcome;
    }

    if (!table) {
      return {
        status: "not_applicable",
        provider: "none",
        source: "none",
        message: "未配置指标来源：请导入指标文件或设置 EasyScholar 密钥",
        metricsYear: null,
        jif: emptyValue("not_applicable"),
        jif5: emptyValue("not_applicable"),
        jci: emptyValue("not_applicable"),
        quartile: emptyValue("not_applicable"),
        cas: { zone: null, major: null, minor: null, edition: null, status: "not_applicable" },
        extra: {},
      };
    }
    return {
      status: "not_found",
      provider: "local_import",
      source: "本地指标文件",
      message: "指标文件未收录该期刊",
      metricsYear: null,
      jif: emptyValue("not_found"),
      jif5: emptyValue("not_found"),
      jci: emptyValue("not_found"),
      quartile: emptyValue("not_found"),
      cas: { zone: null, major: null, minor: null, edition: null, status: "not_found" },
      extra: {},
    };
  }

  private outcomeFromExtra(extra: ReturnType<typeof parseExtraMetrics>): LookupOutcome {
    if (!extra) {
      throw new Error("empty extra metrics");
    }
    const jifValue = extra.jif ?? null;
    const quartile = extra.jcr ?? null;
    const zone = extra.cas ?? extra.casMajor ?? null;
    const jifYear = extra.jifYear ?? null;
    const status: MetricStatus = jifValue != null && quartile ? "success" : "partial";
    return {
      status,
      provider: "extra",
      source: extra.source || "条目 Extra 字段",
      metricsYear: jifYear,
      jif: {
        value: jifValue,
        metricsYear: jifYear,
        status: jifValue != null ? "success" : "not_found",
      },
      jif5: { value: extra.jif5 ?? null, metricsYear: jifYear, status: extra.jif5 != null ? "success" : "not_found" },
      jci: { value: extra.jci ?? null, metricsYear: extra.jcrYear ?? jifYear, status: extra.jci != null ? "success" : "not_found" },
      quartile: {
        value: quartile,
        metricsYear: extra.jcrYear ?? jifYear,
        status: quartile ? "success" : "not_found",
      },
      cas: {
        zone,
        major: extra.casMajor ?? zone,
        minor: extra.casMinor ?? null,
        edition: extra.casEdition ?? null,
        status: zone != null ? "success" : "not_found",
      },
      extra: {},
    };
  }

  private async saveOutcome(
    identity: JournalIdentity,
    paperKey: string,
    outcome: LookupOutcome
  ): Promise<MetricSnapshot> {
    const snapshot: MetricSnapshot = {
      schemaVersion: SNAPSHOT_SCHEMA_VERSION,
      id: `${identity.id}|${outcome.provider}`,
      journalIdentityId: identity.id,
      provider: outcome.provider,
      source: outcome.source,
      fetchedAt: nowIso(),
      metricsYear: outcome.metricsYear,
      jif: outcome.jif,
      jif5: outcome.jif5,
      jci: outcome.jci,
      quartile: outcome.quartile,
      cas: outcome.cas,
      extra: outcome.extra,
    };
    this.store.putSnapshot(snapshot);
    this.store.setBinding(paperKey, {
      journalIdentityId: identity.id,
      metricsYear: outcome.metricsYear,
      updatedAt: nowIso(),
    });
    this.store.clearAttempts(identity.id);
    try {
      // Await the write: the acceptance requirement is that the value is
      // still there after an offline restart, so the alert must not appear
      // before the cache is on disk.
      await this.store.save();
    }
    catch (e) {
      // Keep the in-memory cache usable even if the disk write fails.
      debug("metrics save failed: " + errText(e));
    }
    return snapshot;
  }

  private async waitForEasyscholarSlot(): Promise<void> {
    const wait = this.lastEasyscholarAt + EASYSCHOLAR_MIN_INTERVAL_MS - Date.now();
    if (wait > 0) {
      await new Promise<void>((resolve) => setTimeout(resolve, wait));
    }
    this.lastEasyscholarAt = Date.now();
  }

  /* ---------------------------------------------------------------- */
  /* Import                                                            */
  /* ---------------------------------------------------------------- */

  async importTable(table: ImportTable): Promise<void> {
    this.store.setImportTable(table);
    // A new table can fill previously missing journals; clear backoff so the
    // next selection retries instead of waiting out a stale delay.
    this.store.data.attempts = {};
    await this.store.save();
    this.notify();
  }

  /* ---------------------------------------------------------------- */
  /* Change notification                                               */
  /* ---------------------------------------------------------------- */

  notify(): void {
    if (this.notifyTimer !== null) {
      return;
    }
    this.notifyTimer = setTimeout(() => {
      this.notifyTimer = null;
      try {
        this.updateHandler?.();
      }
      catch (e) {
        debug("metrics update handler failed: " + errText(e));
      }
      for (const listener of this.listeners) {
        try {
          listener();
        }
        catch (e) {
          debug("metrics listener failed: " + errText(e));
        }
      }
    }, 250);
  }
}
