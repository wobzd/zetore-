import { debug, errText } from "../util";
import type { SelectionPayload } from "../annotations/service";

/**
 * Page-level access to Zotero's Structured Document Text (SDT) index.
 *
 * SDT is Zotero's own PDF text layer (the same blocks the reader uses for
 * annotations), so coordinates and page labels line up with the reader. We
 * deliberately read one page at a time: a 100-page PDF should not be
 * materialized just to translate one sentence.
 */

export interface DocumentPage {
  pageIndex: number;
  pageLabel: string;
  blocks: DocumentBlock[];
  text: string;
}

export interface DocumentBlock {
  blockId: string;
  topLevelIndex: number;
  pageIndex: number;
  pageLabel: string;
  text: string;
}

export interface DocumentInfo {
  attachmentItemID: number;
  title: string;
  fingerprint: string;
  fingerprintKind: string;
  extractionVersion: string;
  pageCount: number;
  metadata: any;
  catalog: any;
}

export interface SelectionContext {
  attachmentItemID: number;
  pageIndex: number | null;
  pageLabel: string;
  blockId: string | null;
  selectedText: string;
  before: string;
  after: string;
  sectionHeading: string;
  contextText: string;
  matched: boolean;
  fingerprint: string;
  fingerprintKind: string;
  extractionVersion: string;
  positionHash: string;
}

/**
 * One addressable SDT block in a full-document context. The evidence ID is
 * 1-based on the page (`p12:b3`) so a model can cite it naturally; the
 * `pageIndex` remains 0-based for Zotero's reader APIs.
 */
export interface DocumentContextBlock {
  evidenceId: string;
  pageIndex: number;
  pageLabel: string;
  blockIndex: number;
  sectionHeading: string;
  text: string;
}

export interface DocumentContext {
  attachmentItemID: number;
  title: string;
  pageCount: number;
  blocks: DocumentContextBlock[];
  text: string;
  truncated: boolean;
  totalChars: number;
  includedChars: number;
  fingerprint: string;
}

const EXTRACTION_VERSION = "sdt-v1";
const CONTEXT_BEFORE_CHARS = 900;
const CONTEXT_AFTER_CHARS = 900;
const DEFAULT_CONTEXT_CHARS = 60000;
const MIN_CONTEXT_CHARS = 4000;
const MAX_CONTEXT_CHARS = 200000;

interface CacheEntry {
  version: string;
  info: DocumentInfo;
  reader: any;
  pages: Map<number, DocumentPage>;
}

function normalizeText(value: unknown): string {
  return String(value || "")
    .replace(/\u00ad/g, "")
    .replace(/([A-Za-z])-\s*\n\s*([a-z])/g, "$1$2")
    .replace(/\s+/g, " ")
    .trim();
}

function nodeText(node: any): string {
  if (!node || typeof node !== "object") {
    return "";
  }
  if (typeof node.text === "string") {
    return node.text;
  }
  if (Array.isArray(node.content)) {
    return node.content.map(nodeText).join(" ");
  }
  return "";
}

function pageLabelOf(page: any, pageIndex: number): string {
  const label = page?.label ?? page?.pageLabel;
  return label === undefined || label === null || label === "" ? String(pageIndex + 1) : String(label);
}

function matchesPageLabel(catalogLabel: string, wanted: string): boolean {
  const a = normalizeText(catalogLabel);
  const b = normalizeText(wanted);
  if (!b) {
    return false;
  }
  if (a === b) {
    return true;
  }
  const na = a.replace(/[^\d]/g, "");
  const nb = b.replace(/[^\d]/g, "");
  return !!na && !!nb && na === nb;
}

function safeTitle(attachment: any): string {
  try {
    const parentID = attachment.parentItemID;
    if (parentID) {
      const parent = Zotero.Items.get(parentID);
      const title = parent?.getField?.("title");
      if (title) {
        return String(title);
      }
    }
  }
  catch (e) {
    // fall through to filename
  }
  try {
    return String(
      attachment.getField?.("title")
      || attachment.attachmentFilename
      || attachment.key
      || attachment.id
    );
  }
  catch (e) {
    return String(attachment?.id || "document");
  }
}

