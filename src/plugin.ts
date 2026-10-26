import { FTL_IDS, FTL_NAME, PLUGIN_ID } from "./const";
import { debug, errorLog, errText, jsonify, nowIso, recordRegistrationError, registrationErrors } from "./util";
import { registerColumn, unregisterColumn } from "./ui/column";
import { registerSection, unregisterSection } from "./ui/section";
import { registerMenu, unregisterMenu } from "./ui/menu";
import { registerReaderListener, unregisterReaderListener } from "./ui/reader";
import { registerAnalysisToolbar, unregisterAnalysisToolbar } from "./ui/analysisPanel";
import { applySemanticTag, removeAllSemanticTags, saveTranslationAnnotation, type SelectionPayload } from "./annotations/service";
import type { SemanticTag } from "./annotations/semantics";
import { appendReadingEvent } from "./store/readingStore";
import {
  appendConversationMessages,
  clearConversation,
  loadConversation,
} from "./store/conversationStore";
import { MetricsService } from "./metrics/service";
import { parseMetricsFile, pickMetricsFile } from "./metrics/importFile";
import { dataDir, ensureDir } from "./adapter/paths";
import { buildReport, type Report } from "./selfcheck";
import { isAIConfigured, readAIConfig, redactedAIConfig } from "./ai/config";
import { chat, chatStream } from "./ai/provider";
import { glossaryCacheVersion, readGlossary } from "./ai/glossary";
import type { CancelToken } from "./ai/cancel";
import {
  analysisPreset,
  buildAnalysisMessages,
  buildTranslationMessages,
  TRANSLATION_PROMPT_VERSION,
  type AnalysisPresetKey,
} from "./ai/prompts";
import { parseEvidence, type AnalysisResult } from "./ai/analysis";
import { DocumentTextService } from "./document/text";
import { buildTranslationCacheKey, TranslationCache, type TranslationCacheInput } from "./store/translationCache";
import type { AIState, TranslateResult } from "./ui/reader";

export interface PluginInfo {
  id: string;
  version: string;
  rootURI: string;
}

export interface RegistrationResults {
  // Index signature so the object can be handed to the report builder as a
  // plain name -> (registered key | false) map.
  [key: string]: string | false;
  column: string | false;
  section: string | false;
  menu: string | false;
  reader: string | false;
  analysis: string | false;
  prefs: string | false;
}

export class Plugin {
  id: string = PLUGIN_ID;
  version: string = "0.0.0";
  rootURI: string = "";
  startedAt: string = "";
  registrations: RegistrationResults = {
    column: false,
    section: false,
    menu: false,
    reader: false,
    analysis: false,
    prefs: false,
  };
  ftlCheck: Record<string, unknown> = { ok: false, reason: "not verified yet" };
  /**
   * Snapshot of the plugin API surface taken at startup, before any
   * registration runs. If e.g. Zotero.MenuManager is missing at that moment,
   * registerMenu() degrades to `false` silently; this records the cause.
   */
  apiSnapshot: Record<string, string> = {};
  selections: Array<Record<string, unknown>> = [];
  lastReportPath: string | null = null;
  metrics: MetricsService = new MetricsService();
  documentText: DocumentTextService = new DocumentTextService();
  aiCache: TranslationCache = new TranslationCache();

  private handledWindows: WeakSet<object> = new WeakSet();
  private shutdownDone = false;

