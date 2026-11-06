/**
 * companionmem-client.js — CompanionMem 长记忆客户端（复用 Yodada 生产同款服务）
 *
 * 数据协议与 Yodada CompanionMemLongMemory 一致：
 *  POST {CM_API_URL}/v1/memories/recall，Header Authorization: Bearer <token> + X-Timezone（IANA 名）
 *  body: {agent_id, query, k, [person_ids], [reasoning], [mood_emotion]}
 *  响应: {code, msg, data: {evidence: {results: [...]}, context: {...}}}
 *   - evidence.results：记忆条目 {content, person, usage, time_kind, layer,
 *     event_time_local, created_at_local, confidence, importance, emotion}
 *     layer 分层：l0 原始对话 / l1 蒸馏摘要（服务端 add 时 distill 异步生成）
 *   - context 分区：{time_intent, state: {emotion, health, stress},
 *     relation_state: {person_id, attitude, trust, intimacy, conflict, boundaries}, ...}
 *
 * 写入：POST /v1/memories/add，body: {agent_id, messages: [{role, content}], distill: true}
 *  服务端异步蒸馏（L0→L1），无需等待。默认关闭（MEMORY_WRITE=off）——agent_id 与
 *  Yodada 生产设备共享记忆库，实验台对话写入会混入生产记忆，需明确开启。
 */

/** 默认检索条数（对齐 Yodada：topK 固定 5） */
const DEFAULT_K = 5;
const DEFAULT_TIMEOUT_MS = 10000;

/**
 * CompanionMem 客户端工厂：未配置时返回 null（调用方回落静态/Mem0 数据源）
 * @param {{ apiUrl?: string, apiKey?: string, agentId?: string, writeEnabled?: boolean }} config
 * @returns {{ recall: Function, add: Function } | null}
 */
