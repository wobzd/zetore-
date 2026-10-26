# M0 实机验证记录

> 目标：在真实 Zotero 10.0.6 上确认 6 个扩展点可用，并拿到结构化取文的真实返回结构。
> 结论：**已通过，20/20**（2026-10-20，Zotero 10.0.6 / Windows，插件版本 0.1.2）。
> 全程未改动 Zotero 数据目录与已有插件。

## 0. 环境

- Zotero 10.0.6（`E:\文献阅读器\zetore`，Gecko 140.17.0）
- profile：`C:\Users\huang\AppData\Roaming\Zotero\Zotero\Profiles\d55402k8.default`
- 产物：`dist/zotero-reading-assistant.xpi`
- 构建：

  ```powershell
  cd D:\Project\AI\插件\zotero-reading-assistant
  node scripts/build.mjs
  ```

## 1. 实测结论

| 扩展点 | 结果 | 实测证据 |
| --- | --- | --- |
| 插件安装/启用 | 通过 | `extensions.json`：`active=true version=0.1.2 target=zotero@zotero.org[6.999,10.0.*]` |
| 主列表列 `ItemTreeManager.registerColumn` | 通过 | 注册键 `…-m0-status`；列选择器中可见并显示 `PDF` |
| 条目面板分区 `ItemPaneManager.registerSection` | 通过 | 注册键 `…-m0-section`；header/sidenav 的 `l10nID` 均解析成功 |
| 工具菜单 `MenuManager.registerMenu` | 通过 | 注册键 `…-m0-tools-menu`；`#menu_ToolsPopup` 内实际节点数 = 1 |
| 划词浮窗 `Reader.registerEventListener` | 通过 | 弹窗显示「ZRA-M0：已捕获 N 字符」+「记录到报告」/「诊断报告」 |
| FTL 本地化 | 通过 | 4 个 ID 在 zh-CN 下全部返回中文（如 `zra-m0-menu-tools` → `文献阅读助手：M0 自检`） |
| 结构化取文 | 通过 | SDT pack v1 / schema 1.2.0；18 页、155 个顶层块、首 240 字正文样本可读 |

**结构化取文的关键事实**：Zotero 10 的 `Zotero.PDFWorker.getStructuredDocumentText(itemID)` 返回 `{ buf: ArrayBuffer }`，即 **SDT 二进制包**，不是纯文本。
读取必须走 `Zotero.SDT`（`sdt.js:29-153`）：

```js
const pack   = await Zotero.SDT.getPack(itemID, { isPriority: true });
// { ok, bytes: ArrayBuffer, packVersion, schemaMajorVersion } | { ok:false, reason }
const reader = await Zotero.SDT.getReader(itemID, { isPriority: true });
const meta   = await reader.getMetadata();   // { processor, dateCreated, source }
const cat    = await reader.getCatalog();    // { pages, outline }
const blocks = await reader.getPageBlocks(0); // 顶层块，node.text 或 node.content[]
```

## 2. 安装

1. Zotero → **工具 → 插件**
2. 右上角齿轮 → **Install Add-on From File…**
3. 选择 `D:\Project\AI\插件\zotero-reading-assistant\dist\zotero-reading-assistant.xpi`
4. 安装后列表应显示 **Zotero 文献阅读助手 (M0) 0.1.2**

> 覆盖安装同 ID 时版本号必须递增，否则 Zotero 会拒绝。

## 3. 观察点

| # | 操作 | 期望 |
| --- | --- | --- |
| 1 | 打开 **工具** 菜单 | 出现「文献阅读助手：M0 自检」 |
| 2 | 选中一条带 PDF 的文献，看右侧条目面板 | 出现「文献阅读助手 (M0)」分区 + sidenav 图标 |
| 3 | 条目列表表头右键 → 列选择器 | 出现 `ZRA-M0` 列；带 PDF 的条目显示 `PDF` |
| 4 | 双击打开 PDF，选中一段文字 | 弹窗出现「ZRA-M0：已捕获 N 字符」+ 两个按钮 |
| 5 | 点「记录到报告」 | 无报错，写入 `%TEMP%\zra-m0-selections.json` |
| 6 | 工具 → 文献阅读助手：M0 自检 | 弹出「自检完成：20/20 通过」 |
| 7 | 打开「工具」菜单后再跑自检 | 报告 `ui.menuNode.count === 1` |

> 菜单项在**打开菜单时**才渲染；安装/重载插件后没打开过工具菜单时，`ui.menuNode.count` 为 0 属正常。

## 4. 报告位置