  async onStartup(info: PluginInfo, _reason: string): Promise<void> {
    this.id = info.id || PLUGIN_ID;
    this.version = info.version || "0.0.0";
    this.rootURI = info.rootURI || "";
    this.startedAt = nowIso();

    try {
      await this.metrics.initialize();
    }
    catch (e) {
      // A broken/unreadable metrics.json must not prevent the plugin from
      // starting; the store falls back to an empty in-memory state.
      errorLog(e);
    }
    this.metrics.setUpdateHandler(() => this.refreshItemsView());

    this.apiSnapshot = {
      MenuManager: typeof Zotero.MenuManager,
      ItemTreeManager: typeof Zotero.ItemTreeManager,
      ItemPaneManager: typeof Zotero.ItemPaneManager,
      Reader: typeof Zotero.Reader,
      PDFWorker: typeof Zotero.PDFWorker,
      Annotations: typeof Zotero.Annotations,
      HTTP: typeof Zotero.HTTP,
      PreferencePanes: typeof Zotero.PreferencePanes,
      DataDirectory: typeof Zotero.DataDirectory,
      FilePicker: "esm",
    };
    debug("api snapshot: " + jsonify(this.apiSnapshot));

    this.registrations.column = registerColumn(this.id, this.metrics);
    this.registrations.section = registerSection(this.id, this.metrics, {
      onImport: () => {
        void this.importMetricsFile();
      },
      onReveal: () => {
        void this.revealDataDir();
      },
      onDiagnose: () => {
        void this.runSelfCheck();
      },
    });
    this.registrations.menu = this.registerMenus();
    this.registrations.reader = registerReaderListener(this.id, {
      onOpenDataDir: () => {
        void this.revealDataDir();
      },
      onDiagnose: () => {
        void this.runSelfCheck();
      },
      onTag: (payload, semantic) => this.handleTag(payload, semantic),
      onClearTags: (payload) => this.handleClearTags(payload),
      onTranslate: (payload, targetLanguage, requestId, onText, cancelToken) =>
        this.handleTranslate(payload, targetLanguage, requestId, onText, cancelToken),
      onSaveTranslation: (payload, translation, targetLanguage) =>
        this.handleSaveTranslation(payload, translation, targetLanguage),
      onOpenSettings: () => this.openAISettings(),
      getAIState: () => this.getAIState(),
    });
    this.registrations.analysis = registerAnalysisToolbar(this.id, {
      ask: (attachmentItemID, preset, question, requestId, onText, cancelToken) =>
        this.handleAnalysis(attachmentItemID, preset, question, requestId, onText, cancelToken),
      loadConversation: (attachmentItemID) => loadConversation(attachmentItemID),
      clearConversation: (attachmentItemID) => clearConversation(attachmentItemID),
      onOpenEvidence: (attachmentItemID, pageIndex) =>
        this.openEvidence(attachmentItemID, pageIndex),
      onOpenSettings: () => this.openAISettings(),
      getAIState: () => this.getAIState(),
    });
    this.registrations.prefs = await this.registerPreferencePane();

    debug("onStartup done: " + jsonify(this.registrations));

    // At app startup no main window exists yet and Zotero delivers
    // onMainWindowLoad() through its Services.wm listener. When the plugin is
    // installed into an already-running app, that listener never fires for the
    // open window, so the FTL link would never be inserted here.
    try {
      const wins: any[] = typeof Zotero.getMainWindows === "function" ? Zotero.getMainWindows() : [];
      for (const win of wins) {
        this.onMainWindowLoad(win);
      }
      debug("attached to " + wins.length + " existing main window(s)");
    }
    catch (e) {
      errorLog(e);
    }
  }

  onMainWindowLoad(win: any): void {
    try {
      if (!win || !win.document) {
        return;
      }
      if (this.handledWindows.has(win)) {
        return;
      }
      this.handledWindows.add(win);

      // Plugin FTL files are not in the main window's default linkset;
      // Zotero's registerLocales() exposes them as "zotero-plugins:<locale>/"
      // resources, and this is the documented way to pull one into a window.
      if (win.MozXULElement && typeof win.MozXULElement.insertFTLIfNeeded === "function") {
        win.MozXULElement.insertFTLIfNeeded(FTL_NAME);
        debug("insertFTLIfNeeded(" + FTL_NAME + ")");
      }
      else {
        debug("MozXULElement.insertFTLIfNeeded is unavailable");
      }

      this.verifyFtl(win);

      // MenuData carries only l10nID (no plain label), and Zotero's own
      // plugins register their menus once the window exists. If the startup
      // attempt failed, retry now that the FTL link is attached.
      if (this.registrations.menu === false) {
        this.registrations.menu = this.registerMenus();
        debug("registerMenu retry after window load -> " + String(this.registrations.menu));
      }
      else if (typeof this.registrations.menu === "string") {
        debug("menu already registered at startup: " + this.registrations.menu);
      }
    }
    catch (e) {
      errorLog(e);
    }
  }

