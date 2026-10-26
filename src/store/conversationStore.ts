import { dataPath, readJson, writeJsonAtomic } from "../adapter/paths";
import { nowIso } from "../util";
import type { EvidenceRef } from "../ai/analysis";

/**
 * Per-paper AI conversation. Kept separate from the append-only reading log:
 * a chat can be cleared/rewritten, while the reading log is an audit trail.
 */
export const CONVERSATION_SCHEMA_VERSION = 1;
export const MAX_CONVERSATION_MESSAGES = 80;

export interface ConversationMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  at: string;
  preset?: string | null;
  evidence?: EvidenceRef[];
}

export interface ConversationFile {
  schemaVersion: number;
  paper: { libraryID: number; itemKey: string };
  attachmentKey: string | null;
  lastSequence: number;
  updatedAt: string;
  messages: ConversationMessage[];
}

interface NewConversationMessage {
  role: "user" | "assistant";
  content: string;
  preset?: string | null;
  evidence?: EvidenceRef[];
}

const locks = new Map<string, Promise<void>>();

function withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = locks.get(key) ?? Promise.resolve();
  const run = prev.then(fn, fn);
  locks.set(key, run.then(() => undefined, () => undefined));
  return run;
}

function sanitizeKey(key: string): string {
  return key.replace(/[^A-Za-z0-9_-]/g, "_");
}

function identityOf(attachmentItemID: number): {
  attachment: any;
  paperKey: string;
  libraryID: number;
  attachmentKey: string | null;
  path: string;
} {
  const attachment = Zotero.Items.get(attachmentItemID);
  if (!attachment) {
    throw new Error(`attachment item not found: ${attachmentItemID}`);
  }
  const parent = attachment.parentItem || attachment;
  const paperKey = String(parent.key || attachment.key || "unknown");
  return {
    attachment,
    paperKey,
    libraryID: Number(parent.libraryID ?? attachment.libraryID ?? 0),
    attachmentKey: attachment.parentItemID ? String(attachment.key || "") : null,
    path: dataPath("conversations", `${sanitizeKey(paperKey)}.json`),
  };
}

function emptyFile(libraryID: number, paperKey: string): ConversationFile {
  return {
    schemaVersion: CONVERSATION_SCHEMA_VERSION,
    paper: { libraryID, itemKey: paperKey },
    attachmentKey: null,
    lastSequence: 0,
    updatedAt: nowIso(),
    messages: [],
  };
}

export async function loadConversation(
  attachmentItemID: number
): Promise<ConversationMessage[]> {
  const identity = identityOf(attachmentItemID);
  const file = await readJson<ConversationFile>(
    identity.path,
    emptyFile(identity.libraryID, identity.paperKey)
  );
  return Array.isArray(file.messages) ? file.messages.slice(-MAX_CONVERSATION_MESSAGES) : [];
}

export async function appendConversationMessages(
  attachmentItemID: number,
  incoming: NewConversationMessage[]
): Promise<ConversationMessage[]> {
  if (!incoming.length) {
    return loadConversation(attachmentItemID);
  }
  const identity = identityOf(attachmentItemID);
  return withLock(identity.path, async () => {
    const file = await readJson<ConversationFile>(
      identity.path,
      emptyFile(identity.libraryID, identity.paperKey)
    );
    if (!Array.isArray(file.messages)) {
      file.messages = [];
    }
    const added: ConversationMessage[] = [];
    for (const message of incoming) {
      const sequence = Math.max(file.lastSequence || 0, file.messages.length) + 1;
      file.lastSequence = sequence;
      const stored: ConversationMessage = {
        id: `${identity.paperKey}-${sequence}`,
        role: message.role,
        content: String(message.content || ""),
        at: nowIso(),
        preset: message.preset || null,
        evidence: Array.isArray(message.evidence) ? message.evidence : [],
      };
      file.messages.push(stored);
      added.push(stored);
    }
    file.schemaVersion = CONVERSATION_SCHEMA_VERSION;
    file.attachmentKey = identity.attachmentKey;
    file.updatedAt = nowIso();
    if (file.messages.length > MAX_CONVERSATION_MESSAGES) {
      file.messages = file.messages.slice(-MAX_CONVERSATION_MESSAGES);
    }
    await writeJsonAtomic(identity.path, file);
    return added;
  });
}

export async function clearConversation(attachmentItemID: number): Promise<void> {
  const identity = identityOf(attachmentItemID);
  await withLock(identity.path, async () => {
    const file = emptyFile(identity.libraryID, identity.paperKey);
    file.attachmentKey = identity.attachmentKey;
    await writeJsonAtomic(identity.path, file);
  });
}
