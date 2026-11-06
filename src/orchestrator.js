/**
 * orchestrator.js — 编排核心：组装上下文、调度 Director/Generator、校验、降级、指标与日志
 *
 * 五组模式：
 *  A 单模型 + 全量数据；B 单模型 + curated 精选记忆；
 *  C 双模型（Brief 含策略）；D 双模型（Brief 无策略）；
 *  R 智能路由（Router 判定 fast→Generator 直答 / cognitive→完整双模型链路）
 */

import { runDirectorTurn } from './director.js';
import { buildSingleModelMessages, buildBriefDrivenMessages, buildFastPathMessages, runGenerator } from './generator.js';
import { routeMessage } from './router.js';
import { SessionLogger } from './logger.js';
import { estimateCostCNY } from './model-client.js';
import { logTurnSummary } from './console-logger.js';
import { createMem0Client } from './mem0-client.js';

/** 合法实验模式 */
const VALID_MODES = /** @type {const} */ (['A', 'B', 'C', 'D', 'E', 'R']);

/**
 * 初始化一轮的 metrics 骨架
 * @param {'A'|'B'|'C'|'D'} mode
 * @returns {object}
 */
function initMetrics(mode) {
  return {
    mode,
    directorLatencyMs: 0,
    generatorFirstTokenMs: null,
    generatorFirstContentMs: null,
    totalLatencyMs: 0,
    directorTokens: { input: 0, output: 0 },
    generatorTokens: { input: 0, output: 0 },
    generatorUsageKnown: true,
    estimatedCostCNY: 0,
    degraded: false,
    retries: 0,
    /** 记忆源：static / mem0 / companionmem */
    memorySource: 'static',
    /**
     * 角色主体性指标（仅 E 模式有值；供「角色自主表达率 / 观点一致性」离线统计）：
     * hasContribution 本轮角色是否贡献了自身内容；initiative 主动度；move 主动方式；
     * strength 观点强度；topic 贡献主题
     */
    characterHasContribution: null,
    characterInitiative: null,
    characterMove: null,
    characterStrength: null,
    characterTopic: null,
    /** R 模式：路由耗时 / 判定路径 / 引擎（其他模式无值） */
    routerLatencyMs: null,
    routerPath: null,
    routerEngine: null,
  };
}

/**
 * 执行一轮对话（A/B 直连 Generator；C/D 先 Director 再 Generator）
 * @param {{ client: object, data: object, message: string, history?: Array<{role: string, content: string}>, mode: 'A'|'B'|'C'|'D', emit?: Function, externalSignal?: AbortSignal, includeThinking?: boolean, enableSearch?: boolean, logDir?: string }} params
 *   emit(eventName, payload) 用于向前端推送 SSE 事件：stage / reasoning / brief / delta / done
 *   includeThinking：开启 qwen3.7 思考模式，思考经 reasoning 事件实时流出（source: director|generator）
 *   enableSearch：开启百炼联网搜索（仅作用于 Generator 的生成阶段），问实时性问题时不瞎编；会增加 1-3s 延迟
 *   logDir：JSONL 日志目录（缺省 results/）；测试传临时目录可避免污染真实实验日志
 * @returns {Promise<{reply: string, brief: object|null, validation: object|null, metrics: object, loggerFile: string}>}
 */