  onMainWindowUnload(_win: any): void {
    // Nothing to tear down per-window: the l10n link and menu/section nodes are
    // owned by Zotero and removed with the window itself.
  }

  onShutdown(_reason: string): void {
    if (this.shutdownDone) {
      return;
    }
    this.shutdownDone = true;

    if (typeof this.registrations.column === "string") {
      unregisterColumn(this.registrations.column);
    }
    if (typeof this.registrations.section === "string") {
      unregisterSection(this.registrations.section);
    }
    if (typeof this.registrations.menu === "string") {
      unregisterMenu(this.registrations.menu);
    }
    if (typeof this.registrations.prefs === "string") {
      try {
        Zotero.PreferencePanes.unregister(this.registrations.prefs);
      }
      catch (e) {
        errorLog(e);
      }
    }
    unregisterAnalysisToolbar();
    unregisterReaderListener();

    // Flush the translation cache without delaying shutdown. A failed write is
    // harmless: the cache is an optimization, never the source of truth.
    void this.aiCache.flush().catch((e) => debug("aiCache.flush failed: " + errText(e)));
    this.documentText.clear();

    this.registrations = {
      column: false,
      section: false,
      menu: false,
      reader: false,
      analysis: false,
      prefs: false,
    };
    debug("onShutdown done");
  }

  async recordSelection(selection: Record<string, unknown>): Promise<void> {
    try {
      this.selections.push({ ...selection, at: nowIso() });
      const path = await this.writeJson("zra-m0-selections.json", this.selections);
      debug("selection recorded: " + path);
    }
    catch (e) {
      errorLog(e);
    }
  }

  /**
   * F4: create or update a native highlight and record the action on the
   * paper's reading log. Failures are surfaced in the popup, not thrown into
   * the reader event handler.
   */
  async handleTag(payload: SelectionPayload, semantic: SemanticTag): Promise<string> {
    try {
      const result = await applySemanticTag(payload, semantic);
      // "unchanged" means the annotation already had this exact tag; logging
      // it would only flood the reading log with no-op clicks.
      if (result.action !== "unchanged") {
        try {
          await appendReadingEvent(payload.attachmentItemID, "annotation.semantic_tag", {
            semantic: semantic.key,
            tag: semantic.tag,
            action: result.action,
            annotationKey: result.annotationKey,
            tags: result.tags,
            text: payload.text.slice(0, 200),
          });
        }
        catch (e) {
          // The annotation is saved; a failed log write must not turn a
          // successful annotation into a visible error.
          debug("appendReadingEvent failed: " + errText(e));
        }
      }
      if (result.action === "created") {
        return `已高亮：${semantic.label}`;
      }
      if (result.action === "updated") {
        return `已添加标签：${semantic.label}`;
      }
      return `已存在：${semantic.label}`;
    }
    catch (e) {
      errorLog(e);
      return "写入失败：" + errText(e);
    }
  }

  async handleClearTags(payload: SelectionPayload): Promise<string> {
    try {
      const result = await removeAllSemanticTags(payload);
      if (result.notFound) {
        return "当前位置没有原生批注";
      }
      if (!result.removed.length) {
        return "没有需要移除的语义标签";
      }
      try {
        await appendReadingEvent(payload.attachmentItemID, "annotation.tags_cleared", {
          removed: result.removed,
          annotationKey: result.annotationKey,
          tags: result.tags,
          text: payload.text.slice(0, 200),
        });
      }
      catch (e) {
        debug("appendReadingEvent failed: " + errText(e));
      }
      return `已移除：${result.removed.map((t) => t.replace(/^阅读\//, "")).join("、")}`;
    }
    catch (e) {
      errorLog(e);
      return "移除失败：" + errText(e);
    }
  }

  getAIState(): AIState {
    const config = readAIConfig();
    return {
      configured: isAIConfigured(config),
      autoTranslate: config.autoTranslate,
      providerName: config.providerName,
      model: config.model,
    };
  }