function stableJSON(value: unknown): string {
  try {
    return JSON.stringify(value ?? {});
  }
  catch (e) {
    return "{}";
  }
}

function parsePosition(value: unknown): any {
  if (typeof value === "string") {
    try {
      return JSON.parse(value);
    }
    catch (e) {
      return null;
    }
  }
  return value ?? null;
}

function pageContainsText(page: DocumentPage, text: string): boolean {
  const needle = normalizeText(text).slice(0, 80);
  return !!needle && page.text.includes(needle);
}

/**
 * Split a long block into a window around the match so a 5,000-character
 * reference list doesn't blow up the prompt.
 */
function windowAround(text: string, needle: string, before: number, after: number): {
  text: string;
  start: number;
  end: number;
} {
  const hay = normalizeText(text);
  const target = normalizeText(needle);
  const start = target ? hay.indexOf(target) : -1;
  if (start < 0) {
    return { text: hay.slice(0, before + after), start: 0, end: Math.min(hay.length, before + after) };
  }
  const from = Math.max(0, start - before);
  const to = Math.min(hay.length, start + target.length + after);
  return { text: hay.slice(from, to), start, end: start + target.length };
}

const SECTION_WORDS = [
  "abstract", "introduction", "background", "related work", "methods", "method",
  "materials and methods", "results", "results and discussion", "discussion",
  "conclusion", "conclusions", "limitations", "future work", "references",
  "摘要", "引言", "前言", "背景", "方法", "材料与方法", "结果", "讨论",
  "结论", "局限", "展望", "参考文献",
];

function looksLikeHeading(text: string): boolean {
  const value = normalizeText(text);
  if (!value || value.length > 110) {
    return false;
  }
  if (/[。！？.!?;；]$/.test(value)) {
    return false;
  }
  const lower = value.toLowerCase().replace(/^\d+(\.\d+)*\s*/, "").trim();
  return SECTION_WORDS.some((word) => lower === word || lower.startsWith(word + " ") || lower.startsWith(word + ":"));
}

function sectionHeadingFromBlocks(blocks: DocumentBlock[], selectedIndex: number): string {
  for (let i = selectedIndex; i >= 0; i--) {
    const text = normalizeText(blocks[i]?.text);
    if (!text) {
      continue;
    }
    if (looksLikeHeading(text)) {
      return text.length > 90 ? text.slice(0, 90) : text;
    }
  }
  return "";
}

function isKeySection(heading: string): boolean {
  const value = normalizeText(heading).toLowerCase();
  return /abstract|introduction|method|materials|results|discussion|conclusion|limitation|摘要|引言|方法|材料|结果|讨论|结论|局限/.test(value);
}

/**
 * Keep the first pages, the last pages and the argument-bearing middle
 * sections when a paper exceeds the prompt budget. The final pass fills any
 * remaining room in document order, so citations stay readable.
 */
function selectContextBlocks(
  blocks: DocumentContextBlock[],
  pageCount: number,
  maxChars: number
): DocumentContextBlock[] {
  const selected = new Set<number>();
  let used = 0;
  const add = (index: number): void => {
    if (index < 0 || index >= blocks.length || selected.has(index)) {
      return;
    }
    const block = blocks[index];
    const cost = block.text.length + block.evidenceId.length + 48;
    if (used + cost > maxChars) {
      return;
    }
    selected.add(index);
    used += cost;
  };

  for (let i = 0; i < blocks.length; i++) {
    if (blocks[i].pageIndex <= 1) {
      add(i);
    }
  }
  for (let i = 0; i < blocks.length; i++) {
    if (blocks[i].pageIndex >= Math.max(0, pageCount - 2)) {
      add(i);
    }
  }
  for (let i = 0; i < blocks.length; i++) {
    if (isKeySection(blocks[i].sectionHeading)) {
      add(i);
    }
  }
  for (let i = 0; i < blocks.length; i++) {
    add(i);
  }

  // A pathologically small budget must still produce a usable prompt.
  if (!selected.size && blocks.length) {
    selected.add(0);
  }
  return Array.from(selected).sort((a, b) => a - b).map((index) => blocks[index]);
}

