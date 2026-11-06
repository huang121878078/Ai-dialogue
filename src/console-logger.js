/**
 * console-logger.js — 控制台模型 IO 调试日志
 *
 * 目的：在 `npm start` 的服务端终端完整打印每次调用大模型的上下文（system/user 全文）
 * 与返回内容（含 reasoning 思考），以及耗时 / token，便于人工观察与调试。
 *
 * 设计要点：
 *  - 纯控制台输出（console.log → stdout），无任何新的第三方依赖；
 *  - 全部开关来自环境变量，默认开启，设置 LOG_MODEL_IO=off 即可整体关闭；
 *  - 所有函数在关闭开关时直接 return，对主流程零影响；
 *  - 所有函数内部做了防御性取值与 try/catch 包裹：日志失败绝不影响模型调用。
 *
 * 环境变量：
 *  - LOG_MODEL_IO    on（默认）/ off —— off、0、false（不区分大小写）时关闭本模块的全部输出
 *                    （注意：model-client 里 response_format 被拒时的 console.warn 降级告警
 *                     属于运行告警，不随本开关关闭）
 *  - LOG_MAX_CHARS   0（默认，不截断）/ 正整数 —— 单个文本段（一条 message / content / reasoning）打印上限
 *  - NO_COLOR        设置任意非空值时禁用 ANSI 颜色（标准约定）
 */

/** 分隔线字符与长度（每组请求/响应都用它包裹，便于在终端里快速定位） */
const SEPARATOR_CHAR = '─';
const SEPARATOR_LENGTH = 60;

/** ANSI 颜色码（仅在 TTY 且未设置 NO_COLOR 时使用） */
const ANSI = {
  reset: '\u001b[0m',
  cyan: '\u001b[36m',
  green: '\u001b[32m',
  red: '\u001b[31m',
  gray: '\u001b[90m',
};

/** 视为「关闭」的开关取值（不区分大小写） */
const OFF_VALUES = new Set(['off', '0', 'false']);

/** stage → 标题前缀（未知 stage 统一显示为 Model） */
const STAGE_TITLES = {
  director: 'Director',
  generator: 'Generator',
};

/** 缓存：开关只求值一次（首次调用时求值，避免模块加载顺序影响 .env 注入） */
let cachedEnabled;
let cachedMaxChars;
let cachedColorEnabled;

/**
 * 判断开关原始值是否表示「关闭」
 * @param {*} raw process.env 中读到的原始值
 * @returns {boolean}
 */
function isOffValue(raw) {
  if (raw === undefined || raw === null) return false;
  return OFF_VALUES.has(String(raw).trim().toLowerCase());
}

/**
 * 模型 IO 调试日志是否开启（默认开启）
 * @returns {boolean}
 */
export function isModelIoLogEnabled() {
  if (cachedEnabled === undefined) {
    cachedEnabled = !isOffValue(process.env.LOG_MODEL_IO);
  }
  return cachedEnabled;
}

/**
 * 单段文本打印上限（0 = 不截断）
 * @returns {number}
 */
function getMaxChars() {
  if (cachedMaxChars === undefined) {
    // 用 Number 而非 parseInt：parseInt('2e3') 会得到 2、parseInt('1.9') 得到 1，
    // 用户写 2e3 却只打印 2 个字符会非常费解。非整数 / 非正数 / 非数字一律视为「不截断」。
    const raw = String(process.env.LOG_MAX_CHARS ?? '').trim();
    const parsed = raw === '' ? Number.NaN : Number(raw);
    cachedMaxChars = Number.isInteger(parsed) && parsed > 0 ? parsed : 0;
  }
  return cachedMaxChars;
}

/**
 * 是否启用 ANSI 颜色：仅在真实终端且未设置 NO_COLOR 时启用
 * @returns {boolean}
 */
