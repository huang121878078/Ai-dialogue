/**
 * curiosity-engine.js — Curiosity Engine（好奇心引擎）
 *
 * 职责（文档 4.2）：判断「接下来什么值得角色去了解」，产出**候选研究任务**并排序。
 * 不执行网络调用、不生成最终兴趣——只生成任务。
 *
 * 评分（文档给定公式，全部归一化到 0-1）：
 *   priority = relevance*0.30 + curiosity_persistence*0.25 + knowledge_gap*0.20
 *            + novelty*0.15 + freshness*0.10
 *
 * 硬约束（文档 4.2「不应产生研究任务的情况」）：
 *  - 用户只提到一次、且与兴趣种子无关 → 不生成
 *  - 涉及用户隐私 → 直接拒绝（不进入队列）
 *  - 近期已研究同一子主题（去重窗口内）→ 跳过
 *  - 队列已达预算上限 → 不再新增
 */

import { CURIOSITY_WEIGHTS, INTEREST_THRESHOLDS } from './rules.js';

/** 隐私关键词：出现即拒绝生成研究任务（不为角色学习搜索用户敏感信息） */
const PRIVACY_PATTERNS = [
  /家庭住址|家庭地址|住在|家住|门牌|小区|楼号|单元/,
  /身份证|护照号|银行卡|密码|验证码/,
  /手机号|电话号码|微信号|QQ号/,
  /学校名|班级|公司名.*地址/,
];

/** 归一化：把计数映射到 0-1（分母为「够用」的参考值） */
function norm(value, ref) {
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.min(1, value / ref);
}

/** 计算天数差（基于 ISO 日期字符串） */
function daysBetween(a, b) {
  if (!a || !b) return Number.POSITIVE_INFINITY;
  const ta = Date.parse(a);
  const tb = Date.parse(b);
  if (Number.isNaN(ta) || Number.isNaN(tb)) return Number.POSITIVE_INFINITY;
  return Math.abs(tb - ta) / 86_400_000;
}

/**
 * 从对话事件中提取「反复出现」的话题（只提到一次的不算，文档 4.2）
 * @param {Array<{topic?: string, subtopic?: string, text: string, at?: string}>} events
 * @returns {Map<string, {count: number, lastAt: string|null, texts: string[]}>}
 */
function collectRepeatedTopics(events) {
  const map = new Map();
  for (const e of Array.isArray(events) ? events : []) {
    if (!e || typeof e.text !== 'string') continue;
    const topic = e.topic;
    const subtopic = e.subtopic;
    const key = [topic, subtopic].filter(Boolean).join(' / ');
    if (!key) continue;
    if (PRIVACY_PATTERNS.some((p) => p.test(e.text))) continue; // 隐私话题直接跳过
    const entry = map.get(key) ?? { count: 0, lastAt: null, texts: [] };
    entry.count += 1;
    entry.lastAt = e.at ?? entry.lastAt;
    if (entry.texts.length < 3) entry.texts.push(e.text);
    map.set(key, entry);
  }
  return map;
}

/**
 * 生成研究候选任务
 * @param {{
 *   interestSeeds: {seeds: Array<{id: string, topic: string, suggested_subtopics?: string[]}>},
 *   characterState: {interests?: Array<{topic: string, status: string, evidence_ids?: string[], last_reinforced_at?: string|null}>},
 *   conversationEvents?: Array<{topic?: string, subtopic?: string, text: string, at?: string}>,
 *   knowledgeBase?: {items?: Array<{topic: string, claim: string, status?: string}>},
 *   researchTasks?: Array<{id: string, topic?: string, subtopic?: string, status?: string, started_at?: string, finished_at?: string}>,
 *   now?: string,
 *   maxTasks?: number,
 * }} input
 * @returns {{tasks: Array<object>, rejected: Array<{topic: string, reason: string}>}}
 *   tasks 已按 priority 降序排序；rejected 记录被硬约束拒绝的主题及原因（便于审计）
 */
