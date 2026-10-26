# M3 实现记录 — F3 全文解读、证据回跳与逐篇会话

- 版本：`0.4.4`
- 构建：`node scripts/build.mjs`
- 产物：`dist/zotero-reading-assistant.xpi`，`58,539 B`；bundle `197,295 B`
- SHA256：`082D9F519155741DAE7765F1175A08D53A9C671AE5C2AB25F7A4BEFCC5E6015C`
- 范围：F3 全文 ContextBuilder、四预设分析、自由追问、证据 ID/页码回跳、逐篇会话、阅读器浮动面板；0.4.3 增加 F3/F2 SSE 流式输出与真正 HTTP abort；0.4.4 增加 F2 术语表 UI、翻译 Prompt 注入与术语版本化缓存失效。
- UI：AI 回答使用安全 DOM Markdown 渲染（标题、粗体、列表、引用、代码），不执行模型返回的 HTML；0.4.1 修复面板显示原始 `**`/`*` 的问题；0.4.2 调整中文排版（13px/1.75、标题 14px、列表/段落 8px 留白、行内证据引用弱化、面板宽 430px）；0.4.3 增加「停止生成」/「停止」按钮与流式增量渲染；0.4.4 设置页增加术语表文本区与实时条数。

---

## 1. 新增与修改

```
src/
  document/text.ts          buildContext()：全文分块、预算裁剪、证据 ID
  ai/prompts.ts             ANALYSIS_PRESETS、buildAnalysisMessages()
  ai/analysis.ts            AnalysisResult、EvidenceRef、parseEvidence()
  store/conversationStore.ts 逐篇会话 JSON、原子写、80 条上限
  ui/analysisPanel.ts       renderToolbar 按钮 + 阅读器浮动面板
  plugin.ts                 handleAnalysis()、openEvidence()、注册/注销
  selfcheck.ts              增加 api.Reader.open 检查
```

新增数据文件：`<Zotero 数据目录>/zotero-reading-assistant/conversations/<paperKey>.json`。

---

## 2. 全文 ContextBuilder

`DocumentTextService.buildContext(attachmentItemID, maxChars = 60000)`：

- 通过 `Zotero.SDT.getReader()` 读取全部页面和块。
- 每块生成证据 ID：`p{pageIndex+1}:b{blockIndex}`。
  - 页码从 1 开始，便于模型引用和用户阅读。
  - `pageIndex` 内部保持 0-based，供 `Zotero.Reader.open()` 使用。
- 每块带 `sectionHeading`，由最近的上一个标题块推断。
- 超过预算时按以下顺序选择：
  1. 前两页；
  2. 最后两页；
  3. 摘要、引言、方法、结果、讨论、结论、局限等关键节；
  4. 剩余预算按原文顺序填充。
- 返回 `text`、`blocks`、`pageCount`、`totalChars`、`includedChars`、`truncated`、`fingerprint`。
- 预算下限 4,000、上限 200,000 字符；默认 60,000。

---

## 3. 四预设与 Prompt

`src/ai/prompts.ts` 新增：

| key | 标签 | 目标 |
| --- | --- | --- |
| `summary` | 速读摘要 | 研究问题、数据、方法、主要结果、结论 |
| `methods` | 方法拆解 | 数据来源、样本、变量、步骤、指标、假设与偏差 |
| `findings` | 结果与证据 | 数字、效应方向、比较对象、统计显著性 |
| `critique` | 局限与批判 | 外部/内部效度、测量限制、基线、结论边界 |

`buildAnalysisMessages()` 强制：

- 只能依据 `paper.context` 回答，不能使用论文外知识。
- 每个事实性结论、数字或作者观点后必须附 `[pN:bM]`。
- 没有证据时明确说“本文没有提供足够证据”。
- 区分作者明确陈述与模型推断。
- 最多携带最近 8 条会话消息，每条截断到 4,000 字符。

---

## 4. 阅读器浮动面板

`src/ui/analysisPanel.ts`：

- 注册 `Zotero.Reader.registerEventListener("renderToolbar", handler, pluginID)`。
- 在 PDF 阅读器工具栏追加「AI 阅读」按钮。
- 点击后在阅读器 iframe 内创建 fixed 面板，包含：
  - 四个预设按钮；
  - 会话列表；
  - 自由提问输入框；
  - 「提问」「清空会话」「设置」；
  - 状态行。
- 助手消息中的 `[pN:bM]` 会解析成证据 chip；点击调用：

```ts
Zotero.Reader.open(attachmentItemID, { pageIndex })
```

`pageIndex` 是 `Zotero.Reader.open` 的第二个位置参数，0-based；不是嵌套在 `{ location: ... }` 中。

- 面板随阅读器标签页销毁；会话数据在插件数据目录，重新打开仍可加载。
- `onShutdown()` 调用 `unregisterAnalysisToolbar()`。

---

## 5. 逐篇会话

`src/store/conversationStore.ts`：

- 按论文父条目 key 保存：`conversations/<paperKey>.json`。
- 文件含 `schemaVersion`、`paper`、`attachmentKey`、`lastSequence`、`updatedAt`、`messages`。
- 消息字段：`id`、`role`、`content`、`at`、`preset`、`evidence`。
- 原子写、进程内串行锁、最多 80 条。
- 「清空会话」只清空会话文件，不删除阅读事件日志。

