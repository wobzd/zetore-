# M2 实现记录（第一阶段）— AI 设置 + F2 划词翻译

- 版本：`0.3.7`（0.3.1 修复设置页/浮窗；0.3.2 精简弹窗并更新 DeepSeek 预设；0.3.3 修复原生弹窗宽度上限；0.3.4 增加模型校验；0.3.5 改为显式模型下拉框；0.3.6 增加 Agnes AI 预设与模型列表；0.3.7 合并为单一模型下拉框并增加“获取模型”）
- 构建：`node scripts/build.mjs`
- 产物：`dist/zotero-reading-assistant.xpi`（46,187 B；bundle 145,885 B）
- SHA256：`DFA7912377611A542972237D70B8063734A75DD732E0D5F4A53B77FB88FA6E31`
- 范围：M2 第一阶段。已完成 **AI 服务设置 + OpenAI 兼容 Provider + F2 划词翻译 + 本地翻译缓存 + 存为批注**；**F3 全文解读 / 证据回跳 / 逐篇会话尚未开始**。
- 后续：F3 已在 `0.4.0` 实现，见 `docs/M3_IMPLEMENTATION.md`；`0.4.4` 增加术语表 UI、翻译 Prompt 注入与内容版本化缓存失效。本文第 7/8 节已同步当前状态。

---

## 1. 代码结构

```
src/
  ai/
    types.ts                AIConfig / AIError / ChatMessage / ChatResult
    config.ts               pref 读写、默认值、endpoint 归一化、脱敏
    provider.ts             OpenAI 兼容 chat() / testConnection()
    prompts.ts              翻译 Prompt、版本号、目标语言
    glossary.ts             术语表解析、Prompt 块、内容版本
  document/text.ts          SDT 全文读取、页/块定位、上下文提取
  store/translationCache.ts 本地翻译缓存（精确命中、原子写、LRU 上限）
  ui/reader.ts              阅读器划词弹窗：六色 + 翻译 + 复制 + 存批注
  annotations/service.ts    saveTranslationAnnotation()
content/
  preferences.xhtml         设置页片段（XUL 根 + html: 表单）
  preferences.js            设置页逻辑（Zotero.Prefs / Zotero.HTTP）
  preferences.css           设置页样式
```

新增/修改的关键文件：

- `src/plugin.ts`：注册设置页、Tools「AI 设置…」、`handleTranslate`、`handleSaveTranslation`、`getAIState`、缓存与 SDT 服务、自检上下文。
- `src/ui/menu.ts`、`src/const.ts`、`locale/*/zotero-reading-assistant.ftl`：新增 `zra-menu-ai-settings`。
- `src/selfcheck.ts`：新增 `api.PreferencePanes.register`、`api.SDT.getReader`、`ai.config`、`ai.apiKey`、`ai.translationCache`。
- `scripts/build.mjs`：把 `content/preferences.{xhtml,js,css}` 打进 XPI。
- `package.json` / `manifest.json`：`0.3.7`。

---

## 2. AI 设置

### 2.1 入口

- Zotero 设置 → **文献阅读助手**（`Zotero.PreferencePanes.register`，id `zra-ai-preferences`）。
- 工具 → 文献阅读助手 → **AI 设置…**（`Zotero.Utilities.Internal.openPreferences("zra-ai-preferences")`）。
- 阅读器划词弹窗里的「设置」按钮。

### 2.2 配置项

| 设置 | pref 键（前缀 `extensions.zotero.zotero-reading-assistant.ai.`） | 默认 |
| --- | --- | --- |
| 服务名称 | `providerName` | `DeepSeek` |
| Base URL | `baseURL` | `https://api.deepseek.com/v1` |
| API Key | `apiKey` | 空 |
| 模型 | `model` | `deepseek-flash` |
| 温度 | `temperature` | `0.3` |
| 最大输出 | `maxTokens` | `1200` |
| 自动翻译 | `autoTranslate` | `true` |

- 预设：DeepSeek、Agnes AI、通义千问（DashScope 兼容模式）、自定义（MiMo / 其他 OpenAI 兼容服务；模型可用“获取模型”拉取）。
- `Base URL` 可以填服务根地址，也可以直接粘贴完整的 `/chat/completions` 地址；插件会自动补齐。
- 「测试连接」使用**当前表单值**（不保存），发一次 `max_tokens: 8` 的最小请求；成功/失败都显示在设置页。
- API Key 仅写入本机 Zotero pref，**不写入插件数据目录、debug 日志或自检报告**；自检只报告 `hasAPIKey` 布尔值。
- 设置页保存后立即生效，不需要重启 Zotero。阅读器弹窗打开期间修改设置，下一次点「翻译」会重新读取配置。

