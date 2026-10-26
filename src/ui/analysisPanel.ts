import { ANALYSIS_PRESETS, type AnalysisPresetKey } from "../ai/prompts";
import type { AnalysisResult } from "../ai/analysis";
import type { ConversationMessage } from "../store/conversationStore";
import type { AIState } from "./reader";
import { createCancelToken, type CancelToken } from "../ai/cancel";
import { debug, errorLog, errText, recordRegistrationError } from "../util";

export interface AnalysisPanelCallbacks {
  ask: (
    attachmentItemID: number,
    preset: AnalysisPresetKey | null,
    question: string,
    requestId: string,
    onText?: (text: string) => void,
    cancelToken?: CancelToken
  ) => Promise<AnalysisResult>;
  loadConversation: (attachmentItemID: number) => Promise<ConversationMessage[]>;
  clearConversation: (attachmentItemID: number) => Promise<void>;
  onOpenEvidence: (attachmentItemID: number, pageIndex: number) => Promise<void> | void;
  onOpenSettings: () => void;
  getAIState: () => AIState;
}

type ToolbarHandler = (event: any) => void;
let toolbarHandler: ToolbarHandler | null = null;

function button(doc: any, label: string, title?: string): any {
  const el = doc.createElement("button");
  el.type = "button";
  el.textContent = label;
  if (title) {
    el.title = title;
  }
  el.style.cssText =
    "background:transparent;border:1px solid rgba(127,127,127,.35);border-radius:4px;" +
    "padding:3px 8px;cursor:pointer;font:inherit;font-size:11.5px;line-height:19px;color:inherit;";
  return el;
}

function panelStatus(status: any, message: string, kind?: "error" | "ok"): void {
  status.textContent = message;
  status.style.color = kind === "error" ? "#c0392b" : kind === "ok" ? "#1a7f37" : "";
}

