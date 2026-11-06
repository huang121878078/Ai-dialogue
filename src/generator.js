/**
 * generator.js — Generator 消息组装（单模型 A/B 与双模型 C/D 两种输入）与流式生成
 */

import { readFile } from 'node:fs/promises';
import { TEMPERATURES } from './model-client.js';

/** 最近历史最多保留的轮数（一轮 = 用户+助手） */
const MAX_HISTORY_ROUNDS = 10;

/** 思考模式开启时附加的思考指令：约束长度（语言无法控制——实测思考语言由模型自选） */
const GENERATOR_THINKING_DIRECTIVE =
  '\n\n## 思考模式要求\n思考过程请尽量精简（150 字以内），只写：当前情绪判断、要自然融入的记忆、语气与长度把握。';

/**
 * 联网搜索开启时附加的工具护栏：搜索结果带来源回填，约束模型自然融合（对齐 Yodada 实测经验）
 * 实测教训：长上下文（Brief+记忆）下模型会「假装搜过了」然后凭训练记忆编内容——必须显式禁止
 */
const SEARCH_GUARD_DIRECTIVE =
  '\n\n## 联网搜索工具使用要求\n你已挂载 web_search 工具，搜索结果会以「标题/来源/链接/摘要」的 Markdown 回填。请遵守：\n1. **用户要求搜索（帮我搜/查一下/联网查）或问题需要实时资讯（新闻/天气/最新动态）时，必须真正调用 web_search 工具——绝不允许「假装已经搜过」然后凭自己记忆编造内容。** 输入中的参考资料（Brief、记忆）不包含任何实时信息。\n2. 严格遵守工具描述里的调用原则——能自己准确回答的常识问题不搜，情绪陪伴类对话绝不搜。\n3. 搜索结果只是素材——回复中不要出现「知识库」「搜索结果」「根据资料」等字眼，像自己本来就知道一样自然地说；需要提及出处时口语化带一句来源即可。\n4. 保持你的人格和口语风格，不用标题、列表、结构化排版。\n5. 涉及「今天几号/星期几/现在几点」优先用上下文中的系统时钟或 getLocalTime 工具，搜索资料可能滞后。\n6. 搜索到的信息不确定时坦白说不确定，不要编造细节。';

/**
 * 运行时时钟上下文（每轮注入 Director / Generator 的输入）
 * 设计依据（PM 方案 6.2）：当前日期、星期、时间以「运行时系统时钟 + 明确时区」为准，
 * 杜绝模型用训练数据或静态记忆充当当前时间（防「今天星期几」类问题瞎编）
 * @param {Date} [now] 可注入的时钟（默认当前时间；测试可传固定值）
 * @returns {string}
 */
export function buildTimeContext(now = new Date()) {
  const fmt = new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    weekday: 'long',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
  return [
    '## 当前时间（系统运行时时钟，可信；涉及时间判断一律以此为准，勿用记忆或猜测推断）',
    `${fmt.format(now)}（UTC+8 北京时间）`,
  ].join('\n');
}

let promptCache = null;

/** Character Agency 段落裁剪标记（仅 E 模式保留） */
const AGENCY_START = '<!-- AGENCY:START -->';
const AGENCY_END = '<!-- AGENCY:END -->';

/**
 * 读取 Generator 系统提示词；E 模式保留角色主体性段，A/B/C/D 裁掉
 * @param {'A'|'B'|'C'|'D'|'E'} mode
 * @returns {Promise<string>}
 */
async function loadGeneratorPrompt(mode) {
  if (promptCache === null) {
    promptCache = await readFile(
      new URL('../prompts/generator.system.md', import.meta.url),
      'utf-8'
    );
  }
  if (mode === 'E') return promptCache;
  const startIdx = promptCache.indexOf(AGENCY_START);
  const endIdx = promptCache.indexOf(AGENCY_END);
  if (startIdx === -1 || endIdx === -1 || endIdx < startIdx) return promptCache;
  return promptCache.slice(0, startIdx) + promptCache.slice(endIdx + AGENCY_END.length);
}

/**
 * 截取最近 N 轮历史（最多 10 轮）
 * @param {Array<{role: string, content: string}>} history
 * @returns {Array<{role: string, content: string}>}
 */
export function takeRecentHistory(history) {
  const safe = Array.isArray(history) ? history.filter(
    (h) => h && (h.role === 'user' || h.role === 'assistant') && typeof h.content === 'string'
  ) : [];
  return safe.slice(-MAX_HISTORY_ROUNDS * 2);
}