### 2.3 Provider

`src/ai/provider.ts` 只依赖 OpenAI 兼容的 `POST /chat/completions`：

```json
{
      "model": "deepseek-flash",
  "messages": [{ "role": "system", "content": "..." }, { "role": "user", "content": "..." }],
  "temperature": 0.3,
  "max_tokens": 1200,
  "stream": false
}
```

错误分类：

- `401/403` → 鉴权失败
- `404` → 接口或模型不存在
- `429` → 限流/额度不足
- `400` + context/token/length → 上下文超长
- `5xx` → 服务端错误
- 超时 / 网络 / 取消 / JSON 解析 / 空响应

HTTP 设置：`responseType: "json"`、`successCodes: false`、`errorDelayMax: 0`、翻译超时 90 s、测试连接超时 20 s。`UnexpectedStatusException` 从 `.xmlhttp` 读取状态和响应体。

---

## 3. F2 翻译流程

```
划词
  → renderTextSelectionPopup
  → buildPayload(reader, params, text)
  → handleTranslate(payload, targetLanguage, requestId)
      → DocumentTextService.getSelectionContext()
          → Zotero.SDT.getReader(attachmentItemID)   // async，必须 await
          → getMetadata() / getCatalog()
          → getPageBlocks(pageIndex)                  // 0-based
          → 页/块匹配 + 章节标题 + 前后文
      → 翻译缓存精确命中？
          → 命中：直接返回
          → 未命中：buildTranslationMessages() → chat() → 写缓存
      → 追加 ai.translation 阅读事件
  → 弹窗显示译文
```

### 3.1 选区定位

- 优先用 `position.pageIndex`（0-based）；若该页找不到选文，检查相邻页（兼容 1-based 或跨页选区）。
- 页内先做精确块匹配；失败后用 token 重叠度选最可能的块。
- 上下文包含：章节标题、前一块、**当前块中选区前后 300 字窗口**、选文、后一块。
- 选文和上下文都经过空白归一化；匹配失败时仍发送选文，并在弹窗标记「未定位到段落」。

### 3.2 Prompt

- 只翻译 `selection`；`context` 只用于消歧，不得翻译/总结。
- 保留数字、单位、公式、变量名、引用标记、否定词、比较级和限定强度。
- 不添加原文没有的结论或评价；只输出译文，不加前缀、不加 Markdown 代码块。
- 用户内容以 JSON 传入，避免 PDF 文本里的尖括号破坏指令边界。
- `TRANSLATION_PROMPT_VERSION=1`；`GLOSSARY_VERSION=1` 是术语表格式版本，实际缓存键还包含术语内容的 FNV 内容版本。修改 Prompt 或术语格式时递增。
- 术语表从 pref `extensions.zotero.zotero-reading-assistant.ai.glossary` 读取，按行解析为 `source/target` 列表；非空时追加到 system prompt，空表保持原 Prompt 不变。

### 3.3 目标语言

当前支持：

- `zh-CN` 简体中文（默认）
- `en` English

### 3.4 自动翻译与晚到保护

- `autoTranslate=true` 时，选区稳定约 **450 ms** 后自动请求；手动「翻译」始终可用。
- 每个弹窗持有 `activeRequest` 请求号；晚到的响应只有在请求号仍匹配且弹窗仍连接时才写入 UI。
- 快速换选区时旧弹窗被移除，晚到结果不会覆盖新选区。
- 当前 HTTP 层未实现真正的 abort；取消语义由 UI 请求号保证。流式输出留到后续阶段。

### 3.5 存为批注

- 点击「存为批注」→ `saveTranslationAnnotation()`：
  - 同位置已有高亮：追加 `【译文·目标语言】` 到 `annotationComment`，合并 `翻译` 标签，不重复创建高亮。
  - 没有高亮：创建原生高亮，颜色 `#ffd400`，标签 `翻译`，comment 写入译文。
- 不覆盖用户已有标签或已有 comment。
- 追加 `ai.translation_saved` 阅读事件。

---

## 4. 翻译缓存

文件：`<Zotero 数据目录>/zotero-reading-assistant/cache/translations.json`