function appendInlineMarkdown(doc: any, parent: any, text: string): void {
  // Keep this deliberately small and DOM-based: model output is untrusted, so
  // never inject its HTML. Only the common emphasis/code forms are rendered.
  const pattern =
    /(\*\*[\s\S]+?\*\*|`[^`]+`|\[p\d+:b\d+(?:\s*,\s*p\d+:b\d+)*\]|\*[^*\n]+?\*)/g;
  let last = 0;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    if (match.index > last) {
      parent.appendChild(doc.createTextNode(text.slice(last, match.index)));
    }
    const token = match[0];
    if (token.startsWith("**") && token.endsWith("**") && token.length > 4) {
      const strong = doc.createElement("strong");
      strong.textContent = token.slice(2, -2);
      parent.appendChild(strong);
    }
    else if (token.startsWith("`") && token.endsWith("`") && token.length > 2) {
      const code = doc.createElement("code");
      code.textContent = token.slice(1, -1);
      code.style.cssText =
        "font-family:ui-monospace,monospace;font-size:11.5px;" +
        "padding:0 3px;border-radius:3px;background:rgba(127,127,127,.14);";
      parent.appendChild(code);
    }
    else if (/^\[p\d+:b\d+/.test(token)) {
      const citation = doc.createElement("span");
      citation.textContent = token;
      citation.style.cssText =
        "font-size:10.5px;opacity:.62;white-space:nowrap;";
      parent.appendChild(citation);
    }
    else {
      const em = doc.createElement("em");
      em.textContent = token.slice(1, -1);
      parent.appendChild(em);
    }
    last = match.index + token.length;
  }
  if (last < text.length) {
    parent.appendChild(doc.createTextNode(text.slice(last)));
  }
}

function appendMarkdown(doc: any, container: any, markdown: string): void {
  const lines = String(markdown || "").replace(/\r\n?/g, "\n").split("\n");
  let inCode = false;
  let codeLines: string[] = [];

  const appendLine = (tag: string, text: string, style: string): any => {
    const el = doc.createElement(tag);
    el.style.cssText = style;
    appendInlineMarkdown(doc, el, text);
    container.appendChild(el);
    return el;
  };

  for (const line of lines) {
    const trimmed = line.trim();
    if (/^```/.test(trimmed)) {
      if (inCode) {
        const pre = doc.createElement("pre");
        pre.style.cssText =
          "margin:6px 0;padding:7px 8px;overflow:auto;white-space:pre-wrap;" +
          "background:rgba(127,127,127,.12);border-radius:4px;font:11.5px/1.6 ui-monospace,monospace;";
        pre.textContent = codeLines.join("\n");
        container.appendChild(pre);
        codeLines = [];
      }
      inCode = !inCode;
      continue;
    }
    if (inCode) {
      codeLines.push(line);
      continue;
    }
    if (!trimmed) {
      const gap = doc.createElement("div");
      gap.style.height = "8px";
      container.appendChild(gap);
      continue;
    }

    const heading = line.match(/^\s{0,3}(#{1,4})\s+(.+)$/);
    if (heading) {
      const level = heading[1].length;
      const el = appendLine(
        "div",
        heading[2],
        `font-weight:600;font-size:${level <= 2 ? 14 : 13}px;margin:10px 0 6px;`
      );
      el.style.lineHeight = "1.4";
      continue;
    }

    const bullet = line.match(/^(\s*)[-*+]\s+(.+)$/);
    if (bullet) {
      const row = doc.createElement("div");
      row.style.cssText =
        `display:flex;gap:6px;align-items:flex-start;margin:0 0 8px;` +
        `padding-left:${Math.min(3, Math.floor(bullet[1].length / 2)) * 10}px;`;
      const marker = doc.createElement("span");
      marker.textContent = "•";
      marker.style.cssText = "flex:none;opacity:.55;line-height:1.75;";
      const body = doc.createElement("span");
      body.style.cssText = "flex:1;min-width:0;";
      appendInlineMarkdown(doc, body, bullet[2]);
      row.appendChild(marker);
      row.appendChild(body);
      container.appendChild(row);
      continue;
    }

    const ordered = line.match(/^(\s*)(\d+)[.)]\s+(.+)$/);
    if (ordered) {
      const row = doc.createElement("div");
      row.style.cssText =
        `display:flex;gap:6px;align-items:flex-start;margin:0 0 8px;` +
        `padding-left:${Math.min(3, Math.floor(ordered[1].length / 2)) * 10}px;`;
      const marker = doc.createElement("span");
      marker.textContent = `${ordered[2]}.`;
      marker.style.cssText =
        "flex:none;opacity:.55;min-width:18px;line-height:1.75;" +
        "font-variant-numeric:tabular-nums;";
      const body = doc.createElement("span");
      body.style.cssText = "flex:1;min-width:0;";
      appendInlineMarkdown(doc, body, ordered[3]);
      row.appendChild(marker);
      row.appendChild(body);
      container.appendChild(row);
      continue;
    }

    const quote = line.match(/^\s*>\s?(.*)$/);
    if (quote) {
      const el = appendLine(
        "div",
        quote[1],
        "margin:8px 0;padding-left:8px;border-left:2px solid rgba(127,127,127,.45);opacity:.88;"
      );
      el.style.lineHeight = "1.7";
      continue;
    }

    if (/^\s*([-*_])\1{2,}\s*$/.test(line)) {
      const hr = doc.createElement("div");
      hr.style.cssText = "height:1px;margin:10px 0;background:rgba(127,127,127,.28);";
      container.appendChild(hr);
      continue;
    }

    appendLine("div", line, "margin:0 0 8px;line-height:1.75;");
  }

  if (codeLines.length) {
    const pre = doc.createElement("pre");
    pre.style.cssText =
      "margin:6px 0;padding:7px 8px;overflow:auto;white-space:pre-wrap;" +
      "background:rgba(127,127,127,.12);border-radius:4px;font:11.5px/1.6 ui-monospace,monospace;";
    pre.textContent = codeLines.join("\n");
    container.appendChild(pre);
  }
}