/**
 * 渲染历史为文本
 * @param {Array<{role: string, content: string}>} history
 * @returns {string}
 */
function renderHistory(history) {
  if (history.length === 0) return '（无——本轮是会话第一条消息）';
  return history.map((h) => `${h.role === 'user' ? '阿哲' : '小满'}：${h.content}`).join('\n');
}

/**
 * 渲染记忆列表文本（带必要 status 标注）
 * 注意：绝不渲染 id——记忆编号（如 M001）是系统内部标识，一旦进入 Generator 输入
 * 就可能被模型抄进用户可见的回复（实测泄露「（M003）」等），因此只给内容与状态
 * @param {Array<object>} memories 记忆原文对象（含 content/status）
 * @returns {string}
 */
function renderMemories(memories) {
  if (!memories || memories.length === 0) return '（本轮无可用记忆）';
  // 归属前缀强制标注：这些记忆都属于「用户」——防止模型把用户的人/宠物/经历挪用成自己的
  // （实测：仅靠 prompt 文字约束不够，模型为表现"有生活"会说「我家芝麻」，出现记忆归属错误）
  return memories
    .map((m) => `- 【用户的记忆】${m.content}（状态：${m.status}）`)
    .join('\n');
}

/**
 * A/B 模式（单模型）：system = persona + 数据摘要；user = 静态数据文本 + 最近历史 + 当前消息
 * A 注入全部记忆；B 只注入 curated: true 的精选子集
 * @param {{ message: string, history: Array<object>, data: object, mode: 'A'|'B' }} params
 * @returns {Promise<Array<{role: string, content: string}>>}
 */
export async function buildSingleModelMessages({ message, history, data, mode }) {
  const system = [
    await loadGeneratorPrompt(mode),
    '',
    '## 你的人格设定（persona）',
    JSON.stringify(data.persona, null, 2),
    '',
    '## 用户画像',
    JSON.stringify(data.userProfile, null, 2),
    '',
    '## 用户近期情绪状态',
    JSON.stringify(data.emotion, null, 2),
    '',
    '## 关系状态',
    JSON.stringify(data.relationship, null, 2),
  ].join('\n');

  const memories =
    mode === 'B' ? data.memories.filter((m) => m.curated === true) : data.memories;

  const recent = takeRecentHistory(history);
  const user = [
    buildTimeContext(),
    '',
    '## 关于用户的记忆（只用这里提供的，不编造）',
    renderMemories(memories),
    '',
    '## 最近对话历史',
    renderHistory(recent),
    '',
    '## 用户最新消息',
    message,
  ].join('\n');

  return [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];
}

/**
 * Fast Path（R 模式路由判定为简单对话时）：Generator 直答，跳过 Director
 * 上下文刻意保持轻量：persona + 运行时时间 + 最近历史 + 用户画像，**不含记忆列表**——
 * 记忆筛选是 Director 的职责，路由层认为简单对话用不到；若用户问到共同记忆，
 * Generator 坦诚说这轮没带记忆（不编造），下一轮路由大概率会送认知路径
 * @param {{ message: string, history: Array<object>, data: object }} params
 * @returns {Promise<Array<{role: string, content: string}>>}
 */
export async function buildFastPathMessages({ message, history, data }) {
  const system = [
    await loadGeneratorPrompt('A'),
    '',
    '## 你的人格设定（persona）',
    JSON.stringify(data.persona, null, 2),
    '',
    '## 用户画像',
    JSON.stringify(data.userProfile, null, 2),
    '',
    '## 本轮为快速通道',
    '本轮没有加载记忆资料（对话被路由层判定为简单交流）。自然回复即可；',
    '若用户问到过去的对话或共同记忆，坦诚说这一轮没带记忆，不要编造任何共同经历。',
  ].join('\n');

  const recent = takeRecentHistory(history);
  const user = [
    buildTimeContext(),
    '',
    '## 最近对话历史',
    renderHistory(recent),
    '',
    '## 用户最新消息',
    message,
  ].join('\n');

  return [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];
}

/**
 * 清洗 Brief 中会泄露内部标识的字段（Generator 视角）：
 * personalization.selectedMemories 各项去掉 memoryId（保留 reason / usageSuggestion 等
 * 对回复有用的信息）——内部记忆编号绝不能进入 Generator 输入，否则会被抄进用户回复
 * @param {object} brief Director 输出的 Brief
 * @returns {object} 清洗后的 Brief 浅拷贝（不动原对象）
 */