function isColorEnabled() {
  if (cachedColorEnabled === undefined) {
    const isTty = Boolean(process.stdout && process.stdout.isTTY);
    const noColor = typeof process.env.NO_COLOR === 'string' && process.env.NO_COLOR.length > 0;
    cachedColorEnabled = isTty && !noColor;
  }
  return cachedColorEnabled;
}

/**
 * 给文本上色（未启用颜色时原样返回）
 * @param {string} text
 * @param {'cyan'|'green'|'red'|'gray'} color
 * @returns {string}
 */
function paint(text, color) {
  if (!isColorEnabled()) return text;
  const code = ANSI[color];
  if (!code) return text;
  return `${code}${text}${ANSI.reset}`;
}

/**
 * 安全转字符串（永不抛异常）
 * @param {*} value
 * @returns {string}
 */
function toText(value) {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return String(value);
  }
  try {
    return JSON.stringify(value) ?? '';
  } catch {
    try {
      return String(value);
    } catch {
      return '';
    }
  }
}

/**
 * 统计字符数（按码点，与 clip 的切分口径一致）
 * 若用 String.length（UTF-16 码元），含 emoji 的文本会显示成 10 字符，
 * 而截断提示写「共 7 字符」，同一个块里两个数字自相矛盾。
 * @param {string} text
 * @returns {number}
 */
function countChars(text) {
  // 无代理对（绝大多数中文/英文文本）时直接用长度，省一次数组展开
  return /[\uD800-\uDFFF]/.test(text) ? Array.from(text).length : text.length;
}

/**
 * 按 LOG_MAX_CHARS 截断长文本
 * 按「码点」计数与切分：直接用 String.prototype.slice 会按 UTF-16 码元切，
 * 遇到 emoji 等代理对字符时会切出半个字符（终端显示 �）。
 * @param {string} text
 * @returns {string}
 */
function clip(text) {
  const max = getMaxChars();
  // 快路径：UTF-16 长度不超过上限时，码点数必然也不超过上限，无需展开
  if (max <= 0 || text.length <= max) return text;
  const codePoints = Array.from(text);
  if (codePoints.length <= max) return text;
  return `${codePoints.slice(0, max).join('')}…（已截断，共 ${codePoints.length} 字符）`;
}

/**
 * 本地时间戳 HH:mm:ss.SSS
 * @returns {string}
 */
function timestamp() {
  const now = new Date();
  const pad = (n, width = 2) => String(n).padStart(width, '0');
  return `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}.${pad(
    now.getMilliseconds(),
    3
  )}`;
}

/**
 * stage 转中文/英文标题（director → Director，generator → Generator，其他 → Model）
 * @param {string} [stage]
 * @returns {string}
 */
function stageTitle(stage) {
  const key = typeof stage === 'string' ? stage.trim().toLowerCase() : '';
  return STAGE_TITLES[key] ?? 'Model';
}

/**
 * 组装附加说明（如「· 修复重试」）
 * @param {string} [label]
 * @returns {string}
 */
function labelSuffix(label) {
  const text = typeof label === 'string' ? label.trim() : '';
  return text ? ` · ${text}` : '';
}

/** 打印分隔线（灰） */
function printSeparator() {
  console.log(paint(SEPARATOR_CHAR.repeat(SEPARATOR_LENGTH), 'gray'));
}

/**
 * token 数字格式化（非有限数显示 unknown）
 * @param {*} value
 * @returns {string}
 */
function formatCount(value) {
  return Number.isFinite(value) ? String(value) : 'unknown';
}

/**
 * 打印一次模型请求（完整 messages 上下文）
 * @param {object} params
 * @param {'director'|'generator'} [params.stage] 调用阶段（决定标题）
 * @param {string} [params.label] 附加说明（如 '修复重试'）
 * @param {string} [params.model] 模型名
 * @param {number} [params.temperature] 采样温度
 * @param {boolean} [params.enableThinking] 是否开启思考模式
 * @param {boolean} [params.stream] 是否流式
 * @param {string} [params.formatLabel] response_format 回退链当前档位（空则省略该行）
 * @param {Array<{role: string, content: string}>} [params.messages] 本次请求的完整消息
 * @param {number} [params.attempt] format 回退链当前级数（从 0 起；>0 表示已发生回退）
 */