```json
{
  "schemaVersion": 2,
  "entries": [
    {
      "key": "t1_<hash>_<len>",
      "createdAt": "2026-10-20T...",
      "providerName": "DeepSeek",
  "model": "deepseek-flash",
      "sourceLanguage": "auto",
      "targetLanguage": "zh-CN",
      "attachmentFingerprint": "...",
      "selectionText": "...",
      "positionHash": "...",
      "contextHash": "...",
      "contextText": "...",
      "translation": "...",
      "usage": { "prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0 }
    }
  ]
}
```

- 缓存键包含：附件指纹、选文、位置 hash、上下文 hash、源/目标语言、Provider、Base URL、模型、Prompt 版本、术语表版本。
- `schemaVersion=2`；`glossaryVersion` 是 `格式版本:条数:FNV(内容):长度` 的内容版本，术语内容变化即失效；旧 schema 1 缓存加载时忽略。
- 命中时额外校验 **完整选文 + 完整上下文文本**，避免 32 位 hash 碰撞返回错误译文。
- 最多 500 条；超出按 `createdAt` 淘汰最旧条目。
- `.tmp` + 原子替换写盘；写失败不会影响本次翻译结果。
- API Key 不进入缓存。

---

## 5. 源码级依据（Zotero 10.0.6）

| API / 行为 | 依据 |
| --- | --- |
| 设置页 `src` / `scripts` / `stylesheets` 可相对插件根；片段以 XUL 为默认命名空间，HTML 用 `html:` | `xpcom/preferencePanes.js:97-164` |
| `Zotero.SDT.getReader(itemID)` 是 async，返回 reader 或 null | `xpcom/sdt.js:143-153` |
| `reader.getMetadata()` / `getCatalog()` / `getPageBlocks(0)` | `sdt.js` 与 M0 自检实测（20/20） |
| `HTTP.request` 支持 `responseType` / `successCodes` / `errorDelayMax` / `timeout` | `xpcom/http.js` |
| `UnexpectedStatusException` 暴露 `.xmlhttp` | `http.js` |
| 阅读器划词事件 `renderTextSelectionPopup` | `xpcom/reader.js` |
| `annotationComment` 可读写；`saveFromJSON` / `setTags` | `xpcom/annotations.js`；M1 实机验收 |
| `Zotero.Prefs.get/set(key, value, true)` 为全局 pref | Zotero 公共 API |

---

## 6. 实机验收清单

安装 `dist/zotero-reading-assistant.xpi`，重启 Zotero 10.0.6。

### 设置页

- [ ] 设置 → 文献阅读助手出现；工具菜单出现「AI 设置…」。
- [ ] 填入 DeepSeek API Key，点「测试连接」→ 显示连接成功和耗时。
- [ ] 点「保存」→ 提示已保存；关闭再打开设置页，值仍在（Key 回显）。
- [ ] 切换预设为通义千问 → Base URL / 模型自动填入；切回 DeepSeek 正常。

### 翻译

- [ ] 打开有 SDT 索引的英文 PDF，选中 1–3 句 → 弹窗出现「翻译」。
- [ ] 点「翻译」→ 显示中文译文；数字、单位、引用标记保留。
- [ ] 自动翻译开启时，选中后约 0.5 s 自动出结果。
- [ ] 同一选区再次翻译 → 状态显示「已从缓存加载」，`cache/translations.json` 有记录。
- [ ] 快速连续换选区 → 新弹窗显示新译文，不被旧请求覆盖。
- [ ] 点「复制」→ 剪贴板得到译文。
- [ ] 点「存为批注」→ PDF 出现原生高亮，comment 有 `【译文·简体中文】`，标签含 `翻译`。
- [ ] 同一位置再存一次 → 追加 comment，不新建重复高亮。

### 持久化与自检

- [ ] 重启 Zotero → 设置页配置仍在；同一选区翻译仍可缓存命中。
- [ ] 工具 → 自检：
  - 未配置 Key：`ai.apiKey` 失败是**预期**；其余 AI/API 项应通过。
  - 配置 Key 后：`ai.config`、`ai.apiKey`、`ai.translationCache`、`register.prefs` 均通过。

---

## 7. 已知限制

