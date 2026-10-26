import { debug, errText, nowIso, withTimeout } from "./util";

export interface CheckEntry {
  id: string;
  ok: boolean;
  detail?: unknown;
}

export interface ReportSummary {
  total: number;
  pass: number;
  fail: number;
}

export interface Report {
  meta: Record<string, unknown>;
  registrations: Record<string, string | false>;
  ftl: Record<string, unknown>;
  checks: CheckEntry[];
  summary: ReportSummary;
}

export interface SelfCheckContext {
  pluginId: string;
  version: string;
  rootURI: string;
  startedAt: string;
  registrations: Record<string, string | false>;
  ftlCheck: Record<string, unknown>;
  selectionsCount: number;
  apiSnapshot?: Record<string, string>;
  registrationErrors?: Array<{ fn: string; error: string; at: string }>;
  ai?: Record<string, unknown>;
  aiCache?: Record<string, unknown>;
}

interface SamplePDF {
  itemID: number;
  key: string;
  libraryID: number;
  title: string;
  source: string;
}

const PDF_TIMEOUT_MS = 120000;

export async function buildReport(ctx: SelfCheckContext): Promise<Report> {
  const checks: CheckEntry[] = [];
  const startedAtMs = Date.now();

  const zoteroVersion = Zotero.version ?? null;
  const platform = Zotero.platform ?? null;
  const zoteroType = typeof Zotero;

  checks.push({
    id: "env.zotero",
    // The sandbox-exposed Zotero object reports typeof "function" on some
    // builds, so compare against undefined rather than requiring "object".
    ok: zoteroType !== "undefined" && Zotero !== null,
    detail: {
      typeofZotero: zoteroType,
      version: zoteroVersion,
      platform,
      isWin: !!Zotero.isWin,
      isMac: !!Zotero.isMac,
      isLinux: !!Zotero.isLinux,
    },
  });

  // --- API surface -------------------------------------------------------
  fnCheck(checks, "api.PDFWorker.getStructuredDocumentText", Zotero.PDFWorker?.getStructuredDocumentText);
  fnCheck(checks, "api.ItemTreeManager.registerColumn", Zotero.ItemTreeManager?.registerColumn);
  fnCheck(checks, "api.ItemPaneManager.registerSection", Zotero.ItemPaneManager?.registerSection);
  fnCheck(checks, "api.MenuManager.registerMenu", Zotero.MenuManager?.registerMenu);
  fnCheck(checks, "api.Reader.registerEventListener", Zotero.Reader?.registerEventListener);
  fnCheck(checks, "api.Reader.open", Zotero.Reader?.open);
  fnCheck(checks, "api.Annotations.saveFromJSON", Zotero.Annotations?.saveFromJSON);
  fnCheck(checks, "api.PreferencePanes.register", Zotero.PreferencePanes?.register);
  fnCheck(checks, "api.SDT.getReader", Zotero.SDT?.getReader);
  fnCheck(checks, "api.Items.getAll", Zotero.Items?.getAll);
  fnCheck(checks, "api.alert", Zotero.alert);
  fnCheck(checks, "api.launchURL", Zotero.launchURL);

  // --- Registration results ---------------------------------------------
  for (const key of Object.keys(ctx.registrations)) {
    const value = ctx.registrations[key];
    checks.push({
      id: "register." + key,
      ok: typeof value === "string" && value.length > 0,
      detail: value === false ? "register() returned false (see Zotero debug log)" : value,
    });
  }

  // --- FTL ---------------------------------------------------------------
  checks.push({
    id: "ui.ftl",
    ok: !!(ctx.ftlCheck && (ctx.ftlCheck as { ok?: boolean }).ok),
    detail: ctx.ftlCheck,
  });

  // --- AI configuration (never includes the key itself) ------------------
  {
    const ai = ctx.ai || {};
    const hasBaseURL = !!(ai as { baseURL?: string }).baseURL;
    const hasModel = !!(ai as { model?: string }).model;
    const hasAPIKey = !!(ai as { hasAPIKey?: boolean }).hasAPIKey;
    checks.push({
      id: "ai.config",
      ok: hasBaseURL && hasModel,
      detail: ai,
    });
    checks.push({
      id: "ai.apiKey",
      ok: hasAPIKey,
      detail: hasAPIKey
        ? "API Key is configured (value intentionally not reported)"
        : "No API Key yet; configure it in Settings → 文献阅读助手",
    });
    checks.push({
      id: "ai.translationCache",
      ok: !!ctx.aiCache && typeof (ctx.aiCache as { entries?: number }).entries === "number",
      detail: ctx.aiCache,
    });
  }

  // --- Menu node presence (distinguishes "registered" from "rendered") ----
  {
    const win = Zotero.getMainWindow();
    const key = typeof ctx.registrations.menu === "string" ? ctx.registrations.menu : null;
    let popupFound = false;
    let count = -1;
    let error: string | null = null;
    try {
      const popup = win?.document?.querySelector("#menu_ToolsPopup");
      popupFound = !!popup;
      if (popup && key) {
        const esc = win.CSS?.escape ? win.CSS.escape(key) : key;
        count = popup.querySelectorAll("." + esc).length;
      }
      else {
        count = 0;
      }
    }
    catch (e) {
      error = errText(e);
    }
    const registered = typeof ctx.registrations.menu === "string" && !!ctx.registrations.menu;
    checks.push({
      id: "ui.menuNode",
      // Zotero creates the menu node lazily on the first Tools-menu open.
      // Registration succeeding is enough here; a count of 0 is not a failure
      // unless the popup exists but registration also failed.
      ok: count > 0 || (registered && popupFound && !error),
      detail: {
        key,
        popupFound,
        count,
        registered,
        note: "count is only meaningful if the Tools menu was opened since startup; registered=true means the node will be created on first open",
        error,
      },
    });
  }

  // --- Real PDF extraction ----------------------------------------------
  const sample = await findSamplePDF(checks);
  if (sample) {
    // Low-level worker API. In Zotero 10 this returns the structured document
    // text *pack* as { buf: ArrayBuffer }, not plain text (manager.js:652-694,
    // sdt.js:278-285).
    const t0 = Date.now();
    try {
      const result: any = await withTimeout(
        Zotero.PDFWorker.getStructuredDocumentText(sample.itemID, { isPriority: true }),
        PDF_TIMEOUT_MS,
        "getStructuredDocumentText"
      );
      const buf = result?.buf;
      checks.push({
        id: "pdf.structuredText",
        ok: !!buf,
        detail: {
          ms: Date.now() - t0,
          sampleItemID: sample.itemID,
          resultType: Object.prototype.toString.call(result),
          resultKeys: result && typeof result === "object" ? Object.keys(result) : [],
          bufType: Object.prototype.toString.call(buf),
          bufByteLength: typeof buf?.byteLength === "number" ? buf.byteLength : null,
        },
      });
    }
    catch (e) {
      checks.push({
        id: "pdf.structuredText",
        ok: false,
        detail: { ms: Date.now() - t0, sampleItemID: sample.itemID, error: errText(e) },
      });
    }

    // High-level API: Zotero.SDT.getPack() / getReader() (sdt.js:29-153).
    const sdt: any = (Zotero as any).SDT;
    const t1 = Date.now();
    let pack: any = null;
    try {
      pack = sdt && typeof sdt.getPack === "function"
        ? await withTimeout(sdt.getPack(sample.itemID, { isPriority: true }), PDF_TIMEOUT_MS, "SDT.getPack")
        : null;
      checks.push({
        id: "pdf.sdtPack",
        ok: !!(pack && pack.ok),
        detail: {
          ms: Date.now() - t1,
          available: !!sdt,
          ok: pack?.ok ?? false,
          reason: pack?.reason ?? null,
          packVersion: pack?.packVersion ?? null,
          schemaMajorVersion: pack?.schemaMajorVersion ?? null,
          byteLength: pack?.bytes?.byteLength ?? null,
        },
      });
    }
    catch (e) {
      checks.push({
        id: "pdf.sdtPack",
        ok: false,
        detail: { ms: Date.now() - t1, available: !!sdt, error: errText(e) },
      });
    }

    const t2 = Date.now();
    try {
      const reader: any = sdt && typeof sdt.getReader === "function"
        ? await withTimeout(sdt.getReader(sample.itemID, { isPriority: true }), PDF_TIMEOUT_MS, "SDT.getReader")
        : null;

      let pageCount: number | null = null;
      let blockCount: number | null = null;
      let textLength = 0;
      let textSample = "";
      let metadata: any = null;
      let catalog: any = null;

      if (reader) {
        metadata = await reader.getMetadata?.();
        catalog = await reader.getCatalog?.();
        pageCount = Array.isArray(catalog?.pages) ? catalog.pages.length : null;
        blockCount = typeof reader.getTopLevelBlockCount === "function"
          ? reader.getTopLevelBlockCount()
          : null;
        const blocks = await reader.getPageBlocks?.(0);
        if (Array.isArray(blocks)) {
          const text = blocks.map(nodeText).join(" ").replace(/\s+/g, " ").trim();
          textLength = text.length;
          textSample = text.slice(0, 240);
        }
      }

      checks.push({
        id: "pdf.sdtRead",
        ok: !!reader && textLength > 0,
        detail: {
          ms: Date.now() - t2,
          available: !!sdt,
          header: reader?.header
            ? {
              packVersion: reader.header.packVersion,
              schemaVersion: reader.header.schemaVersion,
            }
            : null,
          pageCount,
          blockCount,
          textLength,
          textSample,
          metadataKeys: metadata && typeof metadata === "object" ? Object.keys(metadata) : [],
          catalogKeys: catalog && typeof catalog === "object" ? Object.keys(catalog) : [],
        },
      });
    }
    catch (e) {
      checks.push({
        id: "pdf.sdtRead",
        ok: false,
        detail: { ms: Date.now() - t2, available: !!sdt, error: errText(e) },
      });
    }
  }

  const summary: ReportSummary = {
    total: checks.length,
    pass: checks.filter((c) => c.ok).length,
    fail: checks.filter((c) => !c.ok).length,
  };

  return {
    meta: {
      pluginId: ctx.pluginId,
      version: ctx.version,
      rootURI: ctx.rootURI,
      phase: "M0",
      startedAt: ctx.startedAt,
      generatedAt: nowIso(),
      durationMs: Date.now() - startedAtMs,
      zoteroVersion,
      platform,
      isWin: !!Zotero.isWin,
      tempDir: PathUtils.tempDir,
      selectionsCount: ctx.selectionsCount,
      apiSnapshot: ctx.apiSnapshot ?? {},
      registrationErrors: ctx.registrationErrors ?? [],
    },
    registrations: ctx.registrations,
    ftl: ctx.ftlCheck,
    checks,
    summary,
  };
}

