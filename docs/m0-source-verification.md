# M0 源码核对报告

**样本**：本机 Zotero **10.0.6**（`E:\文献阅读器\zetore`，Firefox 140 ESR）
**源码来源**：`E:\文献阅读器\zetore\app\omni.ja`（45.3 MB / 7519 条目）解包后的副本
**副本路径**：`C:\Users\huang\AppData\Local\Temp\opencode\zotero10_src\`
**行号约定**：下文所有行号均指该副本中的行号（与 omni.ja 内原文件一致）

---

## 结论摘要

| 项 | 结论 | 是否影响 M0 |
| --- | --- | --- |
| bootstrap 生命周期与沙箱全局 | 可用 | 否（已按实测签名实现） |
| `chrome://` 注册 | 可用（`Components` 在沙箱中可用，已有实装插件为证） | 否 |
| 插件 FTL 注入 | 可用，必须用**裸文件名** `insertFTLIfNeeded("<name>.ftl")` | 否（已实现） |
| 工具菜单 | 可用，但菜单项**只能**用 `l10nID`，没有纯文本 `label` | 否（已改为 l10nID） |
| 条目面板分区 | 可用，`header` 与 `sidenav` **都必填**，且两者都必须同时给 `l10nID` + `icon` | 否（已实现） |
| 条目列表列 | 可用，`label` 可直接用普通字符串 | 否 |
| 阅读器划词弹窗 | 可用，`params.annotation.text` 有值 | 否 |
| 结构化全文提取 | 签名确认，返回结构未在源码中定型 → 需运行时记录 | **是**（自检项） |
| 批注写入 | 可用，但 `tags` 是**整体覆盖**语义，后续必须注意 | 否（M0 不写批注） |
| 深链协议 | `page` 为 1-based，内部换算 `pageIndex = parseInt(page) - 1` | 低 |
| API 参数校验 | 必填缺失不抛异常，只 `log warn` 并返回 `false` | 否（自检已记录返回值） |

---

## A. bootstrap 生命周期与沙箱

`xpcom/plugins.js`

- `:80` `_loadScope(addon);`
- `:82` `await registerLocales(addon);`
- `:83` `await _callMethod(addon, 'startup', REASONS.APP_STARTUP);`
- `:106` `await _callMethod(addon, 'onMainWindowLoad', REASONS.MAIN_WINDOW_LOAD, { window: domWindow });`
- `:120` `await _callMethod(addon, 'onMainWindowUnload', REASONS.MAIN_WINDOW_LOAD, { window: domWindow });`
- `:133` `function _loadScope(addon) {`
- `:224` `async function _callMethod(addon, method, reason, extraParams) {`

**结论**

1. 生命周期方法固定为 `install / startup / shutdown / uninstall / onMainWindowLoad / onMainWindowUnload`。
2. `onMainWindowLoad` 收到的参数是 `{ window }`，不是 window 本身 → 必须解构。
3. `_loadScope` 用 `Cu.Sandbox` 建立系统主体沙箱，并向其中注入 `Zotero`、`Services`、`IOUtils`、`PathUtils`、`ChromeUtils`、`Localization`、定时器等；`APP_SHUTDOWN` 来自 `REASONS`。
4. 因此 **bundle 里可以直接引用 `Zotero` / `Services` / `IOUtils` / `PathUtils`**，无需 `ChromeUtils.import` 逐个取。

---

## B. `chrome://` 注册与 `Components` 可用性

**源码侧**：`plugins.js:_loadScope` 未显式注入 `Components`，理论上存在"沙箱里没有 Components"的风险。

**实证侧**（决定性）：本机已安装并正常工作的 `zoteropdftranslate@euclpts.com`，其 `bootstrap.js` 直接写：

```js
const aomStartup = Components.classes["@mozilla.org/addons/addon-manager-startup;1"]
  .getService(Components.interfaces.amIAddonManagerStartup);
const manifestURI = Services.io.newURI(rootURI + "manifest.json");
chromeHandle = aomStartup.registerChrome(manifestURI, [
  ["content", "zoteropdftranslate", rootURI + "chrome/content/"],
]);
```

