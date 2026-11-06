/**
 * model-client.js — qwen3.7-flash 模型客户端（原生 fetch，OpenAI 兼容模式）
 * 不引入任何 SDK；超时/重试/response_format 兼容回退均在此处理。
 * 每次调用可在服务端终端打印完整上下文与返回（见 console-logger.js，可用 LOG_MODEL_IO=off 关闭）。
 */

import { logModelRequest, logModelResponse, logModelError } from './console-logger.js';

/** 模型调用与成本配置（成本为北京区官方价，可在此修改） */
export const MODEL_CONFIG = {
  model: 'qwen3.7-flash',
  endpoint: 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions',
  /** 单价：人民币 / 每百万 tokens */
  priceCNY: { input: 0.2, output: 0.8 },
  timeoutMs: 60_000,
  /** 网络级错误重试次数（非 2xx 不重试） */
  networkRetries: 1,
};

/** 各环节采样温度（可调） */
export const TEMPERATURES = {
  director: 0.1,
  generator: 0.8,
};

/** API 返回非 2xx 时的错误 */
export class ApiError extends Error {
  /**
   * @param {number} status HTTP 状态码
   * @param {string} bodySnippet 响应体前 500 字符
   */
  constructor(status, bodySnippet) {
    super(`模型接口返回非 2xx：HTTP ${status}；响应体片段：${bodySnippet}`);
    this.name = 'ApiError';
    this.status = status;
    this.bodySnippet = bodySnippet;
  }
}

/** 网络级错误（fetch 抛出，可重试） */
export class NetworkError extends Error {
  constructor(cause) {
    super(`模型接口网络错误：${cause?.message ?? String(cause)}`);
    this.name = 'NetworkError';
    this.cause = cause;
  }
}

/**
 * 创建模型客户端
 * @param {{ apiKey: string }} options
 * @returns {{ chatCompletion: Function, streamChatCompletion: Function }}
 */
