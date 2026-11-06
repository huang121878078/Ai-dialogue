/**
 * director.js — Director 模型调用、输出解析与校验（含一次修复重试）
 * C 模式：输出完整 Brief（含 conversationStrategy）
 * D 模式：裁剪 system prompt 的 Strategy 段并附加禁令，schema 禁止该字段
 * E 模式（C + Character Agency）：Strategy + Character 两段均启用，schema 额外要求 characterContribution
 */

import { readFile } from 'node:fs/promises';
import { extractJson, validateBrief, validateMemoryWhitelist, getStrictJsonSchema } from './validators.js';
import { TEMPERATURES } from './model-client.js';
import { takeRecentHistory, buildTimeContext } from './generator.js';

/** Strategy 段落的裁剪标记（与 prompts/director.system.md 中注释对齐） */
const STRATEGY_START = '<!-- STRATEGY:START -->';
const STRATEGY_END = '<!-- STRATEGY:END -->';
/** Character Agency 段落的裁剪标记（仅 E 模式保留，C/D 裁掉） */
const CHARACTER_START = '<!-- CHARACTER:START -->';
const CHARACTER_END = '<!-- CHARACTER:END -->';
/** D 模式附加在 system prompt 末尾的禁令 */
const D_MODE_BAN =
  '\n\n## D 模式附加要求\n本模式你只做理解与记忆分析：不要输出 conversationStrategy 与 characterContribution 字段（策略与角色贡献由下游自行决定）。';

/** 思考模式开启时附加的思考指令：约束长度（语言无法控制——实测 qwen3.7-flash 思考多为英文，模型固有行为） */
const DIRECTOR_THINKING_DIRECTIVE =
  '\n\n## 思考模式要求\n思考过程请尽量精简（200 字以内），只写最关键的判断：用户意图与情绪、记忆取舍理由、策略选择依据。不要罗列或翻译输入内容。';

/** 按需在 system prompt 后追加思考指令（不改变原有 prompt 内容） */
function withThinkingDirective(messages, directive) {
  if (messages.length === 0 || typeof messages[0].content !== 'string') return messages;
  return [{ ...messages[0], content: messages[0].content + directive }, ...messages.slice(1)];
}

/** 已加载的 prompt 缓存 */
let promptCache = null;

/**
 * 读取 Director 系统提示词（完整版）
 * @returns {Promise<string>}
 */
async function loadDirectorPrompt() {
  if (promptCache === null) {
    promptCache = await readFile(
      new URL('../prompts/director.system.md', import.meta.url),
      'utf-8'
    );
  }
  return promptCache;
}

/**
 * 按 mode 生成 Director 的 system prompt
 * 裁剪规则（prompt 文件保留完整版，代码动态裁剪）：
 *  - C：裁掉 CHARACTER 段（无角色主体性）
 *  - D：裁掉 STRATEGY + CHARACTER 段，并附加禁令
 *  - E：两段全保留（C + Character Agency）
 * @param {'C'|'D'|'E'} mode
 * @returns {Promise<string>}
 */
export async function buildDirectorSystemPrompt(mode) {
  const full = await loadDirectorPrompt();
  const cutSection = (text, startMark, endMark) => {
    const startIdx = text.indexOf(startMark);
    const endIdx = text.indexOf(endMark);
    if (startIdx === -1 || endIdx === -1 || endIdx < startIdx) return null;
    return text.slice(0, startIdx) + text.slice(endIdx + endMark.length);
  };

  if (mode === 'E') return full;

  // C/D：移除角色主体性段
  let out = full;
  const withoutCharacter = cutSection(out, CHARACTER_START, CHARACTER_END);
  if (withoutCharacter !== null) out = withoutCharacter;

  if (mode === 'C') return out;

  // D：再裁掉策略段并附加禁令
  const withoutStrategy = cutSection(out, STRATEGY_START, STRATEGY_END);
  return (withoutStrategy ?? out) + D_MODE_BAN;
}

