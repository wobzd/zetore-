import { debug, errorLog, errText, recordRegistrationError } from "../util";
import { SEMANTIC_TAGS, type SemanticTag } from "../annotations/semantics";
import type { SelectionPayload } from "../annotations/service";
import { TARGET_LANGUAGES } from "../ai/prompts";
import { createCancelToken, type CancelToken } from "../ai/cancel";

export interface SelectionRecord extends Record<string, unknown> {
  text: string;
  textLength: number;
  itemID: number | null;
  attachmentKey: string | null;
  pageLabel: string | null;
  annotationColor: string | null;
}

export interface AIState {
  configured: boolean;
  autoTranslate: boolean;
  providerName: string;
  model: string;
}

export interface TranslateResult {
  text: string;
  cached: boolean;
  model: string | null;
  usage: Record<string, unknown> | null;
  pageLabel: string;
  sectionHeading: string;
  matched: boolean;
  fingerprintKind: string;
}

export interface ReaderCallbacks {
  onOpenDataDir: () => void;
  onDiagnose: () => void;
  onTag: (payload: SelectionPayload, semantic: SemanticTag) => Promise<string>;
  onClearTags: (payload: SelectionPayload) => Promise<string>;
  onTranslate: (
    payload: SelectionPayload,
    targetLanguage: string,
    requestId: string,
    onText?: (text: string) => void,
    cancelToken?: CancelToken
  ) => Promise<TranslateResult>;
  onSaveTranslation: (
    payload: SelectionPayload,
    translation: string,
    targetLanguage: string
  ) => Promise<string>;
  onOpenSettings: () => void;
  getAIState: () => AIState;
}

type ReaderHandler = (event: any) => void;

let handler: ReaderHandler | null = null;

/** Pick black or white text depending on the swatch's perceived luminance. */
function textColor(hex: string): string {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  const luminance = 0.299 * r + 0.587 * g + 0.114 * b;
  return luminance > 160 ? "#1a1a1a" : "#ffffff";
}

function buildPayload(reader: any, params: any, text: string): SelectionPayload {
  const annotation = params?.annotation || {};
  return {
    attachmentItemID: reader?.itemID ?? 0,
    text,
    pageLabel: annotation.pageLabel ?? "",
    sortIndex: annotation.sortIndex ?? null,
    position: annotation.position ?? null,
  };
}

function smallButton(doc: any, label: string, title?: string): any {
  const btn = doc.createElement("button");
  btn.textContent = label;
  if (title) {
    btn.title = title;
  }
  btn.style.cssText =
    "background:transparent;border:1px solid rgba(127,127,127,.35);border-radius:3px;" +
    "padding:1px 6px;cursor:pointer;font:inherit;font-size:11px;line-height:18px;";
  return btn;
}

/**
 * Zotero wraps plugin sections in `.selection-popup`, which is capped at
 * `max-width: 198px` by reader.css. That cap makes a translation collapse into
 * a tall, one-word-per-line column even when the panel itself asks for more
 * width. Expand the native wrapper for this popup only and keep it inside the
 * reader viewport after the width/height changes.
 */