export function createModelClient({ apiKey }) {
  if (!apiKey || typeof apiKey !== 'string') {
    throw new Error('缺少 DASHSCOPE_API_KEY，无法创建模型客户端');
  }

  /**
   * 发送一次 HTTP 请求（含 60s 超时与网络级重试 1 次）
   * @param {object} body 请求体（已含 model/messages/stream 等）
   * @param {{ externalSignal?: AbortSignal }} [options]
   * @returns {Promise<Response>}
   */
  async function requestOnce(body, options = {}) {
    const { externalSignal } = options;
    const timeoutController = new AbortController();
    const timer = setTimeout(() => timeoutController.abort(), MODEL_CONFIG.timeoutMs);
    /** 组合外部中断（客户端断开）与超时信号 */
    const signal = externalSignal
      ? AbortSignal.any([externalSignal, timeoutController.signal])
      : timeoutController.signal;

    let lastError;
    const maxAttempts = 1 + MODEL_CONFIG.networkRetries;
    /** 清理超时计时器（成功/失败路径都要清，避免泄漏） */
    const clearTimer = () => clearTimeout(timer);
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      try {
        const res = await fetch(MODEL_CONFIG.endpoint, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(body),
          signal,
        });
        // 已拿到响应（流式为响应头到达）：立即清超时，让 60s 只覆盖
        // 连接建立 + 首响应阶段，不中途 abort 长时间的流式生成
        clearTimer();
        if (!res.ok) {
          const text = await res.text();
          // 非 2xx：带上状态码与响应体前 500 字符，不重试
          throw new ApiError(res.status, text.slice(0, 500));
        }
        return res;
      } catch (err) {
        // 外部中断（用户关闭连接）直接终止，不重试；同时必须清掉 60s 超时定时器，
        // 否则悬空的 setTimeout 会把 Node 进程吊住到超时（脚本 / CI 会被拖死）
        if (externalSignal?.aborted) {
          clearTimer();
          throw err;
        }
        // 已超时：不再进入重试，避免二次等待（此时定时器已触发，无需清理）
        if (timeoutController.signal.aborted) throw new NetworkError(err);
        // 非 2xx 已在上方 clearTimer() 之后抛出，这里只是继续上抛
        if (err instanceof ApiError) throw err;
        lastError = new NetworkError(err);
        // 网络级错误：重试 1 次（计时器继续生效，总预算仍为 60s）
      }
    }
    clearTimer();
    throw lastError;
  }

  /**
   * 构造 response_format 逐级回退链（按顺序尝试，前者被供应商 400 拒绝时降级到后者）
   * jsonSchema 模式链：json_schema(严格) → json_object → 无格式约束
   * 仅 responseFormat 模式链：responseFormat 原样 → 无格式约束
   * @param {{ responseFormat?: object, jsonSchema?: {name: string, schema: object} }} params
   * @returns {Array<{label: string, body: object}>} 每项含构造好的请求体（已并入 baseBody）
   */
  function buildFormatChain({ baseBody, responseFormat, jsonSchema }) {
    /** @type {Array<{label: string, format: object|null}>} */
    const chain = [];
    if (jsonSchema && typeof jsonSchema === 'object' && jsonSchema.schema) {
      // OpenAI 兼容的严格 JSON 输出模式：约束解码阶段即强制 schema 合规
      chain.push({
        label: 'json_schema',
        format: {
          type: 'json_schema',
          json_schema: {
            name: typeof jsonSchema.name === 'string' && jsonSchema.name ? jsonSchema.name : 'response',
            strict: true,
            schema: jsonSchema.schema,
          },
        },
      });
      // 供应商不支持 json_schema 时退回只保证合法 JSON 的模式
      chain.push({ label: 'json_object', format: { type: 'json_object' } });
    } else if (responseFormat) {
      chain.push({ label: 'response_format', format: responseFormat });
    }
    // 兜底：完全去掉 response_format（旧逻辑行为，无 JSON 保证但至少能拿到输出）
    chain.push({ label: 'none', format: null });
    return chain.map(({ label, format }) => ({
      label,
      body: format ? { ...baseBody, response_format: format } : baseBody,
    }));
  }

  /**
   * 非流式对话补全
   * @param {{ messages: Array<{role: string, content: string}>, temperature?: number, responseFormat?: object, jsonSchema?: {name: string, schema: object}, enableThinking?: boolean, stage?: 'director'|'generator', label?: string }} params
   *   jsonSchema：传 {name, schema} 时自动构造 strict json_schema（schema 应为「严格变体」，
   *   即所有对象 required 补全 / additionalProperties:false，见 validators.js 的 getStrictJsonSchema）
   *   enableThinking：开启 qwen3.7 思考模式（思考内容在响应的 reasoning_content 字段返回）
   *   stage：调用阶段，仅用于控制台日志标题（director → Director 请求）；缺省显示为 Model
   *   label：可选的日志附加说明（如「修复重试」），仅作用于控制台日志
   * @returns {Promise<{content: string, reasoning: string, promptTokens: number, completionTokens: number}>}
   */
  async function chatCompletion({
    messages,
    temperature,
    responseFormat,
    jsonSchema,
    enableThinking = false,
    stage,
    label,
  }) {
    // 本次调用总耗时基准：从进入函数算起（回退时的失败等待也计入，反映真实终端体验）
    const callStartedAt = Date.now();
    // enable_thinking 必须显式传：qwen3.5/3.6/3.7 系列默认开思考模式，
    // 不需要思考时必须显式关闭（body 顶层参数，与 model 同级）
    const baseBody = {
      model: MODEL_CONFIG.model,
      messages,
      temperature: temperature ?? TEMPERATURES.director,
      stream: false,
      enable_thinking: Boolean(enableThinking),
    };

    const chain = buildFormatChain({ baseBody, responseFormat, jsonSchema });

    let res;
    for (let i = 0; i < chain.length; i++) {
      // 回退链的每次尝试都单独打印一组请求日志：回退发生时能直接看到
      // 「第二次尝试已降级为 json_object」
      logModelRequest({
        stage,
        label,
        model: baseBody.model,
        temperature: baseBody.temperature,
        enableThinking: baseBody.enable_thinking,
        stream: false,
        formatLabel: chain[i].label,
        messages,
        attempt: i,
      });
      try {
        res = await requestOnce(chain[i].body);
        break;
      } catch (err) {
        // 部分供应商/模型版本不支持 response_format：仅当 HTTP 400 且响应体明确
        // 指向该参数（response_format / json_object / json_schema）时才降级重试，
        // 401 等无关错误不做必然失败的二次调用
        const isFormatRejection =
          err instanceof ApiError &&
          err.status === 400 &&
          /response_format|json[_ -]?(object|schema)/i.test(err.bodySnippet);
        const hasNext = i < chain.length - 1;
        if (isFormatRejection && hasNext) {
          console.warn(
            `[model-client] response_format（${chain[i].label}）被供应商拒绝，回退为 ${chain[i + 1].label}：${err.bodySnippet}`
          );
          continue;
        }
        // 回退链走到尽头（或无回退余地）：打印错误后抛出
        logModelError({ stage, label, formatLabel: chain[i].label, error: err });
        throw err;
      }
    }

    const json = await res.json();
    const message = json.choices?.[0]?.message ?? {};
    const content = message.content ?? '';
    const reasoning = message.reasoning_content ?? '';
    const result = {
      content: typeof content === 'string' ? content : String(content ?? ''),
      reasoning: typeof reasoning === 'string' ? reasoning : '',
      promptTokens: json.usage?.prompt_tokens ?? 0,
      completionTokens: json.usage?.completion_tokens ?? 0,
    };

    // 非流式没有首个 token 时间，firstTokenMs 传 null（日志里自动省略该片段）
    logModelResponse({
      stage,
      label,
      content: result.content,
      reasoning: result.reasoning,
      promptTokens: result.promptTokens,
      completionTokens: result.completionTokens,
      latencyMs: Date.now() - callStartedAt,
      firstTokenMs: null,
      usageKnown: Boolean(json.usage),
    });

    return result;
  }

  /**
   * 流式对话补全（Generator 与 Director 共用，SSE）
   * 思考模式开启时：思考增量通过 onReasoning 实时回调（delta.reasoning_content），
   * 正文增量通过 onDelta 回调；两者在内部各自累积并在返回值中给出全文
   * @param {{ messages: Array<{role: string, content: string}>, temperature?: number,
   *   onDelta?: Function, onReasoning?: Function, externalSignal?: AbortSignal,
   *   enableThinking?: boolean, jsonSchema?: {name: string, schema: object},
   *   stage?: 'director'|'generator', label?: string }} params
   *   stage：调用阶段，仅用于控制台日志标题（generator → Generator 请求）；缺省显示为 Model
   *   label：可选的日志附加说明（如「修复重试」），仅作用于控制台日志
   * @returns {Promise<{content: string, reasoning: string, promptTokens: number, completionTokens: number, usageKnown: boolean, firstTokenMs: number|null}>}
   */
  async function streamChatCompletion({
    messages,
    temperature,
    onDelta,
    onReasoning,
    externalSignal,
    enableThinking = false,
    enableSearch = false,
    jsonSchema,
    tools,
    stage,
    label,
  }) {
    // 本次调用整体耗时基准（含建连，日志里的 latencyMs 用它计算）
    const callStartedAt = Date.now();
    const baseBody = {
      model: MODEL_CONFIG.model,
      messages,
      temperature: temperature ?? TEMPERATURES.generator,
      stream: true,
      enable_thinking: Boolean(enableThinking),
      // 百炼联网搜索（旧方案，已被 function calling 工具模式替代为默认路径）：
      // 仅当显式传入 enableSearch 且未挂 tools 时才走模型内置搜索（兼容保留）
      enable_search: Boolean(enableSearch) && !Array.isArray(tools),
      ...(Boolean(enableSearch) && !Array.isArray(tools) ? { search_options: { forced_search: true } } : {}),
      // 百炼要求：流式响应要拿到 usage 必须显式开启 include_usage，
      // 否则 tokens 恒为 0、成本无法估算
      stream_options: { include_usage: true },
    };
    // function calling 工具（OpenAI tools 格式）：模型按工具描述自主决定调用，
    // 流式响应中 tool_calls 以分片形式到达（delta.tool_calls[].function.arguments 逐段拼接）
    if (Array.isArray(tools) && tools.length > 0) {
      baseBody.tools = tools;
      baseBody.tool_choice = 'auto';
    }

    // Director 流式调用需要 json_schema 约束：复用与 chatCompletion 相同的回退链
    const chain = buildFormatChain({ baseBody, jsonSchema });

    let res;
    /** 实际生效的 format 档位（流式读取阶段中断时也要能在错误日志里报出来） */
    let usedFormatLabel = chain[0]?.label;
    for (let i = 0; i < chain.length; i++) {
      // 回退链的每次尝试都单独打印一组请求日志（回退时会看到多组）
      logModelRequest({
        stage,
        label,
        model: baseBody.model,
        temperature: baseBody.temperature,
        enableThinking: baseBody.enable_thinking,
        enableSearch: baseBody.enable_search,
        stream: true,
        formatLabel: chain[i].label,
        messages,
        attempt: i,
      });
      try {
        res = await requestOnce(chain[i].body, { externalSignal });
        usedFormatLabel = chain[i].label;
        break;
      } catch (err) {
        const isFormatRejection =
          err instanceof ApiError &&
          err.status === 400 &&
          /response_format|json[_ -]?(object|schema)/i.test(err.bodySnippet);
        const hasNext = i < chain.length - 1;
        if (isFormatRejection && hasNext) {
          console.warn(
            `[model-client] response_format（${chain[i].label}）被供应商拒绝，回退为 ${chain[i + 1].label}：${err.bodySnippet}`
          );
          continue;
        }
        // 回退链走到尽头（或无回退余地）：打印错误后抛出
        logModelError({ stage, label, formatLabel: chain[i].label, error: err });
        throw err;
      }
    }

    const startedAt = Date.now();
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let pending = '';
    /** 首个输出 token（思考或正文，思考模式下即思考开始时刻） */
    let firstTokenMs = null;
    /** 首个正文 token（思考模式下晚于 firstTokenMs；关闭思考时两者相等） */
    let firstContentMs = null;
    let promptTokens = 0;
    let completionTokens = 0;
    let usageKnown = false;
    let contentAll = '';
    let reasoningAll = '';
    /** 流式 tool_calls 分片缓冲：index → {id, name, arguments}（逐段拼接） */
    const toolCallBuffers = new Map();

    /** 逐行解析 SSE：data: {...} / data: [DONE] */
    const handleLine = (line) => {
      const trimmed = line.trim();
      if (!trimmed.startsWith('data:')) return;
      const payload = trimmed.slice(5).trim();
      if (!payload || payload === '[DONE]') return;
      let chunk;
      try {
        chunk = JSON.parse(payload);
      } catch {
        return; // 忽略无法解析的行（心跳/杂行）
      }
      // 思考增量（qwen 思考模式）：先于正文流出，实时推给前端
      const reasoningDelta = chunk.choices?.[0]?.delta?.reasoning_content;
      if (typeof reasoningDelta === 'string' && reasoningDelta.length > 0) {
        if (firstTokenMs === null) firstTokenMs = Date.now() - startedAt;
        reasoningAll += reasoningDelta;
        if (onReasoning) onReasoning(reasoningDelta);
      }
      // 正文增量
      const delta = chunk.choices?.[0]?.delta?.content;
      if (typeof delta === 'string' && delta.length > 0) {
        if (firstTokenMs === null) firstTokenMs = Date.now() - startedAt;
        if (firstContentMs === null) firstContentMs = Date.now() - startedAt;
        contentAll += delta;
        if (onDelta) onDelta(delta);
      }
      // 工具调用增量（function calling）：id/name 首片到达，arguments 逐段拼接
      const deltaToolCalls = chunk.choices?.[0]?.delta?.tool_calls;
      if (Array.isArray(deltaToolCalls)) {
        if (firstTokenMs === null) firstTokenMs = Date.now() - startedAt;
        for (const tc of deltaToolCalls) {
          if (!tc || typeof tc !== 'object') continue;
          const idx = Number.isFinite(tc.index) ? tc.index : 0;
          if (!toolCallBuffers.has(idx)) toolCallBuffers.set(idx, { id: '', name: '', arguments: '' });
          const buf = toolCallBuffers.get(idx);
          if (typeof tc.id === 'string' && tc.id) buf.id = tc.id;
          if (typeof tc.function?.name === 'string' && tc.function.name) buf.name += tc.function.name;
          if (typeof tc.function?.arguments === 'string') buf.arguments += tc.function.arguments;
        }
      }
      // 流式 usage 可能在最后一个 chunk 上；没有就记 0 并标注 unknown
      if (chunk.usage) {
        promptTokens = chunk.usage.prompt_tokens ?? 0;
        completionTokens = chunk.usage.completion_tokens ?? 0;
        usageKnown = true;
      }
    };

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        pending += decoder.decode(value, { stream: true });
        const lines = pending.split('\n');
        pending = lines.pop(); // 末行可能不完整，留待下一块
        for (const line of lines) handleLine(line);
      }
      if (pending.length > 0) handleLine(pending);
    } catch (err) {
      // 流式读取阶段中断（客户端断开 / 连接中断）：打印错误日志后向上抛，
      // 已累积的正文由上层决定是否保留
      logModelError({ stage, label, formatLabel: usedFormatLabel, error: err });
      throw err;
    }

    // 日志用的首字延迟口径：startedAt 只从「响应头到达」开始计时，而供应商常把响应头
    // 与首个 chunk 一起 flush（同一毫秒），导致该差值恒为 0；日志因此改为
    // 「请求发出 → 首个 token」的真实值。仅影响控制台日志，返回的 firstTokenMs 语义不变。
    const logFirstTokenMs =
      firstTokenMs === null ? null : startedAt - callStartedAt + firstTokenMs;

    // 打印完整返回（reasoning 在前、content 在后）+ 本次调用整体耗时与 token
    logModelResponse({
      stage,
      label,
      content: contentAll,
      reasoning: reasoningAll,
      promptTokens,
      completionTokens,
      latencyMs: Date.now() - callStartedAt,
      firstTokenMs: logFirstTokenMs,
      usageKnown,
    });

    return {
      content: contentAll,
      reasoning: reasoningAll,
      /** 完整的工具调用列表（模型发起；非空时调用方应执行工具并回填后再次请求） */
      toolCalls: [...toolCallBuffers.values()].filter((t) => t.name),
      promptTokens,
      completionTokens,
      usageKnown,
      firstTokenMs,
      firstContentMs,
    };
  }

  return { chatCompletion, streamChatCompletion };
}

/**
 * 估算成本（人民币元）
 * @param {{ directorTokens: {input: number, output: number}, generatorTokens: {input: number, output: number} }} tokens
 * @returns {number} 保留 6 位的估算值（展示时前端再格式化为 4 位）
 */
export function estimateCostCNY({ directorTokens, generatorTokens }) {
  const inputTotal =
    (directorTokens?.input ?? 0) + (generatorTokens?.input ?? 0);
  const outputTotal =
    (directorTokens?.output ?? 0) + (generatorTokens?.output ?? 0);
  const cost =
    (inputTotal / 1_000_000) * MODEL_CONFIG.priceCNY.input +
    (outputTotal / 1_000_000) * MODEL_CONFIG.priceCNY.output;
  return Number(cost.toFixed(6));
}