export function generateResearchCandidates({
  interestSeeds,
  characterState,
  conversationEvents = [],
  knowledgeBase = { items: [] },
  researchTasks = [],
  now = new Date().toISOString(),
  maxTasks = 5,
} = {}) {
  const seeds = interestSeeds?.seeds ?? [];
  const interests = characterState?.interests ?? [];
  const knowledgeItems = knowledgeBase?.items ?? [];
  const rejected = [];

  // 最近一次研究时间（用于 freshness / 去重）
  const lastResearchByKey = new Map();
  for (const t of researchTasks) {
    if (!t || t.status !== 'done') continue;
    const key = [t.topic, t.subtopic].filter(Boolean).join(' / ');
    const at = t.finished_at ?? t.started_at ?? null;
    const prev = lastResearchByKey.get(key);
    if (!prev || (at && at > prev)) lastResearchByKey.set(key, at);
  }

  const repeated = collectRepeatedTopics(conversationEvents);
  const candidates = [];

  for (const seed of seeds) {
    const interest = interests.find((i) => i.topic === seed.topic || i.seed_id === seed.id);
    const subtopics = Array.isArray(seed.suggested_subtopics) && seed.suggested_subtopics.length > 0
      ? seed.suggested_subtopics
      : ['综述'];

    for (const subtopic of subtopics) {
      const key = `${seed.topic} / ${subtopic}`;
      const conv = repeated.get(key) ?? repeated.get(`${seed.topic} / `) ?? null;

      // ---- 硬约束 1：用户只提到一次且非种子主题 → 不生成（种子主题本身允许研究）
      // 种子主题天然允许研究（产品给定的探索方向），但需要 relevance 分支撑
      // ---- 硬约束 2：隐私（已在 collectRepeatedTopics 过滤；种子主题不涉及用户隐私）

      // ---- 硬约束 3：近期已研究同一子主题（7 天内）→ 跳过（防重复研究）
      const lastAt = lastResearchByKey.get(key) ?? null;
      const daysSinceLast = lastAt ? daysBetween(lastAt, now) : Number.POSITIVE_INFINITY;
      if (daysSinceLast < 7) {
        rejected.push({ topic: key, reason: `近 7 天内已研究过（${lastAt}），避免重复` });
        continue;
      }

      // ---- 分项打分 ----
      // relevance：种子主题直接 1.0；对话中反复出现再加权（上限 1）
      const relevance = Math.min(1, 0.7 + norm(conv?.count ?? 0, 3) * 0.3);

      // curiosity_persistence：兴趣状态与既有证据（emerging/established + 多次研究 → 高分）
      const statusScore = interest?.status === 'established' ? 1 : interest?.status === 'emerging' ? 0.7 : 0.4;
      const evidenceCount = interest?.evidence_ids?.length ?? 0;
      const persistence = Math.min(1, statusScore * 0.6 + norm(evidenceCount, INTEREST_THRESHOLDS.established.minResearchTasks) * 0.4);

      // knowledge_gap：该主题已有知识越少，缺口越大
      const topicKnowledge = knowledgeItems.filter((k) => k.topic === seed.topic).length;
      const knowledgeGap = Math.max(0, 1 - norm(topicKnowledge, 6));

      // novelty：该子主题是否已有知识（已有 → 新颖度低）
      const subtopicKnowledge = knowledgeItems.filter(
        (k) => k.topic === seed.topic && String(k.claim ?? '').includes(subtopic)
      ).length;
      const novelty = Math.max(0, 0.3 + 0.7 * (1 - norm(subtopicKnowledge, 2)));

      // freshness：距上次研究越久越高；从未研究过 → 1.0
      const freshness = Number.isFinite(daysSinceLast)
        ? Math.min(1, daysSinceLast / 30)
        : 1;

      const priority =
        relevance * CURIOSITY_WEIGHTS.relevance +
        persistence * CURIOSITY_WEIGHTS.curiosityPersistence +
        knowledgeGap * CURIOSITY_WEIGHTS.knowledgeGap +
        novelty * CURIOSITY_WEIGHTS.novelty +
        freshness * CURIOSITY_WEIGHTS.freshness;

      candidates.push({
        id: `task_${seed.id}_${subtopic}`,
        seedId: seed.id,
        topic: seed.topic,
        subtopic,
        reason: buildReason({ seed, subtopic, conv, interest, topicKnowledge }),
        priority: Math.round(priority * 1000) / 1000,
        scores: {
          relevance: round3(relevance),
          curiosityPersistence: round3(persistence),
          knowledgeGap: round3(knowledgeGap),
          novelty: round3(novelty),
          freshness: round3(freshness),
        },
        status: 'pending',
      });
    }
  }

  candidates.sort((a, b) => b.priority - a.priority);

  return { tasks: candidates.slice(0, maxTasks), rejected };
}

function round3(v) {
  return Math.round(v * 1000) / 1000;
}

/**
 * 生成人类可读的研究理由（写入日志，便于审计「为什么研究这个」）
 */
function buildReason({ seed, subtopic, conv, interest, topicKnowledge }) {
  const parts = [`兴趣种子「${seed.topic}」的细分方向「${subtopic}」`];
  if (conv && conv.count >= 2) parts.push(`对话中已出现 ${conv.count} 次`);
  if (interest?.status === 'emerging') parts.push('兴趣处于 emerging，需更多证据');
  else if (interest?.status === 'established') parts.push('兴趣已 established，继续加深');
  if (topicKnowledge === 0) parts.push('该主题尚无知识积累');
  return parts.join('；');
}