并在 `shutdown` 里用 `Cc["@mozilla.org/intl/stringbundle;1"]`、最后 `chromeHandle.destruct()`。

**结论**：bootstrap 沙箱中 `Components`（以及 `Cc`）**确实可用**；`registerChrome` 是标准做法，`shutdown` 必须 `destruct()`。本工程按此实现（`bootstrap.js`），并额外用 try/catch 包裹，失败也不影响主流程。

---

## C. 插件 FTL 的注入机制

`xpcom/plugins.js`

- `:48` `const PLUGIN_L10N_SOURCE_NAME = "zotero-plugins";`
- `:49` `const PLUGIN_L10N_PRE_PATH = "zotero-plugins:{locale}/";`
- `:573-575` 注释：

  ```text
  *   [plugin root]/locale/en-US/make-it-red.ftl
  *   <link rel="localization" href="make-it-red.ftl"/>
  ```

**实证侧**

- `zoteropdftranslate`：`win.MozXULElement.insertFTLIfNeeded(`${config.addonRef}-mainWindow.ftl`)`
- `jadense-in-zotero`：`W7 = "jadense-in-zotero.ftl"`，随后 `MozXULElement.insertFTLIfNeeded(W7)`

**结论**

1. 插件根目录下 `locale/<locale>/*.ftl` 会被 `registerLocales()` 汇总进统一资源源 `zotero-plugins`。
2. 主窗口默认 linkset **不含**插件 FTL（`zoteroPane.xhtml` 只挂内建 ftl），所以插件必须在 `onMainWindowLoad` 自行注入。
3. 注入时用的是**裸文件名**，不是 `chrome://` URL。
4. 本工程：`locale/{zh-CN,en-US}/zotero-reading-assistant.ftl` + `insertFTLIfNeeded("zotero-reading-assistant.ftl")`。

---

## D. 工具菜单（MenuManager）

`xpcom/pluginAPI/menuManager.js`

- `:36` `"main/menubar/tools",`（在 `VALID_TARGETS` 中）
- `:67-70` `VALID_MENU_TYPES = ["menuitem", "separator", "submenu"]`
- `:113-181` `_menusTypeDefinition`
  - `:114-123` `menuType` 必填
  - `:124-127` `l10nID` **optional**
  - 全文没有 `label` / `subtext` 字段
- `:203-207` `l10nFiles` 字段**已被注释废弃**
- `:221-254` `_validate`（`menus` 不能为空；分组目标不允许顶层分隔符）
- `:824-835` `registerMenu(options)` / `unregisterMenu(paneID)`

**结论**：菜单项文字**只能**通过 `l10nID` 提供；`target: "main/menubar/tools"` 合法；注册返回 `mainKey`（带 pluginID 前缀并 `CSS.escape`），注销时把它回传给 `unregisterMenu`。

---

## E. 条目面板分区（ItemPaneManager）

`xpcom/pluginAPI/itemPaneManager.js`

- `:196-284` `optionTypeDefinition`
  - `:204` `paneID: "string"`
  - `:205` `pluginID: "string"`
  - `:222` `onRender: "function"`（必填）
  - `:231-245` `header`（必填）：`l10nID` 必填、`icon` 必填、`l10nArgs`/`darkIcon` 可选
  - `:246-264` `sidenav`（必填）：`l10nID` 必填、`icon` 必填、`l10nArgs`/`darkIcon`/`orderable` 可选
- `:286-307` `_validate`：`paneID` 不得与内建 `info/abstract/attachments/notes/...` 冲突
- `:448-559` `Zotero.ItemPaneManager.registerSection` / `unregisterSection`
- `:503-546` 官方示例（`header.icon` 16×16、`sidenav.icon` 20×20）
- `:485-491` `onRender` **不能是 async**；耗时逻辑放 `onAsyncRender`