/**
 * 组装 Director 输入消息
 * @param {{ message: string, history: Array<{role: string, content: string}>, data: object, mode: 'C'|'D'|'E', memories?: Array<object>, characterCore?: object, characterState?: object }} params
 *   memories：候选记忆列表（缺省 data.memories 静态数据；配置 Mem0 后由编排层实时检索传入）
 *   characterCore / characterState：E 模式的角色自身认知数据（稳定层 + 动态层）
 * @returns {Promise<Array<{role: string, content: string}>>}
 */
export async function buildDirectorMessages({ message, history, data, mode, memories, characterCore, characterState }) {
  const system = await buildDirectorSystemPrompt(mode);
  const candidateMemories = Array.isArray(memories) ? memories : data.memories;

  // 与 Generator 侧一致：历史最多保留 10 轮（20 条），避免 Director 输入无限膨胀
  const recent = takeRecentHistory(history);
  const historyText =
    recent.length === 0
      ? '（无——本轮是会话第一条消息）'
      : recent.map((h) => `${h.role === 'user' ? '用户' : '助手'}：${h.content}`).join('\n');

  const memoryList = candidateMemories
    .map(
      (m) =>
        `- [${m.id}] ${m.content}（类型 ${m.type} / 状态 ${m.status} / 重要度 ${m.importance}）`
    )
    .join('\n');

  const userLines = [
    buildTimeContext(),
    '',
    '## 用户最新消息',
    message,
    '',
    '## 最近对话历史',
    historyText,
    '',
    '## 候选记忆列表（memoryId 只能从这里选，不编造）',
    memoryList,
    '',
    '## 用户画像',
    JSON.stringify(data.userProfile, null, 2),
    '',
    '## 用户近期情绪状态',
    JSON.stringify(data.emotion, null, 2),
    '',
    '## 关系状态',
    JSON.stringify(data.relationship, null, 2),
  ];

  // E 模式：注入角色自身认知数据（Character Cognition）——Director 据此判断本轮角色是否有
  // 值得贡献的观点/兴趣/待续话题（character_contribution），而不是只围绕用户转
  if (mode === 'E' && characterCore && characterState) {
    userLines.push(
      '',
      '## 角色认知·稳定层（character_core：这个角色是谁、信什么、偏好什么）',
      JSON.stringify(characterCore, null, 2),
      '',
      '## 角色认知·动态层（character_state：角色当前关注、观点、待续话题、主动度）',
      JSON.stringify(characterState, null, 2),
      '',
      '注意：角色偏好与用户偏好是两套独立数据——用户喜欢 RPG 不代表角色也喜欢；' +
        '角色可以说出自己的偏好并与用户讨论差异，但不要把自己的偏好说成用户的。'
    );
  }

  userLines.push('', '请基于以上输入输出 Dynamic Conversation Brief（一个合法 JSON 对象）。');

  const user = userLines.join('\n');

  return [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];
}

/**
 * 执行 Director 一轮：调用（流式，思考可实时外推）→ JSON 提取 → Ajv 校验 → 记忆白名单校验
 * 校验失败时带错误信息做一次修复重试；仍失败返回 ok: false（由编排层降级）
 * @param {{ client: object, message: string, history: Array<object>, data: object, mode: 'C'|'D',
 *   includeThinking?: boolean, onReasoning?: Function, externalSignal?: AbortSignal }} params
 *   includeThinking：开启 qwen3.7 思考模式，思考增量经 onReasoning 实时回调（供前端展示）
 *   externalSignal：客户端断开信号（传给上游调用，断开即中止，不再白跑）
 * @returns {Promise<{ok: boolean, brief: object|null, validation: object, latencyMs: number, tokens: {input: number, output: number}, retries: number, errors: string[], rawOutput: string, reasoning: string}>}
 */
