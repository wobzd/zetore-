import { nowIso } from "../util";
import { normalizeIssn, toNumber, toYear, toZone } from "./identity";
import type { ImportRecord, ImportTable } from "./types";

const IMPORT_SCHEMA_VERSION = 1;

export async function pickMetricsFile(win: any): Promise<string | null> {
  const module = ChromeUtils.importESModule("chrome://zotero/content/modules/filePicker.mjs");
  const picker = new module.FilePicker();
  picker.init(win, "导入期刊指标（JSON / CSV）", picker.modeOpen);
  picker.appendFilter("期刊指标", "*.json; *.csv");
  picker.appendFilters(picker.filterAll);
  const result = await picker.show();
  if (result !== picker.returnOK) {
    return null;
  }
  const path = String(picker.file || "").trim();
  return path || null;
}

export async function parseMetricsFile(path: string): Promise<ImportTable> {
  // Excel-exported CSV often starts with a UTF-8 BOM; strip it before the
  // header lookup or the first column will never match.
  const text = (await IOUtils.readUTF8(path)).replace(/^\uFEFF/, "");
  const base = path.replace(/^.*[\\/]/, "").replace(/\.[^.]+$/, "");
  if (/\.json$/i.test(path)) {
    return parseJsonTable(text, base);
  }
  return parseCsvTable(text, base);
}

function parseJsonTable(text: string, base: string): ImportTable {
  let data: any;
  try {
    data = JSON.parse(text);
  }
  catch (e) {
    throw new Error("JSON 解析失败：" + String((e as Error)?.message || e));
  }
  const recordsRaw = Array.isArray(data)
    ? data
    : Array.isArray(data?.records)
      ? data.records
      : null;
  if (!recordsRaw) {
    throw new Error("JSON 必须是记录数组，或包含 records 数组的对象");
  }
  const metricsYear = toYear(data?.metricsYear ?? data?.year);
  const source = String(data?.source || base);
  return buildTable(recordsRaw, source, metricsYear);
}

/* ------------------------------------------------------------------ */
/* CSV                                                                 */
/* ------------------------------------------------------------------ */

/** RFC 4180-ish parser: quoted fields, escaped quotes, CRLF. */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (inQuotes) {
      if (char === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        }
        else {
          inQuotes = false;
        }
      }
      else {
        field += char;
      }
      continue;
    }
    if (char === '"') {
      inQuotes = true;
    }
    else if (char === ",") {
      row.push(field);
      field = "";
    }
    else if (char === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    }
    else if (char === "\r") {
      // Ignored; \n ends the row.
    }
    else {
      field += char;
    }
  }
  if (field.length || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((cells) => cells.some((cell) => cell.trim() !== ""));
}

const HEADER_MAP: Record<string, keyof ImportRecord | "year"> = {
  name: "name",
  journal: "name",
  journalname: "name",
  publicationtitle: "name",
  title: "name",
  "期刊": "name",
  "期刊名称": "name",
  "刊名": "name",
  issn: "issn",
  eissn: "eissn",
  jif: "jif",
  impactfactor: "jif",
  "影响因子": "jif",
  jifyear: "jifYear",
  "jif年份": "jifYear",
  jif5: "jif5",
  fiveyearimpactfactor: "jif5",
  "5年影响因子": "jif5",
  jci: "jci",
  jcr: "jcr",
  quartile: "jcr",
  jcrquartile: "jcr",
  "分区": "jcr",
  "jcr分区": "jcr",
  jcryear: "jcrYear",
  cas: "cas",
  caszone: "cas",
  "中科院": "cas",
  "中科院分区": "cas",
  casmajor: "casMajor",
  "大类": "casMajor",
  "中科院大类": "casMajor",
  casminor: "casMinor",
  "小类": "casMinor",
  "中科院小类": "casMinor",
  casedition: "casEdition",
  "分区版本": "casEdition",
  source: "source",
  "来源": "source",
  year: "year",
  metricsyear: "year",
  "年份": "year",
};