function fnCheck(checks: CheckEntry[], id: string, value: unknown): void {
  const ok = typeof value === "function";
  checks.push({
    id,
    ok,
    detail: ok ? "function" : "missing (typeof=" + typeof value + ")",
  });
}

async function findSamplePDF(checks: CheckEntry[]): Promise<SamplePDF | null> {
  const attempts: string[] = [];

  // 1) Items currently selected in the main window.
  try {
    const win = Zotero.getMainWindow();
    const selected: any[] = win?.ZoteroPane?.getSelectedItems?.() ?? [];
    for (const item of selected) {
      const found = await resolvePDF(item, "selection");
      if (found) {
        checks.push({ id: "pdf.sample", ok: true, detail: found });
        return found;
      }
    }
    attempts.push(`selection(${selected.length})`);
  }
  catch (e) {
    attempts.push("selection: " + errText(e));
  }

  // 2) Search the user library for PDF attachments.
  try {
    const search = new Zotero.Search();
    search.libraryID = Zotero.Libraries.userLibraryID;
    search.addCondition("itemType", "is", "attachment");
    search.addCondition("attachmentFileType", "is", "pdf");
    const ids: number[] = await search.search();
    for (const id of ids.slice(0, 8)) {
      const item = Zotero.Items.get(id);
      const found = await resolvePDF(item, "search");
      if (found) {
        checks.push({ id: "pdf.sample", ok: true, detail: found });
        return found;
      }
    }
    attempts.push(`search(${ids.length})`);
  }
  catch (e) {
    attempts.push("search: " + errText(e));
  }

  // 3) Last resort: scan the most recent top-level items.
  try {
    const ids: number[] = Zotero.Items.getAll(Zotero.Libraries.userLibraryID, true, false, true) ?? [];
    for (const id of ids.slice(-25).reverse()) {
      const item = Zotero.Items.get(id);
      const found = await resolvePDF(item, "recent");
      if (found) {
        checks.push({ id: "pdf.sample", ok: true, detail: found });
        return found;
      }
    }
    attempts.push(`recent(${Math.min(ids.length, 25)})`);
  }
  catch (e) {
    attempts.push("recent: " + errText(e));
  }

  checks.push({
    id: "pdf.sample",
    ok: false,
    detail:
      "未找到可用的 PDF 附件。请先在主窗口选中一条带 PDF 的文献后重新自检。已尝试：" +
      attempts.join("；"),
  });
  return null;
}

async function resolvePDF(item: any, source: string): Promise<SamplePDF | null> {
  if (!item) {
    return null;
  }
  try {
    if (item.isAttachment?.() && item.attachmentContentType === "application/pdf") {
      return {
        itemID: item.id,
        key: item.key,
        libraryID: item.libraryID,
        title: safeTitle(item),
        source,
      };
    }

    if (item.isRegularItem?.()) {
      const attachments: number[] = item.getAttachments?.() ?? [];
      for (const id of attachments) {
        const att = Zotero.Items.get(id);
        if (att && att.attachmentContentType === "application/pdf") {
          return {
            itemID: att.id,
            key: att.key,
            libraryID: att.libraryID,
            title: safeTitle(att),
            source: source + "/child",
          };
        }
      }
    }
  }
  catch (e) {
    debug("resolvePDF failed: " + errText(e));
  }
  return null;
}

function safeTitle(item: any): string {
  try {
    return item.getField("title") || String(item.id);
  }
  catch (e) {
    return String(item.id);
  }
}

/**
 * Plain text of an SDT block node. Mirrors getNestedBlockPlainText() in
 * resource/document-worker/structured-document-text.js: a node either carries
 * a `text` string or nests further nodes in `content`.
 */
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
