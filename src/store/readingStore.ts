import { dataPath, readJson, writeJsonAtomic } from "../adapter/paths";
import { nowIso } from "../util";

/**
 * Minimal per-paper reading event log (M1 subset of the M3 ReadingDossier).
 *
 * One JSON file per parent item, append-only events, atomic rewrite. The
 * full dossier schema (summaries, material-change markers) is M3 work; this
 * store only needs to prove that annotation actions update a paper record
 * incrementally and survive a restart.
 */
export const READING_STORE_SCHEMA_VERSION = 1;

export interface ReadingEvent {
  id: string;
  sequence: number;
  kind: string;
  at: string;
  data: Record<string, unknown>;
}

export interface ReadingStoreFile {
  schemaVersion: number;
  paper: { libraryID: number; itemKey: string };
  attachmentKey: string | null;
  lastSequence: number;
  events: ReadingEvent[];
}

const locks = new Map<string, Promise<void>>();

/** Serialize read-modify-write cycles per file. */
function withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = locks.get(key) ?? Promise.resolve();
  const run = prev.then(fn, fn);
  locks.set(key, run.then(() => undefined, () => undefined));
  return run;
}

function sanitizeKey(key: string): string {
  return key.replace(/[^A-Za-z0-9_-]/g, "_");
}

function emptyStore(libraryID: number, paperKey: string): ReadingStoreFile {
  return {
    schemaVersion: READING_STORE_SCHEMA_VERSION,
    paper: { libraryID, itemKey: paperKey },
    attachmentKey: null,
    lastSequence: 0,
    events: [],
  };
}

export async function appendReadingEvent(
  attachmentItemID: number,
  kind: string,
  data: Record<string, unknown>
): Promise<string> {
  const attachment = Zotero.Items.get(attachmentItemID);
  if (!attachment) {
    throw new Error(`attachment item not found: ${attachmentItemID}`);
  }

  let parent: any = attachment;
  try {
    parent = attachment.parentItem || attachment;
  }
  catch (e) {
    parent = attachment;
  }

  const paperKey = String(parent.key || attachment.key || "unknown");
  const path = dataPath("readings", `${sanitizeKey(paperKey)}.json`);

  return withLock(path, async () => {
    const store = await readJson<ReadingStoreFile>(
      path,
      emptyStore(parent.libraryID ?? attachment.libraryID ?? 0, paperKey)
    );
    if (!Array.isArray(store.events)) {
      store.events = [];
    }
    const sequence = Math.max(store.lastSequence || 0, store.events.length) + 1;
    store.lastSequence = sequence;
    if (attachment.parentItemID) {
      store.attachmentKey = attachment.key;
    }
    store.events.push({
      id: `${parent.libraryID ?? 0}-${paperKey}-${sequence}`,
      sequence,
      kind,
      at: nowIso(),
      data,
    });
    await writeJsonAtomic(path, store);
    return path;
  });
}
