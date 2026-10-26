# Zotero 文献阅读助手 — F2 翻译 + F3 全文阅读

当前版本 **0.4.4**：在 M1 的期刊指标与六色批注、F2 划词翻译之上，加入 **F3 全文解读**：全文 ContextBuilder、四预设分析、自由追问、证据 ID/页码回跳、逐篇会话和阅读器浮动面板。0.4.4 增加 **术语表 UI**：设置页按行维护 `原文 => 译文`，翻译时作为强制译法注入 Prompt；术语内容变化会通过内容版本自动使旧翻译缓存失效。0.4.3 为 F3 分析和 F2 翻译加入 **SSE 流式输出**与 **真正 HTTP abort**：回答/译文逐段出现，面板和翻译弹窗都有「停止」按钮；关闭面板、关闭阅读器标签或弹窗消失时会中止在途请求。0.4.2 优化 AI 面板排版：正文 13px/1.75、标题加大、列表与段落留白、行内证据引用弱化，面板宽度增至 430px。0.4.1 修复 AI 面板把 Markdown 原样显示为 `**`/`*` 的问题，回答改为安全 DOM 渲染（不执行模型返回的 HTML）。0.3.7 将模型选择合并为单一下拉框，并增加“获取模型”按钮（请求服务商 `/models`，失败时保留内置列表）；0.3.6 增加 Agnes AI 预设与三个模型；0.3.5 将不显示的模型 `datalist` 改为显式下拉框；0.3.3 修复 Zotero 原生 `.selection-popup` 的 198px 宽度上限，弹窗扩到 560px。F3 已在 0.4.3 实机验收通过；0.4.4 的术语表 UI 待安装后复测。

## 当前能力

| 模块 | 能力 |
| --- | --- |
| F1 期刊指标 | 「指标」列、条目面板详情、本地 JSON/CSV 导入、EasyScholar、永久缓存与失败退避 |
| F4 六色批注 | PDF 划词创建原生高亮，写入 `阅读/*` 语义标签；同位置合并；撤销标签只删语义标签 |
| F2 划词翻译 | 选中即弹窗；自动/手动翻译；SSE 流式译文；停止/中止；目标语言简体中文/English；术语表强制译法；复制；存为批注；本地缓存 |
| F3 全文解读 | 阅读器「AI 阅读」浮动面板；速读摘要/方法拆解/结果与证据/局限与批判；自由追问；SSE 流式回答；停止生成；`[pN:bM]` 证据回跳；逐篇会话 |
| AI 设置 | Zotero 设置 → 文献阅读助手；DeepSeek/Agnes/千问预设；单一模型下拉框 + “获取模型”；DeepSeek ID 校验；MiMo 等自定义服务；术语表；测试连接；Key 只存本机 |

## AI 设置（首次使用）

1. Zotero → 设置 → **文献阅读助手**，或工具 → 文献阅读助手 → **AI 设置…**。
2. 选择预设：
   - **DeepSeek（默认）**：`https://api.deepseek.com/v1`，模型 `deepseek-flash`（最新 V4.1 Flash）；需要更强推理可选 `deepseek-v4-pro`。
   - **Agnes AI**：`https://apihub.agnes-ai.com/v1`；模型 `agnes-2.0-flash`（编程/推理，256K）、`agnes-1.5-flash`（通用对话）、`agnes-2.5-flash`（最强编程/推理，512K）。
   - **通义千问**：DashScope 兼容模式，模型 `qwen-plus`。
   - **自定义**：填入 MiMo / 其他 OpenAI 兼容服务的 Base URL、模型名。
3. 填入 API Key → **测试连接** → 成功后 **保存**。
4. 可选：在「术语表」区域按行填写 `原文 => 译文`，保存后简体中文划词翻译会优先使用这些译法（English 目标暂不使用术语表）。
5. 打开 PDF，选中文字 → 弹窗里点「翻译」，或等待约 450 ms 自动翻译。

Base URL 填服务根地址即可（插件自动补 `/chat/completions`），也可以粘贴完整接口地址。

设置键前缀：`extensions.zotero.zotero-reading-assistant.ai.`；API Key 不写入插件数据目录、日志或自检报告。

## F2 翻译行为

- 通过 `Zotero.SDT.getReader()` 读取 PDF 结构化全文，定位选区所在页/块，并带上章节标题、前后文和当前段落窗口。
- Prompt 只翻译选文，保留数字、单位、公式、变量名、引用标记、否定词和比较级。
- 设置页「术语表」按行维护 `原文 => 译文`；命中词条会作为强制译法注入简体中文翻译 Prompt，只影响 F2，不影响 F3；English 目标不使用术语表。
- 同一选区、同一上下文、同一 Provider/模型/Prompt 版本/术语表版本命中本地缓存，状态显示「已从缓存加载」。
- 非缓存请求使用 SSE 流式输出，译文边生成边显示；「停止」会调用底层 XHR abort，而不是只丢弃晚到结果。
- 快速换选区时用请求号丢弃晚到结果，不会把旧译文写进新弹窗；弹窗消失或阅读器标签关闭时会中止在途请求。
- 「存为批注」创建原生高亮，comment 写入 `【译文·目标语言】`，标签为 `翻译`；同位置已有高亮时追加，不重复创建。