export async function runDirectorTurn({
  client,
  message,
  history,
  data,
  mode,
  includeThinking = false,
  onReasoning,
  externalSignal,
  memories,
  characterCore,
  characterState,
}) {
  const baseMessages = await buildDirectorMessages({
    message,
    history,
    data,
    mode,
    memories,
    characterCore,
    characterState,
  });
  const candidateMemories = Array.isArray(memories) ? memories : data.memories;

  // 修复重试会发起第二次调用：耗时与 token 需累加，避免第一次的用量丢失、成本低估
  let latencyMs = 0;
  let tokens = { input: 0, output: 0 };
  let lastErrors = [];
  let lastRaw = '';
  /** 各次尝试的原始文本输出（含校验失败的，供日志诊断用） */
  const rawOutputs = [];
  /** 各次尝试的思考全文（开启思考模式时） */
  let reasoningAll = '';

  /** 最多 2 次尝试（1 次修复重试） */
  for (let attempt = 0; attempt <= 1; attempt++) {
    const messages =
      attempt === 0
        ? baseMessages
        : [
            ...baseMessages,
            { role: 'assistant', content: lastRaw || '（无输出）' },
            {
              role: 'user',
              content: [
                '你上一次的输出未通过校验，错误如下：',
                ...lastErrors.map((e) => `- ${e}`),
                '',
                '请严格修正这些问题，重新输出**完整的** Brief JSON（一个 JSON 对象，无代码围栏、无解释文字）。',
              ].join('\n'),
            },
          ];

    const startedAt = Date.now();
    // 流式调用 + json_schema 严格模式：约束解码阶段即强制 schema 合规（Ajv 校验作为双保险保留）；
    // 思考开启时思考增量实时外推（用户能看到「Director 是怎么想的」），正文在内部累积后统一校验
    const result = await client.streamChatCompletion({
      messages: includeThinking ? withThinkingDirective(messages, DIRECTOR_THINKING_DIRECTIVE) : messages,
      temperature: TEMPERATURES.director,
      jsonSchema: {
        name: 'dynamic_conversation_brief',
        schema: getStrictJsonSchema(mode),
      },
      enableThinking: includeThinking,
      externalSignal,
      onReasoning: includeThinking && onReasoning ? onReasoning : undefined,
      // 服务端控制台日志：标注调用阶段（第 2 次为校验失败的修复重试）
      stage: 'director',
      label: attempt === 0 ? undefined : '修复重试',
    });
    const content = result.content;
    // 累加（重试时保留第一次调用的耗时与 token）
    latencyMs += Date.now() - startedAt;
    tokens = {
      input: tokens.input + result.promptTokens,
      output: tokens.output + result.completionTokens,
    };
    lastRaw = content;
    rawOutputs.push(content);
    if (includeThinking && result.reasoning) {
      reasoningAll = reasoningAll ? `${reasoningAll}\n\n（修复重试的思考）\n\n${result.reasoning}` : result.reasoning;
    }

    try {
      const brief = extractJson(content);
      const verdict = validateBrief(brief, mode);
      if (verdict.valid) {
        // 记忆白名单校验：违规项剔除并记录（不触发重试）
        const whitelist = validateMemoryWhitelist(
          brief.personalization?.selectedMemories ?? [],
          candidateMemories
        );
        if (whitelist.removed.length > 0) {
          brief.personalization.selectedMemories = whitelist.kept;
        }
        return {
          ok: true,
          brief,
          validation: {
            passed: true,
            retried: attempt > 0,
            ajvErrors: [],
            removedMemoryIds: whitelist.removed.map((r) => r?.memoryId ?? String(r)),
          },
          latencyMs,
          tokens,
          retries: attempt,
          errors: [],
          rawOutput: rawOutputs.join('\n\n<<<RETRY-ATTEMPT>>>\n\n'),
          reasoning: reasoningAll,
        };
      }
      lastErrors = verdict.errors;
    } catch (err) {
      // JSON 提取 / 解析失败
      lastErrors = [err.message];
    }
  }

  return {
    ok: false,
    brief: null,
    validation: {
      passed: false,
      retried: true,
      ajvErrors: lastErrors,
      removedMemoryIds: [],
    },
    latencyMs,
    tokens,
    retries: 1,
    errors: lastErrors,
    // 校验失败时更要留原始输出，便于事后诊断降级原因
    rawOutput: rawOutputs.join('\n\n<<<RETRY-ATTEMPT>>>\n\n'),
    reasoning: reasoningAll,
  };
}
