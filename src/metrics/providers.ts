import { errText } from "../util";
import { normalizeJournalName, toNumber, toYear, toZone } from "./identity";
import type {
  CasValue,
  ImportRecord,
  ImportTable,
  JournalIdentity,
  MetricStatus,
  MetricValue,
} from "./types";

export interface LookupContext {
  identity: JournalIdentity;
  year: number | null;
  importTable: ImportTable | null;
  easyscholarKey: string | null;
  timeoutMs: number;
}

export interface LookupOutcome {
  status: MetricStatus;
  provider: string;
  source: string;
  message?: string;
  metricsYear: number | null;
  jif: MetricValue;
  jif5: MetricValue;
  jci: MetricValue;
  quartile: MetricValue;
  cas: CasValue;
  extra: Record<string, string>;
}

export function emptyValue(status: MetricStatus = "not_requested"): MetricValue {
  return { value: null, metricsYear: null, status };
}

export function emptyCas(status: MetricStatus = "not_requested"): CasValue {
  return { zone: null, major: null, minor: null, edition: null, status };
}

export function emptyOutcome(
  provider: string,
  status: MetricStatus,
  message?: string
): LookupOutcome {
  return {
    status,
    provider,
    source: provider === "local_import" ? "本地指标文件" : provider,
    message,
    metricsYear: null,
    jif: emptyValue(status),
    jif5: emptyValue(status),
    jci: emptyValue(status),
    quartile: emptyValue(status),
    cas: emptyCas(status),
    extra: {},
  };
}

/* ------------------------------------------------------------------ */
/* Local import provider                                               */
/* ------------------------------------------------------------------ */

interface ImportIndex {
  byIssn: Map<string, ImportRecord>;
  byName: Map<string, ImportRecord[]>;
}

const indexCache = new WeakMap<ImportTable, ImportIndex>();

function buildIndex(table: ImportTable): ImportIndex {
  const cached = indexCache.get(table);
  if (cached) {
    return cached;
  }
  const byIssn = new Map<string, ImportRecord>();
  const byName = new Map<string, ImportRecord[]>();
  for (const record of table.records) {
    if (record.issn) {
      byIssn.set(record.issn, record);
    }
    const key = normalizeJournalName(record.name || "");
    if (!key) {
      continue;
    }
    const list = byName.get(key) || [];
    list.push(record);
    byName.set(key, list);
  }
  const index = { byIssn, byName };
  indexCache.set(table, index);
  return index;
}

function recordOutcome(record: ImportRecord, table: ImportTable): LookupOutcome {
  const jifYear = record.jifYear ?? table.metricsYear;
  const jif: MetricValue = {
    value: record.jif ?? null,
    metricsYear: jifYear,
    status: record.jif != null ? "success" : "not_found",
  };
  const jif5: MetricValue = {
    value: record.jif5 ?? null,
    metricsYear: jifYear,
    status: record.jif5 != null ? "success" : "not_found",
  };
  const jci: MetricValue = {
    value: record.jci ?? null,
    metricsYear: record.jcrYear ?? jifYear,
    status: record.jci != null ? "success" : "not_found",
  };
  const quartile: MetricValue = {
    value: record.jcr ?? null,
    metricsYear: record.jcrYear ?? jifYear,
    status: record.jcr ? "success" : "not_found",
  };
  const cas: CasValue = {
    zone: record.cas ?? null,
    major: record.casMajor ?? record.cas ?? null,
    minor: record.casMinor ?? null,
    edition: record.casEdition ?? null,
    status: (record.cas ?? record.casMajor) != null ? "success" : "not_found",
  };

  const hasAny = jif.value != null || jif5.value != null || jci.value != null
    || quartile.value != null || cas.zone != null || cas.major != null;
  if (!hasAny) {
    return emptyOutcome("local_import", "not_found", "记录没有指标字段");
  }
  const complete = jif.value != null && quartile.value != null;
  return {
    status: complete ? "success" : "partial",
    provider: "local_import",
    source: record.source || table.source,
    metricsYear: jifYear,
    jif,
    jif5,
    jci,
    quartile,
    cas,
    extra: {
      ...(record.casEdition ? { casEdition: record.casEdition } : {}),
      ...(table.metricsYear ? { tableYear: String(table.metricsYear) } : {}),
    },
  };
}

export function lookupLocalImport(ctx: LookupContext): LookupOutcome {
  const table = ctx.importTable;
  if (!table) {
    return emptyOutcome("local_import", "not_applicable", "未导入指标文件");
  }
  const index = buildIndex(table);

  if (ctx.identity.issn) {
    const byIssn = index.byIssn.get(ctx.identity.issn);
    if (byIssn) {
      return recordOutcome(byIssn, table);
    }
  }

  const key = normalizeJournalName(ctx.identity.name);
  const candidates = key ? index.byName.get(key) || [] : [];
  if (candidates.length === 1) {
    return recordOutcome(candidates[0], table);
  }
  if (candidates.length > 1) {
    const distinct = new Set(candidates.map((c) => c.issn || c.name));
    if (distinct.size === 1) {
      return recordOutcome(candidates[0], table);
    }
    return emptyOutcome(
      "local_import",
      "ambiguous",
      `同名期刊匹配到 ${distinct.size} 条记录，请用 ISSN 区分`
    );
  }
  return emptyOutcome("local_import", "not_found", "指标文件未收录该期刊");
}

/* ------------------------------------------------------------------ */
/* EasyScholar provider                                                */
/* ------------------------------------------------------------------ */