**结论**：`header` 与 `sidenav` 都是必填对象，且**两者都必须同时给 `l10nID` + `icon`**；`onRender` 只能同步建 DOM；`onRender` 参数为 `{ doc, body, item }`。

> 与常见博客示例的差异：很多示例只写 `header`，但 10.0.6 的校验要求 `sidenav` 也在。

---

## F. 条目列表自定义列（ItemTreeManager）

`xpcom/pluginAPI/itemTreeManager.js`

- `:154-162` `_add`：默认 `enabledTreeIDs = ["main"]`、`showInColumnPicker = true`
- `:164-173` `_validate`：与内建列 dataKey 冲突则拒绝
- `:189-217` 文档：`dataKey` 必填；`label` **"Either a string or the id to an i18n string"**；`pluginID` 用于插件卸载时自动清理
- `:217` 返回 `dataKey | false`
- `:295` `unregisterColumn(dataKey)`
- `:302` `unregisterColumns` 已 `@deprecated`

**结论**：`label: "ZRA-M0"` 这类普通字符串是官方示例用法（`:226` 就是 `label: 'Reversed Title'`），无需 FTL；`dataProvider(item, dataKey)` 同步返回单元格文本即可。

---

## G. 阅读器划词弹窗（Reader）

`xpcom/reader.js`

- `:2699-2702` `ReaderEventType` 含 `renderTextSelectionPopup`
- `:2705-2711`

  ```js
  /**
   * @typedef {Object} ReaderEvent
   * @property {ReaderInstance} reader
   * @property {Document} doc
   * @property {Object} params
   * @property {function(...Element): void} append
   */
  ```

- `:2733-2739` 官方示例：`params.annotation.text`
- `:2761-2763` `registerEventListener(type, handler, pluginID)`
- `:2770-2772` `unregisterEventListener(type, handler)`（按 handler 引用匹配）
- `:2774-2776` `_unregisterEventListenerByPluginID`（插件卸载自动清理）

**结论**：`append(Element)` 直接把节点插进弹窗；选中文本从 `params.annotation.text` 取；注销必须传**同一个函数引用**，所以本工程把 handler 存在模块级变量里。

---

## H. 结构化全文提取

`xpcom/pdfWorker/manager.js`

- `:652` `async getStructuredDocumentText(itemID, { isPriority = false, password, onProgress } = {}) {`

**结论**：调用形态确认为 `Zotero.PDFWorker.getStructuredDocumentText(itemID, { isPriority: true })`。
**未定**：返回对象的具体字段未在本函数中固定（由 worker 侧决定）→ 因此自检报告里只记录 `keys`、`text.length`、`pages` 数量等**通用摘要**，不假设字段名。这是 M0 需要运行时确认的核心项。

---

## I. 批注写入语义（后续 F4 需要注意）

`xpcom/annotations.js`

- `:214` `this.saveFromJSON = async function (attachment, json, saveOptions = {}) {`
- `:249` `item.setTags((json.tags || []).map((t) => ({ tag: t.name })));`

**结论**：`saveFromJSON` 对 tags 是**整体替换**，不是合并。若传入的 `json` 缺少 `tags`，原有标签会被清空。M0 不写批注，但 F4（六色语义批注）必须走"读旧 tags → 合并 → 全量写回"。

---

## J. 协议与深链

`ZoteroProtocolHandler.mjs`

- `:841` `location.pageIndex = parseInt(page) - 1;`

**结论**：`?page=` 是 **1-based**，内部转 0-based。因此深链里要写人读的页码（第 1 页 → `page=1`）。
**未验证**：group 库的分段形式（`groups/{groupID}/items/{key}`）本次未复核 → 本工程只构造 library 形式，group 形式留待 M2。

---

## K. 插件 API 参数校验与命名空间

`xpcom/pluginAPI/pluginAPIBase.mjs`

