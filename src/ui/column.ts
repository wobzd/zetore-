import { debug, errorLog, recordRegistrationError } from "../util";
import type { MetricsService } from "../metrics/service";

/**
 * Journal-metric column. Rendering is strictly cache-only: display() never
 * performs network I/O, so scrolling the item tree cannot trigger lookups.
 */
export function registerColumn(pluginID: string, service: MetricsService): string | false {
  try {
    const key = Zotero.ItemTreeManager.registerColumn({
      dataKey: "zra-metrics",
      label: "指标",
      pluginID,
      enabledTreeIDs: ["main"],
      // width must be a string (ItemTreeManager optionTypeDefinition).
      width: "96",
      minWidth: 64,
      showInColumnPicker: true,
      dataProvider: (item: any) => {
        try {
          return service.display(item).text;
        }
        catch (e) {
          return "";
        }
      },
    });
    debug("registerColumn -> " + String(key));
    if (key === false) {
      recordRegistrationError(
        "registerColumn",
        "ItemTreeManager.registerColumn returned false (pluginAPI validation failed)"
      );
    }
    return key;
  }
  catch (e) {
    errorLog(e);
    recordRegistrationError("registerColumn", e);
    return false;
  }
}

export function unregisterColumn(key: string): void {
  try {
    Zotero.ItemTreeManager.unregisterColumn(key);
  }
  catch (e) {
    errorLog(e);
  }
}
