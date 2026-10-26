/**
 * F1 metric data contract (M1 subset of spec §9.6).
 *
 * Every value carries its own status so a partial result (e.g. JIF present
 * but no CAS zone) can be displayed honestly instead of being flattened into
 * a single success flag.
 */

export type MetricStatus =
  | "not_requested"
  | "queued"
  | "success"
  | "partial"
  | "not_found"
  | "ambiguous"
  | "network_error"
  | "auth_error"
  | "rate_limited"
  | "not_applicable";

export interface MetricValue {
  value: number | string | null;
  metricsYear: number | null;
  status: MetricStatus;
}

export interface CasValue {
  zone: number | null;
  major: number | null;
  minor: number | null;
  edition: string | null;
  status: MetricStatus;
}

export interface MetricSnapshot {
  schemaVersion: number;
  /** `${journalIdentityId}|${provider}` */
  id: string;
  journalIdentityId: string;
  provider: string;
  source: string;
  fetchedAt: string;
  metricsYear: number | null;
  jif: MetricValue;
  jif5: MetricValue;
  jci: MetricValue;
  quartile: MetricValue;
  cas: CasValue;
  extra: Record<string, string>;
}

export interface JournalIdentity {
  /** `issn:1234-5678` when an ISSN exists, otherwise `name:<normalized>`. */
  id: string;
  name: string;
  issn: string | null;
  eissn: string | null;
  publisher: string | null;
  aliases: string[];
}

export interface PaperBinding {
  journalIdentityId: string;
  metricsYear: number | null;
  updatedAt: string;
}

export interface AttemptRecord {
  key: string;
  provider: string;
  status: MetricStatus;
  attempts: number;
  lastAttemptAt: string;
  nextRetryAt: string | null;
  message: string | null;
}

export interface ImportRecord {
  name?: string;
  issn?: string;
  eissn?: string;
  jif?: number | null;
  jifYear?: number | null;
  jif5?: number | null;
  jci?: number | null;
  jcr?: string | null;
  jcrYear?: number | null;
  cas?: number | null;
  casMajor?: number | null;
  casMinor?: number | null;
  casEdition?: string | null;
  source?: string;
}

export interface ImportTable {
  schemaVersion: number;
  source: string;
  metricsYear: number | null;
  importedAt: string;
  records: ImportRecord[];
  skipped: number;
}

export interface MetricsStoreFile {
  schemaVersion: number;
  identities: Record<string, JournalIdentity>;
  snapshots: Record<string, MetricSnapshot>;
  bindings: Record<string, PaperBinding>;
  attempts: Record<string, AttemptRecord>;
  importTable: ImportTable | null;
}

/** Snapshot preference when several providers have data for one journal. */
export const SNAPSHOT_PRIORITY = ["extra", "local_import", "easyscholar"] as const;