export async function runTurn({ client, data, message, history = [], mode, emit = () => {}, externalSignal, includeThinking = false, enableSearch = false, logDir, decisionConfig, mem0Client, companionMemClient, toolOptions = {} }) {
  if (!VALID_MODES.includes(mode)) {
    throw new Error(`无效的实验模式：${mode}（只支持 A / B / C / D / R）`);
  }
  if (typeof message !== 'string' || message.trim().length === 0) {
    throw new Error('message 不能为空');
  }

  const startedAt = Date.now();
  const metrics = initMetrics(mode);
  const logger = new SessionLogger({ logDir });
  let brief = null;
  let validation = null;
  let reply = '';
  let generatorMessages = null;
  /** Director 的原始文本输出（含校验失败时的，写入 JSONL 便于事后诊断；A/B 模式为 null） */
  let directorRawOutput = null;
  /** Director 的思考全文（开启思考模式时；A/B 模式为 null） */
  let directorReasoning = null;
  /** Generator 的思考全文（开启思考模式时） */
  let generatorReasoning = null;
  /** R 模式的路由决策结果（写入 JSONL 与 route 事件；其他模式为 null） */
  let routeResult = null;
  /** R 模式下实际走 Director 的模式（cognitive 时按 C 处理，含策略） */
  let directorMode = null;
  /** Generator 的工具调用记录（web_search / getLocalTime） */
  let toolCallsLog = [];

  try {
    if (mode === 'A' || mode === 'B') {
      // ---- 单模型路径：无 Director，direct=0 ----
      generatorMessages = await buildSingleModelMessages({ message, history, data, mode });
    } else if (mode === 'R') {
      // ---- 智能路由：先判定路径，再分流 ----
      emit('stage', { stage: 'router', status: 'start' });
      routeResult = await routeMessage({
        message,
        history,
        decisionWorkspaceId: decisionConfig?.workspaceId,
        apiKey: decisionConfig?.apiKey,
      });
      metrics.routerLatencyMs = routeResult.latencyMs;
      metrics.routerPath = routeResult.path;
      metrics.routerEngine = routeResult.engine;
      // 路由决策对前端可见：路径、置信度、理由、引擎、是否降级
      emit('route', {
        path: routeResult.path,
        confidence: routeResult.confidence,
        reason: routeResult.reason,
        engine: routeResult.engine,
        safetyHint: Boolean(routeResult.safetyHint),
        latencyMs: routeResult.latencyMs,
        fallback: Boolean(routeResult.fallback),
      });

      if (routeResult.path === 'fast') {
        // Fast Path：跳过 Director，Generator 直答（轻量上下文，无记忆）
        generatorMessages = await buildFastPathMessages({ message, history, data });
      } else {
        // Cognitive Path：按 C 模式走完整双模型链路（含策略）
        directorMode = 'C';
      }
    }

    if (directorMode === 'C' || mode === 'C' || mode === 'D' || mode === 'E') {
      // ---- 双模型路径：Director 先分析（思考开启时实时外推）----
      const effectiveDirectorMode = directorMode ?? mode;
      // 记忆源三级优先：CompanionMem（Yodada 生产同款，含 context 分区）> Mem0 > 静态 data/memories
      let candidateMemories = data.memories;
      let memorySource = 'static';
      /** CompanionMem 的 context 分区（state/relation_state）有值时覆盖 Director 的静态情绪/关系输入 */
      let directorData = data;
      if (companionMemClient) {
        const { memories: cmMemories, contextOverride } = await companionMemClient.recall(message);
        if (cmMemories.length > 0) {
          candidateMemories = cmMemories;
          memorySource = 'companionmem';
        }
        if (contextOverride) {
          // 浅拷贝 data，仅覆盖有值的分区（无值时保持静态 JSON 兜底）
          directorData = {
            ...data,
            emotion: contextOverride.emotion ?? data.emotion,
            relationship: contextOverride.relationship ?? data.relationship,
          };
        }
      } else if (mem0Client) {
        const mem0Results = await mem0Client.search(message);
        if (mem0Results.length > 0) {
          candidateMemories = mem0Results.map((r) => ({
            id: r.id,
            content: r.memory,
            type: 'experience',
            status: 'confirmed',
            importance: Number.isFinite(r.score) ? Math.round(r.score * 100) / 100 : 0.5,
            curated: false,
          }));
          memorySource = 'mem0';
        }
      }
      emit('stage', { stage: 'director', status: 'start' });
      const directorResult = await runDirectorTurn({
        client,
        message,
        history,
        data: directorData,
        mode: effectiveDirectorMode,
        includeThinking,
        externalSignal,
        memories: candidateMemories,
        characterCore: mode === 'E' ? data.characterCore : undefined,
        characterState: mode === 'E' ? data.characterState : undefined,
        onReasoning: (text) => emit('reasoning', { text, source: 'director' }),
      });
      metrics.directorLatencyMs = directorResult.latencyMs;
      metrics.directorTokens = directorResult.tokens;
      metrics.retries = directorResult.retries;
      metrics.memorySource = memorySource;
      directorRawOutput = directorResult.rawOutput ?? null;
      directorReasoning = includeThinking ? (directorResult.reasoning || null) : null;

      // 角色主体性指标（E 模式 Brief 里带 characterContribution）
      const charContribution = directorResult.brief?.characterContribution;
      if (charContribution) {
        metrics.characterHasContribution = Boolean(charContribution.hasContribution);
        metrics.characterInitiative = charContribution.initiative ?? null;
        metrics.characterMove = charContribution.initiativeMove ?? null;
        metrics.characterStrength = charContribution.strength ?? null;
        metrics.characterTopic = charContribution.topic ? String(charContribution.topic) : null;
      }

      if (directorResult.ok) {
        brief = directorResult.brief;
        validation = directorResult.validation;
        // Generator 只使用白名单校验后的记忆原文（只给被选中的，附来源标注）
        const selectedIds = new Set(
          (brief.personalization?.selectedMemories ?? []).map((m) => m.memoryId)
        );
        const selectedMemoryObjects = candidateMemories.filter((m) => selectedIds.has(m.id));
        generatorMessages = await buildBriefDrivenMessages({
          message,
          history,
          data,
          selectedMemories: selectedMemoryObjects,
          brief,
          mode: effectiveDirectorMode,
          characterCore: mode === 'E' ? data.characterCore : undefined,
          characterState: mode === 'E' ? data.characterState : undefined,
        });
        emit('brief', {
          brief,
          validation,
          metrics: {
            directorLatencyMs: metrics.directorLatencyMs,
            directorTokens: metrics.directorTokens,
            retries: metrics.retries,
          },
        });
      } else {
        // 校验两次（含修复重试）均失败 → 保守降级：跳过 Brief，按 A 组方式生成
        // 绝不把 Director 的 JSON 当回复发给用户
        metrics.degraded = true;
        validation = directorResult.validation;
        generatorMessages = await buildSingleModelMessages({ message, history, data, mode: 'A' });
        emit('brief', {
          brief: null,
          validation,
          degraded: true,
          metrics: {
            directorLatencyMs: metrics.directorLatencyMs,
            directorTokens: metrics.directorTokens,
            retries: metrics.retries,
          },
        });
      }
    }

    // ---- Generator 流式生成（思考开启时先流思考再流正文；工具调用经 tool_call/tool_result 事件外推）----
    emit('stage', { stage: 'generator', status: 'start' });
    const gen = await runGenerator({
      client,
      messages: generatorMessages,
      externalSignal,
      includeThinking,
      enableSearch,
      toolOptions,
      onDelta: (text) => emit('delta', { text }),
      onReasoning: (text) => emit('reasoning', { text, source: 'generator' }),
      onToolCall: (info) => emit('tool_call', info),
      onToolResult: (info) => emit('tool_result', info),
    });
    reply = gen.reply;
    generatorReasoning = includeThinking ? (gen.reasoning || null) : null;
    toolCallsLog = gen.toolCallsLog ?? [];
    metrics.generatorFirstTokenMs = gen.firstTokenMs;
    metrics.generatorFirstContentMs = gen.firstContentMs;
    metrics.generatorTokens = gen.tokens;
    metrics.generatorUsageKnown = gen.usageKnown;
    metrics.totalLatencyMs = Date.now() - startedAt;
    metrics.estimatedCostCNY = estimateCostCNY({
      directorTokens: metrics.directorTokens,
      generatorTokens: metrics.generatorTokens,
    });

    emit('done', { metrics, degraded: metrics.degraded });

    // 服务端控制台：本轮汇总（总耗时 / Director 耗时 / 成本 / 是否降级 + Brief 摘要）
    logTurnSummary({ mode, metrics, brief });

    // CompanionMem 写入（fire-and-forget，不阻塞响应）：将本轮对话交给服务端异步蒸馏
    // （L0→L1）。受 MEMORY_WRITE 开关控制，默认关闭——agent_id 与 Yodada 生产设备
    // 共享记忆库，写入会混入生产记忆，需在 .env 显式开启
    if (companionMemClient && reply.trim().length > 0) {
      companionMemClient
        .add(message, reply)
        .then((ok) => {
          if (ok) console.log('[companionmem] 本轮对话已写入记忆库（服务端异步蒸馏 L0→L1 中）');
        })
        .catch(() => {});
    }

    // 写 JSONL 日志
    logger.log({
      timestamp: new Date().toISOString(),
      mode,
      message,
      route: routeResult
        ? {
            path: routeResult.path,
            confidence: routeResult.confidence,
            reason: routeResult.reason,
            engine: routeResult.engine,
            safetyHint: Boolean(routeResult.safetyHint),
            fallback: Boolean(routeResult.fallback),
            latencyMs: routeResult.latencyMs,
          }
        : null,
      brief,
      validation,
      reply,
      metrics,
      toolCalls: toolCallsLog,
      directorRawOutput,
      directorReasoning,
      generatorReasoning,
    });

    return { reply, brief, validation, metrics, loggerFile: logger.filePath };
  } catch (err) {
    // 异常路径也留痕（含部分已生成的回复），随后向上抛给 API 层发 error 事件
    metrics.totalLatencyMs = Date.now() - startedAt;
    logger.log({
      timestamp: new Date().toISOString(),
      mode,
      message,
      brief,
      validation,
      reply,
      metrics,
      directorRawOutput,
      directorReasoning,
      generatorReasoning,
      error: err?.message ?? String(err),
    });
    throw err;
  }
}