function formatContextBlocks(blocks: DocumentContextBlock[]): string {
  const parts: string[] = [];
  let lastHeading = "";
  for (const block of blocks) {
    if (block.sectionHeading && block.sectionHeading !== lastHeading) {
      parts.push(`\n## ${block.sectionHeading}`);
      lastHeading = block.sectionHeading;
    }
    parts.push(`[${block.evidenceId}] ${block.text}`);
  }
  return parts.join("\n").trim();
}

export class DocumentTextService {
  private cache = new Map<number, CacheEntry>();

  async getInfo(attachmentItemID: number): Promise<DocumentInfo> {
    const attachment = Zotero.Items.get(attachmentItemID);
    if (!attachment || !attachment.isFileAttachment?.()) {
      throw new Error("选区不在文件附件中");
    }
    const version = String(attachment.dateModified || attachment.key || "");
    const cached = this.cache.get(attachmentItemID);
    if (cached && cached.version === version) {
      return cached.info;
    }

    // Zotero.SDT.getReader() is async: it opens (and if necessary generates)
    // the structured-document-text pack. Awaiting it is essential; using the
    // raw Promise as a reader would fail on every translation.
    const reader = await Zotero.SDT?.getReader?.(attachmentItemID);
    if (!reader) {
      throw new Error("没有可用的 PDF 全文索引；请先让 Zotero 完成索引，或在阅读器里重新打开该 PDF");
    }

    const metadata = await reader.getMetadata();
    const catalog = await reader.getCatalog();
    const pages = Array.isArray(catalog?.pages) ? catalog.pages : [];
    const sourceHash = metadata?.source?.hash;
    const fingerprint = typeof sourceHash === "string" && sourceHash
      ? sourceHash
      : `${attachment.key || attachment.id}:${version}`;
    const fingerprintKind = typeof sourceHash === "string" && sourceHash
      ? "sdt-source-hash"
      : "attachment-key+dateModified";

    const info: DocumentInfo = {
      attachmentItemID,
      title: safeTitle(attachment),
      fingerprint,
      fingerprintKind,
      extractionVersion: EXTRACTION_VERSION,
      pageCount: pages.length,
      metadata,
      catalog,
    };
    this.cache.set(attachmentItemID, {
      version,
      info,
      reader,
      pages: new Map(),
    });
    debug(
      `document info: item=${attachmentItemID} pages=${info.pageCount} fingerprint=${fingerprintKind}`
    );
    return info;
  }

  async getPage(attachmentItemID: number, pageIndex: number): Promise<DocumentPage> {
    const info = await this.getInfo(attachmentItemID);
    const entry = this.cache.get(attachmentItemID);
    if (!entry) {
      throw new Error("document cache disappeared");
    }
    const cached = entry.pages.get(pageIndex);
    if (cached) {
      return cached;
    }

    const catalogPages = Array.isArray(info.catalog?.pages) ? info.catalog.pages : [];
    const catalogPage = catalogPages[pageIndex];
    const pageLabel = pageLabelOf(catalogPage, pageIndex);
    const rawBlocks = await entry.reader.getPageBlocks(pageIndex);
    const blocks: DocumentBlock[] = [];
    for (let i = 0; i < (Array.isArray(rawBlocks) ? rawBlocks.length : 0); i++) {
      const text = normalizeText(nodeText(rawBlocks[i]));
      if (!text) {
        continue;
      }
      blocks.push({
        blockId: `p${pageIndex}:b${i}`,
        topLevelIndex: i,
        pageIndex,
        pageLabel,
        text,
      });
    }
    const page: DocumentPage = {
      pageIndex,
      pageLabel,
      blocks,
      text: blocks.map((b) => b.text).join("\n\n"),
    };
    entry.pages.set(pageIndex, page);
    return page;
  }