  /**
   * F2 translation pipeline:
   *   selection -> SDT context -> cache -> OpenAI-compatible chat -> cache.
   *
   * Throws on failure; the reader popup owns the visible error state. Late
   * responses are guarded by the popup's request number; this method only
   * needs to avoid writing a stale result into the cache under the wrong key
   * (the key is derived from this exact selection/context, so it cannot).
   */
  async handleTranslate(
    payload: SelectionPayload,
    targetLanguage: string,
    requestId: string,
    onText?: (text: string) => void,
    cancelToken?: CancelToken
  ): Promise<TranslateResult> {
    const config = readAIConfig();
    if (!isAIConfigured(config)) {
      throw new Error("尚未配置 AI 服务：请打开设置填写 API Key");
    }

    const context = await this.documentText.getSelectionContext(payload);
    const effectiveTargetLanguage = targetLanguage || "zh-CN";
    // The glossary is a single source->target list; it is currently written for
    // Simplified Chinese. Do not inject Chinese target terms into an English
    // translation.
    const glossary = effectiveTargetLanguage === "zh-CN" ? readGlossary() : [];
    const cacheInput: TranslationCacheInput = {
      attachmentFingerprint: context.fingerprint,
      selectionText: context.selectedText,
      positionHash: context.positionHash,
      contextText: context.contextText,
      sourceLanguage: "auto",
      targetLanguage: effectiveTargetLanguage,
      providerName: config.providerName,
      baseURL: config.baseURL,
      model: config.model,
      promptVersion: TRANSLATION_PROMPT_VERSION,
      glossaryVersion: glossaryCacheVersion(glossary),
    };
    const cacheKey = buildTranslationCacheKey(cacheInput);

    const cached = await this.aiCache.get(cacheKey.key, {
      selectionText: context.selectedText,
      contextHash: cacheKey.contextHash,
      contextText: context.contextText,
    });
    if (cached) {
      debug(`translate cache hit ${requestId} page=${context.pageLabel} model=${cached.model}`);
      return {
        text: cached.translation,
        cached: true,
        model: cached.model || null,
        usage: cached.usage,
        pageLabel: context.pageLabel,
        sectionHeading: context.sectionHeading,
        matched: context.matched,
        fingerprintKind: context.fingerprintKind,
      };
    }

    const messages = buildTranslationMessages({
      selectedText: context.selectedText,
      contextText: context.contextText,
      sectionHeading: context.sectionHeading,
      sourceLanguage: "auto",
      targetLanguage: cacheInput.targetLanguage,
      glossary,
    });
    const result = await chatStream(config, messages, {
      timeoutMs: 90000,
      maxTokens: Math.max(config.maxTokens, 1200),
      onText,
      cancelToken,
    });

    await this.aiCache.put(
      TranslationCache.entryFrom(cacheKey, cacheInput, result.text, (result.usage as any) || null)
    );

    try {
      await appendReadingEvent(payload.attachmentItemID, "ai.translation", {
        targetLanguage: cacheInput.targetLanguage,
        provider: config.providerName,
        model: result.model || config.model,
        pageLabel: context.pageLabel,
        sectionHeading: context.sectionHeading,
        matched: context.matched,
        selection: context.selectedText.slice(0, 300),
        glossaryCount: glossary.length,
        usage: result.usage,
      });
    }
    catch (e) {
      debug("appendReadingEvent(ai.translation) failed: " + errText(e));
    }

    debug(
      `translate ${requestId}: page=${context.pageLabel} matched=${context.matched} `
      + `glossary=${glossary.length} model=${result.model || config.model}`
    );
    return {
      text: result.text,
      cached: false,
      model: result.model,
      usage: (result.usage as any) || null,
      pageLabel: context.pageLabel,
      sectionHeading: context.sectionHeading,
      matched: context.matched,
      fingerprintKind: context.fingerprintKind,
    };
  }

