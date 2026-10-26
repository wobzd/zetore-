import type { ImportRecord, JournalIdentity } from "./types";

/** Extra-field keys we are willing to read. Everything else stays untouched. */
const EXTRA_KEYS: Record<string, keyof ImportRecord> = {
  "jif": "jif",
  "impact factor": "jif",
  "journal impact factor": "jif",
  "jif year": "jifYear",
  "jif5": "jif5",
  "5 year impact factor": "jif5",
  "jci": "jci",
  "jcr": "jcr",
  "jcr quartile": "jcr",
  "jcr year": "jcrYear",
  "cas": "cas",
  "cas zone": "cas",
  "cas major": "casMajor",
  "cas minor": "casMinor",
  "cas edition": "casEdition",
  "metrics source": "source",
  "中科院": "cas",
  "中科院分区": "cas",
  "中科院大类": "casMajor",
  "中科院小类": "casMinor",
  "指标来源": "source",
};

export function normalizeIssn(raw: string | null | undefined): string | null {
  if (!raw) {
    return null;
  }
  const compact = String(raw).toUpperCase().replace(/[^0-9X]/g, "");
  if (compact.length !== 8) {
    return null;
  }
  return `${compact.slice(0, 4)}-${compact.slice(4)}`;
}

export function normalizeJournalName(raw: string | null | undefined): string {
  return String(raw || "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function toNumber(raw: unknown): number | null {
  if (typeof raw === "number") {
    return Number.isFinite(raw) ? raw : null;
  }
  if (typeof raw === "string") {
    const match = raw.replace(/,/g, "").match(/-?\d+(\.\d+)?/);
    if (match) {
      const value = Number(match[0]);
      return Number.isFinite(value) ? value : null;
    }
  }
  return null;
}

export function toYear(raw: unknown): number | null {
  const value = toNumber(raw);
  if (value == null) {
    return null;
  }
  const year = Math.trunc(value);
  return year >= 1900 && year <= 2100 ? year : null;
}

/** "1区" / "Q1" / 1 -> 1 */
export function toZone(raw: unknown): number | null {
  if (typeof raw === "number") {
    return raw >= 1 && raw <= 4 ? Math.trunc(raw) : null;
  }
  if (typeof raw === "string") {
    const match = raw.match(/[1-4]/);
    if (match) {
      return Number(match[0]);
    }
  }
  return null;
}

function field(item: any, name: string): string {
  try {
    return String(item.getField(name) || "").trim();
  }
  catch (e) {
    return "";
  }
}

function extraLines(item: any): string[] {
  const extra = field(item, "extra");
  return extra ? extra.split(/\r?\n/) : [];
}

export function extractIssns(item: any): string[] {
  const out: string[] = [];
  const push = (value: string): void => {
    const normalized = normalizeIssn(value);
    if (normalized && !out.includes(normalized)) {
      out.push(normalized);
    }
  };
  for (const part of field(item, "ISSN").split(/[\s,;]+/)) {
    push(part);
  }
  for (const line of extraLines(item)) {
    const match = line.match(/^ISSN\s*:\s*(.+)$/i);
    if (match) {
      for (const part of match[1].split(/[\s,;]+/)) {
        push(part);
      }
    }
  }
  return out;
}

export function paperKeyOf(item: any): string {
  return `${item.libraryID}:${item.key}`;
}

export function identifyJournal(item: any): JournalIdentity | null {
  if (!item || typeof item.getField !== "function") {
    return null;
  }
  try {
    if (typeof item.isRegularItem === "function" && !item.isRegularItem()) {
      return null;
    }
  }
  catch (e) {
    // Fall through: some synthetic items don't implement isRegularItem.
  }

  const name = field(item, "publicationTitle") || field(item, "journalAbbreviation");
  const issns = extractIssns(item);
  if (!name && !issns.length) {
    return null;
  }
  return {
    id: issns.length ? `issn:${issns[0]}` : `name:${normalizeJournalName(name)}`,
    name,
    issn: issns[0] ?? null,
    eissn: issns[1] ?? null,
    publisher: field(item, "publisher") || null,
    aliases: [],
  };
}

/**
 * Read only whitelisted metric keys from the Extra field. The Extra field
 * itself is never rewritten.
 */
export function parseExtraMetrics(item: any): Partial<ImportRecord> | null {
  const out: Partial<ImportRecord> = {};
  for (const line of extraLines(item)) {
    const index = line.indexOf(":");
    if (index <= 0) {
      continue;
    }
    const key = line.slice(0, index).trim().toLowerCase();
    const value = line.slice(index + 1).trim();
    const mapped = EXTRA_KEYS[key];
    if (!mapped || !value) {
      continue;
    }
    switch (mapped) {
      case "jif":
      case "jif5":
      case "jci":
        out[mapped] = toNumber(value);
        break;
      case "jifYear":
      case "jcrYear":
        out[mapped] = toYear(value);
        break;
      case "cas":
      case "casMajor":
      case "casMinor":
        out[mapped] = toZone(value);
        break;
      case "jcr":
      case "casEdition":
      case "source":
        out[mapped] = value;
        break;
      default:
        break;
    }
  }
  return hasMetrics(out) ? out : null;
}

export function hasMetrics(record: Partial<ImportRecord>): boolean {
  return record.jif != null
    || record.jif5 != null
    || record.jci != null
    || !!record.jcr
    || record.cas != null
    || record.casMajor != null;
}
