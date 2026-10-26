/**
 * F4 six-colour semantic annotation tags.
 *
 * The tag namespace is what carries the meaning; colour is only a hint.
 * `阅读/研究方法` etc. are stored as native Zotero annotation tags so they
 * survive sync, export and plugin removal.
 */

export type SemanticKey =
  | "background"
  | "method"
  | "conclusion"
  | "mechanism"
  | "doubt"
  | "cite";

export interface SemanticTag {
  key: SemanticKey;
  /** Short Chinese label shown in the popup. */
  label: string;
  /** Full native annotation tag. */
  tag: string;
  /** Zotero's built-in highlight colour hex. */
  color: string;
}

export const TAG_PREFIX = "阅读/";

export const SEMANTIC_TAGS: readonly SemanticTag[] = [
  { key: "background", label: "研究背景", tag: "阅读/研究背景", color: "#ffd400" },
  { key: "method", label: "研究方法", tag: "阅读/研究方法", color: "#ff6666" },
  { key: "conclusion", label: "关键结论", tag: "阅读/关键结论", color: "#5fb236" },
  { key: "mechanism", label: "原理机制", tag: "阅读/原理机制", color: "#2ea8e5" },
  { key: "doubt", label: "存疑", tag: "阅读/存疑", color: "#a28ae5" },
  { key: "cite", label: "待引用", tag: "阅读/待引用", color: "#f19837" },
] as const;

const SEMANTIC_TAG_NAMES = new Set(SEMANTIC_TAGS.map((t) => t.tag));

export function isSemanticTag(tag: string): boolean {
  return SEMANTIC_TAG_NAMES.has(tag);
}

export function semanticTagByKey(key: SemanticKey): SemanticTag | null {
  return SEMANTIC_TAGS.find((t) => t.key === key) ?? null;
}
