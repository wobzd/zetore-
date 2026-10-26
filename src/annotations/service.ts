import type { SemanticTag } from "./semantics";
import { isSemanticTag } from "./semantics";
import { debug, errText } from "../util";

/**
 * Everything needed to re-create a highlight, taken from the reader selection
 * event. `position` is Zotero's own SDT/source position object and must be
 * passed through unchanged.
 */
export interface SelectionPayload {
  attachmentItemID: number;
  text: string;
  pageLabel: string;
  sortIndex: number | null;
  position: unknown;
}

export interface TagResult {
  action: "created" | "updated" | "unchanged";
  annotationKey: string;
  tags: string[];
}

export interface UntagResult {
  removed: boolean;
  annotationKey: string | null;
  tags: string[];
}

function stablePosition(position: unknown): string {
  try {
    return JSON.stringify(position ?? {});
  }
  catch (e) {
    return "{}";
  }
}

function tagsOf(annotation: any): string[] {
  try {
    return (annotation.getTags() as Array<{ tag: string }>).map((t) => t.tag);
  }
  catch (e) {
    return [];
  }
}

/**
 * Find a highlight at the exact same position. Position equality is the
 * primary key (the reader hands us the same object shape it would save);
 * text+sortIndex+pageLabel is a fallback for position-format drift.
 */
function findExistingHighlight(attachment: any, payload: SelectionPayload): any | null {
  let annotations: any[] = [];
  try {
    annotations = attachment.getAnnotations() || [];
  }
  catch (e) {
    debug("getAnnotations failed: " + errText(e));
    return null;
  }

  const target = stablePosition(payload.position);
  for (const ann of annotations) {
    if (ann.annotationType !== "highlight") {
      continue;
    }
    if (stablePosition(ann.annotationPosition) === target) {
      return ann;
    }
  }

  for (const ann of annotations) {
    if (ann.annotationType !== "highlight") {
      continue;
    }
    if (
      ann.annotationText === payload.text
      && ann.annotationSortIndex === payload.sortIndex
      && (ann.annotationPageLabel || "") === (payload.pageLabel || "")
    ) {
      return ann;
    }
  }
  return null;
}

/**
 * Create a native highlight, or merge the semantic tag into an existing one.
 * Native tags are read first and written back as a set: saveFromJSON() and
 * setTags() replace the whole tag list, so a blind write would drop the
 * user's own tags.
 */
export async function applySemanticTag(
  payload: SelectionPayload,
  semantic: SemanticTag
): Promise<TagResult> {
  if (!payload.attachmentItemID) {
    throw new Error("no attachment item id in selection payload");
  }
  const attachment = Zotero.Items.get(payload.attachmentItemID);
  if (!attachment || !attachment.isFileAttachment()) {
    throw new Error("selection is not inside a file attachment");
  }

  const existing = findExistingHighlight(attachment, payload);
  if (existing) {
    const tags = tagsOf(existing);
    if (tags.includes(semantic.tag)) {
      return { action: "unchanged", annotationKey: existing.key, tags };
    }
    const merged = [...tags, semantic.tag];
    existing.setTags(merged.map((tag) => ({ tag })));
    await existing.saveTx();
    return { action: "updated", annotationKey: existing.key, tags: merged };
  }

  const json = {
    key: Zotero.DataObjectUtilities.generateKey(),
    type: "highlight",
    color: semantic.color,
    sortIndex: payload.sortIndex ?? 0,
    pageLabel: payload.pageLabel || "",
    position: JSON.parse(JSON.stringify(payload.position ?? {})),
    text: payload.text,
    comment: "",
    tags: [{ name: semantic.tag }],
  };

  // saveFromJSON() stores the position verbatim; an empty position produces an
  // annotation that Zotero cannot render, so refuse it loudly instead.
  if (!json.position || Object.keys(json.position).length === 0) {
    throw new Error("选区位置不可用（position 为空），无法创建批注");
  }

  const created = await Zotero.Annotations.saveFromJSON(attachment, json);
  return { action: "created", annotationKey: created.key, tags: [semantic.tag] };
}

