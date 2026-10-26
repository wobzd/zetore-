import { FTL_IDS } from "../const";
import { debug, errorLog, recordRegistrationError } from "../util";

export interface MenuHandlers {
  onAnalyze: () => void;
  onImport: () => void;
  onAISettings: () => void;
  onReveal: () => void;
  onSelfCheck: () => void;
}

/**
 * Tools menu entries for M1. Labels come from the plugin FTL, which is
 * injected in onMainWindowLoad().
 */
export function registerMenu(pluginID: string, handlers: MenuHandlers): string | false {
  try {
    const key = Zotero.MenuManager.registerMenu({
      menuID: "zra-tools-menu",
      pluginID,
      target: "main/menubar/tools",
      menus: [
        {
          menuType: "menuitem",
          l10nID: FTL_IDS.menuAnalyze,
          onCommand: () => {
            try {
              handlers.onAnalyze();
            }
            catch (e) {
              errorLog(e);
            }
          },
        },
        {
          menuType: "menuitem",
          l10nID: FTL_IDS.menuImport,
          onCommand: () => {
            try {
              handlers.onImport();
            }
            catch (e) {
              errorLog(e);
            }
          },
        },
        {
          menuType: "menuitem",
          l10nID: FTL_IDS.menuAISettings,
          onCommand: () => {
            try {
              handlers.onAISettings();
            }
            catch (e) {
              errorLog(e);
            }
          },
        },
        {
          menuType: "menuitem",
          l10nID: FTL_IDS.menuDataDir,
          onCommand: () => {
            try {
              handlers.onReveal();
            }
            catch (e) {
              errorLog(e);
            }
          },
        },
        {
          menuType: "menuitem",
          l10nID: FTL_IDS.menuTools,
          onCommand: () => {
            try {
              handlers.onSelfCheck();
            }
            catch (e) {
              errorLog(e);
            }
          },
        },
      ],
    });
    debug("registerMenu -> " + String(key));
    if (key === false) {
      recordRegistrationError(
        "registerMenu",
        "MenuManager.registerMenu returned false (pluginAPI validation failed)"
      );
    }
    return key;
  }
  catch (e) {
    errorLog(e);
    recordRegistrationError("registerMenu", e);
    return false;
  }
}

export function unregisterMenu(key: string): void {
  try {
    Zotero.MenuManager.unregisterMenu(key);
  }
  catch (e) {
    errorLog(e);
  }
}