- `:177-194` `_validate`：主键重复直接拒绝；校验失败返回 `false`（**不抛异常**）
- `:203-305` `_validateObject`：
  - `:228-230` 缺必填 → `throw` → 被 `catch` → `{valid:false}`（**只在控制台 warn，不中断插件**）
  - `:242-244` 类型不符同样只 warn + `false`
- `:312-319` `_namespacedMainKey`：`CSS.escape(`${pluginID}-${mainKey}`)`

**结论**

1. 注册失败**不会**让插件崩溃，只会静默返回 `false` → 所以自检必须把四个 `register*` 的返回值写进报告，否则无法区分"没注册"和"注册了但没显示"。
2. 返回的 key 是 **CSS 转义后**的字符串（`@` → `\@`），注销时必须原样回传，不能自己拼。

---

## 复现方式

```powershell
# 1. 解包源码（只读，不改动安装目录）
[System.IO.Compression.ZipFile]::ExtractToDirectory("E:\文献阅读器\zetore\app\omni.ja", "$env:TEMP\opencode\zotero10_src")

# 2. 定位证据
Select-String -Path "$env:TEMP\opencode\zotero10_src\chrome\content\zotero\xpcom\plugins.js" -Pattern "_loadScope\(|_callMethod\(|registerLocales\("
Select-String -Path "$env:TEMP\opencode\zotero10_src\chrome\content\zotero\xpcom\pluginAPI\itemPaneManager.js" -Pattern "header:|sidenav:"
```

## 运行时结论（2026-10-20，Zotero 10.0.6，0.1.2 实测 20/20）

| 待确认项 | 实测结果 |
| --- | --- |
| `getStructuredDocumentText` 返回结构 | `{ buf: ArrayBuffer }`，是 SDT 二进制包，不是文本；读法见下 |
| `sidenav` 是否强制 | 是；header/sidenav 的 `l10nID` + `icon` 齐备时注册成功 |
| FTL 是否命中 | 4 个 ID 在 zh-CN 下全部命中 |
| 划词弹窗是否可用 | 可用；`append(box)` 正常插入，按钮事件可执行 |

### 实测修正（源码推断有偏差的地方）

1. **列注册 `width` 必须是字符串**
   `itemTreeManager.js:96-99` 的 `optionTypeDefinition` 声明 `width: { type: "string" }`。
   传数字会让 `_validateObject` 抛错 → `registerColumn` 返回 `false`，且不产生任何 UI。
   （JSDoc 示例 `width: 100` 是文档 bug。）

2. **`onMainWindowLoad` 不会为“已打开的窗口”补发**
   `plugins.js:93-124` 只注册 `Services.wm` 监听器，用于**之后新打开**的窗口。
   在运行中的 Zotero 里安装/重载插件时，主窗口已存在 → 回调永不触发 → FTL 永不注入。
   修正：`onStartup` 末尾遍历 `Zotero.getMainWindows()` 主动调用 `onMainWindowLoad(win)`，
   用 `WeakSet` 去重，避免与新窗口回调重复。

3. **沙箱里的 `Zotero` 的 `typeof` 是 `"function"`**
   `env.zotero` 不能用 `typeof Zotero === "object"` 判定，改为 `typeof !== "undefined"`。

4. **结构化取文的正确入口是 `Zotero.SDT`**
   `sdt.js:29-153`：
   - `getPack(itemID, {isPriority})` → `{ ok, bytes, packVersion, schemaMajorVersion }`
   - `getReader(itemID)` → reader，含 `getMetadata()` / `getCatalog()` / `getTopLevelBlockCount()` / `getPageBlocks(i)` / `getBlocks(a,b)`
   - 包格式：`packVersion 1`，`schemaVersion "1.2.0"`（实测样本 18 页 / 155 个顶层块 / 4,456 字）

5. **报告序列化不能用全局 seen 集合**
   同一个对象在报告里出现两次（如 `ftlCheck`、`pdf.sample`）会被误标成 `[circular]`；
   已改为按祖先链判定循环引用。