function appendEvidenceChips(
  doc: any,
  row: any,
  evidence: AnalysisResult["evidence"] | undefined,
  attachmentItemID: number,
  callbacks: AnalysisPanelCallbacks,
  setStatus: (message: string, kind?: "error" | "ok") => void
): void {
  const refs = Array.isArray(evidence) ? evidence : [];
  if (!refs.length) {
    return;
  }
  const evidenceRow = doc.createElement("div");
  evidenceRow.style.cssText = "display:flex;flex-wrap:wrap;gap:4px;align-items:center;";
  const label = doc.createElement("span");
  label.textContent = "证据";
  label.style.cssText = "font-size:10.5px;opacity:.55;";
  evidenceRow.appendChild(label);
  for (const ref of refs) {
    const chip = button(doc, ref.id, `跳转到第 ${ref.pageLabel} 页`);
    chip.style.fontSize = "10.5px";
    chip.style.padding = "1px 6px";
    chip.addEventListener("click", () => {
      Promise.resolve(callbacks.onOpenEvidence(attachmentItemID, ref.pageIndex))
        .then(() => setStatus(`已跳转到第 ${ref.pageLabel} 页`, "ok"))
        .catch((e) => {
          errorLog(e);
          setStatus("跳转失败：" + errText(e), "error");
        });
    });
    evidenceRow.appendChild(chip);
  }
  row.appendChild(evidenceRow);
}

function renderMessage(
  doc: any,
  list: any,
  message: ConversationMessage,
  attachmentItemID: number,
  callbacks: AnalysisPanelCallbacks,
  setStatus: (message: string, kind?: "error" | "ok") => void
): { row: any; content: any } {
  const row = doc.createElement("div");
  row.style.cssText = "display:flex;flex-direction:column;gap:4px;";
  const role = doc.createElement("div");
  role.textContent = message.role === "user" ? "你" : "AI 解读";
  role.style.cssText =
    "font-size:10.5px;font-weight:600;opacity:.55;letter-spacing:.04em;";
  row.appendChild(role);

  const content = doc.createElement("div");
  content.style.cssText =
    "font-size:13px;overflow-wrap:anywhere;line-height:1.75;" +
    "padding:10px 12px;border-radius:6px;" +
    (message.role === "user"
      ? "white-space:pre-wrap;background:rgba(127,127,127,.12);"
      : "white-space:normal;background:rgba(127,127,127,.055);");
  if (message.role === "assistant" && message.content) {
    appendMarkdown(doc, content, message.content);
  }
  else if (message.role !== "assistant") {
    content.textContent = message.content;
  }
  row.appendChild(content);

  appendEvidenceChips(
    doc,
    row,
    message.evidence,
    attachmentItemID,
    callbacks,
    setStatus
  );
  list.appendChild(row);
  list.scrollTop = list.scrollHeight;
  return { row, content };
}

function createStreamingUpdater(
  doc: any,
  content: any,
  list: any,
  isActive: () => boolean
): { update: (text: string) => void; flush: (text: string) => void; close: () => void } {
  let pending = "";
  let scheduled = false;
  let closed = false;

  const render = (): void => {
    scheduled = false;
    if (closed || !content.isConnected || !isActive()) {
      return;
    }
    content.replaceChildren();
    appendMarkdown(doc, content, pending);
    list.scrollTop = list.scrollHeight;
  };

  const schedule = (): void => {
    if (scheduled || closed) {
      return;
    }
    scheduled = true;
    const win = doc.defaultView;
    if (win && typeof win.requestAnimationFrame === "function") {
      win.requestAnimationFrame(render);
    }
    else {
      setTimeout(render, 50);
    }
  };

  return {
    update(text: string) {
      pending = String(text || "");
      schedule();
    },
    flush(text: string) {
      pending = String(text || "");
      render();
    },
    close() {
      closed = true;
    },
  };
}