  /**
   * F3: full-text analysis / free-form Q&A. The document context is rebuilt
   * from Zotero's structured text on each request so citations always refer to
   * the current attachment; the last few turns are included as conversation
   * memory. Persistence is best-effort and must not hide a valid answer.
   */
  async handleAnalysis(
    attachmentItemID: number,
    presetKey: AnalysisPresetKey | null,
    question: string,
    requestId: string,
    onText?: (text: string) => void,
    cancelToken?: CancelToken
  ): Promise<AnalysisResult> {
    const config = readAIConfig();
    if (!isAIConfigured(config)) {
      throw new Error("尚未配置 AI 服务：请打开设置填写 API Key");
    }
    const preset = presetKey ? analysisPreset(presetKey) : null;
    if (presetKey && !preset) {
      throw new Error(`未知的分析预设：${presetKey}`);
    }
    const cleanQuestion = String(question || "").trim();
    if (!preset && !cleanQuestion) {
      throw new Error("请输入问题，或选择一个分析预设");
    }

    const startedAtMs = Date.now();
    let context;
    try {
      context = await this.documentText.buildContext(attachmentItemID);
    }
    catch (e) {
      errorLog(e);
      throw new Error("读取论文全文失败：" + errText(e));
    }

    let history: Awaited<ReturnType<typeof loadConversation>> = [];
    try {
      history = await loadConversation(attachmentItemID);
    }
    catch (e) {
      debug("loadConversation failed: " + errText(e));
    }

    const messages = buildAnalysisMessages({
      paperTitle: context.title,
      contextText: context.text,
      question: cleanQuestion,
      preset,
      history: history.map((message) => ({
        role: message.role,
        content: message.content,
      })),
    });

    const userContent = preset ? preset.label : cleanQuestion;
    try {
      await appendConversationMessages(attachmentItemID, [{
        role: "user",
        content: userContent,
        preset: preset?.key || null,
        evidence: [],
      }]);
    }
    catch (e) {
      debug("appendConversationMessages(user) failed: " + errText(e));
    }

    const result = await chatStream(config, messages, {
      timeoutMs: 120000,
      maxTokens: Math.max(config.maxTokens, 2400),
      onText,
      cancelToken,
    });
    const evidence = parseEvidence(result.text, context.blocks);

    try {
      await appendConversationMessages(attachmentItemID, [{
        role: "assistant",
        content: result.text,
        preset: preset?.key || null,
        evidence,
      }]);
    }
    catch (e) {
      debug("appendConversationMessages(assistant) failed: " + errText(e));
    }

    try {
      await appendReadingEvent(attachmentItemID, "ai.analysis", {
        preset: preset?.key || null,
        provider: config.providerName,
        model: result.model || config.model,
        pageCount: context.pageCount,
        totalChars: context.totalChars,
        includedChars: context.includedChars,
        truncated: context.truncated,
        evidenceCount: evidence.length,
        question: preset ? null : cleanQuestion.slice(0, 300),
        usage: result.usage,
      });
    }
    catch (e) {
      debug("appendReadingEvent(ai.analysis) failed: " + errText(e));
    }

    debug(
      `analysis ${requestId}: preset=${preset?.key || "qa"} pages=${context.pageCount} `
      + `chars=${context.includedChars}/${context.totalChars} evidence=${evidence.length} `
      + `model=${result.model || config.model}`
    );
    return {
      text: result.text,
      model: result.model,
      usage: result.usage,
      evidence,
      elapsedMs: Date.now() - startedAtMs,
    };
  }

  /**
   * Zotero's reader API takes the location as the SECOND positional argument:
   * `open(attachmentItemID, { pageIndex })`; pageIndex is 0-based.
   */
  async openEvidence(attachmentItemID: number, pageIndex: number): Promise<void> {
    const page = Math.max(0, Math.floor(Number(pageIndex) || 0));
    try {
      if (!Zotero.Reader || typeof Zotero.Reader.open !== "function") {
        throw new Error("Zotero.Reader.open is unavailable");
      }
      await Zotero.Reader.open(attachmentItemID, { pageIndex: page });
    }
    catch (e) {
      errorLog(e);
      throw new Error("打开证据页失败：" + errText(e));
    }
  }