## F3 全文阅读行为

- 打开 PDF 后，阅读器工具栏出现「AI 阅读」；点击打开右侧浮动面板。
- 四个预设：速读摘要、方法拆解、结果与证据、局限与批判；也可以直接输入问题。
- 全文通过 `Zotero.SDT.getReader()` 读取，按 60,000 字符预算保留前两页、最后两页和摘要/方法/结果/讨论/结论等关键节。
- 回答中的 `[pN:bM]` 是证据 ID；点击 chip 会调用 `Zotero.Reader.open(attachmentItemID, { pageIndex })` 跳到对应页。
- 回答使用 SSE 流式输出；「停止生成」会中止底层 XHR。关闭面板或阅读器标签也会中止在途请求。
- 会话按论文父条目保存在 `conversations/<paperKey>.json`；关闭再打开 PDF 仍可继续，最多保留 80 条。取消的请求不会写入 assistant 消息。
- 面板里的「清空会话」只清空会话，不删除阅读事件日志。

## 数据位置

`<Zotero 数据目录>/zotero-reading-assistant/`

- `metrics.json`：期刊指标、身份、条目绑定、失败退避、导入表。
- `readings/<paperKey>.json`：按论文追加的阅读事件（含 `ai.translation`、`ai.translation_saved`、`ai.analysis`）。
- `conversations/<paperKey>.json`：F3 逐篇 AI 会话，最多 80 条，原子写。
- `cache/translations.json`：翻译缓存（最多 500 条，原子写，不含 API Key）。

工具菜单「打开插件数据目录」可直接定位。

## 期刊指标导入格式

JSON（也接受裸数组）：

```json
{
  "source": "JCR 2024",
  "metricsYear": 2024,
  "records": [
    { "name": "Nature", "issn": "0028-0836", "jif": 50.5, "jcr": "Q1", "cas": 1, "casMinor": 2, "jci": 2.1 }
  ]
}
```

CSV（表头不区分大小写，忽略空格/下划线/连字符）：

```csv
name,issn,jif,jifYear,jcr,cas,casMajor,casMinor,source
Nature,0028-0836,50.5,2024,Q1,1,1,2,JCR 2024
```

必需：`name`（或 `journal` / `期刊`）或 `issn`；且至少一个指标字段。其余记录会跳过并在导入结果中计数。

样例（非真实数据，仅用于验收流程）：`samples/metrics-sample.json`、`samples/metrics-sample.csv`。

## 构建与安装

```powershell
node scripts/build.mjs
```

产物：`dist/zotero-reading-assistant.xpi`（0.4.4，`58,539 B`，bundle `197,295 B`，SHA256 `082D9F519155741DAE7765F1175A08D53A9C671AE5C2AB25F7A4BEFCC5E6015C`）

Zotero → 工具 → 插件 → 齿轮 → Install Plugin From File… → 选择 XPI → 重启 Zotero。

类型检查：

```powershell
node "D:\Project\AI\插件\zotero-research-copilot\node_modules\typescript\bin\tsc" --noEmit -p .
```

## 自检

工具 → 文献阅读助手 → **自检**。报告写入 `%TEMP%\zra-m0-report-latest.json`。

- 未配置 API Key 时，`ai.apiKey` 会失败，这是预期；其余 AI/API/注册项应通过。
- 配置 Key 后，`ai.config`、`ai.apiKey`、`ai.translationCache`、`register.prefs` 均应通过。
- F3 相关：`register.analysis`、`api.Reader.open` 应通过；`pdf.sdtRead` 需要至少一篇有结构化全文索引的 PDF，没有时先让 Zotero 完成索引。

## 已知限制与下一步

- **F3 已在 0.4.3 实机验收通过**：四预设、全文 ContextBuilder、证据回跳、逐篇会话和浮动面板均正常。
- 全文超过 60,000 字符预算会截断，`truncated=true`；长论文的中间章节可能只保留关键节。
- 流式输出依赖服务商支持 OpenAI 兼容 SSE；若服务商忽略 `stream: true` 返回普通 JSON，插件会自动回退解析完整响应。
- 术语表只影响简体中文划词翻译，不影响 F3；English 目标不使用术语表。源语言仍固定 `auto`，目标语言只有简体中文/English。
- PDF 必须有 SDT 索引；没有索引会提示先完成索引。
- 0.4.3 已用 DeepSeek `deepseek-flash` 实测划词翻译、流式输出、停止生成和关闭中止。安装 0.4.4 后请重点复测设置页术语表保存/计数、术语注入翻译、修改术语后缓存失效，以及原有 F3 面板、四预设、自由追问、证据跳页、会话持久化、模型下拉框/“获取模型”/翻译/缓存/存批注。

详细实现与验收清单见 `docs/M2_IMPLEMENTATION.md` 和 `docs/M3_IMPLEMENTATION.md`；M0/M1 记录见 `docs/M0_VALIDATION.md`、`docs/M1_IMPLEMENTATION.md`。