export function createCompanionMemClient({ apiUrl, apiKey, agentId, writeEnabled = false } = {}) {
  if (!apiUrl || !apiKey || !agentId) return null;
  const base = apiUrl.replace(/\/+$/, '');

  /** 统一请求头（对齐 Yodada：X-Timezone 必带 + Bearer 鉴权） */
  const headers = () => ({
    'Content-Type': 'application/json',
    Authorization: `Bearer ${apiKey}`,
    'X-Timezone': 'Asia/Shanghai',
  });

  /**
   * 将单条召回结果映射为实验台的记忆对象（id 前缀 cm-，content 带 Yodada 同款
   * 「【归属人】+ 元信息」拼装格式，让 Director 在选择时可见层级/置信/事件时间）
   */
  function toMemoryItem(item, index) {
    const parts = [];
    if (item.layer) parts.push(`层 ${item.layer}`);
    if (item.usage) parts.push(String(item.usage));
    const eventTime = item.event_time_local || item.created_at_local;
    if (eventTime) parts.push(item.event_time_local ? `事件时间 ${eventTime}` : `记忆时间 ${eventTime}`);
    if (item.confidence != null && item.confidence !== '') parts.push(`置信 ${item.confidence}`);
    const person = item.person ? `【${item.person}】` : '';
    const metaSuffix = parts.length > 0 ? `（${parts.join('；')}）` : '';
    return {
      id: `cm-${String(index + 1).padStart(3, '0')}`,
      content: `${person}${String(item.content ?? '')}${metaSuffix}`,
      type: item.layer === 'l1' ? 'inference' : 'experience',
      status: 'confirmed',
      importance: Number.isFinite(Number(item.confidence)) ? Number(item.confidence) : 0.5,
      curated: false,
    };
  }

  /**
   * 将 context 分区映射为实验台的 emotion / relationship 输入（有值字段才覆盖，
   * 全空返回 null——调用方保持静态 JSON 兜底）
   */
  function toContextOverride(context) {
    if (!context || typeof context !== 'object') return null;
    const emotion = {};
    const state = context.state ?? {};
    if (state.emotion) emotion.recentEmotion = String(state.emotion);
    if (state.stress || state.health) {
      emotion.trend = [state.stress, state.health].filter(Boolean).join('；');
    }
    const relationship = {};
    const rel = context.relation_state ?? {};
    const relParts = [];
    if (rel.attitude) relParts.push(String(rel.attitude));
    if (rel.trust) relParts.push(`信任 ${rel.trust}`);
    if (rel.intimacy) relParts.push(`亲密 ${rel.intimacy}`);
    if (rel.conflict) relParts.push(`冲突 ${rel.conflict}`);
    if (rel.boundaries) relParts.push(`边界 ${rel.boundaries}`);
    if (relParts.length > 0) {
      relationship.notes = `对${rel.person_id || '用户'}的态度：${relParts.join('、')}`;
    }
    if (context.time_intent && context.time_intent !== 'unknown') {
      relationship.timeIntent = String(context.time_intent);
    }
    const hasEmotion = Object.keys(emotion).length > 0;
    const hasRel = Object.keys(relationship).length > 0;
    if (!hasEmotion && !hasRel) return null;
    return { emotion: hasEmotion ? emotion : null, relationship: hasRel ? relationship : null };
  }

  return {
    /**
     * 召回记忆 + context 分区
     * @param {string} query 查询词（传用户当前消息）
     * @param {{ k?: number, timeoutMs?: number }} [options]
     * @returns {Promise<{memories: Array<object>, contextOverride: object|null}>}
     *   失败/无记忆时 memories 为空数组（不阻塞对话）；404 视为"无记忆"非故障
     */
    async recall(query, { k = DEFAULT_K, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const res = await fetch(`${base}/v1/memories/recall`, {
          method: 'POST',
          headers: headers(),
          body: JSON.stringify({ agent_id: agentId, query: String(query ?? ''), k }),
          signal: controller.signal,
        });
        // 404（HTTP 或业务码）＝设备尚无记忆，按"没有"处理，不是故障
        if (res.status === 404) return { memories: [], contextOverride: null };
        if (!res.ok) {
          const text = await res.text().catch(() => '');
          console.warn(`[companionmem] 召回返回非 2xx：HTTP ${res.status}；${text.slice(0, 200)}`);
          return { memories: [], contextOverride: null };
        }
        const json = await res.json();
        if (json.code === 404) return { memories: [], contextOverride: null };
        if (json.code !== 0) {
          console.warn(`[companionmem] 召回失败：code=${json.code} msg=${json.msg}`);
          return { memories: [], contextOverride: null };
        }
        const results = Array.isArray(json.data?.evidence?.results) ? json.data.evidence.results : [];
        const memories = results
          .filter((r) => r && typeof r.content === 'string' && r.content.trim().length > 0)
          .map(toMemoryItem);
        return { memories, contextOverride: toContextOverride(json.data.context) };
      } catch (err) {
        console.warn(`[companionmem] 召回请求失败：${err?.message ?? err}`);
        return { memories: [], contextOverride: null };
      } finally {
        clearTimeout(timer);
      }
    },

    /**
     * 写入一轮对话（服务端异步蒸馏 L0→L1）。
     * ⚠️ agent_id 与 Yodada 生产设备共享记忆库——默认关闭，需 .env 显式 MEMORY_WRITE=on
     * @param {string} userMessage 用户消息
     * @param {string} assistantMessage 助手回复
     * @returns {Promise<boolean>} 是否成功
     */
    async add(userMessage, assistantMessage) {
      if (!writeEnabled) return false;
      if (!userMessage && !assistantMessage) return false;
      const messages = [];
      if (userMessage) messages.push({ role: 'user', content: String(userMessage) });
      if (assistantMessage) messages.push({ role: 'assistant', content: String(assistantMessage) });
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
      try {
        const res = await fetch(`${base}/v1/memories/add`, {
          method: 'POST',
          headers: headers(),
          body: JSON.stringify({ agent_id: agentId, messages, distill: true }),
          signal: controller.signal,
        });
        const json = await res.json().catch(() => ({}));
        if (res.ok && json.code === 0) return true;
        console.warn(`[companionmem] 写入失败：HTTP ${res.status} code=${json.code} msg=${json.msg}`);
        return false;
      } catch (err) {
        console.warn(`[companionmem] 写入请求失败：${err?.message ?? err}`);
        return false;
      } finally {
        clearTimeout(timer);
      }
    },

    /**
     * 清空本 agent 的全部记忆（DELETE /v1/agents/{agent_id}，对齐 Yodada deleteByDeviceId）。
     * 测试前重置用——只应由默认测试设备调用（server 侧已做防误清生产设备的校验）。
     * @returns {Promise<{ok: boolean, hadData: boolean, message: string}>}
     *   404 = 本就无记忆（非故障）
     */
    async clearAll() {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
      try {
        const res = await fetch(`${base}/v1/agents/${encodeURIComponent(agentId)}`, {
          method: 'DELETE',
          headers: headers(),
          signal: controller.signal,
        });
        if (res.status === 404) {
          return { ok: true, hadData: false, message: '本就没有记忆，无需清空' };
        }
        const json = await res.json().catch(() => ({}));
        if (res.ok && json.code === 0) {
          return { ok: true, hadData: true, message: '记忆已全部清空' };
        }
        if (json.code === 404) {
          return { ok: true, hadData: false, message: '本就没有记忆，无需清空' };
        }
        console.warn(`[companionmem] 清空失败：HTTP ${res.status} code=${json.code} msg=${json.msg}`);
        return { ok: false, hadData: false, message: `清空失败：HTTP ${res.status} code=${json.code}` };
      } catch (err) {
        console.warn(`[companionmem] 清空请求失败：${err?.message ?? err}`);
        return { ok: false, hadData: false, message: `清空请求失败：${err?.message ?? err}` };
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