  async handleSaveTranslation(
    payload: SelectionPayload,
    translation: string,
    targetLanguage: string
  ): Promise<string> {
    try {
      const result = await saveTranslationAnnotation(payload, translation, targetLanguage);
      try {
        await appendReadingEvent(payload.attachmentItemID, "ai.translation_saved", {
          annotationKey: result.annotationKey,
          action: result.action,
          targetLanguage,
          selection: payload.text.slice(0, 200),
        });
      }
      catch (e) {
        debug("appendReadingEvent(ai.translation_saved) failed: " + errText(e));
      }
      return result.action === "created" ? "已存为批注（含译文）" : "已追加到已有批注";
    }
    catch (e) {
      errorLog(e);
      throw new Error(errText(e));
    }
  }

  private registerMenus(): string | false {
    return registerMenu(this.id, {
      onAnalyze: () => {
        void this.analyzeSelected();
      },
      onImport: () => {
        void this.importMetricsFile();
      },
      onAISettings: () => {
        this.openAISettings();
      },
      onReveal: () => {
        void this.revealDataDir();
      },
      onSelfCheck: () => {
        void this.runSelfCheck();
      },
    });
  }

  /**
   * Zotero Settings → 文献阅读助手. The pane is a small XHTML fragment plus a
   * plain-JS script; it reads/writes the same pref branch as src/ai/config.ts.
   */
  private async registerPreferencePane(): Promise<string | false> {
    try {
      if (!Zotero.PreferencePanes || typeof Zotero.PreferencePanes.register !== "function") {
        recordRegistrationError(
          "registerPreferencePane",
          "Zotero.PreferencePanes.register is unavailable"
        );
        return false;
      }
      // On a plugin reload the old pane may still be registered; unregister
      // first so the second register() doesn't throw "already registered".
      try {
        Zotero.PreferencePanes.unregister("zra-ai-preferences");
      }
      catch (e) {
        debug("PreferencePanes.unregister before register failed (ignored): " + errText(e));
      }
      const id = await Zotero.PreferencePanes.register({
        pluginID: this.id,
        src: "content/preferences.xhtml",
        id: "zra-ai-preferences",
        label: "文献阅读助手",
        scripts: ["content/preferences.js"],
        stylesheets: ["content/preferences.css"],
      });
      debug("PreferencePanes.register -> " + String(id));
      return typeof id === "string" ? id : false;
    }
    catch (e) {
      errorLog(e);
      recordRegistrationError("registerPreferencePane", e);
      return false;
    }
  }

  openAISettings(): void {
    try {
      if (typeof Zotero.Utilities?.Internal?.openPreferences === "function") {
        Zotero.Utilities.Internal.openPreferences("zra-ai-preferences");
        return;
      }
      throw new Error("Zotero.Utilities.Internal.openPreferences is unavailable");
    }
    catch (e) {
      errorLog(e);
      Zotero.alert(
        Zotero.getMainWindow(),
        "文献阅读助手",
        "无法打开设置页：" + errText(e) + "\n\n请手动打开 编辑 → 设置 → 文献阅读助手。"
      );
    }
  }

  async analyzeSelected(): Promise<void> {
    const win = Zotero.getMainWindow();
    let items: any[] = [];
    try {
      items = win?.ZoteroPane?.getSelectedItems?.() || [];
    }
    catch (e) {
      items = [];
    }
    const regular = items.filter(
      (item) => item && (typeof item.isRegularItem !== "function" || item.isRegularItem())
    );
    if (!regular.length) {
      Zotero.alert(win, "文献阅读助手", "请先在文献列表中选择条目。");
      return;
    }
    try {
      const result = await this.metrics.analyzeItems(regular, { force: true });
      Zotero.alert(
        win,
        "文献阅读助手",
        `已处理 ${result.processed} 条，跳过 ${result.skipped} 条。\n\n`
        + "结果已写入插件缓存，可在“指标”列和条目面板查看。"
      );
    }
    catch (e) {
      errorLog(e);
      Zotero.alert(win, "文献阅读助手", "查询失败：" + errText(e));
    }
  }