function readField(all: Record<string, any>, key: string): string | null {
  const value = all?.[key];
  if (value == null) {
    return null;
  }
  if (typeof value === "string" || typeof value === "number") {
    return String(value);
  }
  if (typeof value === "object") {
    for (const candidate of ["value", "text", "rank", "oneRankText"]) {
      if (value[candidate] != null) {
        return String(value[candidate]);
      }
    }
  }
  return null;
}

/**
 * Official open endpoint (verified contract):
 *   GET https://www.easyscholar.cc/open/getPublicationRank
 *       ?secretKey=...&publicationName=<encodeURIComponent>
 * Response: { code, msg, data: { officialRank: { all: { sciif, sci, jci,
 *   sciUp, sciUpSmall, sciUpTop, sciBase, sciwarn, ... } } } }
 * Rate limit: 2 requests/second (enforced by MetricsService).
 *
 * Fields used here: sciif (JIF), sci (JCR quartile), jci, sciif5, sciUp
 * (CAS upgrade zone), sciUpSmall (CAS minor), sciUpTop (Top), sciBase.
 */
export async function lookupEasyScholar(ctx: LookupContext): Promise<LookupOutcome> {
  const secret = (ctx.easyscholarKey || "").trim();
  if (!secret) {
    return emptyOutcome("easyscholar", "not_applicable", "未配置 EasyScholar 密钥");
  }
  if (!ctx.identity.name) {
    return emptyOutcome("easyscholar", "not_applicable", "条目不包含期刊名称");
  }

  const url = "https://www.easyscholar.cc/open/getPublicationRank"
    + `?secretKey=${encodeURIComponent(secret)}`
    + `&publicationName=${encodeURIComponent(ctx.identity.name)}`;

  let body: any;
  try {
    const xhr = await Zotero.HTTP.request("GET", url, {
      responseType: "json",
      timeout: ctx.timeoutMs,
    });
    body = xhr.response;
  }
  catch (e) {
    const message = errText(e);
    const status: MetricStatus = /429|too many|频繁|限速/i.test(message)
      ? "rate_limited"
      : "network_error";
    return emptyOutcome("easyscholar", status, message);
  }

  if (typeof body === "string") {
    try {
      body = JSON.parse(body);
    }
    catch (e) {
      return emptyOutcome("easyscholar", "network_error", "响应不是 JSON");
    }
  }
  if (!body || typeof body !== "object") {
    return emptyOutcome("easyscholar", "network_error", "响应为空");
  }

  if (body.code !== 200) {
    const message = String(body.msg || `code ${body.code}`);
    if (body.code === 40002 || /key/i.test(message)) {
      return emptyOutcome("easyscholar", "auth_error", message);
    }
    if (/频繁|限速|limit|429/i.test(message)) {
      return emptyOutcome("easyscholar", "rate_limited", message);
    }
    if (/无结果|未找到|not found|不存在/i.test(message)) {
      return emptyOutcome("easyscholar", "not_found", message);
    }
    return emptyOutcome("easyscholar", "network_error", message);
  }

  const all = body.data?.officialRank?.all || body.data?.officialRank?.select;
  if (!all || typeof all !== "object") {
    return emptyOutcome("easyscholar", "not_found", "接口未返回期刊等级");
  }

  const jifRaw = readField(all, "sciif");
  const jif5Raw = readField(all, "sciif5");
  const jciRaw = readField(all, "jci");
  const quartileRaw = readField(all, "sci");
  const casRaw = readField(all, "sciUp");
  const casBaseRaw = readField(all, "sciBase");
  const casSmallRaw = readField(all, "sciUpSmall");
  const casTopRaw = readField(all, "sciUpTop");
  const warningRaw = readField(all, "sciwarn");

  const jifValue = toNumber(jifRaw);
  const jif5Value = toNumber(jif5Raw);
  const jciValue = toNumber(jciRaw);
  const zone = toZone(casRaw) ?? toZone(casBaseRaw);
  const minor = toZone(casSmallRaw);

  const hasAny = jifValue != null || jif5Value != null || jciValue != null
    || !!quartileRaw || zone != null;
  if (!hasAny) {
    return emptyOutcome("easyscholar", "not_found", "接口未返回该期刊的指标");
  }

  const jifStatus: MetricStatus = jifValue != null ? "success" : "not_found";
  const quartileStatus: MetricStatus = quartileRaw ? "success" : "not_found";
  const casStatus: MetricStatus = zone != null ? "success" : "not_found";

  return {
    status: jifValue != null && quartileRaw ? "success" : "partial",
    provider: "easyscholar",
    source: "EasyScholar",
    metricsYear: null,
    jif: { value: jifValue, metricsYear: null, status: jifStatus },
    jif5: { value: jif5Value, metricsYear: null, status: jif5Value != null ? "success" : "not_found" },
    jci: { value: jciValue, metricsYear: null, status: jciValue != null ? "success" : "not_found" },
    quartile: { value: quartileRaw, metricsYear: null, status: quartileStatus },
    cas: {
      zone,
      major: zone,
      minor,
      edition: zone != null ? "中科院升级版" : null,
      status: casStatus,
    },
    extra: {
      ...(casTopRaw ? { casTop: casTopRaw } : {}),
      ...(warningRaw ? { warning: warningRaw } : {}),
      ...(casBaseRaw ? { casBase: casBaseRaw } : {}),
    },
  };
}

export function toYearSafe(raw: unknown): number | null {
  return toYear(raw);
}
