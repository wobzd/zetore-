/*
 * Zotero 文献阅读助手 — M0 bootstrap
 *
 * Loaded by Zotero's plugin loader into a system-principal sandbox
 * (see xpcom/plugins.js:_loadScope).  Sandbox globals include:
 *   Zotero, Services, IOUtils, PathUtils, ChromeUtils, Components,
 *   Localization, timers, and APP_SHUTDOWN (from REASONS).
 *
 * The actual implementation lives in content/scripts/index.js, which is an
 * esbuild IIFE bundle.  It attaches itself to Zotero.__ZRA as a side effect,
 * so this file only forwards lifecycle calls.
 */

var chromeHandle = null;

function zraLog(msg) {
  try {
    Zotero.debug("[ZRA/boot] " + msg);
  }
  catch (e) {
    // Zotero might not be ready yet; nothing sensible to do.
  }
}

function zraError(e) {
  try {
    Zotero.logError(e);
  }
  catch (err) {
    // ignore
  }
  zraLog("ERROR: " + (e && e.message ? e.message : String(e)));
}

async function writeStartupError(e, rootURI) {
  try {
    const path = PathUtils.join(PathUtils.tempDir, "zra-m0-STARTUP-ERROR.json");
    const payload = {
      at: new Date().toISOString(),
      message: String(e),
      stack: e && e.stack ? String(e.stack) : null,
      rootURI: rootURI || null,
    };
    await IOUtils.writeUTF8(path, JSON.stringify(payload, null, 2));
    const win = Zotero.getMainWindow();
    Zotero.alert(
      win,
      "文献阅读助手 M0 启动失败",
      "错误报告已写入：\n" + path + "\n\n" + String(e)
    );
  }
  catch (e2) {
    zraError(e2);
  }
}

function install(data, reason) {
  zraLog("install reason=" + reason);
}

async function startup({ id, version, rootURI }, reason) {
  zraLog("startup id=" + id + " version=" + version + " reason=" + reason);

  try {
    await Zotero.initializationPromise;

    // Register chrome://zotero-reading-assistant/content/ so that icons and
    // scripts shipped inside content/ are reachable from chrome URLs.
    try {
      const aomStartup = Components.classes["@mozilla.org/addons/addon-manager-startup;1"]
        .getService(Components.interfaces.amIAddonManagerStartup);
      const manifestURI = Services.io.newURI(rootURI + "manifest.json");
      chromeHandle = aomStartup.registerChrome(manifestURI, [
        ["content", "zotero-reading-assistant", rootURI + "content/"],
      ]);
      zraLog("chrome registered");
    }
    catch (e) {
      // Non-fatal: the plugin still works, only chrome:// icons would fail.
      zraError(e);
    }

    // `this` is the sandbox scope (plugins.js calls func.call(scope, params, reason)).
    const scope = this || globalThis;
    Services.scriptloader.loadSubScript(rootURI + "content/scripts/index.js", scope);
    zraLog("bundle loaded");

    const plugin = Zotero.__ZRA;
    if (!plugin) {
      throw new Error("bundle did not expose Zotero.__ZRA");
    }

    await plugin.onStartup({ id, version, rootURI }, reason);
    zraLog("onStartup finished");
  }
  catch (e) {
    zraError(e);
    await writeStartupError(e, rootURI);
  }
}

function onMainWindowLoad(args, reason) {
  try {
    const plugin = Zotero.__ZRA;
    const win = args && args.window;
    if (!win) {
      return;
    }
    if (plugin && typeof plugin.onMainWindowLoad === "function") {
      plugin.onMainWindowLoad(win);
    }
  }
  catch (e) {
    zraError(e);
  }
}

function onMainWindowUnload(args, reason) {
  try {
    const plugin = Zotero.__ZRA;
    const win = args && args.window;
    if (!win) {
      return;
    }
    if (plugin && typeof plugin.onMainWindowUnload === "function") {
      plugin.onMainWindowUnload(win);
    }
  }
  catch (e) {
    zraError(e);
  }
}

function shutdown({ id, version, rootURI }, reason) {
  const isAppShutdown = typeof APP_SHUTDOWN !== "undefined" && reason === APP_SHUTDOWN;
  if (isAppShutdown) {
    zraLog("shutdown: app shutdown, skipping cleanup");
    return;
  }

  zraLog("shutdown reason=" + reason);
  try {
    const plugin = Zotero.__ZRA;
    if (plugin && typeof plugin.onShutdown === "function") {
      plugin.onShutdown(reason);
    }
  }
  catch (e) {
    zraError(e);
  }

  try {
    if (chromeHandle) {
      chromeHandle.destruct();
      chromeHandle = null;
      zraLog("chrome destructed");
    }
  }
  catch (e) {
    zraError(e);
  }

  try {
    delete Zotero.__ZRA;
  }
  catch (e) {
    // ignore
  }
}

function uninstall(data, reason) {
  zraLog("uninstall reason=" + reason);
}