- F3 已在 `0.4.3` 实机验收通过；四预设、全文 ContextBuilder、证据编号/页码回跳、逐篇会话和浮动面板均正常。
- M2 阶段为非流式请求；`0.4.3` 已加入 SSE 流式输出与真正 HTTP abort，见 `docs/M3_IMPLEMENTATION.md`。
- 目标语言只有简体中文/English；`0.4.4` 已实现术语表 UI，术语表只影响简体中文划词翻译，不影响 F3。
- 源语言固定 `auto`。
- PDF 必须已有 SDT 索引；没有索引时提示先让 Zotero 完成索引。
- API Key 以明文存于 Zotero pref（与多数 Zotero 插件一致），但不会进入数据目录/日志/报告。
- `0.4.3` 已用 DeepSeek `deepseek-flash` 实测划词翻译、流式输出、停止与关闭中止；`0.4.4` 术语表仍需安装后实机复测。

---

## 8. 下一步

1. 用户安装 `0.4.4`，配置 DeepSeek Key，按第 6 节验收 F2，并重点测试术语表保存、计数、翻译注入与缓存失效。
2. 修复实机暴露的问题（尤其设置页、SDT 页索引、批注 comment）。
3. F3 已完成；后续可继续源语言选择、更多目标语言或术语表按目标语言分组。

---

## 9. 0.3.1 实机问题修复

### 9.1 设置页空白

- 现象：设置左侧出现「文献阅读助手」，右侧内容区空白；pane 标签已注册，说明 `PreferencePanes.register()` 成功。
- 根因：Zotero `preferences.js` 的 `_loadPane()` 使用
  `MozXULElement.parseXULToFragment(markup, dtdFiles)` 加载 `pane.src`。
  该 API 会先把片段包进 `<box>...</box>` 再按 XML 解析；`content/preferences.xhtml`
  开头的 `<?xml version="1.0"?>` 位于包装节点内部，导致
  `not well-formed XML`，解析在插入 heading 和表单之前就失败，所以只剩空白。
- 修复：移除 XML 声明；根 `<vbox>` 保留 XUL 命名空间并补 `flex="1"`；HTML 表单继续使用
  `html:` 前缀。注意：`preferences.xhtml` 是**片段**，不是完整 XUL 文档。
- 验证：将文件内容包进 `<box>` 后用 XML 解析器检查，结果为 `XML_OK`；XPI 内文件不再以
  `<?xml` 开头。

### 9.2 翻译浮窗溢出

- 现象：划词弹窗在阅读器底部/右侧被裁切，「存为批注」与底部按钮显示不全。
- 修复：
  - 未配置 AI 时不再渲染完整翻译区，只显示紧凑的「AI 未配置 / 设置 / 数据目录 / 诊断」行。
  - 浮窗宽度 `min(520px, calc(100vw - 24px))` → `min(440px, calc(100vw - 20px))`，并加 `max-width:100%`。
  - 最大高度 `72vh` → `60vh`。
  - 原文最大高度 `64px` → `48px`；译文最大高度 `220px` → `150px`。
  - 原文/译文增加 `overflow-wrap:anywhere` / `word-break:break-word`，避免长 URL、长单词撑破。
- 说明：设置页修复后，用户配置 Key 再重新划词即可看到完整翻译区。

---

## 10. 0.3.2 交互调整

### 10.1 移除选区预览

- 删除弹窗顶部的「选中内容（N 字符）」标题和原文预览块。
- 用户已经知道自己在 PDF 中选了什么；预览占用纵向空间，且把译文推到更下方。
- 弹窗现在从语义标签按钮开始；翻译区紧随其后。

### 10.2 译文区自适应

- `result` 不再固定 `max-height:150px`，也不再有独立滚动条；高度随译文内容增长。
- 整个弹窗最大高度 `70vh`，内容超过时由弹窗整体滚动，避免“译文小框 + 外层大框”双层滚动。
- 保留 `overflow-wrap:anywhere` / `word-break:break-word`，长公式、URL、英文术语不会撑破宽度。

### 10.3 DeepSeek 模型预设

- 官方当前 OpenAI 兼容模型：
  - `deepseek-flash`：DeepSeek-V4.1-Flash-1017（2026-10-17 更新，默认推荐）。
  - `deepseek-v4-pro`：更强的 Pro 模型。
- 插件默认从旧的 `deepseek-chat` 更新为 `deepseek-flash`；设置页提示同时列出 `deepseek-v4-pro`。
- 已保存的旧配置不会被静默改写；在设置页选择一次 DeepSeek 预设或手动改模型名即可。
- 截图中的 `deepseek-flash` 已经是最新模型，翻译成功说明调用链正常。

### 10.4 验证

- `tsc --noEmit`：`TSC_OK`。
- `node --check content/preferences.js`：通过。
- XPI `43,508 B`；SHA256 `D83A723B25FE2EB1140616C31697D3488D41472F66FDB14BC8CDF0C7643911F9`。

