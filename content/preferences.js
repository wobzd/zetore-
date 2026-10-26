/*
 * Settings pane for Zotero 文献阅读助手.
 *
 * Loaded by Zotero.PreferencePanes.register() (see src/plugin.ts). This file
 * is plain JS on purpose: preference-pane scripts run in the preferences
 * window, outside the plugin bundle sandbox. It only touches Zotero.Prefs and
 * Zotero.HTTP, and never logs the API key.
 */
(function () {
  "use strict";

  var PREFIX = "extensions.zotero.zotero-reading-assistant.ai.";
  var KEYS = {
    providerName: PREFIX + "providerName",
    baseURL: PREFIX + "baseURL",
    apiKey: PREFIX + "apiKey",
    model: PREFIX + "model",
    temperature: PREFIX + "temperature",
    maxTokens: PREFIX + "maxTokens",
    autoTranslate: PREFIX + "autoTranslate",
    glossary: PREFIX + "glossary"
  };

  var MAX_GLOSSARY_ENTRIES = 200;
  var MAX_TERM_LENGTH = 200;

  var PRESETS = {
    deepseek: {
      providerName: "DeepSeek",
      baseURL: "https://api.deepseek.com/v1",
      model: "deepseek-flash"
    },
    agnes: {
      providerName: "Agnes AI",
      baseURL: "https://apihub.agnes-ai.com/v1",
      model: "agnes-2.0-flash"
    },
    qwen: {
      providerName: "通义千问",
      baseURL: "https://dashscope.aliyuncs.com/compatible-mode/v1",
      model: "qwen-plus"
    }
  };

  function $(id) {
    return document.getElementById(id);
  }

  function pref(key, fallback) {
    try {
      var value = Zotero.Prefs.get(key, true);
      if (value === undefined || value === null || value === "") {
        return fallback;
      }
      return value;
    }
    catch (e) {
      return fallback;
    }
  }

  function setStatus(text, kind) {
    var el = $("zra-status");
    if (!el) {
      return;
    }
    el.textContent = text || "";
    el.className = "zra-status" + (kind ? " zra-" + kind : "");
  }

  function normalizeBaseURL(url) {
    return String(url || "").trim().replace(/\/+$/, "");
  }

  function cleanTerm(value) {
    return String(value || "").replace(/\s+/g, " ").trim();
  }

  function splitGlossaryPair(line) {
    var separators = ["=>", "->", "→", "\t", "="];
    for (var i = 0; i < separators.length; i++) {
      var index = line.indexOf(separators[i]);
      if (index !== -1) {
        return {
          source: line.slice(0, index),
          target: line.slice(index + separators[i].length)
        };
      }
    }
    return null;
  }

  // Keep this parser in sync with src/ai/glossary.ts. It only powers the
  // live count in the pane; the plugin re-parses the saved text at request
  // time, so a pane/plugin mismatch can never change what is sent to the AI.
  function parseGlossary(text) {
    var entries = new Map();
    var lines = String(text || "").split(/\r?\n/);
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i].trim();
      if (!line || line.indexOf("#") === 0 || line.indexOf("//") === 0) {
        continue;
      }
      var pair = splitGlossaryPair(line);
      if (!pair) {
        continue;
      }
      var source = cleanTerm(pair.source);
      var target = cleanTerm(pair.target);
      if (
        !source
        || !target
        || source.length > MAX_TERM_LENGTH
        || target.length > MAX_TERM_LENGTH
      ) {
        continue;
      }
      if (entries.has(source)) {
        entries.delete(source);
      }
      entries.set(source, target);
      if (entries.size >= MAX_GLOSSARY_ENTRIES) {
        break;
      }
    }
    return Array.from(entries, function (entry) {
      return { source: entry[0], target: entry[1] };
    });
  }

  function updateGlossaryCount() {
    var el = $("zra-glossary-count");
    if (!el) {
      return;
    }
    var count = parseGlossary($("zra-glossary").value).length;
    el.textContent = "已识别 " + count + " 条术语"
      + (count >= MAX_GLOSSARY_ENTRIES ? "（已达上限）" : "");
  }

  function endpointOf(baseURL) {
    var base = normalizeBaseURL(baseURL);
    if (!base) {
      return "";
    }
    if (/\/chat\/completions$/i.test(base)) {
      return base;
    }
    return base + "/chat/completions";
  }

  // DeepSeek's API accepts model IDs, not the human-readable version label.
  // Checking only the official host keeps proxies/custom gateways free to use
  // their own aliases while catching the common "DeepSeek-V4.1-Flash-1017"
  // mistake before it reaches the provider.
  function isOfficialDeepSeekBase(baseURL) {
    return /^https?:\/\/api\.deepseek\.com(?:\/|$)/i.test(normalizeBaseURL(baseURL));
  }

  function isSupportedDeepSeekModel(model) {
    return model === "deepseek-flash" || model === "deepseek-v4-pro";
  }

  function modelValidationError(config) {
    if (!isOfficialDeepSeekBase(config.baseURL)) {
      return "";
    }
    if (isSupportedDeepSeekModel(config.model)) {
      return "";
    }
    return "DeepSeek 官方 API 只接受 deepseek-flash 或 deepseek-v4-pro；"
      + "当前模型 “" + config.model + "” 不是 API 模型 ID"
      + "（DeepSeek-V4.1-Flash-1017 是版本名）。请从模型下拉框中选择。";
  }

  function collect() {
    return {
      providerName: String($("zra-provider-name").value || "").trim() || "自定义",
      baseURL: normalizeBaseURL($("zra-base-url").value),
      apiKey: String($("zra-api-key").value || "").trim(),
      model: String($("zra-model").value || "").trim(),
      maxTokens: Math.round(Number($("zra-max-tokens").value) || 1200),
      temperature: Number($("zra-temperature").value) || 0.3,
      autoTranslate: !!$("zra-auto-translate").checked,
      glossary: String($("zra-glossary").value || "")
    };
  }

  function load() {
    $("zra-provider-name").value = pref(KEYS.providerName, "DeepSeek");
    $("zra-base-url").value = pref(KEYS.baseURL, "https://api.deepseek.com/v1");
    $("zra-api-key").value = pref(KEYS.apiKey, "");
    $("zra-max-tokens").value = pref(KEYS.maxTokens, 1200);
    $("zra-temperature").value = pref(KEYS.temperature, 0.3);
    $("zra-auto-translate").checked = pref(KEYS.autoTranslate, true) !== false;
    $("zra-glossary").value = String(pref(KEYS.glossary, "") || "");
    updateGlossaryCount();

    var base = normalizeBaseURL($("zra-base-url").value);
    var savedModel = String(pref(KEYS.model, "deepseek-flash") || "").trim();
    var model = savedModel;
    if (isOfficialDeepSeekBase(base) && !isSupportedDeepSeekModel(model)) {
      // Old aliases such as deepseek-chat and version labels such as
      // DeepSeek-V4.1-Flash-1017 are not valid API model IDs.
      model = "deepseek-flash";
    }
    setModelValue(model);

    if (/deepseek\.com/i.test(base)) {
      $("zra-provider-preset").value = "deepseek";
    }
    else if (/agnes-ai\.com/i.test(base)) {
      $("zra-provider-preset").value = "agnes";
    }
    else if (/dashscope\.aliyuncs\.com/i.test(base)) {
      $("zra-provider-preset").value = "qwen";
    }
    else {
      $("zra-provider-preset").value = "custom";
    }

    if (model !== savedModel) {
      setStatus("旧模型名 “" + savedModel + "” 不是 DeepSeek API 模型 ID，"
        + "已改为 deepseek-flash；请点击保存。", "");
    }
    else {
      setStatus("", "");
    }
  }

  function modelLabel(id) {
    var labels = {
      "deepseek-flash": "DeepSeek V4.1 Flash（1017）— deepseek-flash",
      "deepseek-v4-pro": "DeepSeek V4 Pro — deepseek-v4-pro",
      "agnes-2.0-flash": "Agnes 2.0 Flash — 编程/推理（256K ctx）",
      "agnes-1.5-flash": "Agnes 1.5 Flash — 通用对话",
      "agnes-2.5-flash": "Agnes 2.5 Flash — 最强编程/推理（512K ctx）",
      "qwen-plus": "通义千问 Plus — qwen-plus",
      "qwen-max": "通义千问 Max — qwen-max",
      "qwen-turbo": "通义千问 Turbo — qwen-turbo",
      "qwen-long": "通义千问 Long — qwen-long"
    };
    return labels[id] || id;
  }

  function ensureModelOption(id, label) {
    var select = $("zra-model");
    if (!select || !id) {
      return;
    }
    for (var i = 0; i < select.options.length; i++) {
      if (select.options[i].value === id) {
        if (label) {
          select.options[i].textContent = label;
        }
        return;
      }
    }
    var option = document.createElementNS("http://www.w3.org/1999/xhtml", "option");
    option.value = id;
    option.textContent = label || modelLabel(id);
    select.appendChild(option);
  }

  function setModelValue(id) {
    var select = $("zra-model");
    if (!select) {
      return;
    }
    if (!id) {
      select.value = "";
      return;
    }
    ensureModelOption(id, modelLabel(id));
    select.value = id;
  }

  function modelsEndpointOf(baseURL) {
    var base = normalizeBaseURL(baseURL);
    if (!base) {
      return "";
    }
    base = base.replace(/\/chat\/completions$/i, "");
    if (/\/models$/i.test(base)) {
      return base;
    }
    return base + "/models";
  }

  function modelsRequestError(status, data) {
    if (status === 404) {
      return "该服务没有 /models 接口，请直接从下拉框选择";
    }
    return requestError(status, data);
  }

  function fetchModels() {
    var config = collect();
    if (!config.baseURL) {
      setStatus("请先填写 Base URL", "error");
      return;
    }
    if (!/^https?:\/\//i.test(config.baseURL)) {
      setStatus("Base URL 必须以 http:// 或 https:// 开头", "error");
      return;
    }
    if (!config.apiKey) {
      setStatus("请先填写 API Key", "error");
      return;
    }
    var endpoint = modelsEndpointOf(config.baseURL);
    if (!endpoint) {
      setStatus("Base URL 无效", "error");
      return;
    }
    var button = $("zra-fetch-models");
    button.disabled = true;
    setStatus("正在获取模型列表…", "busy");

    Zotero.HTTP.request("GET", endpoint, {
      headers: {
        "Authorization": "Bearer " + config.apiKey
      },
      timeout: 20000,
      responseType: "json",
      successCodes: false,
      errorDelayMax: 0
    }).then(function (xhr) {
      var status = Number((xhr && xhr.status) || 0);
      var data = xhr && (xhr.response || xhr.responseText);
      if (typeof data === "string") {
        try {
          data = JSON.parse(data);
        }
        catch (e) {
          data = null;
        }
      }
      if (status < 200 || status >= 300) {
        setStatus("获取模型失败：" + modelsRequestError(status, data), "error");
        return;
      }
      var list = (data && (data.data || data.models)) || [];
      var ids = [];
      for (var i = 0; i < list.length; i++) {
        var item = list[i];
        var id = typeof item === "string" ? item : (item && item.id);
        id = String(id || "").trim();
        if (id && ids.indexOf(id) === -1) {
          ids.push(id);
        }
      }
      if (!ids.length) {
        setStatus("服务返回了空模型列表", "error");
        return;
      }
      for (var j = 0; j < ids.length; j++) {
        ensureModelOption(ids[j], modelLabel(ids[j]));
      }
      var select = $("zra-model");
      if (select && !select.value) {
        select.value = ids[0];
      }
      setStatus("已获取 " + ids.length + " 个模型；请选择并保存。", "ok");
    }).catch(function (error) {
      var status = Number(
        (error && error.status)
        || (error && error.xmlhttp && error.xmlhttp.status)
        || (error && error.xhr && error.xhr.status)
        || 0
      );
      var data = error && (
        error.response
        || error.responseText
        || (error.xmlhttp && (error.xmlhttp.response || error.xmlhttp.responseText))
        || (error.xhr && (error.xhr.response || error.xhr.responseText))
      );
      if (typeof data === "string") {
        try {
          data = JSON.parse(data);
        }
        catch (e) {
          data = null;
        }
      }
      var message = status
        ? modelsRequestError(status, data)
        : "网络错误：" + String((error && error.message) || error);
      setStatus("获取模型失败：" + message, "error");
    }).then(function () {
      button.disabled = false;
    });
  }

  function save() {
    var config = collect();
    if (!config.baseURL) {
      setStatus("请填写 Base URL", "error");
      return;
    }
    if (!/^https?:\/\//i.test(config.baseURL)) {
      setStatus("Base URL 必须以 http:// 或 https:// 开头", "error");
      return;
    }
    if (!config.apiKey) {
      setStatus("请填写 API Key", "error");
      return;
    }
    if (!config.model) {
      setStatus("请选择模型", "error");
      return;
    }
    var modelError = modelValidationError(config);
    if (modelError) {
      setStatus(modelError, "error");
      return;
    }

    Zotero.Prefs.set(KEYS.providerName, config.providerName, true);
    Zotero.Prefs.set(KEYS.baseURL, config.baseURL, true);
    Zotero.Prefs.set(KEYS.apiKey, config.apiKey, true);
    Zotero.Prefs.set(KEYS.model, config.model, true);
    Zotero.Prefs.set(KEYS.maxTokens, config.maxTokens, true);
    Zotero.Prefs.set(KEYS.temperature, config.temperature, true);
    Zotero.Prefs.set(KEYS.autoTranslate, config.autoTranslate, true);
    Zotero.Prefs.set(KEYS.glossary, config.glossary, true);
    var glossaryCount = parseGlossary(config.glossary).length;
    setStatus("已保存（术语 " + glossaryCount + " 条）。回到阅读器选中文字即可使用。", "ok");
  }

  function requestError(status, data) {
    var detail = "";
    if (data && data.error && data.error.message) {
      detail = String(data.error.message);
    }
    else if (data && data.message) {
      detail = String(data.message);
    }
    var lower = detail.toLowerCase();
    if (status === 401 || status === 403) {
      return "鉴权失败：请检查 API Key";
    }
    if (status === 404) {
      return "接口或模型不存在：请检查 Base URL 和模型名";
    }
    if (status === 429) {
      return "请求被限流或额度不足，请稍后重试";
    }
    if (status === 400 && /context|token|length|too long|maximum/.test(lower)) {
      return "输入超过模型上下文长度";
    }
    if (status === 400 && /supported api model|invalid model|model.*not.*(found|exist)/.test(lower)) {
      return "模型名不被服务端支持：请填 API model ID；DeepSeek 用 deepseek-flash 或 deepseek-v4-pro，不要填版本名。";
    }
    if (status >= 500) {
      return "AI 服务端错误（HTTP " + status + "）";
    }
    return detail || ("请求失败（HTTP " + status + "）");
  }

  function test() {
    var config = collect();
    if (!config.baseURL || !config.apiKey || !config.model) {
      setStatus("请先填写 Base URL、API Key 并选择模型", "error");
      return;
    }
    var modelError = modelValidationError(config);
    if (modelError) {
      setStatus(modelError, "error");
      return;
    }
    var endpoint = endpointOf(config.baseURL);
    if (!endpoint) {
      setStatus("Base URL 无效", "error");
      return;
    }
    var button = $("zra-test");
    button.disabled = true;
    setStatus("正在测试连接…", "busy");
    var started = Date.now();

    var body = JSON.stringify({
      model: config.model,
      messages: [{ role: "user", content: "Reply with exactly: OK" }],
      temperature: 0,
      max_tokens: 8,
      stream: false
    });

    Zotero.HTTP.request("POST", endpoint, {
      headers: {
        "Content-Type": "application/json",
        "Authorization": "Bearer " + config.apiKey
      },
      body: body,
      timeout: 20000,
      responseType: "json",
      // Resolve 4xx/5xx so the pane can show the provider's error message
      // instead of a generic rejection; don't let HTTP retries hang the test.
      successCodes: false,
      errorDelayMax: 0
    }).then(function (xhr) {
      var status = Number((xhr && xhr.status) || 0);
      var data = xhr && (xhr.response || xhr.responseText);
      if (typeof data === "string") {
        try {
          data = JSON.parse(data);
        }
        catch (e) {
          data = null;
        }
      }
      if (status < 200 || status >= 300) {
        setStatus("测试失败：" + requestError(status, data), "error");
        return;
      }
      var content = data
        && data.choices
        && data.choices[0]
        && ((data.choices[0].message && data.choices[0].message.content) || data.choices[0].text);
      var elapsed = Date.now() - started;
      if (content) {
        setStatus("连接成功（" + elapsed + " ms）：" + String(content).trim().slice(0, 60), "ok");
      }
      else {
        setStatus("连接成功（" + elapsed + " ms），但响应中没有文本", "ok");
      }
    }).catch(function (error) {
      var status = Number(
        (error && error.status)
        || (error && error.xmlhttp && error.xmlhttp.status)
        || (error && error.xhr && error.xhr.status)
        || 0
      );
      var data = error && (
        error.response
        || error.responseText
        || (error.xmlhttp && (error.xmlhttp.response || error.xmlhttp.responseText))
        || (error.xhr && (error.xhr.response || error.xhr.responseText))
      );
      if (typeof data === "string") {
        try {
          data = JSON.parse(data);
        }
        catch (e) {
          data = null;
        }
      }
      var message = status
        ? requestError(status, data)
        : "网络错误：无法连接 AI 服务（" + String((error && error.message) || error) + "）";
      setStatus("测试失败：" + message, "error");
    }).then(function () {
      button.disabled = false;
    });
  }

  function applyPreset() {
    var key = $("zra-provider-preset").value;
    var preset = PRESETS[key];
    if (!preset) {
      return;
    }
    $("zra-provider-name").value = preset.providerName;
    $("zra-base-url").value = preset.baseURL;
    setModelValue(preset.model);
    setStatus("已填入 " + preset.providerName + " 默认值，请补充 API Key。", "");
  }

  function toggleKey() {
    var input = $("zra-api-key");
    var button = $("zra-toggle-key");
    if (input.type === "password") {
      input.type = "text";
      button.textContent = "隐藏";
    }
    else {
      input.type = "password";
      button.textContent = "显示";
    }
  }

  function init() {
    if (!$("zra-prefs")) {
      // The pane fragment isn't in the document yet; retry once after the
      // preferences window finishes inserting it.
      setTimeout(init, 50);
      return;
    }
    load();
    $("zra-save").addEventListener("click", save);
    $("zra-test").addEventListener("click", test);
    $("zra-provider-preset").addEventListener("change", applyPreset);
    $("zra-toggle-key").addEventListener("click", toggleKey);
    $("zra-fetch-models").addEventListener("click", fetchModels);
    $("zra-glossary").addEventListener("input", updateGlossaryCount);
    $("zra-api-key").addEventListener("keydown", function (event) {
      if (event.key === "Enter") {
        event.preventDefault();
        save();
      }
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init, { once: true });
  }
  else {
    setTimeout(init, 0);
  }
})();
