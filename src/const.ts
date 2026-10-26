export const PLUGIN_ID = "zotero-reading-assistant@plugin.local";
export const FTL_NAME = "zotero-reading-assistant.ftl";
export const CHROME_BASE = "chrome://zotero-reading-assistant/content/";

export const FTL_IDS = {
  menuAnalyze: "zra-menu-analyze",
  menuImport: "zra-menu-import",
  menuAISettings: "zra-menu-ai-settings",
  menuDataDir: "zra-menu-data-dir",
  // Kept from M0: the self-check verifies these IDs resolve in zh-CN/en-US.
  menuTools: "zra-m0-menu-tools",
  sectionHeader: "zra-m0-section-header",
  sectionSidenav: "zra-m0-section-sidenav",
  sectionRun: "zra-m0-section-run",
} as const;