---

## 11. 0.3.3 弹窗宽度修复

### 11.1 根因

- Zotero `reader.css` 中 `.selection-popup{max-width:198px}`。插件的内容挂在
  `.selection-popup > .custom-sections` 下，因此内层即使写 `width:440px`，也会被父级
  压回约 182px；译文只能每行显示十来个汉字，纵向被拉得很长。
- 只删除原文预览、放宽译文高度，解决的是“变高”，没有解决“变宽”。

### 11.2 修复

- `src/ui/reader.ts` 新增 `expandSelectionPopup()`：
  - 只对本插件挂载的 `.selection-popup` 设置
    `width:min(560px, calc(100vw - 24px)) !important` 和同名 `max-width`。
  - 内层 `.zra-annotation-popup` 改为 `width:100%`，填满扩宽后的原生容器。
  - 保持原生颜色行左对齐，高亮/下划线切换固定 76px，避免被拉成整行。
  - Zotero 的 `ViewPopup` 在翻译结果到达前就测量了尺寸；扩宽后通过
    `marginLeft` / `marginTop` 重新夹取到阅读器可视区域，并用 `ResizeObserver`
    在译文变高时再次调整，避免右侧/底部裁切。
- 不修改 Zotero 原生 CSS 文件，只改当前弹窗实例，不影响其他插件的划词弹窗。

### 11.3 验证

- `tsc --noEmit`：通过。
- `node scripts/build.mjs`：0.3.3，bundle `145,885 B`，XPI `44,239 B`。
- XPI SHA256：`3CC76F377EF5EA489CA059801D83C4682A2746A1B7D6B5CA52A63B78DBDBE461`。
- 静态检查：XPI 内 `manifest.json` 版本为 `0.3.3`，打包清单完整。
- 待实机确认：560px 宽度在用户当前阅读器窗口中的实际视觉效果，以及靠右/靠底选区是否仍被裁切。

---

## 12. 0.3.4 / 0.3.5 模型选择与校验

### 12.1 问题

- 用户在「模型」输入框填写 `DeepSeek-V4.1-Flash-1017`，测试连接返回：
  `The supported API model names are deepseek-flash, deepseek-v4-pro...`。
- 该字段对应请求体里的 `model` 参数，必须填 API 模型 ID，不是 DeepSeek 的版本展示名。
  `DeepSeek-V4.1-Flash-1017` 是版本说明；`deepseek-chat` 也是旧别名，当前官方 API 不再接受。
- 原先只有纯文本输入和提示文字，用户仍容易把“最新 V4.1 Flash”当成模型名填写。

### 12.2 修复

- 「模型」字段标签改为「模型（API model ID）」。
- 0.3.4 先尝试 `datalist` 建议；用户实测 Zotero 设置页不显示下拉箭头/建议列表。
- 0.3.5 改为显式 `<select id="zra-model-select">` + 可手填输入框：
  - 下拉选项：`deepseek-flash`、`deepseek-v4-pro`、`qwen-plus`。
  - 选择下拉项后写入输入框；输入框内容变化时同步下拉选中状态。
  - 0.3.5 当时保留手填能力；0.3.7 已移除独立输入框，改为单一模型下拉框 + “获取模型”，见第 14 节。
- 提示文字明确：DeepSeek 只接受 `deepseek-flash` / `deepseek-v4-pro`，
  `DeepSeek-V4.1-Flash-1017` 是版本名，不要填入。
- 保存和测试连接前校验官方 DeepSeek 模型 ID；不合法时直接给出中文修正提示，不发请求。
- 打开设置页时，如果保存的是官方 DeepSeek 且模型不是上述两个 ID，表单自动显示
  `deepseek-flash`，并提示点击保存。
- 服务端返回 `supported API model names` / `invalid model` 时，错误信息改为可读的
  “请填 API model ID，不要填版本名”。
- 修复提示文字中未加 `html:` 前缀的 `<code>` 被当成 XUL 元素、显示为整行色块的问题。

### 12.3 验证

- `node --check content/preferences.js`：通过。
- `preferences.xhtml` 片段 XML 解析：`XML_OK`。
- `tsc --noEmit`：通过。
- `node scripts/build.mjs`：0.3.5，bundle `145,885 B`，XPI `45,356 B`。
- XPI SHA256：`57204FDB3E2572DF0C76BDE0F85737C226A20E00C212B80619ECAF03EDBFE920`。
- 待实机确认：设置页模型下拉框是否显示，以及保存 `deepseek-flash` 后测试连接是否返回成功。