function sanitizeBriefForGenerator(brief) {
  if (!brief || typeof brief !== 'object' || !brief.personalization) return brief;
  const selected = brief.personalization.selectedMemories;
  if (!Array.isArray(selected)) return brief;
  return {
    ...brief,
    personalization: {
      ...brief.personalization,
      selectedMemories: selected.map((item) =>
        item && typeof item === 'object'
          ? { relevance: item.relevance, reason: item.reason, usageSuggestion: item.usageSuggestion }
          : item
      ),
    },
  };
}

/**
 * C/D 模式（双模型）：输入 = 当前消息 + 最近历史 + persona + relationship
 * + 白名单校验后的记忆原文 + Brief（C 含策略，D 不含）
 * @param {{ message: string, history: Array<object>, data: object, selectedMemories: Array<object>, brief: object, mode: 'C'|'D' }} params
 * @returns {Promise<Array<{role: string, content: string}>>}
 */
export async function buildBriefDrivenMessages({
  message,
  history,
  data,
  selectedMemories,
  brief,
  mode,
  characterCore,
  characterState,
}) {
  const systemLines = [
    await loadGeneratorPrompt(mode),
    '',
    '## 你的人格设定（persona）',
    JSON.stringify(data.persona, null, 2),
    '',
    '## 关系状态',
    JSON.stringify(data.relationship, null, 2),
  ];
  // E 模式：角色自身认知的稳定层并入 system（它是"你是谁"的一部分，长期不变）
  if (mode === 'E' && characterCore) {
    systemLines.push(
      '',
      '## 你的认知核心（character_core：你的价值观、偏好与观点强度策略）',
      JSON.stringify(characterCore, null, 2)
    );
  }
  const system = systemLines.join('\n');

  // D 模式绝不把策略给 Generator（Brief 中本就不应含有，此处再保险剔除一次）；
  // 所有模式：Brief 内的 memoryId 等内部标识一律清洗掉（见 sanitizeBriefForGenerator）
  let briefForGenerator = brief;
  if (brief && typeof brief === 'object') {
    briefForGenerator = sanitizeBriefForGenerator(brief);
    if (mode === 'D') {
      briefForGenerator = { ...briefForGenerator, conversationStrategy: undefined };
    }
  }

  const recent = takeRecentHistory(history);
  const userLines = [
    buildTimeContext(),
    '',
    '## 本轮参考资料（内部信息，供参考，不要直接复述字段名）',
    '',
    '### 已校验记忆（只使用这些，不编造共同经历）',
    renderMemories(selectedMemories),
    '',
    '### 本轮对话分析 Brief（策略是参考方案，不是逐字脚本）',
    JSON.stringify(briefForGenerator, null, 2),
  ];
  // E 模式：角色动态状态放 user（本轮参考），并明确"这些是你自己的，不是用户的"
  if (mode === 'E' && characterState) {
    userLines.push(
      '',
      '### 你自己的当前状态（character_state：你的关注、观点、待续话题、主动度）',
      JSON.stringify(characterState, null, 2),
      '',
      '这些是你自己的想法和兴趣，不是用户的。可以自然地分享、或接着上次的话题继续，' +
        '但不要为了显得有主见而硬塞——本轮不适合就什么都不说。'
    );
  }
  userLines.push('', '## 最近对话历史', renderHistory(recent), '', '## 用户最新消息', message);
  const user = userLines.join('\n');

  return [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];
}

/**
 * 流式生成回复（带 function calling 工具循环）
 * 模型可自主调用挂载的工具（web_search / getLocalTime）：工具轮执行后回填结果再继续生成，
 * 最多 MAX_TOOL_ROUNDS 轮，最终一轮的 content 即用户可见回复
 * @param {{ client: object, messages: Array<object>, onDelta: Function, onReasoning?: Function,
 *   onToolCall?: Function, onToolResult?: Function, externalSignal?: AbortSignal,
 *   includeThinking?: boolean, enableSearch?: boolean, toolOptions?: object }} params
 *   includeThinking 开启时思考增量经 onReasoning 实时回调（供前端展示），正文经 onDelta 流式
 *   enableSearch 开启时挂载 web_search 工具（模型按调用原则自主决定是否搜索，IQS 独立搜索 API）
 *   onToolCall/onToolResult：工具调用/结果回调（前端状态条：{name, label} / {name, label, output}）
 * @returns {Promise<{reply: string, reasoning: string, firstTokenMs: number|null, firstContentMs: number|null, tokens: {input: number, output: number}, usageKnown: boolean, toolCallsLog: Array<object>}>}
 */