  async importMetricsFile(): Promise<void> {
    const win = Zotero.getMainWindow();
    try {
      const path = await pickMetricsFile(win);
      if (!path) {
        return;
      }
      const table = await parseMetricsFile(path);
      await this.metrics.importTable(table);
      const year = table.metricsYear ? ` ${table.metricsYear}` : "";
      Zotero.alert(
        win,
        "文献阅读助手",
        `已导入 ${table.records.length} 条指标（${table.source}${year}），跳过 ${table.skipped} 条。\n\n`
        + "已缓存的历史结果不会被清除；如需刷新，请选择文献后运行“查询所选文献的期刊指标”。"
      );
    }
    catch (e) {
      errorLog(e);
      Zotero.alert(win, "导入失败", errText(e));
    }
  }

  async revealDataDir(): Promise<void> {
    try {
      const dir = dataDir();
      await ensureDir(dir);
      Zotero.File.reveal(dir);
    }
    catch (e) {
      errorLog(e);
    }
  }

  private refreshItemsView(): void {
    try {
      const win = Zotero.getMainWindow();
      win?.ZoteroPane?.itemsView?.refreshAndMaintainSelection?.();
    }
    catch (e) {
      debug("refreshItemsView failed: " + errText(e));
    }
  }

  async runSelfCheck(): Promise<void> {
    const win = Zotero.getMainWindow();
    try {
      const report: Report = await buildReport({
        pluginId: this.id,
        version: this.version,
        rootURI: this.rootURI,
        startedAt: this.startedAt,
        registrations: this.registrations,
        ftlCheck: this.ftlCheck,
        selectionsCount: this.selections.length,
        apiSnapshot: this.apiSnapshot,
        registrationErrors: registrationErrors.slice(),
        ai: redactedAIConfig(),
        aiCache: await this.aiCache.stats(),
      });

      const stamp = nowIso().replace(/[:.]/g, "-");
      const path = await this.writeJson(`zra-m0-report-${stamp}.json`, report);
      const latestPath = await this.writeJson("zra-m0-report-latest.json", report);
      this.lastReportPath = path;

      Zotero.alert(
        win,
        "文献阅读助手：自检",
        "自检完成：" +
          report.summary.pass +
          "/" +
          report.summary.total +
          " 通过\n\n报告：\n" +
          path +
          "\n\n副本：\n" +
          latestPath
      );
    }
    catch (e) {
      errorLog(e);
      try {
        Zotero.alert(win, "文献阅读助手：自检", "自检失败：" + errText(e));
      }
      catch (e2) {
        errorLog(e2);
      }
    }
  }

  async writeJson(name: string, data: unknown): Promise<string> {
    const path = PathUtils.join(PathUtils.tempDir, name);
    await IOUtils.writeUTF8(path, jsonify(data));
    return path;
  }

  private verifyFtl(win: any): void {
    const doc = win && win.document;
    const l10n = doc && doc.l10n;

    if (!l10n || typeof l10n.formatValue !== "function") {
      this.ftlCheck = {
        ok: false,
        reason: "document.l10n.formatValue is unavailable",
        at: nowIso(),
      };
      return;
    }

    const ids = [
      FTL_IDS.menuTools,
      FTL_IDS.menuAnalyze,
      FTL_IDS.menuImport,
      FTL_IDS.menuAISettings,
      FTL_IDS.menuDataDir,
      FTL_IDS.sectionHeader,
      FTL_IDS.sectionSidenav,
      FTL_IDS.sectionRun,
    ];

    const tasks = ids.map(async (id) => {
      try {
        const value = await l10n.formatValue(id);
        return { id, value: value === null || value === undefined ? null : String(value), error: null as string | null };
      }
      catch (e) {
        return { id, value: null as string | null, error: errText(e) };
      }
    });

    Promise.all(tasks)
      .then((results) => {
        const ok = results.every((r) => !!r.value);
        this.ftlCheck = { ok, results, at: nowIso() };
        debug("ftl check: " + jsonify(this.ftlCheck));
      })
      .catch((e) => {
        this.ftlCheck = { ok: false, reason: errText(e), at: nowIso() };
      });
  }
}
