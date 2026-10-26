# M1 实现记录 — F1 期刊指标 + F4 六色语义批注

- 版本：`0.2.1`
- 构建：`node scripts/build.mjs`
- 产物：`dist/zotero-reading-assistant.xpi`（25,968 B）
- SHA256：`8AC0F74920A663C08F35392E32C7C13BD83A37B0006DE76E31856C518458D2D9`
- 目标（规格 §13.1）：F1、F4 核心用例通过，**离线重启仍可用**。

---

## 1. 代码结构

```
src/
  adapter/paths.ts          插件数据目录 + 原子 JSON 读写
  annotations/
    semantics.ts            六色语义标签定义（颜色 / 标签 / 命名空间）
    service.ts              原生高亮创建、标签合并、撤销标签
  store/readingStore.ts     按论文追加的阅读事件日志（M1 子集）
  metrics/
    types.ts                指标状态机、快照、身份、导入表
    identity.ts             ISSN/刊名归一化、Extra 白名单解析
    store.ts                单文件 JSON 存储（原子写、串行化）
    providers.ts            本地导入 Provider + EasyScholar Provider
    service.ts              缓存、队列、优先级、退避、限速、展示
    importFile.ts           FilePicker + JSON/CSV 解析与校验
  ui/
    column.ts               「指标」列（只读缓存）
    section.ts              条目面板：详情 / 查询刷新 / 导入 / 密钥
    menu.ts                 工具菜单 4 项
    reader.ts               划词弹窗：六色 + 撤销标签 + 记录 + 诊断
  plugin.ts                 生命周期、注册、菜单动作、自检
```

数据目录：`<Zotero 数据目录>/zotero-reading-assistant/`
- `metrics.json`：`identities` / `snapshots` / `bindings` / `attempts` / `importTable`
- `readings/<paperKey>.json`：`schemaVersion` / `paper` / `attachmentKey` / `lastSequence` / `events[]`

---

## 2. F1 数据与查询

### 2.1 期刊身份

- 优先用 ISSN：`ISSN` 字段（逗号/分号/空格分隔）+ `Extra` 中的 `ISSN:` 行。
- 无 ISSN 时用归一化刊名：NFKC、小写、`& → and`、去标点、压缩空白。
- 身份 ID：`issn:XXXX-XXXX` 或 `name:<normalized>`。
- 条目绑定键：`<libraryID>:<itemKey>`。

### 2.2 来源优先级

1. **条目 Extra**（白名单字段，只读，不回写）
2. **本地导入** JSON/CSV
3. **EasyScholar**（需要 SecretKey）

快照按 `${journalIdentityId}|${provider}` 存储；展示时按 `extra > local_import > easyscholar` 取第一条。成功快照永久保留，失败不会清除旧值。

### 2.3 状态机

`not_requested / queued / success / partial / not_found / ambiguous / network_error / auth_error / rate_limited / not_applicable`

- 列显示：`Q1 · IF 5.8`、`未查询`、`查询中…`、`未收录`、`待确认`、`失败`、`待配置`、`限速`。
- 失败退避：1 分钟 → 5 分钟 → 30 分钟；成功或重新导入后清除。
- 未配置任何来源时列显示空白，条目面板给出配置提示。

### 2.4 队列与限速

- 仅**选中条目**（`onItemChange` / `onRender`）或**工具菜单批量查询**入队；列渲染不触发网络，安装后不扫描文库。
- 队列串行处理；同一 `paperKey` 去重。
- EasyScholar 请求间隔 ≥600 ms（官方限制 2 次/秒），超时 12 s。
- 写盘使用 `.tmp` + `IOUtils.move` 原子替换；`saveOutcome()` 会 **await 写盘**，保证提示出现前缓存已落地。

### 2.5 导入格式

JSON：`{ source, metricsYear, records: [...] }` 或裸数组。
CSV：表头大小写不敏感，忽略空格/下划线/连字符。