```
%TEMP%\zra-m0-report-latest.json          # 最新一次自检（固定名，优先回传这个）
%TEMP%\zra-m0-report-<ISO时间戳>.json      # 每次自检的历史副本
%TEMP%\zra-m0-selections.json             # 划词记录
%TEMP%\zra-m0-STARTUP-ERROR.json          # 仅当插件启动失败时出现
```

Windows 下 `%TEMP%` = `C:\Users\huang\AppData\Local\Temp`。

## 5. 报告结构（0.1.2）

```jsonc
{
  "meta": {
    "pluginId": "zotero-reading-assistant@plugin.local",
    "version": "0.1.2",
    "zoteroVersion": "10.0.6",
    "isWin": true,
    "apiSnapshot": { "MenuManager": "object", "ItemTreeManager": "object", "...": "..." },
    "registrationErrors": []          // 注册抛异常时的 { fn, error, at }
  },
  "registrations": {
    "column":  "zotero-reading-assistant\\@plugin\\.local-m0-status",
    "section": "…-m0-section",
    "menu":    "…-m0-tools-menu",
    "reader":  "renderTextSelectionPopup"
  },
  "ftl": { "ok": true, "results": [ { "id": "zra-m0-menu-tools", "value": "文献阅读助手：M0 自检" } ] },
  "checks": [
    { "id": "env.zotero", "ok": true, "detail": { "typeofZotero": "function", "version": "10.0.6" } },
    { "id": "register.column", "ok": true, "detail": "…-m0-status" },
    { "id": "ui.ftl", "ok": true, "detail": { "ok": true, "results": [ ... ] } },
    { "id": "ui.menuNode", "ok": true, "detail": { "popupFound": true, "count": 1 } },
    { "id": "pdf.sample", "ok": true, "detail": { "itemID": 1508, "key": "2H39WU8Y" } },
    { "id": "pdf.structuredText", "ok": true, "detail": {
        "resultKeys": ["buf"], "bufType": "[object ArrayBuffer]", "bufByteLength": 210548 } },
    { "id": "pdf.sdtPack", "ok": true, "detail": {
        "packVersion": 1, "schemaMajorVersion": 1, "byteLength": 210547 } },
    { "id": "pdf.sdtRead", "ok": true, "detail": {
        "pageCount": 18, "blockCount": 155, "textLength": 4456, "textSample": "Atmos. Chem. Phys., 6, 3131–…" } }
  ],
  "summary": { "total": 20, "pass": 20, "fail": 0 }
}
```

判定：`summary.fail === 0` → M0 通过。

## 6. 卸载/回滚

工具 → 插件 → 选中「Zotero 文献阅读助手 (M0)」→ **Remove**。
`shutdown` 会注销列、分区、菜单、阅读器监听，并 `chromeHandle.destruct()`。

## 7. 故障排查（含本次实际踩到的坑）

| 现象 | 原因 / 先看 |
| --- | --- |
| 安装报「可能无法与该版本的 Zotero 兼容」 | `applications.zotero` 必须同时有 `id` / `update_url` / `strict_max_version`（`Extension.sys.mjs:1874-1883`）；缺 `update_url` 也报这条通用文案 |
| 插件已启用但菜单项看不到 | ①FTL 未注入 → 项标签为空（`ui.ftl.ok=false`）；②从未打开过工具菜单（`ui.menuNode.count=0`）；③`registrations.menu === false` |
| 运行中安装后 FTL 一直不生效 | `onMainWindowLoad` 只对新打开的窗口回调（`plugins.js:93-124`），0.1.2 起在 `onStartup` 里主动遍历 `Zotero.getMainWindows()` 补调 |
| 列注册返回 false | `width` 必须是 **string**（`itemTreeManager.js:96-99`），传数字会让整个 option 校验失败 |
| `ui.ftl.ok=false` | 看 `ftl.results[*].error`；多为 locale 目录名与 Zotero 语言不匹配 |
| `pdf.structuredText.ok=false` | 看 `detail.error`：`timeout after 120000ms` → 换小 PDF；无样本 → 先选中带 PDF 的条目 |
| 启动即报错 | `%TEMP%\zra-m0-STARTUP-ERROR.json`（含 stack） |
| 图标不显示 | chrome 注册失败，检查 `chrome://zotero-reading-assistant/content/icons/icon16.svg` |

## 8. M0 未覆盖 / 留给后续

- 跨页选区、同页重复句子的位置区分（M2 前需专项验证）。
- `Annotations.saveFromJSON` 的**标签整体覆盖**语义（M1 必须合并旧标签后再写）。
- 期刊指标在线源与 AI Provider 的真实连通（缺凭据，不阻塞本地功能开发）。
- 群组库深链格式（M2）。