export function logModelRequest(params = {}) {
  if (!isModelIoLogEnabled()) return;
  try {
    // 先兜 null/undefined 再解构：形参默认值 = {} 只能兜 undefined，传 null 会抛 TypeError
    const {
      stage,
      label,
      model,
      temperature,
      enableThinking,
      enableSearch,
      stream,
      formatLabel,
      messages,
      attempt = 0,
    } = params ?? {};
    const formatLevel = Number.isFinite(attempt) ? Math.max(0, Math.trunc(attempt)) : 0;
    const formatText = typeof formatLabel === 'string' ? formatLabel.trim() : '';
    // 尝试次数只用 label 表达（如「修复重试」）；format 回退另用「已回退至第 N 级」表达，
    // 避免把「回退链长度」误读成「模型调用重试了 N 次」。首轮（第 1 级）不显示任何次数。
    const fallbackSuffix =
      formatLevel > 0
        ? `（format 已回退至第 ${formatLevel + 1} 级：${formatText || 'unknown'}）`
        : '';
    const header = `[${timestamp()}] ▶ ${stageTitle(stage)} 请求${labelSuffix(
      label
    )}${fallbackSuffix}`;

    const safeMessages = Array.isArray(messages) ? messages : [];
    const totalChars = safeMessages.reduce(
      (sum, m) => sum + countChars(toText(m && m.content)),
      0
    );

    const metaParts = [
      `model: ${toText(model) || 'unknown'}`,
      `temperature: ${Number.isFinite(temperature) ? temperature : 'default'}`,
      `thinking: ${enableThinking ? 'on' : 'off'}`,
      `stream: ${stream ? 'true' : 'false'}`,
    ];
    // 联网搜索仅开启时显示（默认关闭不刷屏）
    if (enableSearch) metaParts.push('search: on');
    if (typeof formatLabel === 'string' && formatLabel.trim()) {
      metaParts.push(`format: ${formatLabel.trim()}`);
    }

    printSeparator();
    console.log(paint(header, 'cyan'));
    console.log(paint(metaParts.join(' / '), 'gray'));
    console.log(
      paint(`── messages（共 ${safeMessages.length} 条，${totalChars} 字符）──`, 'gray')
    );

    for (const message of safeMessages) {
      const role = toText(message && message.role) || 'unknown';
      // 空行分隔：多行内容保持原文不缩进，方便直接复制到别处对比
      console.log('');
      console.log(paint(`[${role}]`, 'gray'));
      console.log(clip(toText(message && message.content)));
    }
  } catch (err) {
    console.log(`[console-logger] 打印请求日志失败：${toText(err && err.message) || '未知错误'}`);
  }
}

/**
 * 打印一次模型响应（reasoning 全文 + content 全文 + 耗时 / token）
 * @param {object} params
 * @param {'director'|'generator'} [params.stage] 调用阶段（决定标题）
 * @param {string} [params.label] 附加说明
 * @param {string} [params.content] 正文全文
 * @param {string} [params.reasoning] 思考全文（为空则不打印该段）
 * @param {number} [params.promptTokens] 输入 token
 * @param {number} [params.completionTokens] 输出 token
 * @param {number} [params.latencyMs] 本次调用整体耗时（毫秒）
 * @param {number} [params.firstTokenMs] 首个 token 的延迟（毫秒；null / 0 视为未知，直接省略）
 * @param {boolean} [params.usageKnown] 是否拿到 usage（false 时 token 显示 unknown）
 */