function createPanel(
  reader: any,
  doc: any,
  callbacks: AnalysisPanelCallbacks
): any {
  const panel = doc.createElement("div");
  panel.id = "zra-ai-panel";
  panel.style.cssText = [
    "position:fixed",
    "right:16px",
    "top:64px",
    "bottom:16px",
    "width:min(430px, calc(100vw - 32px))",
    "display:flex",
    "flex-direction:column",
    "gap:10px",
    "padding:12px",
    "box-sizing:border-box",
    "background:Canvas",
    "color:CanvasText",
    "border:1px solid rgba(127,127,127,.4)",
    "border-radius:8px",
    "box-shadow:0 8px 30px rgba(0,0,0,.28)",
    "z-index:2147483000",
    "font:12.5px/1.5 system-ui, sans-serif",
    "overflow:hidden",
  ].join(";");

  let activeCancel: CancelToken | null = null;
  const nativeRemove = panel.remove.bind(panel);
  panel.remove = (): void => {
    activeCancel?.cancel();
    nativeRemove();
  };
  try {
    const win = doc.defaultView;
    if (win) {
      const cancelOnHide = (): void => activeCancel?.cancel();
      win.addEventListener("pagehide", cancelOnHide, { once: true });
      win.addEventListener("unload", cancelOnHide, { once: true });
    }
  }
  catch (e) {
    debug("analysis panel pagehide hook failed: " + errText(e));
  }

  const header = doc.createElement("div");
  header.style.cssText = "display:flex;gap:6px;align-items:center;";
  const title = doc.createElement("div");
  title.textContent = "AI 阅读";
  title.style.cssText = "font-weight:600;font-size:14px;flex:1;";
  header.appendChild(title);
  const close = button(doc, "关闭");
  close.addEventListener("click", () => {
    activeCancel?.cancel();
    panel.remove();
  });
  header.appendChild(close);
  panel.appendChild(header);

  const presetRow = doc.createElement("div");
  presetRow.style.cssText = "display:flex;flex-wrap:wrap;gap:4px;";
  const presetButtons: any[] = [];
  for (const preset of ANALYSIS_PRESETS) {
    const presetButton = button(doc, preset.label, preset.instruction);
    presetButton.addEventListener("click", () => {
      void send(preset.key, "");
    });
    presetButtons.push(presetButton);
    presetRow.appendChild(presetButton);
  }
  panel.appendChild(presetRow);

  const list = doc.createElement("div");
  list.style.cssText =
    "flex:1;min-height:80px;overflow:auto;display:flex;flex-direction:column;gap:12px;" +
    "padding:8px;border:1px solid rgba(127,127,127,.25);border-radius:6px;";
  panel.appendChild(list);

  const empty = doc.createElement("div");
  empty.textContent = "选择上方预设，或输入问题。回答会按论文保存，并带页码证据。";
  empty.style.cssText = "font-size:12px;opacity:.62;line-height:1.7;";
  list.appendChild(empty);

  const composer = doc.createElement("div");
  composer.style.cssText = "display:flex;flex-direction:column;gap:5px;";
  const input = doc.createElement("textarea");
  input.placeholder = "针对这篇论文提问，例如：这篇论文的主要局限是什么？";
  input.rows = 2;
  input.style.cssText =
    "width:100%;box-sizing:border-box;resize:vertical;min-height:48px;" +
    "font:inherit;font-size:12.5px;padding:7px 8px;border-radius:5px;" +
    "border:1px solid rgba(127,127,127,.35);background:Field;color:FieldText;";
  composer.appendChild(input);

  const actions = doc.createElement("div");
  actions.style.cssText = "display:flex;flex-wrap:wrap;gap:4px;align-items:center;";
  const sendButton = button(doc, "提问");
  const stopButton = button(doc, "停止生成", "中止当前 AI 请求");
  stopButton.style.display = "none";
  const clearButton = button(doc, "清空会话");
  const settingsButton = button(doc, "设置");
  actions.appendChild(sendButton);
  actions.appendChild(stopButton);
  actions.appendChild(clearButton);
  actions.appendChild(settingsButton);
  composer.appendChild(actions);

  const status = doc.createElement("div");
  status.style.cssText = "min-height:16px;font-size:11px;opacity:.72;";
  composer.appendChild(status);
  panel.appendChild(composer);

  let busy = false;
  let localSent = false;
  const setStatus = (message: string, kind?: "error" | "ok"): void => {
    if (panel.isConnected) {
      panelStatus(status, message, kind);
    }
  };
  const setBusy = (value: boolean): void => {
    busy = value;
    sendButton.disabled = value;
    input.disabled = value;
    clearButton.disabled = value;
    stopButton.disabled = !value;
    stopButton.style.display = value ? "" : "none";
    for (const presetButton of presetButtons) {
      presetButton.disabled = value;
    }
  };

  async function send(preset: AnalysisPresetKey | null, rawQuestion: string): Promise<void> {
    const question = String(rawQuestion || "").trim();
    if (busy) {
      return;
    }
    if (!preset && !question) {
      setStatus("请输入问题，或选择一个预设", "error");
      return;
    }
    const current = callbacks.getAIState();
    if (!current.configured) {
      setStatus("请先在设置中配置 AI 服务", "error");
      return;
    }

    const presetInfo = preset ? ANALYSIS_PRESETS.find((item) => item.key === preset) : null;
    const localContent = presetInfo ? presetInfo.label : question;
    const localMessage: ConversationMessage = {
      id: `local-${Date.now()}`,
      role: "user",
      content: localContent,
      at: new Date().toISOString(),
      preset: preset || null,
      evidence: [],
    };
    localSent = true;
    if (empty.isConnected) {
      empty.remove();
    }
    renderMessage(doc, list, localMessage, reader.itemID, callbacks, setStatus);

    const assistantRow = renderMessage(
      doc,
      list,
      {
        id: `local-a-${Date.now()}`,
        role: "assistant",
        content: "",
        at: new Date().toISOString(),
        evidence: [],
      },
      reader.itemID,
      callbacks,
      setStatus
    );
    assistantRow.content.textContent = "…";
    const cancelToken = createCancelToken();
    activeCancel = cancelToken;
    const updater = createStreamingUpdater(
      doc,
      assistantRow.content,
      list,
      () => panel.isConnected && !cancelToken.cancelled
    );

    input.value = "";
    setBusy(true);
    setStatus(presetInfo ? `正在分析「${presetInfo.label}」…` : "正在阅读全文并回答…");

    const requestId = `a${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    try {
      const result = await callbacks.ask(
        reader.itemID,
        preset,
        question,
        requestId,
        (text) => updater.update(text),
        cancelToken
      );
      // The request is complete; a click on "stop" from here on must not
      // discard an answer that was already persisted by the plugin.
      if (activeCancel === cancelToken) {
        activeCancel = null;
      }
      if (!panel.isConnected) {
        updater.close();
        return;
      }
      if (cancelToken.cancelled) {
        updater.close();
        assistantRow.row.remove();
        setStatus("已停止生成");
        return;
      }
      updater.flush(result.text);
      updater.close();
      appendEvidenceChips(
        doc,
        assistantRow.row,
        result.evidence,
        reader.itemID,
        callbacks,
        setStatus
      );
      list.scrollTop = list.scrollHeight;
      const bits = [
        result.model || current.model,
        `${result.elapsedMs} ms`,
        result.evidence.length ? `${result.evidence.length} 条证据` : "无证据标记",
      ];
      setStatus(bits.join(" · "), "ok");
    }
    catch (e) {
      updater.close();
      if (assistantRow.row.isConnected) {
        assistantRow.row.remove();
      }
      if (!panel.isConnected) {
        return;
      }
      if (cancelToken.cancelled || (e as any)?.kind === "cancelled") {
        setStatus("已停止生成");
      }
      else {
        errorLog(e);
        setStatus("失败：" + errText(e), "error");
      }
    }
    finally {
      if (activeCancel === cancelToken) {
        activeCancel = null;
      }
      setBusy(false);
    }
  }

  sendButton.addEventListener("click", () => {
    void send(null, input.value);
  });
  stopButton.addEventListener("click", () => {
    if (!activeCancel || activeCancel.cancelled) {
      return;
    }
    activeCancel.cancel();
    setStatus("正在停止生成…");
  });
  input.addEventListener("keydown", (event: any) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      void send(null, input.value);
    }
  });
  clearButton.addEventListener("click", () => {
    if (busy) {
      return;
    }
    void callbacks.clearConversation(reader.itemID)
      .then(() => {
        list.replaceChildren();
        list.appendChild(empty);
        setStatus("已清空这篇论文的会话", "ok");
      })
      .catch((e) => {
        errorLog(e);
        setStatus("清空失败：" + errText(e), "error");
      });
  });
  settingsButton.addEventListener("click", () => {
    try {
      callbacks.onOpenSettings();
      setStatus("已打开设置");
    }
    catch (e) {
      setStatus("打开设置失败：" + errText(e), "error");
    }
  });

  panel.addEventListener("keydown", (event: any) => {
    if (event.key === "Escape") {
      activeCancel?.cancel();
      panel.remove();
    }
  });

  const target = doc.body || doc.documentElement;
  target.appendChild(panel);
  void callbacks.loadConversation(reader.itemID)
    .then((messages) => {
      if (localSent || !panel.isConnected || !Array.isArray(messages) || !messages.length) {
        return;
      }
      list.replaceChildren();
      for (const message of messages) {
        renderMessage(doc, list, message, reader.itemID, callbacks, setStatus);
      }
    })
    .catch((e) => {
      debug("loadConversation failed: " + errText(e));
      setStatus("读取历史会话失败：" + errText(e), "error");
    });

  input.focus();
  return panel;
}

function togglePanel(reader: any, doc: any, callbacks: AnalysisPanelCallbacks): void {
  const existing = doc.getElementById("zra-ai-panel");
  if (existing) {
    existing.remove();
    return;
  }
  try {
    createPanel(reader, doc, callbacks);
  }
  catch (e) {
    errorLog(e);
    try {
      Zotero.alert(null, "文献阅读助手", "打开 AI 阅读面板失败：" + errText(e));
    }
    catch (ignored) {
      // alert is best-effort
    }
  }
}

/**
 * Adds an "AI 阅读" button to the PDF reader toolbar. The panel is owned by
 * the reader iframe, so it disappears with the reader tab; conversation data
 * lives in the plugin data directory and survives reopening.
 */
export function registerAnalysisToolbar(
  pluginID: string,
  callbacks: AnalysisPanelCallbacks
): string | false {
  try {
    toolbarHandler = (event: any) => {
      try {
        const { reader, doc, append } = event || {};
        if (!reader || !doc || !append || !reader.itemID) {
          return;
        }
        if (doc.getElementById("zra-ai-toggle")) {
          return;
        }
        const toggle = button(doc, "AI 阅读", "打开全文问答与四预设分析");
        toggle.id = "zra-ai-toggle";
        toggle.style.fontWeight = "600";
        toggle.addEventListener("click", () => togglePanel(reader, doc, callbacks));
        append(toggle);
      }
      catch (e) {
        errorLog(e);
      }
    };
    Zotero.Reader.registerEventListener("renderToolbar", toolbarHandler, pluginID);
    debug("registerAnalysisToolbar -> renderToolbar");
    return "renderToolbar";
  }
  catch (e) {
    errorLog(e);
    recordRegistrationError("registerAnalysisToolbar", e);
    toolbarHandler = null;
    return false;
  }
}

export function unregisterAnalysisToolbar(): void {
  if (!toolbarHandler) {
    return;
  }
  try {
    Zotero.Reader.unregisterEventListener("renderToolbar", toolbarHandler);
  }
  catch (e) {
    errorLog(e);
  }
  toolbarHandler = null;
}
