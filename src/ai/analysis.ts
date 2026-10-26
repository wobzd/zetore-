import type { ChatUsage } from "./types";
import type { AnalysisPresetKey } from "./prompts";
import type { DocumentContextBlock } from "../document/text";

export interface AnalysisRequest {
  attachmentItemID: number;
  preset: AnalysisPresetKey | null;
  question: string;
}

export interface EvidenceRef {
  /** The exact citation token, e.g. `p12:b3`. */
  id: string;
  /** 0-based page index for Zotero.Reader.open(). */
  pageIndex: number;
  /** Human-readable page label from the SDT catalog, when available. */
  pageLabel: string;
  /** Internal block ID, e.g. `p11:b3` (0-based page). */
  blockId: string;
}

export interface AnalysisResult {
  text: string;
  model: string | null;
  usage: ChatUsage | null;
  evidence: EvidenceRef[];
  elapsedMs: number;
}

/**
 * Extract citations the model wrote. The prompt uses 1-based pages; Zotero's
 * reader API uses 0-based pageIndex, so conversion happens here once.
 */
export function parseEvidence(
  text: string,
  blocks: DocumentContextBlock[] = []
): EvidenceRef[] {
  const byId = new Map<string, DocumentContextBlock>();
  for (const block of blocks) {
    byId.set(block.evidenceId, block);
  }
  const seen = new Set<string>();
  const result: EvidenceRef[] = [];
  const re = /\[p(\d+):b(\d+)\]/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(String(text || ""))) !== null) {
    const id = `p${match[1]}:b${match[2]}`;
    if (seen.has(id)) {
      continue;
    }
    seen.add(id);
    const pageNumber = Number(match[1]);
    const blockIndex = Number(match[2]);
    if (!Number.isInteger(pageNumber) || pageNumber < 1 || !Number.isInteger(blockIndex)) {
      continue;
    }
    const pageIndex = pageNumber - 1;
    const block = byId.get(id);
    // If we have the context, only keep citations that actually point at a
    // supplied block. This blocks hallucinated page/block IDs from becoming
    // clickable evidence.
    if (blocks.length && !block) {
      continue;
    }
    result.push({
      id,
      pageIndex,
      pageLabel: block?.pageLabel || String(pageNumber),
      blockId: `p${pageIndex}:b${blockIndex}`,
    });
  }
  return result;
}