export function logModelResponse(params = {}) {
  if (!isModelIoLogEnabled()) return;
  try {
    // 先兜 null/undefined 再解构（= {} 默认值兜不住 null）
    const {
      stage,
      label,
      content,
      reasoning,
      promptTokens,
      completionTokens,
      latencyMs,
      firstTokenMs,
      usageKnown,
    } = params ?? {};
    const latency = Number.isFinite(latencyMs) ? Math.max(0, Math.trunc(latencyMs)) : null;
    const parts = [];
    if (latency !== null) {
      parts.push(`耗时 ${(latency / 1000).toFixed(1)}s (${latency} ms)`);
    } else {
      parts.push('耗时 unknown');
    }
    parts.push(
      usageKnown === false
        ? 'in unknown / out unknown'
        : `in ${formatCount(promptTokens)} / out ${formatCount(completionTokens)}`
    );
    // firstTokenMs 只有「真实测到的正值」才展示：null（无值）与 0/负数（无意义）一律省略，
    // 避免出现误导性的 "firstToken 0 ms"
    if (Number.isFinite(firstTokenMs) && firstTokenMs > 0) {
      parts.push(`firstToken ${Math.trunc(firstTokenMs)} ms`);
    }

    const header = `[${timestamp()}] ◀ ${stageTitle(stage)} 响应${labelSuffix(
      label
    )} · ${parts.join(' | ')}`;

    printSeparator();
    console.log(paint(header, 'green'));

    const reasoningText = toText(reasoning);
    const contentText = toText(content);

    // 思考可能长达数千字：照原文打印，仅受 LOG_MAX_CHARS 约束
    if (reasoningText.length > 0) {
      console.log(paint(`── reasoning（${countChars(reasoningText)} 字符）──`, 'gray'));
      console.log(clip(reasoningText));
    }
    console.log(paint(`── content（${countChars(contentText)} 字符）──`, 'gray'));
    console.log(clip(contentText));
  } catch (err) {
    console.log(`[console-logger] 打印响应日志失败：${toText(err && err.message) || '未知错误'}`);
  }
}

/**
 * 打印一次模型调用错误（红色）
 * @param {object} params
 * @param {'director'|'generator'} [params.stage] 调用阶段（决定标题）
 * @param {string} [params.label] 附加说明（如 '修复重试'）
 * @param {string} [params.formatLabel] 失败时所处的 format 档位（如 json_schema）
 * @param {Error|object} [params.error] 错误对象（可带 status / bodySnippet）
 */
export function logModelError(params = {}) {
  if (!isModelIoLogEnabled()) return;
  try {
    // 先兜 null/undefined 再解构（= {} 默认值兜不住 null）
    const { stage, label, formatLabel, error } = params ?? {};
    const headerParts = [`[${timestamp()}] ✖ ${stageTitle(stage)} 调用失败${labelSuffix(label)}`];
    const formatText = typeof formatLabel === 'string' ? formatLabel.trim() : '';
    if (formatText) {
      headerParts.push(`format: ${formatText}`);
    }

    printSeparator();
    console.log(paint(headerParts.join(' · '), 'red'));

    const name = toText(error && error.name);
    const message = toText(error && error.message) || toText(error) || '未知错误';
    if (name) console.log(paint(`类型：${name}`, 'red'));
    console.log(message);

    const status = error && error.status;
    if (status !== undefined && status !== null) {
      console.log(paint(`HTTP 状态：${status}`, 'red'));
    }

    const bodySnippet = toText(error && error.bodySnippet);
    if (bodySnippet) {
      console.log(paint('── 响应体片段 ──', 'gray'));
      console.log(clip(bodySnippet));
    }
  } catch (err) {
    console.log(`[console-logger] 打印错误日志失败：${toText(err && err.message) || '未知错误'}`);
  }
}

/**
 * 从 Brief 中提取「情绪 / 策略 / 记忆」三段摘要文本（全部防御性取值）
 * @param {object|null|undefined} brief Director 输出的 Brief
 * @param {boolean} degraded 本轮是否降级
 * @param {string} mode 实验模式（区分「本来就无 Brief」与「Director 校验失败降级」）
 * @returns {string}
 */