字段别名：
`name / journal / journalName / publicationTitle / 期刊 / 期刊名称 / 刊名`、
`issn`、`eissn`、`jif / impactFactor / 影响因子`、`jifYear`、`jif5 / fiveYearImpactFactor`、
`jci`、`jcr / quartile / 分区 / jcr分区`、`jcrYear`、
`cas / casZone / 中科院 / 中科院分区`、`casMajor / 大类`、`casMinor / 小类`、`casEdition`、
`source / 来源`、`year / metricsYear / 年份`。

校验：必须有刊名或 ISSN，且至少一个指标字段；无效记录跳过并计数。

**测试样例（非真实数据，仅用于验收导入流程）**

- `samples/metrics-sample.json`
- `samples/metrics-sample.csv`

样例包含 3 条记录，第一条为 `Atmospheric Chemistry and Physics`（ISSN `1680-7324`），因此当前打开的 ACP 论文可直接命中。`source` 标记为「测试样例（非真实数据）」，导入后条目面板会显示该来源。

---

## 3. F4 六色语义批注

标签（命名空间 `阅读/`）：

| key | 标签 | 颜色 |
| --- | --- | --- |
| background | `阅读/研究背景` | `#ffd400` |
| method | `阅读/研究方法` | `#ff6666` |
| conclusion | `阅读/关键结论` | `#5fb236` |
| mechanism | `阅读/原理机制` | `#2ea8e5` |
| doubt | `阅读/存疑` | `#a28ae5` |
| cite | `阅读/待引用` | `#f19837` |

行为：

1. 点击颜色 → 在当前位置查找高亮（位置 JSON 全等，失败时回退到 `text + sortIndex + pageLabel`）。
2. 不存在 → `Zotero.DataObjectUtilities.generateKey()` + `Zotero.Annotations.saveFromJSON()` 创建**原生高亮**，写入语义标签，颜色取语义色。
3. 已存在 → 读取旧标签集合，加入语义标签后写回（`setTags()` 是整体替换，必须先读后写）。同标签重复点击为 `unchanged`。
4. 「撤销标签」→ 仅移除 `阅读/*` 标签；保留批注本身与用户标签。
5. 每次操作追加事件到 `readings/<paperKey>.json`：
   - `annotation.semantic_tag`（action / annotationKey / tags / text 前 200 字）
   - `annotation.tags_cleared`（removed / remaining tags）
   - `action = unchanged` 的重复点击不写事件，避免日志被空操作淹没。

---

## 4. 源码级依据

| API / 行为 | 依据 |
| --- | --- |
| `onMainWindowLoad` 只对新窗口触发；运行中安装需主动遍历 `Zotero.getMainWindows()` | `plugins.js:93-124`（M0 实测确认） |
| 列 `width` 必须是字符串 | `itemTreeManager.js:96-99`（M0 实测确认） |
| 列 `dataProvider` 返回字符串 | `itemTreeManager.js:53-56, 253-257` |
| `DataObjectUtilities.generateKey()` | `dataObjectUtilities.js:72` |
| `attachment.getAnnotations(includeTrashed?, asIDs?)` 默认返回 item 对象 | `item.js:4667` |
| `Annotations.saveFromJSON(attachment, json, saveOptions)`；写 `annotationSortIndex`；缺 key 时自动生成 | `annotations.js:214, 245, 282, 311` |
| Zotero 侧保存阅读器批注：`annotation.key = annotation.id` → `saveFromJSON` | `reader.js:288-334` |
| 划词批注对象 `{type, color, sortIndex, pageLabel, position, text}` | reader bundle `getAnnotationFromRange`（提取副本第 57,873 行附近） |
| `HTTP.request` 支持 `timeout`（默认 30 s） | `http.js:207-208, 416-421` |
| `FilePicker`：`init(win, title, mode)` / `show()` 返回常量 / `file` 返回路径字符串 | `content/zotero/modules/filePicker.mjs`；用法见 `zoteroPane.js:27, 1557, 6618` |
| `Zotero.Prefs.set(pref, value, true)` | Zotero 全局偏好接口 |
| `Zotero.File.reveal(dir)` | `dataDirectory.js:625` |
| EasyScholar 接口契约与字段 | <https://www.easyscholar.cc/console/user/open>（`sciif / sci / jci / sciif5 / sciUp / sciUpSmall / sciUpTop / sciBase / sciwarn`，限速 2 次/秒） |