function expandSelectionPopup(doc: any, box: any): void {
  const popup = box.closest(".selection-popup");
  if (!popup) {
    return;
  }

  const oldWidth = popup.getBoundingClientRect().width;
  const width = "min(560px, calc(100vw - 24px))";
  popup.classList.add("zra-selection-wide");
  popup.style.setProperty("width", width, "important");
  popup.style.setProperty("max-width", width, "important");
  popup.style.setProperty("box-sizing", "border-box", "important");
  // A new selection may reuse the same native popup node. Clear the previous
  // clamp before measuring the new position.
  popup.style.marginLeft = "0";
  popup.style.marginTop = "0";

  // ViewPopup calculates its transform from the old 198px width. Shift the
  // widened box so its pointer still sits on the selection: centered for
  // top/bottom placement, edge-aligned for left/right placement.
  const delta = popup.getBoundingClientRect().width - oldWidth;
  let anchorShift = -delta / 2;
  if (popup.classList.contains("page-popup-right-center")) {
    anchorShift = 0;
  }
  else if (popup.classList.contains("page-popup-left-center")) {
    anchorShift = -delta;
  }
  popup.style.marginLeft = `${anchorShift}px`;

  // Keep the native colour row and highlight toggle compact instead of
  // stretching them across the newly widened toolbar.
  const colors = popup.querySelector(".colors");
  if (colors) {
    colors.style.justifyContent = "flex-start";
  }
  const toolToggle = popup.querySelector(".tool-toggle");
  if (toolToggle) {
    toolToggle.style.width = "76px";
    toolToggle.style.alignSelf = "flex-start";
  }

  const win = doc.defaultView;
  if (!win) {
    return;
  }

  const adjust = (): void => {
    if (!popup.isConnected || !box.isConnected) {
      return;
    }
    const parent = popup.parentElement;
    if (!parent) {
      return;
    }
    const bounds = parent.getBoundingClientRect();
    const rect = popup.getBoundingClientRect();
    const margin = 8;
    let dx = 0;
    let dy = 0;
    if (rect.right > bounds.right - margin) {
      dx = bounds.right - margin - rect.right;
    }
    if (rect.left + dx < bounds.left + margin) {
      dx = bounds.left + margin - rect.left;
    }
    if (rect.bottom > bounds.bottom - margin) {
      dy = bounds.bottom - margin - rect.bottom;
    }
    if (rect.top + dy < bounds.top + margin) {
      dy = bounds.top + margin - rect.top;
    }
    if (dx !== 0) {
      const current = parseFloat(popup.style.marginLeft || "0") || 0;
      popup.style.marginLeft = `${current + dx}px`;
    }
    if (dy !== 0) {
      const current = parseFloat(popup.style.marginTop || "0") || 0;
      popup.style.marginTop = `${current + dy}px`;
    }
  };

  // Two frames: one for the width change, one for the reflowed height.
  const scheduleAdjust = (): void => {
    win.requestAnimationFrame(() => win.requestAnimationFrame(adjust));
  };
  scheduleAdjust();

  // The native ViewPopup measures its size before our translation arrives and
  // does not observe later size changes. Re-clamp whenever the result grows.
  const ResizeObserverCtor = win.ResizeObserver;
  if (ResizeObserverCtor) {
    let observer: any = null;
    observer = new ResizeObserverCtor(() => {
      if (!box.isConnected) {
        observer?.disconnect();
        return;
      }
      win.requestAnimationFrame(adjust);
    });
    observer.observe(box);
  }
}

/**
 * Registers the semantic annotation + AI translation popup in the PDF reader.
 *
 * F4: clicking a colour creates a native highlight (or merges the semantic tag
 * into the existing highlight at the same position) and appends a reading
 * event. F2: the same popup offers a translation panel; auto-translate runs
 * after ~400 ms when enabled, and every request carries an id so a late
 * response can never overwrite a newer selection's result.
 */