---

## 13. 0.3.6 Agnes AI 预设

### 13.1 配置

- 按用户提供的 Agnes AI 配置新增预设：
  - 服务名称：`Agnes AI`
  - 接口格式：OpenAI Compatible
  - Base URL：`https://apihub.agnes-ai.com/v1`
  - 默认模型：`agnes-2.0-flash`
- 模型下拉增加截图中的三个 model ID：
  - `agnes-2.0-flash` — Agnes 2.0 Flash — 编程/推理（256K ctx）
  - `agnes-1.5-flash` — Agnes 1.5 Flash — 通用对话
  - `agnes-2.5-flash` — Agnes 2.5 Flash — 最强编程/推理（512K ctx）
- 0.3.6 仍保留可手填输入框；0.3.7 起改为单一模型下拉框，见第 14 节。

### 13.2 UI 行为

- 服务预设选择「Agnes AI」后，自动填入服务名称、Base URL 和 `agnes-2.0-flash`；
  用户只需补 API Key。
- 0.3.6 时选择 Agnes 模型会写入模型输入框；0.3.7 起模型区只有一个下拉框，选中即作为当前模型。
- 插件同一时间使用一个模型；0.3.7 的“获取模型”按钮只读取服务商模型列表，不复制截图中的“多模型配置表 / 手动添加”管理界面。

### 13.3 验证

- `node --check content/preferences.js`：通过。
- `preferences.xhtml` 片段 XML 解析：`XML_OK`。
- `tsc --noEmit`：通过。
- `node scripts/build.mjs`：0.3.6，bundle `145,885 B`，XPI `45,516 B`。
- XPI SHA256：`0BDD7BA5533A6FE47842D604D83A6664EF87B22F5353DC91DADF0F44BDBA9CBE`。
- 待实机确认：Agnes AI 预设、三个模型下拉项、API Key 测试连接与划词翻译。

---

## 14. 0.3.7 单一模型下拉框 + 获取模型

### 14.1 UI 结构

- 设置页模型区只保留一个 `<html:select id="zra-model">`，移除 0.3.6 的独立模型输入框和 `zra-model-select`。
- 内置选项：
  - `deepseek-flash` — DeepSeek V4.1 Flash（1017）
  - `deepseek-v4-pro` — DeepSeek V4 Pro
  - `agnes-2.0-flash` / `agnes-1.5-flash` / `agnes-2.5-flash`
  - `qwen-plus` / `qwen-max` / `qwen-turbo` / `qwen-long`
- 服务预设切换时直接设置下拉值；保存的模型不在内置列表时动态插入 option，避免值丢失。
- 用户所说的“deepseek1017”映射到 `deepseek-flash`；`DeepSeek-V4.1-Flash-1017` 仍是版本名，不作为 API model ID。
- 插件同一时间只使用下拉框中的当前模型。

### 14.2 “获取模型”按钮

- 点击后调用 `GET {baseURL}/models`：
  - 先规范化 Base URL，去掉末尾 `/`；若以 `/chat/completions` 结尾则去掉，再追加 `/models`；已以 `/models` 结尾则不重复追加。
  - 请求头使用 `Authorization: Bearer <API Key>`。
  - 解析 `data.data` 或 `data.models`，读取字符串项或对象的 `id`，去重后动态追加到下拉框。
  - 保留当前选择；当前为空时选第一个；状态栏显示获取数量。
  - 404 显示“该服务没有 /models 接口，请直接从下拉框选择”；401/403 等沿用可读错误提示。
  - 请求期间禁用按钮，完成后恢复。
- 用户必须填写自己的 API Key；截图中的打码 Key 不会被复制或写入日志。
- 若服务商不支持 `/models`，内置列表仍可使用；用户不需要该按钮时可后续移除。

### 14.3 验证

- `node --check content/preferences.js`：通过。
- `preferences.xhtml` 片段 XML 解析：`XML_OK`。
- `tsc --noEmit`：通过。
- `node scripts/build.mjs`：0.3.7，bundle `145,885 B`，XPI `46,187 B`。
- XPI SHA256：`DFA7912377611A542972237D70B8063734A75DD732E0D5F4A53B77FB88FA6E31`。
- XPI `manifest.json` 版本：`0.3.7`。
- 待实机确认：单一模型下拉框显示、“获取模型”按钮、DeepSeek 1017 映射、Agnes 预设、API Key 测试连接与划词翻译。