function describeBrief(brief, degraded, mode) {
  if (!brief || typeof brief !== 'object') {
    // 三段文案互斥：降级 / 单模型模式 / 其余（含 C-D 未降级但缺 Brief 的异常路径）
    if (degraded) return 'Brief 摘要：（无 Brief——Director 校验失败已降级）';
    if (mode === 'A' || mode === 'B') return 'Brief 摘要：（无 Brief——A/B 单模型模式）';
    return 'Brief 摘要：（无 Brief）';
  }

  // 情绪：[疲惫 0.90, 虚无 0.80]
  const emotionList =
    brief.understanding && Array.isArray(brief.understanding.emotions)
      ? brief.understanding.emotions
      : [];
  const emotionText =
    emotionList
      .map((item) => {
        const label = toText(item && item.label) || '未知';
        const confidence = item && Number.isFinite(item.confidence) ? item.confidence : null;
        return confidence === null ? label : `${label} ${confidence.toFixed(2)}`;
      })
      .join(', ') || '（无）';

  // 策略：primary + secondary（D 模式无策略）
  const strategy = (brief.conversationStrategy && typeof brief.conversationStrategy === 'object'
    ? brief.conversationStrategy
    : null) ?? null;
  const primary = toText(strategy && strategy.primary);
  const secondary = toText(strategy && strategy.secondary);
  const strategyText =
    primary && secondary
      ? `${primary} + ${secondary}`
      : primary || secondary || '（无——D 模式或未产出）';

  // 记忆：M003, M026, M001
  const selectedList =
    brief.personalization && Array.isArray(brief.personalization.selectedMemories)
      ? brief.personalization.selectedMemories
      : [];
  const memoryText =
    selectedList.map((item) => toText(item && item.memoryId) || '?').join(', ') || '（无）';

  return `Brief 摘要：情绪 [${emotionText}] | 策略 ${strategyText} | 记忆 ${memoryText}`;
}

/**
 * 打印一轮结束的汇总块（灰色）：耗时 / 成本 / 是否降级 + Brief 摘要
 * @param {object} params
 * @param {'A'|'B'|'C'|'D'} [params.mode] 实验模式
 * @param {object} [params.metrics] 本轮 metrics
 * @param {object|null} [params.brief] 本轮 Brief（A/B 或降级时为 null）
 */
export function logTurnSummary(params = {}) {
  if (!isModelIoLogEnabled()) return;
  try {
    // 先兜 null/undefined 再解构（= {} 默认值兜不住 null）
    const { mode, metrics, brief } = params ?? {};
    const m = metrics && typeof metrics === 'object' ? metrics : {};
    const degraded = m.degraded === true;
    const modeText = toText(mode ?? m.mode);
    const totalLatency = Number.isFinite(m.totalLatencyMs) ? Math.trunc(m.totalLatencyMs) : null;
    const directorLatency = Number.isFinite(m.directorLatencyMs) ? Math.trunc(m.directorLatencyMs) : 0;
    const cost = Number.isFinite(m.estimatedCostCNY) ? m.estimatedCostCNY.toFixed(4) : '0.0000';
    // A/B 是单模型路径，没有 Director，也没有「降级」概念：两个字段都不展示，避免误读
    const isDualModel = modeText === 'C' || modeText === 'D';
    const showDirector = isDualModel || directorLatency > 0;

    const parts = [
      '■ 轮次完成',
      `模式 ${modeText || '?'}`,
      totalLatency === null ? '总耗时 unknown' : `总耗时 ${totalLatency} ms`,
    ];
    if (showDirector) {
      parts.push(`Director ${directorLatency} ms`);
    }
    parts.push(`成本 ¥${cost}`);
    if (isDualModel || degraded) {
      parts.push(`降级 ${degraded ? '是' : '否'}`);
    }

    printSeparator();
    console.log(paint(parts.join(' | '), 'gray'));
    console.log(paint(describeBrief(brief, degraded, modeText), 'gray'));
    printSeparator();
  } catch (err) {
    console.log(`[console-logger] 打印轮次摘要失败：${toText(err && err.message) || '未知错误'}`);
  }
}