  async findPageIndex(
    attachmentItemID: number,
    payload: SelectionPayload
  ): Promise<number | null> {
    const info = await this.getInfo(attachmentItemID);
    const position = parsePosition(payload.position);
    const positionPage = Number(position?.pageIndex);
    if (Number.isInteger(positionPage) && positionPage >= 0 && positionPage < info.pageCount) {
      const page = await this.getPage(attachmentItemID, positionPage);
      if (pageContainsText(page, payload.text)) {
        return positionPage;
      }
      // Some source positions are 1-based (or point at the page where the
      // selection starts while the text continues on the next page). Check
      // the two neighbours before trusting the raw index.
      for (const candidate of [positionPage - 1, positionPage + 1]) {
        if (candidate >= 0 && candidate < info.pageCount) {
          const neighbour = await this.getPage(attachmentItemID, candidate);
          if (pageContainsText(neighbour, payload.text)) {
            return candidate;
          }
        }
      }
      return positionPage;
    }

    const catalogPages = Array.isArray(info.catalog?.pages) ? info.catalog.pages : [];
    if (payload.pageLabel) {
      for (let i = 0; i < catalogPages.length; i++) {
        if (matchesPageLabel(pageLabelOf(catalogPages[i], i), payload.pageLabel)) {
          return i;
        }
      }
    }

    // Last resort: scan a bounded number of pages for the selected text. This
    // is only used when the reader didn't hand us a usable page index.
    const needle = normalizeText(payload.text).slice(0, 80);
    if (needle) {
      const limit = Math.min(info.pageCount, 40);
      for (let i = 0; i < limit; i++) {
        const page = await this.getPage(attachmentItemID, i);
        if (page.text.includes(needle)) {
          return i;
        }
      }
    }
    return null;
  }

  async getSelectionContext(payload: SelectionPayload): Promise<SelectionContext> {
    const info = await this.getInfo(payload.attachmentItemID);
    const selectedText = normalizeText(payload.text);
    if (!selectedText) {
      throw new Error("选文为空");
    }

    const pageIndex = await this.findPageIndex(payload.attachmentItemID, payload);
    if (pageIndex === null) {
      return {
        attachmentItemID: payload.attachmentItemID,
        pageIndex: null,
        pageLabel: payload.pageLabel || "",
        blockId: null,
        selectedText,
        before: "",
        after: "",
        sectionHeading: "",
        contextText: selectedText,
        matched: false,
        fingerprint: info.fingerprint,
        fingerprintKind: info.fingerprintKind,
        extractionVersion: info.extractionVersion,
        positionHash: stableJSON(parsePosition(payload.position)).slice(0, 500),
      };
    }

    const page = await this.getPage(payload.attachmentItemID, pageIndex);
    let matchIndex = -1;
    const probe = selectedText.slice(0, Math.min(80, selectedText.length));
    for (let i = 0; i < page.blocks.length; i++) {
      const blockText = page.blocks[i].text;
      if (blockText.includes(selectedText) || (probe && blockText.includes(probe))) {
        matchIndex = i;
        break;
      }
    }
    // Cross-line hyphenation and ligatures can defeat exact matching. Fall
    // back to the block with the largest token overlap on this page.
    if (matchIndex < 0) {
      const tokens = selectedText.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((t) => t.length > 3);
      let bestScore = 0;
      for (let i = 0; i < page.blocks.length; i++) {
        const hay = page.blocks[i].text.toLowerCase();
        let score = 0;
        for (const token of tokens.slice(0, 20)) {
          if (hay.includes(token)) {
            score++;
          }
        }
        if (score > bestScore) {
          bestScore = score;
          matchIndex = i;
        }
      }
      if (bestScore === 0) {
        matchIndex = -1;
      }
    }

    if (matchIndex < 0) {
      return {
        attachmentItemID: payload.attachmentItemID,
        pageIndex,
        pageLabel: page.pageLabel,
        blockId: null,
        selectedText,
        before: "",
        after: "",
        sectionHeading: "",
        contextText: selectedText,
        matched: false,
        fingerprint: info.fingerprint,
        fingerprintKind: info.fingerprintKind,
        extractionVersion: info.extractionVersion,
        positionHash: stableJSON(payload.position).slice(0, 500),
      };
    }

    const block = page.blocks[matchIndex];
    const beforeBlock = page.blocks[matchIndex - 1];
    const afterBlock = page.blocks[matchIndex + 1];
    const before = beforeBlock
      ? normalizeText(beforeBlock.text).slice(-CONTEXT_BEFORE_CHARS)
      : "";
    const after = afterBlock
      ? normalizeText(afterBlock.text).slice(0, CONTEXT_AFTER_CHARS)
      : "";
    let sectionHeading = sectionHeadingFromBlocks(page.blocks, matchIndex);
    if (!sectionHeading && pageIndex > 0) {
      const previousPage = await this.getPage(payload.attachmentItemID, pageIndex - 1);
      sectionHeading = sectionHeadingFromBlocks(previousPage.blocks, previousPage.blocks.length - 1);
    }

    // Include the selected block's own window, not just the neighbouring
    // blocks: the sentence before/after the selection is usually the most
    // important disambiguation context.
    const blockWindow = windowAround(block.text, selectedText, 300, 300);
    const contextText = [
      sectionHeading ? `章节：${sectionHeading}` : "",
      before ? `前文：${before}` : "",
      blockWindow.text ? `所在段落：${blockWindow.text}` : "",
      `【选文】${selectedText}`,
      after ? `后文：${after}` : "",
    ].filter(Boolean).join("\n\n");

    return {
      attachmentItemID: payload.attachmentItemID,
      pageIndex,
      pageLabel: block.pageLabel || page.pageLabel,
      blockId: block.blockId,
      selectedText,
      before,
      after,
      sectionHeading,
      contextText,
      matched: true,
      fingerprint: info.fingerprint,
      fingerprintKind: info.fingerprintKind,
      extractionVersion: info.extractionVersion,
      positionHash: stableJSON(parsePosition(payload.position)).slice(0, 500),
    };
  }