---

## 5. 实机验收清单

### F1

- [ ] 安装 0.2.1 并重启，工具菜单出现 4 项，条目面板出现「期刊指标」。
- [ ] 工具 → 导入期刊指标文件… → 选择 `samples/metrics-sample.json`（或 `.csv`）；提示 3 条记录、0 条跳过。
- [ ] 选中 ACP 论文 → 工具 → 查询所选文献的期刊指标 → 「指标」列显示 `Q1 · IF 9.9`，条目面板来源为「测试样例（非真实数据）」。
- [ ] 条目面板显示 JIF / JCR / 中科院 / JCI 与来源。
- [ ] **重启 Zotero（可断网）后指标仍显示**（读缓存）。
- [ ] 在条目 Extra 加入 `JIF: 9.9` 与 `JCR: Q1` → 查询 → 显示 9.9（Extra 优先）。
- [ ] 无配置时不报错，列留空；错误密钥显示「待配置」，1 分钟后才允许重试。

### F4

- [ ] PDF 划词 → 弹窗出现六色按钮 + 撤销标签/记录/诊断。
- [ ] 点击「研究方法」→ 出现原生高亮，标签为 `阅读/研究方法`。
- [ ] 同一选区再点「关键结论」→ 不新建批注，标签变为两条。
- [ ] 手动给该批注加自定义标签 → 再点颜色 → 自定义标签保留。
- [ ] 「撤销标签」→ `阅读/*` 消失，高亮与自定义标签保留。
- [ ] `readings/<paperKey>.json` 出现对应事件；可点弹窗「数据目录」或工具 → 打开插件数据目录直接查看。
- [ ] 重启后批注与标签仍在（原生 Zotero 批注）。

---

## 6. 已知限制 / 留给后续里程碑

- 在线 Provider 目前只有 EasyScholar；Clarivate JIF、中科院官方、Crossref、OpenAlex 在 M2。
- EasyScholar 只按刊名匹配，不返回指标年度；同名刊可能误配，状态会落为 `partial` / `not_found`。
- 尚未提供偏好设置页；密钥存于 `extensions.zotero.zotero-reading-assistant.easyscholarKey`，入口在条目面板。
- `ambiguous` 目前仅由本地导入产生，尚无人工确认 UI。
- 跨页选区是否拆分为多条批注、同页重复文本的位置区分，需实机确认（M0 已知风险）。
- 群组库深链、完整 ReadingDossier、AI 总结属于 M2/M3。
- 批注创建路径已做源码级核对，但尚未在本机 Zotero 中实机点击验证；验收清单第 2–5 项用于确认。

---

## 7. 0.2.1 修订

- `ui.menuNode` 自检改为「注册成功即通过」：Zotero 的工具菜单节点在首次打开菜单时才创建，未打开时 `count=0` 会被误判为失败（此前显示 19/20）。
- 阅读器弹窗的「记录」按钮改为「数据目录」，点击直接打开 `zotero-reading-assistant/`（含 `readings/` 与 `metrics.json`）。
- 弹窗状态行移到按钮上方，点击后立刻看到「已高亮 / 已添加标签 / 已存在」。
- `action = unchanged` 的重复点击不再写入 reading 事件，日志只保留 `created` / `updated` / `tags_cleared`。
- CSV 导入剥离 UTF-8 BOM，兼容 Excel 导出的 CSV。
- 新增 `samples/metrics-sample.json` 与 `samples/metrics-sample.csv` 验收样例。