export async function runGenerator({
  client,
  messages,
  onDelta,
  onReasoning,
  onToolCall,
  onToolResult,
  externalSignal,
  includeThinking = false,
  enableSearch = false,
  toolOptions = {},
}) {
  let reply = '';
  let reasoning = '';
  let firstTokenMs = null;
  let firstContentMs = null;
  const tokens = { input: 0, output: 0 };
  let usageKnown = true;
  /** 工具调用记录（日志与前端展示用） */
  const toolCallsLog = [];

  // 组装本轮消息：思考指令与搜索护栏按需追加到 system prompt
  let systemContent = messages[0]?.content ?? '';
  if (includeThinking) systemContent += GENERATOR_THINKING_DIRECTIVE;
  if (enableSearch) systemContent += SEARCH_GUARD_DIRECTIVE;
  const effectiveMessages =
    includeThinking || enableSearch
      ? [{ ...messages[0], content: systemContent }, ...messages.slice(1)]
      : messages.map((m) => ({ ...m }));

  // 工具挂载：getLocalTime 始终在（零成本），web_search 按开关（且 IQS key 已配置）
  const { getToolDefinitions, executeTool, MAX_TOOL_ROUNDS } = await import('./tools.js');
  const tools = getToolDefinitions({ enableSearch, iqsApiKey: toolOptions.iqsApiKey });

  // ---- 工具循环：模型发起 tool_calls → 执行 → 回填 → 再生成，直到产出最终正文 ----
  for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
    const isFinalChance = round === MAX_TOOL_ROUNDS;
    // 最后一轮不再挂工具，强制模型直接作答（防不收敛）
    const roundTools = isFinalChance ? undefined : tools.length > 0 ? tools : undefined;

    const result = await client.streamChatCompletion({
      messages: effectiveMessages,
      temperature: TEMPERATURES.generator,
      externalSignal,
      enableThinking: includeThinking,
      tools: roundTools,
      // 服务端控制台日志：标注调用阶段（工具轮的 label 标注轮次）
      stage: 'generator',
      label: round > 0 ? `工具轮 ${round + 1}` : undefined,
      onDelta: (text) => {
        reply += text;
        onDelta(text);
      },
      onReasoning: (text) => {
        reasoning += text;
        if (onReasoning) onReasoning(text);
      },
    });

    // 累计 tokens（工具轮也计费）
    tokens.input += result.promptTokens;
    tokens.output += result.completionTokens;
    if (!result.usageKnown) usageKnown = false;
    if (firstTokenMs === null && result.firstTokenMs !== null) firstTokenMs = result.firstTokenMs;
    if (firstContentMs === null && result.firstContentMs !== null) firstContentMs = result.firstContentMs;

    // 无工具调用（或已到最后一轮）：本轮 content 即最终回复
    if (!Array.isArray(result.toolCalls) || result.toolCalls.length === 0) {
      break;
    }
    if (isFinalChance) {
      // 最后一轮仍在请求工具：不执行，直接以已有内容收尾
      console.warn('[generator] 达到工具轮数上限，强制收尾');
      break;
    }

    // ---- 执行工具并回填 ----
    // assistant 消息须带上 tool_calls 原样回传（OpenAI 协议要求）
    effectiveMessages.push({
      role: 'assistant',
      content: result.content || '',
      tool_calls: result.toolCalls.map((t) => ({
        id: t.id,
        type: 'function',
        function: { name: t.name, arguments: t.arguments },
      })),
    });
    for (const tc of result.toolCalls) {
      const { output, label } = await executeTool(tc, toolOptions);
      toolCallsLog.push({ name: tc.name, arguments: tc.arguments, output: output.slice(0, 2000) });
      if (onToolCall) onToolCall({ name: tc.name, label });
      if (onToolResult) onToolResult({ name: tc.name, label, output: output.slice(0, 400) });
      effectiveMessages.push({ role: 'tool', tool_call_id: tc.id, content: output });
    }
    // 工具轮后模型将重新生成：清空累积正文，避免中间轮只言片语混入最终回复
    reply = '';
  }

  return {
    reply,
    reasoning,
    firstTokenMs,
    firstContentMs,
    tokens,
    usageKnown,
    toolCallsLog,
  };
}
