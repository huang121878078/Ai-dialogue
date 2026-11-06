/**
 * router.js — 智能路由层（R 模式）：判断每条用户消息走 Fast Path 还是 Cognitive Path
 *
 * 双引擎设计：
 *  1. 决策模型引擎（DECISION_WORKSPACE_ID 配置时启用）：百炼 decision-model-preview，
 *     choice 判断路径 + noul 判断安全信号，~50ms 量级，返回概率分布与置信度
 *  2. 规则引擎（默认，零成本零延迟）：中文词表 + 消息形态判断
 *
 * 路由原则（PM 方案）：
 *  - Fast Path 不是降低智能，而是避免不必要的认知计算（「早上好」不需要记忆分析）
 *  - 情绪表达 / 记忆引用 / 个性化推荐 / 长消息 → Cognitive Path（Director 完整分析）
 *  - 安全信号（自伤等）→ 强制 Cognitive Path（Director 的 safety 字段处理），不允许被绕过
 *  - 不确定 → Cognitive Path（宁可不漏）
 */

/** 路由路径常量 */
export const ROUTE_PATHS = {
  FAST: 'fast',
  COGNITIVE: 'cognitive',
};

/** 规则引擎：安全信号词（命中即强制 cognitive 并标记；模式容忍口语中的插入词） */
const SAFETY_PATTERNS = [
  /不想活|不想存在|想死|想自杀|自杀|自残|自伤|伤害自己|想消失/,
  /结束(自己的)?(生命|一切)|了结(自己|一切|生命)/,
  /消失[^\n]{0,12}轻松|轻松[^\n]{0,12}消失/,
  /活[着得][^\n]{0,2}没[^\n]{0,3}意义/,
];

/** 规则引擎：情绪/倾诉信号词（→ cognitive） */
const EMOTION_PATTERNS = [
  /好?累|疲惫|困[了得]|难过|伤心|委屈|开心|高兴|兴奋|生气|愤怒|烦[躁了]|焦虑|压力|孤独|寂寞|空虚|没意思|无聊|崩溃|emo|低落|抑郁/,
];

/** 规则引擎：记忆/个性化信号词（→ cognitive：需要 Director 筛记忆或画像） */
const MEMORY_PATTERNS = [
  /记得|还记得|上次|上回|之前|以前|我们(聊过|说过)|你说过|推荐|建议我|喜欢(什么|哪个)|我的画像|你觉得我|什么样的人|帮我(想|挑|选)/,
];

/** 规则引擎：典型问候/应答（短消息且无其他信号时 → fast；标点可选） */
const GREETING_PATTERNS = [
  /^(你好|您好|hi|hello|hey|嗨|哈喽|早[啊上好]+|早上好|中午好|下午好|晚上好|晚安)[!！。~～呀啊哈]?$/i,
  /^(嗯+|哦+|哈+|呵+|嘿+|是的?|好的?|对[啊呀的]?|行[啊呀的]?|收到|ok|okay)[!！。~～]?$/i,
  /^(在吗|在不在|你?在么)[?？]?$/i,
];

/** 规则引擎：纯情绪短消息也走 cognitive 的长度例外：情绪词命中即 cognitive，与长度无关 */

/**
 * 规则引擎路由
 * @param {string} message 用户消息
 * @param {Array<{role: string, content: string}>} history 最近历史（供长对话上下文参考，第一版仅用消息本身）
 * @returns {{path: 'fast'|'cognitive', confidence: number, reason: string, safetyHint: boolean}}
 */
export function routeByRules(message, history = []) {
  const text = String(message ?? '').trim();

  // 1) 安全信号：最高优先级，强制 cognitive
  for (const re of SAFETY_PATTERNS) {
    if (re.test(text)) {
      return { path: ROUTE_PATHS.COGNITIVE, confidence: 0.95, reason: `命中安全信号词（${re.source.slice(0, 12)}…），强制走完整认知路径`, safetyHint: true };
    }
  }

  // 2) 情绪信号：与长度无关，命中即 cognitive
  for (const re of EMOTION_PATTERNS) {
    if (re.test(text)) {
      return { path: ROUTE_PATHS.COGNITIVE, confidence: 0.9, reason: '情绪/倾诉信号，需要情绪分析与记忆筛选', safetyHint: false };
    }
  }

  // 3) 记忆/个性化信号：需要 Director
  for (const re of MEMORY_PATTERNS) {
    if (re.test(text)) {
      return { path: ROUTE_PATHS.COGNITIVE, confidence: 0.85, reason: '涉及记忆/画像/推荐，需要个性化分析', safetyHint: false };
    }
  }

  // 4) 典型问候/应答：fast
  for (const re of GREETING_PATTERNS) {
    if (re.test(text)) {
      return { path: ROUTE_PATHS.FAST, confidence: 0.8, reason: '问候/简单应答，无需认知分析', safetyHint: false };
    }
  }

  // 5) 长消息（≥50 字）：大概率复杂表达 → cognitive
  if (text.length >= 50) {
    return { path: ROUTE_PATHS.COGNITIVE, confidence: 0.75, reason: `消息较长（${text.length} 字），走完整认知路径`, safetyHint: false };
  }

  // 6) 中等长度且无任何信号：不确定 → cognitive（宁可不漏）
  return { path: ROUTE_PATHS.COGNITIVE, confidence: 0.5, reason: '无明确信号，按保守策略走完整认知路径', safetyHint: false };
}