/**
 * Save a translation as a native highlight comment.
 *
 * F2 only creates an annotation on an explicit "存为批注" click. If a
 * highlight already exists at the same position we append the translation to
 * its comment instead of creating a duplicate highlight.
 */
export async function saveTranslationAnnotation(
  payload: SelectionPayload,
  translation: string,
  targetLanguage: string
): Promise<{ action: "created" | "updated"; annotationKey: string; tags: string[] }> {
  if (!payload.attachmentItemID) {
    throw new Error("no attachment item id in selection payload");
  }
  const attachment = Zotero.Items.get(payload.attachmentItemID);
  if (!attachment || !attachment.isFileAttachment()) {
    throw new Error("selection is not inside a file attachment");
  }
  const text = String(translation || "").trim();
  if (!text) {
    throw new Error("译文为空，无法保存");
  }

  const tag = "翻译";
  const note = `【译文·${targetLanguage || "目标语言"}】\n${text}`;
  const existing = findExistingHighlight(attachment, payload);
  if (existing) {
    const tags = tagsOf(existing);
    const merged = tags.includes(tag) ? tags : [...tags, tag];
    const previous = String(existing.annotationComment || "").trim();
    existing.annotationComment = previous ? `${previous}\n\n${note}` : note;
    existing.setTags(merged.map((value) => ({ tag: value })));
    await existing.saveTx();
    return { action: "updated", annotationKey: existing.key, tags: merged };
  }

  const json = {
    key: Zotero.DataObjectUtilities.generateKey(),
    type: "highlight",
    color: "#ffd400",
    sortIndex: payload.sortIndex ?? 0,
    pageLabel: payload.pageLabel || "",
    position: JSON.parse(JSON.stringify(payload.position ?? {})),
    text: payload.text,
    comment: note,
    tags: [{ name: tag }],
  };
  if (!json.position || Object.keys(json.position).length === 0) {
    throw new Error("选区位置不可用（position 为空），无法创建批注");
  }
  const created = await Zotero.Annotations.saveFromJSON(attachment, json);
  return { action: "created", annotationKey: created.key, tags: [tag] };
}

/**
 * Remove every semantic tag from the highlight at this position, leaving the
 * highlight and all non-semantic tags intact. Used by the popup's single
 * "撤销标签" action.
 */
export async function removeAllSemanticTags(
  payload: SelectionPayload
): Promise<{ removed: string[]; annotationKey: string | null; tags: string[]; notFound: boolean }> {
  const attachment = Zotero.Items.get(payload.attachmentItemID);
  if (!attachment || !attachment.isFileAttachment()) {
    return { removed: [], annotationKey: null, tags: [], notFound: true };
  }
  const existing = findExistingHighlight(attachment, payload);
  if (!existing) {
    return { removed: [], annotationKey: null, tags: [], notFound: true };
  }
  const tags = tagsOf(existing);
  const removed = tags.filter((t) => isSemanticTag(t));
  if (!removed.length) {
    return { removed, annotationKey: existing.key, tags, notFound: false };
  }
  const remaining = tags.filter((t) => !isSemanticTag(t));
  existing.setTags(remaining.map((tag) => ({ tag })));
  await existing.saveTx();
  return { removed, annotationKey: existing.key, tags: remaining, notFound: false };
}

/**
 * Remove only our semantic tag. The highlight itself and every other tag stay
 * untouched — deleting a tag must never be interpreted as deleting an
 * annotation.
 */
export async function removeSemanticTag(
  payload: SelectionPayload,
  semantic: SemanticTag
): Promise<UntagResult> {
  const attachment = Zotero.Items.get(payload.attachmentItemID);
  if (!attachment || !attachment.isFileAttachment()) {
    return { removed: false, annotationKey: null, tags: [] };
  }
  const existing = findExistingHighlight(attachment, payload);
  if (!existing) {
    return { removed: false, annotationKey: null, tags: [] };
  }
  const tags = tagsOf(existing);
  if (!tags.includes(semantic.tag)) {
    return { removed: false, annotationKey: existing.key, tags };
  }
  const remaining = tags.filter((t) => t !== semantic.tag);
  existing.setTags(remaining.map((tag) => ({ tag })));
  await existing.saveTx();
  return { removed: true, annotationKey: existing.key, tags: remaining };
}