---

## 6. 请求流程

```
点击预设 / 输入问题
  -> analysisPanel.send()
  -> Plugin.handleAnalysis()
      -> readAIConfig() / isAIConfigured()
      -> DocumentTextService.buildContext()
      -> loadConversation()（最近 8 条）
      -> buildAnalysisMessages()
      -> 先持久化 user 消息（失败不阻塞）
      -> chatStream(config, messages, {
           timeoutMs: 120000,
           maxTokens: >=2400,
           onText: 增量答案,
           cancelToken: 面板「停止生成」/关闭时触发
         })
      -> 每个 SSE chunk 调用 onText(fullText)
      -> 完整结束后 parseEvidence(result.text, context.blocks)
      -> 持久化 assistant 消息 + evidence（取消时不写）
      -> appendReadingEvent("ai.analysis")
  -> 面板增量渲染 Markdown，结束后追加证据 chip
```

证据解析只保留当前 context 中真实存在的 block，避免模型编造 `[p99:b0]` 后生成可点击的假证据。

### 流式与取消实现

- `src/ai/provider.ts` 的 `chatStream()` 请求 `stream: true`，通过 `Zotero.HTTP.request` 的 `requestObserver` 挂 `xmlhttp.onprogress`，从 `responseText` 增量解析 `data:` 行。
- `src/ai/cancel.ts` 提供 `CancelToken`；UI 点击「停止」时调用 `cancel()`，provider 通过 `cancellerReceiver` 调用 Zotero 的 XHR cancel 函数，真正中止网络请求。
- `analysisPanel.ts` 用 `requestAnimationFrame` 节流重绘增量 Markdown；取消或失败时移除未完成的 assistant 行，不写入会话。
- `reader.ts` 翻译弹窗在流式阶段只更新文本，完成前保持「复制/存为批注」禁用；取消、弹窗消失或阅读器标签关闭时 abort。
- 兼容非 SSE 服务：若响应没有 `data:` 事件，则按普通 JSON 完整响应解析并一次性显示。

---

## 7. 验收清单

安装 `0.4.4` 后：

- [ ] 打开带 PDF 的文献，阅读器工具栏出现「AI 阅读」。
- [ ] 点「速读摘要」，回答逐段出现，而不是长时间空白后一次性出现。
- [ ] 生成中点「停止生成」，请求中止，状态显示「已停止生成」，未完成回答不写入会话。
- [ ] 生成中关闭面板或关闭阅读器标签，网络请求中止（可在 Zotero 调试输出/网络面板确认）。
- [ ] 点「速读摘要」，面板显示带 `[pN:bM]` 的回答。
- [ ] AI 回答中的 `##`、`**粗体**`、`*` 列表显示为格式，而不是原始 Markdown 符号。
- [ ] 正文行距、标题层级、列表间距明显比 0.4.1 疏朗，长段落不显拥挤。
- [ ] 依次点「方法拆解」「结果与证据」「局限与批判」，均能返回。
- [ ] 输入自由问题，例如“这篇论文的主要局限是什么？”，能回答。
- [ ] 点击证据 chip，阅读器跳到对应页；页码为 0 的首页也能跳。
- [ ] 关闭再打开同一 PDF，会话仍在。
- [ ] 点「清空会话」，面板清空，重开不恢复。
- [ ] 划词翻译时译文逐段出现；点「停止」后请求中止，复制/存批注保持禁用。
- [ ] 翻译生成中关闭弹窗或切换阅读器标签，请求中止。
- [ ] 设置页「术语表」粘贴 `photovoltaic => 光伏`，计数显示 1；保存后划词翻译使用该译法。
- [ ] 修改术语后再次翻译，旧翻译缓存不再命中（状态不显示「已从缓存加载」）。
- [ ] 清空术语表并保存，翻译恢复普通行为。
- [ ] 未配置 API Key 时，提问提示先配置，不崩溃。
- [ ] 工具 → 自检：`register.analysis`、`api.Reader.open` 通过；`ai.config.detail.glossaryCount` 反映条数。
- [ ] 打开插件数据目录，能看到 `conversations/<paperKey>.json`。

---

## 8. 已知限制

- F3 已在 `0.4.3` 实机验收通过；`0.4.4` 术语表 UI 仍需安装后实机复测。
- 术语表只注入简体中文划词翻译 Prompt，不影响 F3 全文解读；English 目标暂不使用术语表。
- 流式输出依赖服务商支持 OpenAI 兼容 SSE；若服务商忽略 `stream: true` 返回普通 JSON，插件会回退解析完整响应。
- 全文超过预算会截断，`truncated=true`；长论文的中间章节可能只保留关键节。
- PDF 必须已有 SDT 索引；没有索引时提示先完成索引。
- 面板只在阅读器工具栏渲染时注入；插件安装前已打开的阅读器可能需要重新打开 PDF 才会出现按钮。
- API Key 仍以明文存于 Zotero pref；不会进入插件数据目录、日志或自检报告。