export function registerReaderListener(
  pluginID: string,
  callbacks: ReaderCallbacks
): string | false {
  try {
    handler = (event: any) => {
      try {
        const { reader, doc, params, append } = event;
        const text: string = params?.annotation?.text || "";
        if (!text) {
          return;
        }

        const payload = buildPayload(reader, params, text);
        const ai = callbacks.getAIState();

        const box = doc.createElement("div");
        box.className = "zra-annotation-popup";
        box.style.cssText =
          "display:flex;flex-direction:column;gap:5px;padding:7px 8px;font-size:12px;" +
          "width:100%;min-width:0;max-width:100%;max-height:70vh;" +
          "overflow:auto;box-sizing:border-box;";

        const attach = (): void => {
          append(box);
          expandSelectionPopup(doc, box);
        };

        // --- semantic tags ------------------------------------------------
        const tagRow = doc.createElement("div");
        tagRow.style.cssText = "display:flex;flex-wrap:wrap;gap:4px;";
        const tagStatus = doc.createElement("div");
        tagStatus.style.cssText = "font-size:11px;font-weight:500;min-height:14px;";

        let tagBusy = false;
        const runTag = (pending: string, task: () => Promise<string>): void => {
          if (tagBusy) {
            return;
          }
          tagBusy = true;
          tagStatus.textContent = pending;
          task()
            .then((message) => {
              if (box.isConnected) {
                tagStatus.textContent = message;
              }
            })
            .catch((e) => {
              errorLog(e);
              if (box.isConnected) {
                tagStatus.textContent = "失败：" + errText(e);
              }
            })
            .then(() => {
              tagBusy = false;
            });
        };

        for (const semantic of SEMANTIC_TAGS) {
          const btn = doc.createElement("button");
          btn.textContent = semantic.label;
          btn.title = semantic.tag;
          btn.style.cssText =
            `background:${semantic.color};color:${textColor(semantic.color)};` +
            "border:none;border-radius:3px;padding:2px 7px;cursor:pointer;" +
            "font:inherit;font-size:11px;line-height:18px;";
          btn.addEventListener("click", () => {
            runTag(`正在写入「${semantic.label}」…`, () => callbacks.onTag(payload, semantic));
          });
          tagRow.appendChild(btn);
        }

        const clearBtn = smallButton(doc, "撤销标签", "仅移除 阅读/ 语义标签，保留批注和用户标签");
        clearBtn.addEventListener("click", () => {
          runTag("正在移除标签…", () => callbacks.onClearTags(payload));
        });
        tagRow.appendChild(clearBtn);
        box.appendChild(tagRow);
        box.appendChild(tagStatus);

        const openSettings = (): void => {
          try {
            callbacks.onOpenSettings();
            tagStatus.textContent = "已打开设置";
          }
          catch (e) {
            tagStatus.textContent = "打开设置失败：" + errText(e);
          }
        };

        // If AI is not configured yet, keep the popup short. The full
        // translation panel is only useful after a key exists, and stacking it
        // under Zotero's native annotation toolbar can push the panel off the
        // bottom of the reader.
        if (!ai.configured) {
          const divider = doc.createElement("div");
          divider.style.cssText = "height:1px;background:rgba(127,127,127,.22);margin:1px 0;";
          box.appendChild(divider);

          const compact = doc.createElement("div");
          compact.style.cssText = "display:flex;flex-wrap:wrap;gap:5px;align-items:center;font-size:11px;";
          const note = doc.createElement("span");
          note.textContent = "AI 未配置";
          note.style.cssText = "opacity:.72;margin-right:2px;";
          compact.appendChild(note);

          const settings = smallButton(doc, "设置", "打开 Zotero 设置 → 文献阅读助手");
          settings.addEventListener("click", openSettings);
          compact.appendChild(settings);

          const dir = smallButton(doc, "数据目录", "打开插件数据目录");
          dir.addEventListener("click", () => {
            try {
              callbacks.onOpenDataDir();
              tagStatus.textContent = "已打开数据目录";
            }
            catch (e) {
              errorLog(e);
              tagStatus.textContent = "打开失败：" + errText(e);
            }
          });
          compact.appendChild(dir);

          const diag = smallButton(doc, "诊断");
          diag.addEventListener("click", () => {
            try {
              callbacks.onDiagnose();
            }
            catch (e) {
              errorLog(e);
            }
          });
          compact.appendChild(diag);

          box.appendChild(compact);
          attach();
          return;
        }

        // --- F2 translation ----------------------------------------------
        const divider = doc.createElement("div");
        divider.style.cssText = "height:1px;background:rgba(127,127,127,.22);margin:1px 0;";
        box.appendChild(divider);

        const transHead = doc.createElement("div");
        transHead.style.cssText = "display:flex;flex-wrap:wrap;gap:6px;align-items:center;";
        const transLabel = doc.createElement("div");
        transLabel.textContent = "翻译";
        transLabel.style.cssText = "font-weight:600;font-size:11.5px;";
        transHead.appendChild(transLabel);

        const targetSelect = doc.createElement("select");
        targetSelect.style.cssText =
          "font:inherit;font-size:11px;padding:1px 3px;border-radius:3px;" +
          "border:1px solid rgba(127,127,127,.35);background:transparent;color:inherit;";
        for (const language of TARGET_LANGUAGES) {
          const option = doc.createElement("option");
          option.value = language.code;
          option.textContent = language.label;
          targetSelect.appendChild(option);
        }
        transHead.appendChild(targetSelect);

        const aiStatus = doc.createElement("div");
        aiStatus.style.cssText =
          "flex:1 1 180px;min-width:120px;font-size:10.5px;opacity:.78;";
        aiStatus.textContent = ai.configured
          ? (ai.autoTranslate ? "选中稳定后将自动翻译" : "点击“翻译”")
          : "请在设置中配置 AI 服务";
        transHead.appendChild(aiStatus);
        box.appendChild(transHead);

        const result = doc.createElement("div");
        result.style.cssText =
          "white-space:pre-wrap;line-height:1.6;min-height:34px;flex:0 0 auto;" +
          "padding:6px 7px;border-radius:4px;background:rgba(127,127,127,.08);" +
          "overflow-wrap:anywhere;word-break:break-word;";
        result.textContent = ai.configured
          ? (ai.autoTranslate ? "准备自动翻译…" : "点击“翻译”获取译文。")
          : "尚未配置 AI 服务。点击下方“设置”填写 API Key 后即可翻译。";
        box.appendChild(result);

        const transActions = doc.createElement("div");
        transActions.style.cssText = "display:flex;flex-wrap:wrap;gap:4px;align-items:center;";

        const translateBtn = doc.createElement("button");
        translateBtn.textContent = "翻译";
        translateBtn.style.cssText =
          "background:rgba(127,127,127,.14);border:1px solid rgba(127,127,127,.35);" +
          "border-radius:3px;padding:1px 9px;cursor:pointer;font:inherit;font-size:11px;line-height:18px;";
        // Keep this enabled even when AI is unconfigured: the user may open
        // Settings from this popup and then retry without reselecting text.
        transActions.appendChild(translateBtn);

        const cancelTranslateBtn = smallButton(doc, "停止", "中止当前翻译请求");
        cancelTranslateBtn.disabled = true;
        cancelTranslateBtn.style.display = "none";
        transActions.appendChild(cancelTranslateBtn);

        const copyBtn = smallButton(doc, "复制", "复制译文");
        copyBtn.disabled = true;
        transActions.appendChild(copyBtn);

        const saveBtn = smallButton(doc, "存为批注", "把译文写入该选区的原生高亮批注");
        saveBtn.disabled = true;
        transActions.appendChild(saveBtn);

        const settingsBtn = smallButton(doc, "设置", "打开 Zotero 设置 → 文献阅读助手");
        transActions.appendChild(settingsBtn);
        box.appendChild(transActions);

        // --- footer -------------------------------------------------------
        const footer = doc.createElement("div");
        footer.style.cssText = "display:flex;flex-wrap:wrap;gap:4px;align-items:center;";
        const dirBtn = smallButton(doc, "数据目录", "打开插件数据目录（readings / metrics.json / cache）");
        dirBtn.addEventListener("click", () => {
          try {
            callbacks.onOpenDataDir();
            tagStatus.textContent = "已打开数据目录";
          }
          catch (e) {
            errorLog(e);
            tagStatus.textContent = "打开失败：" + errText(e);
          }
        });
        footer.appendChild(dirBtn);

        const diagBtn = smallButton(doc, "诊断");
        diagBtn.addEventListener("click", () => {
          try {
            callbacks.onDiagnose();
          }
          catch (e) {
            errorLog(e);
          }
        });
        footer.appendChild(diagBtn);
        box.appendChild(footer);

        // --- translation state machine ------------------------------------
        let translation = "";
        let activeRequest = 0;
        let translating = false;
        let activeCancel: CancelToken | null = null;
        const targetLanguage = (): string => targetSelect.value || "zh-CN";
        const setAIStatus = (message: string, kind?: "error" | "ok"): void => {
          if (!box.isConnected) {
            return;
          }
          aiStatus.textContent = message;
          aiStatus.style.color = kind === "error"
            ? "#c0392b"
            : kind === "ok"
              ? "#1a7f37"
              : "";
        };

        const finishTranslate = (requestNumber: number, token: CancelToken): void => {
          translating = false;
          if (activeCancel === token) {
            activeCancel = null;
          }
          if (requestNumber === activeRequest && box.isConnected) {
            translateBtn.disabled = false;
            cancelTranslateBtn.disabled = true;
            cancelTranslateBtn.style.display = "none";
            targetSelect.disabled = false;
          }
        };

        const runTranslate = (): void => {
          const current = callbacks.getAIState();
          if (!current.configured) {
            setAIStatus("请先在设置中配置 AI 服务", "error");
            return;
          }
          // Settings can be changed while this popup is open; the response
          // status shows the provider model actually used for this request.
          if (translating) {
            return;
          }
          translating = true;
          const requestNumber = ++activeRequest;
          const requestId = `r${requestNumber}_${Date.now()}`;
          const token = createCancelToken();
          activeCancel = token;
          translation = "";
          translateBtn.disabled = true;
          cancelTranslateBtn.disabled = false;
          cancelTranslateBtn.style.display = "";
          targetSelect.disabled = true;
          saveBtn.disabled = true;
          copyBtn.disabled = true;
          setAIStatus("正在翻译…");
          result.textContent = "…";
          const started = Date.now();
          const onText = (text: string): void => {
            if (requestNumber !== activeRequest || !box.isConnected || token.cancelled) {
              return;
            }
            result.textContent = text || "…";
          };
          callbacks.onTranslate(payload, targetLanguage(), requestId, onText, token)
            .then((response) => {
              if (requestNumber !== activeRequest || !box.isConnected) {
                return;
              }
              if (token.cancelled) {
                translation = "";
                result.textContent = "";
                saveBtn.disabled = true;
                copyBtn.disabled = true;
                setAIStatus("已停止翻译");
                return;
              }
              translation = response.text;
              result.textContent = response.text;
              saveBtn.disabled = false;
              copyBtn.disabled = false;
              const bits = [
                response.cached ? "已从缓存加载" : "翻译完成",
                response.model || current.model,
                `${Date.now() - started} ms`,
              ];
              if (response.sectionHeading) {
                bits.push(response.sectionHeading.slice(0, 40));
              }
              if (!response.matched) {
                bits.push("未定位到段落");
              }
              setAIStatus(bits.join(" · "), "ok");
            })
            .catch((e) => {
              if (requestNumber !== activeRequest || !box.isConnected) {
                return;
              }
              translation = "";
              result.textContent = "";
              saveBtn.disabled = true;
              copyBtn.disabled = true;
              if (token.cancelled || (e as any)?.kind === "cancelled") {
                setAIStatus("已停止翻译");
              }
              else {
                setAIStatus("翻译失败：" + errText(e), "error");
              }
            })
            .then(() => finishTranslate(requestNumber, token));
        };

        translateBtn.addEventListener("click", () => {
          runTranslate();
        });

        cancelTranslateBtn.addEventListener("click", () => {
          if (!activeCancel || activeCancel.cancelled) {
            return;
          }
          activeCancel.cancel();
          setAIStatus("正在停止翻译…");
        });

        targetSelect.addEventListener("change", () => {
          if (translating) {
            return;
          }
          translation = "";
          saveBtn.disabled = true;
          copyBtn.disabled = true;
          result.textContent = ai.configured ? "目标语言已切换，点击“翻译”。" : result.textContent;
          setAIStatus("目标语言：" + targetSelect.options[targetSelect.selectedIndex]?.textContent);
        });

        // The native selection popup can disappear without a close event.
        // Cancel the in-flight XHR when that happens so a dismissed popup
        // cannot keep streaming (or spend tokens) in the background.
        try {
          const win = doc.defaultView;
          const Observer = win?.MutationObserver;
          const root = doc.body || doc.documentElement;
          if (Observer && root) {
            let observer: any = null;
            observer = new Observer(() => {
              if (!box.isConnected) {
                activeCancel?.cancel();
                observer?.disconnect();
              }
            });
            observer.observe(root, { childList: true, subtree: true });
          }
          if (win) {
            const cancelOnHide = (): void => activeCancel?.cancel();
            win.addEventListener("pagehide", cancelOnHide, { once: true });
            win.addEventListener("unload", cancelOnHide, { once: true });
          }
        }
        catch (e) {
          debug("translation popup observer failed: " + errText(e));
        }

        copyBtn.addEventListener("click", () => {
          if (!translation) {
            return;
          }
          const win = doc.defaultView;
          const clipboard = win?.navigator?.clipboard;
          if (clipboard && typeof clipboard.writeText === "function") {
            clipboard.writeText(translation)
              .then(() => setAIStatus("已复制译文", "ok"))
              .catch((e: unknown) => setAIStatus("复制失败：" + errText(e), "error"));
            return;
          }
          const ta = doc.createElement("textarea");
          ta.value = translation;
          ta.style.cssText = "position:fixed;left:-9999px;top:0;";
          doc.body.appendChild(ta);
          ta.select();
          try {
            doc.execCommand("copy");
            setAIStatus("已复制译文", "ok");
          }
          catch (e) {
            setAIStatus("复制失败：" + errText(e), "error");
          }
          ta.remove();
        });

        saveBtn.addEventListener("click", () => {
          if (!translation) {
            return;
          }
          saveBtn.disabled = true;
          setAIStatus("正在保存批注…");
          callbacks.onSaveTranslation(payload, translation, targetLanguage())
            .then((message) => setAIStatus(message, "ok"))
            .catch((e) => setAIStatus("保存失败：" + errText(e), "error"))
            .then(() => {
              if (box.isConnected) {
                saveBtn.disabled = false;
              }
            });
        });

        settingsBtn.addEventListener("click", openSettings);

        attach();

        if (ai.configured && ai.autoTranslate && text.trim().length >= 2) {
          setTimeout(() => {
            if (box.isConnected && !translation && !translating) {
              runTranslate();
            }
          }, 450);
        }
      }
      catch (e) {
        errorLog(e);
      }
    };

    Zotero.Reader.registerEventListener("renderTextSelectionPopup", handler, pluginID);
    debug("registerReaderListener -> renderTextSelectionPopup");
    return "renderTextSelectionPopup";
  }
  catch (e) {
    errorLog(e);
    recordRegistrationError("registerReaderListener", e);
    handler = null;
    return false;
  }
}

export function unregisterReaderListener(): void {
  if (!handler) {
    return;
  }
  try {
    Zotero.Reader.unregisterEventListener("renderTextSelectionPopup", handler);
  }
  catch (e) {
    errorLog(e);
  }
  handler = null;
}