  /**
   * Build a budget-aware full-document context for F3 analysis. Blocks keep
   * their page/block identity so the model can cite them and the UI can jump
   * back to the exact page.
   */
  async buildContext(
    attachmentItemID: number,
    maxChars: number = DEFAULT_CONTEXT_CHARS
  ): Promise<DocumentContext> {
    const info = await this.getInfo(attachmentItemID);
    if (!info.pageCount) {
      throw new Error("PDF 没有可读页面；请先让 Zotero 完成全文索引");
    }

    const blocks: DocumentContextBlock[] = [];
    let currentHeading = "";
    for (let pageIndex = 0; pageIndex < info.pageCount; pageIndex++) {
      const page = await this.getPage(attachmentItemID, pageIndex);
      for (let blockIndex = 0; blockIndex < page.blocks.length; blockIndex++) {
        const block = page.blocks[blockIndex];
        if (looksLikeHeading(block.text)) {
          currentHeading = block.text.length > 90 ? block.text.slice(0, 90) : block.text;
        }
        blocks.push({
          evidenceId: `p${pageIndex + 1}:b${blockIndex}`,
          pageIndex,
          pageLabel: block.pageLabel || page.pageLabel,
          blockIndex,
          sectionHeading: currentHeading,
          text: block.text,
        });
      }
    }
    if (!blocks.length) {
      throw new Error("PDF 没有可读文本；请先让 Zotero 完成全文索引");
    }

    const budget = Math.max(
      MIN_CONTEXT_CHARS,
      Math.min(MAX_CONTEXT_CHARS, Math.round(Number(maxChars) || DEFAULT_CONTEXT_CHARS))
    );
    const selected = selectContextBlocks(blocks, info.pageCount, budget);
    const text = formatContextBlocks(selected);
    return {
      attachmentItemID,
      title: info.title,
      pageCount: info.pageCount,
      blocks: selected,
      text,
      truncated: selected.length < blocks.length,
      totalChars: blocks.reduce((sum, block) => sum + block.text.length, 0),
      includedChars: text.length,
      fingerprint: info.fingerprint,
    };
  }

  clear(attachmentItemID?: number): void {
    if (typeof attachmentItemID === "number") {
      this.cache.delete(attachmentItemID);
      return;
    }
    this.cache.clear();
  }

  stats(): Record<string, unknown> {
    return {
      documents: this.cache.size,
      pages: Array.from(this.cache.values()).reduce((sum, entry) => sum + entry.pages.size, 0),
    };
  }
}

export function documentTextErrorText(error: unknown): string {
  return error instanceof Error ? error.message : errText(error);
}
