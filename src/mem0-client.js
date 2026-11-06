/**
 * mem0-client.js — Mem0 长记忆检索客户端（复用 Yodada 的自建 Mem0 服务）
 *
 * 数据协议与 Yodada Mem0LongMemory 一致：
 *  POST {MEM0_API_URL}/search，Header X-API-Key
 *  body: {query, top_k, threshold, filters: {agent_id}}
 *  响应: {results: [{id, memory, score, created_at, metadata}]}
 *
 * 记忆与设备绑定（agent_id = 设备 MAC）：experiment 配置 MEM0_AGENT_ID 后，
 * Director 的候选记忆将从 Mem0 实时检索（真实对话提取的记忆），
 * 未配置时回落到本地静态 data/memories.json（对照实验的稳定基线）。
 */

/** 默认检索参数（对齐 Yodada 实测口径：threshold 0.3、top 8） */
const DEFAULT_TOP_K = 8;
const DEFAULT_THRESHOLD = 0.3;

/**
 * Mem0 客户端工厂：未配置时返回 null（调用方回落静态数据源）
 * @param {{ apiUrl?: string, apiKey?: string, agentId?: string }} config 从环境变量读取的配置
 * @returns {{ search: Function } | null}
 */
export function createMem0Client({ apiUrl, apiKey, agentId } = {}) {
  if (!apiUrl || !apiKey || !agentId) return null;
  const base = apiUrl.replace(/\/+$/, '');

  return {
    /**
     * 语义检索记忆
     * @param {string} query 查询词（一般传用户当前消息）
     * @param {{ topK?: number, threshold?: number, fetchImpl?: Function, timeoutMs?: number }} [options]
     * @returns {Promise<Array<{id: string, memory: string, score: number, createdAt: string|null}>>}
     *   检索失败时返回空数组（不阻塞对话，记忆缺失优于对话中断）
     */
    async search(query, { topK = DEFAULT_TOP_K, threshold = DEFAULT_THRESHOLD, fetchImpl = fetch, timeoutMs = 8000 } = {}) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const res = await fetchImpl(`${base}/search`, {
          method: 'POST',
          headers: {
            'X-API-Key': apiKey,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            query: String(query ?? ''),
            top_k: topK,
            threshold,
            filters: { agent_id: agentId },
          }),
          signal: controller.signal,
        });
        if (!res.ok) {
          const text = await res.text().catch(() => '');
          console.warn(`[mem0] 检索返回非 2xx：HTTP ${res.status}；${text.slice(0, 200)}`);
          return [];
        }
        const json = await res.json();
        const results = Array.isArray(json.results) ? json.results : [];
        return results.map((r) => ({
          id: String(r.id ?? `mem0-${Math.random().toString(36).slice(2, 8)}`),
          memory: String(r.memory ?? ''),
          score: Number.isFinite(r.score) ? r.score : 0,
          createdAt: r.created_at ?? null,
        }));
      } catch (err) {
        console.warn(`[mem0] 检索请求失败：${err?.message ?? err}`);
        return [];
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
