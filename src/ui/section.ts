import { FTL_IDS } from "../const";
import { debug, errorLog, errText, recordRegistrationError } from "../util";
import type { MetricsService } from "../metrics/service";

export interface SectionHandlers {
  onImport: () => void;
  onReveal: () => void;
  onDiagnose: () => void;
}

let unsubscribeSection: (() => void) | null = null;

/**
 * Item pane section: journal identity, cached metric values, query/import
 * actions, and the EasyScholar key field.
 *
 * Auto-query happens on selection (onItemChange / onRender), never from the
 * column renderer, so opening a large library does not start a scan.
 */
export function registerSection(
  pluginID: string,
  service: MetricsService,
  handlers: SectionHandlers
): string | false {
  let current: { doc: any; body: any; item: any } | null = null;

  const renderInto = (doc: any, body: any, item: any): void => {
    while (body.firstChild) {
      body.removeChild(body.firstChild);
    }

    const box = doc.createElement("div");
    box.className = "zra-metrics-section";
    box.style.cssText = "padding:6px 8px;display:flex;flex-direction:column;gap:6px;font-size:12px;";

    const title = doc.createElement("div");
    title.textContent = "期刊指标";
    title.style.cssText = "font-weight:600;";
    box.appendChild(title);

    const details = service.getDetails(item);
    if (!details.identity) {
      const hint = doc.createElement("div");
      hint.textContent = "当前条目没有期刊信息。选择一篇期刊论文后显示指标。";
      hint.style.cssText = "opacity:.7;";
      box.appendChild(hint);
      body.appendChild(box);
      return;
    }

    const identityLine = doc.createElement("div");
    identityLine.textContent =
      (details.identity.name || "（无刊名）")
      + (details.identity.issn ? " · ISSN " + details.identity.issn : "");
    identityLine.style.cssText = "opacity:.85;word-break:break-all;";
    box.appendChild(identityLine);

    const snapshot = details.snapshot;
    const grid = doc.createElement("div");
    grid.style.cssText = "display:grid;grid-template-columns:auto 1fr;gap:2px 12px;";
    const addRow = (label: string, value: string): void => {
      const labelCell = doc.createElement("div");
      labelCell.textContent = label;
      labelCell.style.cssText = "opacity:.65;";
      const valueCell = doc.createElement("div");
      valueCell.textContent = value;
      grid.appendChild(labelCell);
      grid.appendChild(valueCell);
    };
    addRow(
      "JIF",
      snapshot?.jif.value != null
        ? `${snapshot.jif.value}${snapshot.jif.metricsYear ? `（${snapshot.jif.metricsYear}）` : ""}`
        : "—"
    );
    if (snapshot?.jif5.value != null) {
      addRow("5年 JIF", String(snapshot.jif5.value));
    }
    addRow("JCR 分区", snapshot?.quartile.value ? String(snapshot.quartile.value) : "—");
    addRow(
      "中科院分区",
      snapshot?.cas.zone != null
        ? `${snapshot.cas.zone}区${snapshot.cas.minor != null ? `（小类 ${snapshot.cas.minor}区）` : ""}`
        : "—"
    );
    addRow("JCI", snapshot?.jci.value != null ? String(snapshot.jci.value) : "—");
    box.appendChild(grid);

    const statusLine = doc.createElement("div");
    statusLine.style.cssText = "font-size:11px;opacity:.7;word-break:break-all;";
    let statusMessage = details.message || "";
    if (!statusMessage) {
      if (details.state === "queued") {
        statusMessage = "查询中…";
      }
      else if (!details.configured) {
        statusMessage = "未配置指标来源：可导入本地指标文件，或填写 EasyScholar SecretKey。";
      }
      else if (details.state === "not_requested") {
        statusMessage = "尚未查询";
      }
      else {
        statusMessage = details.state;
      }
    }
    statusLine.textContent = statusMessage;
    box.appendChild(statusLine);

    const actions = doc.createElement("div");
    actions.style.cssText = "display:flex;gap:6px;flex-wrap:wrap;";

    const queryButton = doc.createElement("button");
    queryButton.textContent = "查询 / 刷新";
    queryButton.addEventListener("click", () => {
      queryButton.disabled = true;
      queryButton.textContent = "查询中…";
      void (async () => {
        try {
          await service.analyzeItem(item, { force: true });
        }
        catch (e) {
          debug("section query failed: " + errText(e));
        }
        finally {
          renderInto(doc, body, item);
        }
      })();
    });
    actions.appendChild(queryButton);

    const importButton = doc.createElement("button");
    importButton.textContent = "导入指标文件…";
    importButton.addEventListener("click", () => {
      try {
        handlers.onImport();
      }
      catch (e) {
        errorLog(e);
      }
    });
    actions.appendChild(importButton);

    const revealButton = doc.createElement("button");
    revealButton.textContent = "数据目录";
    revealButton.addEventListener("click", () => {
      try {
        handlers.onReveal();
      }
      catch (e) {
        errorLog(e);
      }
    });
    actions.appendChild(revealButton);

    box.appendChild(actions);

    const keyRow = doc.createElement("div");
    keyRow.style.cssText = "display:flex;gap:6px;align-items:center;";
    const keyInput = doc.createElement("input");
    keyInput.type = "password";
    keyInput.placeholder = "EasyScholar SecretKey";
    keyInput.value = service.getEasyscholarKey() || "";
    keyInput.style.cssText = "flex:1;min-width:0;";
    const saveButton = doc.createElement("button");
    saveButton.textContent = "保存";
    saveButton.addEventListener("click", () => {
      void (async () => {
        await service.setEasyscholarKey(keyInput.value);
        renderInto(doc, body, item);
      })();
    });
    keyRow.appendChild(keyInput);
    keyRow.appendChild(saveButton);
    box.appendChild(keyRow);

    if (!service.isConfigured()) {
      const hint = doc.createElement("div");
      hint.textContent = "本地导入可离线使用；EasyScholar 需要网络与 SecretKey（限速 2 次/秒）。";
      hint.style.cssText = "font-size:11px;opacity:.6;";
      box.appendChild(hint);
    }

    body.appendChild(box);
  };

  try {
    unsubscribeSection = service.subscribe(() => {
      if (!current || !current.body) {
        return;
      }
      if (current.body.isConnected === false) {
        return;
      }
      try {
        renderInto(current.doc, current.body, current.item);
      }
      catch (e) {
        debug("section rerender failed: " + errText(e));
      }
    });

    const key = Zotero.ItemPaneManager.registerSection({
      paneID: "zra-metrics-section",
      pluginID,
      header: {
        l10nID: FTL_IDS.sectionHeader,
        icon: "chrome://zotero-reading-assistant/content/icons/icon16.svg",
      },
      sidenav: {
        l10nID: FTL_IDS.sectionSidenav,
        icon: "chrome://zotero-reading-assistant/content/icons/icon20.svg",
        orderable: true,
      },
      onRender: ({ doc, body, item }: any) => {
        try {
          current = { doc, body, item };
          renderInto(doc, body, item);
          if (item) {
            service.ensureQueued(item);
          }
        }
        catch (e) {
          errorLog(e);
        }
      },
      onItemChange: ({ item, setEnabled }: any) => {
        try {
          const regular = !!item
            && (typeof item.isRegularItem !== "function" || item.isRegularItem());
          setEnabled(regular);
          if (regular) {
            service.ensureQueued(item);
          }
        }
        catch (e) {
          debug("section onItemChange failed: " + errText(e));
        }
      },
    });

    debug("registerSection -> " + String(key));
    if (key === false) {
      recordRegistrationError(
        "registerSection",
        "ItemPaneManager.registerSection returned false (pluginAPI validation failed)"
      );
    }
    return key;
  }
  catch (e) {
    errorLog(e);
    recordRegistrationError("registerSection", e);
    return false;
  }
}

export function unregisterSection(key: string): void {
  try {
    Zotero.ItemPaneManager.unregisterSection(key);
  }
  catch (e) {
    errorLog(e);
  }
  if (unsubscribeSection) {
    try {
      unsubscribeSection();
    }
    catch (e) {
      errorLog(e);
    }
    unsubscribeSection = null;
  }
}