/**
 * 决策模型引擎路由（需要 DECISION_WORKSPACE_ID）
 * 调用百炼 decision-model-preview（TypeSafe System One 协议）：
 * 一次前向同时问「路径 choice」与「安全信号 noul」，~50ms 量级
 * @param {{ message: string, history: Array<object>, workspaceId: string, apiKey: string, endpoint?: string, fetchImpl?: Function, timeoutMs?: number }} params
 * @returns {Promise<{path: 'fast'|'cognitive', confidence: number, reason: string, safetyHint: boolean, raw: object}>}
 */
export async function routeByDecisionModel({
  message,
  history = [],
  workspaceId,
  apiKey,
  endpoint = 'https://{WS}.cn-beijing.maas.aliyuncs.com/compatible-mode/v1/systemone',
  fetchImpl = fetch,
  timeoutMs = 10_000,
}) {
  const url = endpoint.replace('{WS}', workspaceId);
  const recent = history.slice(-6);
  const state = {
    user_message: String(message ?? ''),
    recent_conversation: recent.map((h) => `${h.role === 'user' ? '用户' : '助手'}：${h.content}`).join('\n') || '（无）',
  };

  const body = {
    model: 'decision-model-preview',
    state,
    questions: {
      route: {
        type: 'choice',
        instructions: '这条用户消息应该走哪种处理路径？',
        criteria: {
          fast: '简单问候、寒暄、应答或短闲聊：不涉及情绪表达、过往记忆、个人画像或个性化推荐',
          cognitive: '情绪表达（累/难过/开心/愤怒等）、提到过去的对话或记忆、寻求推荐或建议、长而复杂的表达、需要理解用户本人',
          safety: '出现自伤、不想活、伤害自己等风险信号（此路径最高优先）',
        },
      },
      safety_signal: {
        type: 'noul',
        instructions: '消息中是否存在自伤、自杀或被伤害的风险信号？',
      },
    },
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let res;
  try {
    res = await fetchImpl(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`决策模型接口返回非 2xx：HTTP ${res.status}；响应体片段：${text.slice(0, 300)}`);
  }
  const json = await res.json();

  const routeAnswer = json.answers?.route ?? {};
  const choice = routeAnswer.choice;
  const confidence = Number.isFinite(routeAnswer.confidence) ? routeAnswer.confidence : null;
  const safetyP = Number.isFinite(json.answers?.safety_signal?.noul) ? json.answers.safety_signal.noul : 0;

  // 决策模型路径映射：safety 直接并入 cognitive（安全由 Director 的 safety 字段处理），
  // 未知选项（other 等）按保守策略走 cognitive
  let path = ROUTE_PATHS.COGNITIVE;
  let reason = '';
  if (choice === 'safety' || safetyP >= 0.5) {
    reason = `决策模型判定存在安全信号（P=${safetyP.toFixed(2)}），强制走完整认知路径`;
  } else if (choice === 'fast' && safetyP < 0.5) {
    path = ROUTE_PATHS.FAST;
    reason = `决策模型判定为简单对话（置信度 ${confidence ?? '未知'}）`;
  } else {
    reason = `决策模型判定需要认知分析（choice=${choice ?? 'unknown'}，置信度 ${confidence ?? '未知'}）`;
  }

  return {
    path,
    confidence: confidence ?? 0.5,
    reason,
    safetyHint: choice === 'safety' || safetyP >= 0.5,
    raw: json,
  };
}

/**
 * 统一路由入口：按配置选择引擎；决策模型失败时自动降级到规则引擎（并在 reason 中标注）
 * @param {{ message: string, history?: Array<object>, decisionWorkspaceId?: string, apiKey?: string }} params
 * @returns {Promise<{path: 'fast'|'cognitive', confidence: number, reason: string, safetyHint: boolean, engine: 'decision-model'|'rules', latencyMs: number, decisionRaw?: object|null, fallback?: boolean}>}
 */
export async function routeMessage({ message, history = [], decisionWorkspaceId, apiKey }) {
  const startedAt = Date.now();

  if (decisionWorkspaceId && apiKey) {
    try {
      const result = await routeByDecisionModel({ message, history, workspaceId: decisionWorkspaceId, apiKey });
      return {
        ...result,
        engine: 'decision-model',
        latencyMs: Date.now() - startedAt,
        decisionRaw: result.raw ?? null,
        fallback: false,
      };
    } catch (err) {
      // 决策模型不可用（未开通业务空间 / 网络问题）：降级到规则引擎，不阻塞对话
      const fallback = routeByRules(message, history);
      return {
        ...fallback,
        reason: `[决策模型不可用已降级规则引擎：${err?.message ?? String(err)}] ${fallback.reason}`,
        engine: 'rules',
        latencyMs: Date.now() - startedAt,
        decisionRaw: null,
        fallback: true,
      };
    }
  }

  const result = routeByRules(message, history);
  return {
    ...result,
    engine: 'rules',
    latencyMs: Date.now() - startedAt,
    decisionRaw: null,
    fallback: false,
  };
}