function normalizeHeader(raw: string): string {
  return raw.trim().toLowerCase().replace(/[\s_\-/]/g, "");
}

function parseCsvTable(text: string, base: string): ImportTable {
  const rows = parseCsv(text);
  if (rows.length < 2) {
    throw new Error("CSV 至少需要表头和一行数据");
  }
  const headers = rows[0].map((cell) => HEADER_MAP[normalizeHeader(cell)] ?? null);
  if (!headers.some((header) => header === "name" || header === "issn")) {
    throw new Error("CSV 缺少 name/journal 或 issn 列");
  }

  const records: any[] = [];
  let metricsYear: number | null = null;
  for (let r = 1; r < rows.length; r++) {
    const record: Record<string, any> = {};
    for (let c = 0; c < headers.length; c++) {
      const key = headers[c];
      if (!key) {
        continue;
      }
      const value = (rows[r][c] ?? "").trim();
      if (!value) {
        continue;
      }
      if (key === "year") {
        metricsYear = toYear(value) ?? metricsYear;
      }
      else {
        record[key] = value;
      }
    }
    if (Object.keys(record).length) {
      records.push(record);
    }
  }
  return buildTable(records, base, metricsYear);
}

/* ------------------------------------------------------------------ */
/* Normalization                                                       */
/* ------------------------------------------------------------------ */

function pickString(...values: unknown[]): string | null {
  for (const value of values) {
    if (value == null) {
      continue;
    }
    const text = String(value).trim();
    if (text) {
      return text;
    }
  }
  return null;
}

function normalizeRecord(raw: any): ImportRecord | null {
  if (!raw || typeof raw !== "object") {
    return null;
  }
  const name = pickString(
    raw.name, raw.journal, raw.journalName, raw.publicationTitle, raw["期刊"], raw["期刊名称"], raw["刊名"]
  ) ?? undefined;
  const issn = normalizeIssn(pickString(raw.issn, raw.ISSN));
  const eissn = normalizeIssn(pickString(raw.eissn, raw.eISSN));

  const record: ImportRecord = {
    name,
    issn: issn ?? undefined,
    eissn: eissn ?? undefined,
    jif: toNumber(raw.jif ?? raw.impactFactor ?? raw["影响因子"]),
    jifYear: toYear(raw.jifYear ?? raw["jif年份"]),
    jif5: toNumber(raw.jif5 ?? raw.fiveYearImpactFactor ?? raw["5年影响因子"]),
    jci: toNumber(raw.jci),
    jcr: pickString(raw.jcr, raw.quartile, raw.jcrQuartile, raw["分区"], raw["jcr分区"]) ?? undefined,
    jcrYear: toYear(raw.jcrYear),
    cas: toZone(raw.cas ?? raw.casZone ?? raw["中科院"] ?? raw["中科院分区"]),
    casMajor: toZone(raw.casMajor ?? raw["大类"] ?? raw["中科院大类"]),
    casMinor: toZone(raw.casMinor ?? raw["小类"] ?? raw["中科院小类"]),
    casEdition: pickString(raw.casEdition, raw["分区版本"]) ?? undefined,
    source: pickString(raw.source, raw["来源"]) ?? undefined,
  };

  if (!record.name && !record.issn) {
    return null;
  }
  const hasMetric = record.jif != null || record.jif5 != null || record.jci != null
    || !!record.jcr || record.cas != null || record.casMajor != null;
  return hasMetric ? record : null;
}

function buildTable(recordsRaw: any[], source: string, metricsYear: number | null): ImportTable {
  const records: ImportRecord[] = [];
  let skipped = 0;
  for (const raw of recordsRaw) {
    const record = normalizeRecord(raw);
    if (!record) {
      skipped++;
      continue;
    }
    records.push(record);
  }
  if (!records.length) {
    throw new Error("文件中没有可用的指标记录（需要刊名或 ISSN，且至少一个指标）");
  }
  return {
    schemaVersion: IMPORT_SCHEMA_VERSION,
    source,
    metricsYear,
    importedAt: nowIso(),
    records,
    skipped,
  };
}
