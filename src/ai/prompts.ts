import { glossaryPromptBlock, type GlossaryEntry } from "./glossary";
import type { ChatMessage } from "./types";

/**
 * Prompt versions are part of the translation cache key. Bump them whenever
 * the instructions or output shape change.
 */
export const TRANSLATION_PROMPT_VERSION = 1;

export const SOURCE_LANGUAGE_AUTO = "auto";

export const TARGET_LANGUAGES = [
  { code: "zh-CN", label: "简体中文" },
  { code: "en", label: "English" },
] as const;

export interface TranslationPromptInput {
  selectedText: string;
  contextText: string;
  sectionHeading: string;
  sourceLanguage: string;
  targetLanguage: string;
  /** User-defined term pairs. Empty/undefined keeps the base prompt unchanged. */
  glossary?: GlossaryEntry[];
}

const TRANSLATION_SYSTEM = [
  "你是学术论文翻译助手。你的唯一任务是翻译用户提供的 selection 字段。",
  "规则：",
  "1. 只翻译 selection；context 仅用于消歧，不得翻译、复述或总结 context。",
  "2. 保留数字、单位、公式、变量名、引用标记（如 [12]、(Smith et al., 2020)）、否定词、比较级和限定强度。",
  "3. 不添加原文没有的结论、评价或解释。",
  "4. 术语按领域惯例翻译；没有把握的专有名词保留原文。",
  "5. 只输出译文本身，不要输出“译文：”之类的前缀，也不要输出 Markdown 代码块。",
].join("\n");

/**
 * The user payload is JSON, not XML-ish delimiters, so a PDF that contains
 * `</selection>` or angle brackets cannot break the instruction boundary.
 */
export function buildTranslationMessages(input: TranslationPromptInput): ChatMessage[] {
  const payload = {
    task: "translate_selection",
    sourceLanguage: input.sourceLanguage || SOURCE_LANGUAGE_AUTO,
    targetLanguage: input.targetLanguage || "zh-CN",
    section: input.sectionHeading || "",
    context: input.contextText || "",
    selection: input.selectedText,
  };
  return [
    {
      role: "system",
      content: TRANSLATION_SYSTEM + glossaryPromptBlock(input.glossary || []),
    },
    {
      role: "user",
      content:
        "请翻译下面 JSON 中 selection 字段的内容。context 只是参考，不要翻译它。\n\n"
        + JSON.stringify(payload, null, 2),
    },
  ];
}

export const ANALYSIS_PROMPT_VERSION = 1;

export type AnalysisPresetKey = "summary" | "methods" | "findings" | "critique";

export interface AnalysisPreset {
  key: AnalysisPresetKey;
  label: string;
  instruction: string;
}

/** Four reading modes from the F3 plan. Keep labels short for the popup. */
export const ANALYSIS_PRESETS: AnalysisPreset[] = [
  {
    key: "summary",
    label: "速读摘要",
    instruction:
      "用 5–8 条要点概括：研究问题、数据/样本、方法、主要结果、作者结论。"
      + "先给一段 2–3 句的总览，再列要点。",
  },
  {
    key: "methods",
    label: "方法拆解",
    instruction:
      "拆解研究设计与方法：数据来源、样本量、变量/分组、实验或建模步骤、评价指标、统计/验证方式。"
      + "指出方法上的关键假设和可能的选择偏差。",
  },
  {
    key: "findings",
    label: "结果与证据",
    instruction:
      "提炼主要发现，优先保留具体数字、效应方向、比较对象和统计显著性。"
      + "每条发现都必须附上原文证据标记；不要把作者的推测写成已验证结果。",
  },
  {
    key: "critique",
    label: "局限与批判",
    instruction:
      "从审稿人视角检查：外部效度、内部效度、样本/测量限制、基线是否公平、结论是否超出证据。"
      + "明确区分“作者承认的局限”和“你根据原文推断的局限”。",
  },
];

export function analysisPreset(key: string): AnalysisPreset | null {
  return ANALYSIS_PRESETS.find((preset) => preset.key === key) || null;
}

export interface AnalysisPromptInput {
  paperTitle: string;
  contextText: string;
  question: string;
  preset: AnalysisPreset | null;
  history: ChatMessage[];
}

const ANALYSIS_SYSTEM = [
  "你是严谨的学术论文阅读助手。你只能依据用户提供的 paper.context 回答，不能使用外部知识或凭记忆补充。",
  "证据规则：",
  "1. paper.context 中每个段落前的 [pN:bM] 是该段落的证据 ID；N 是从 1 开始的页码，M 是页内块号。",
  "2. 每个事实性结论、数字或作者观点后，必须附上至少一个原文中的证据 ID，例如 [p4:b2]。",
  "3. 如果原文没有足够证据，直接说“本文没有提供足够证据”，不要猜测。",
  "4. 区分“作者明确陈述”和“你的推断”；推断必须标注为推断。",
  "输出规则：",
  "- 默认用简体中文；问题使用其他语言时跟随问题。",
  "- 可用短标题和项目符号，但不要输出 Markdown 代码块。",
  "- 不要复述整段原文；提炼与问题相关的信息。",
  "- 不要编造页码、block 号、数字、引用或作者结论。",
].join("\n");

export function buildAnalysisMessages(input: AnalysisPromptInput): ChatMessage[] {
  const history = (Array.isArray(input.history) ? input.history : [])
    .filter((message) => message && (message.role === "user" || message.role === "assistant"))
    .slice(-8)
    .map((message) => ({
      role: message.role,
      content: String(message.content || "").slice(0, 4000),
    }));
  const payload = {
    task: input.preset ? "analyze_paper" : "answer_paper_question",
    paper: {
      title: input.paperTitle || "",
      context: input.contextText || "",
    },
    preset: input.preset
      ? {
        key: input.preset.key,
        label: input.preset.label,
        instruction: input.preset.instruction,
      }
      : null,
    question: input.question || "",
    conversation: history,
  };
  return [
    { role: "system", content: ANALYSIS_SYSTEM },
    {
      role: "user",
      content:
        "请根据下面 JSON 中的 paper.context 完成分析或回答问题。"
        + "每个结论都要带 [pN:bM] 证据标记；不要使用 context 之外的知识。\n\n"
        + JSON.stringify(payload, null, 2),
    },
  ];
}
