/**
 * reflection-engine.js — Reflection Engine（反思引擎）
 *
 * 文档 4.4：反思不是拟人化内心独白，而是可检查的状态评估。本模块输出**候选更新**，
 * 不直接写正式状态（写入由 evolution-evaluator 裁决 + commit-evolution 执行）。
 *
 * 输出四类候选：
 *  1. candidateKnowledge：可入库的知识条目（低可信来源只记为 uncertain）
 *  2. candidateInterestEvidence：兴趣证据（来自研究主题与来源，供 evaluator 判是否够门槛）
 *  3. candidateBeliefUpdates：观点更新建议（支持/挑战/修正，附证据；价值判断不得被单篇直接改写）
 *  4. openQuestions：未确认问题（可回流好奇心队列）
 *
 * 关键约束：
 *  - 事实/来源观点/角色推断/未知 严格分开（文档 4.3 输出的 facts/claims/unknowns）
 *  - 低可信来源（low_quality/untrusted）不产生「观点更新建议」——文档 9.2 第 5 条
 *  - 重复知识去重（避免同一 claim 反复入库导致知识库膨胀）
 */

import { SOURCE_RULES } from './rules.js';

/** 归一化文本用于去重：去空白/标点，转小写 */
function normalize(text) {
  return String(text ?? '')
    .toLowerCase()
    .replace(/[\s，。！？、；：“”‘’（）()【】\[\]《》<>·—\-…,\.!?;:]/g, '');
}

/** 判断两条 claim 是否重复：归一化后相等，或一方包含另一方的前 24 字 */
function isDuplicateClaim(a, b) {
  const na = normalize(a);
  const nb = normalize(b);
  if (!na || !nb) return false;
  if (na === nb) return true;
  const head = na.slice(0, 24);
  const headB = nb.slice(0, 24);
  return (head.length >= 12 && nb.includes(head)) || (headB.length >= 12 && na.includes(headB));
}

/**
 * 主题相关性判断（启发式，Phase 0 足够；Phase 1 可换成语义匹配）：
 *  1) 主题完全一致
 *  2) 正文提到完整主题词
 *  3) 正文提到主题词的前 2 个字（如「科幻文学」→「科幻」，「游戏设计」→「游戏」）
 */
function isTopicRelated(claimTopic, claimText, beliefTopic) {
  if (!beliefTopic) return false;
  if (claimTopic === beliefTopic) return true;
  const t = String(claimText ?? '');
  if (t.includes(beliefTopic)) return true;
  const head = beliefTopic.slice(0, 2);
  return head.length >= 2 && t.includes(head);
}

/**
 * 反思一次研究结果
 * @param {{
 *   researchResult: object,
 *   characterKnowledge: {items: Array<object>},
 *   characterBeliefs: {beliefs: Array<object>},
 *   characterState: {interests: Array<object>},
 * }} params
 * @returns {{
 *   candidateKnowledge: Array<object>,
 *   candidateInterestEvidence: Array<object>,
 *   candidateBeliefUpdates: Array<object>,
 *   openQuestions: string[],
 *   skipped: Array<{reason: string, detail: string}>,
 * }}
 */
export function reflectOnResearch({
  researchResult,
  characterKnowledge = { items: [] },
  characterBeliefs = { beliefs: [] },
  characterState = { interests: [] },
}) {
  const candidateKnowledge = [];
  const candidateBeliefUpdates = [];
  const openQuestions = [];
  const skipped = [];
  const evidenceIds = [];

  const existingItems = characterKnowledge.items ?? [];
  const beliefs = characterBeliefs.beliefs ?? [];
  const interests = characterState.interests ?? [];

  for (const claim of researchResult.claims ?? []) {
    const reality = claim.reliability;
    const topic = claim.topic ?? researchResult.topic;
    const subtopic = claim.subtopic ?? researchResult.subtopic;

    // ---- 0) 硬门槛：来源类型不可信（untrusted）→ 连知识都不入库，只记 skipped
    if (claim.sourceType === 'untrusted') {
      skipped.push({ reason: '来源不可信（untrusted），不采信', detail: claim.text.slice(0, 60) });
      continue;
    }

    // ---- 1) 去重
    const dup = existingItems.some((k) => k.topic === topic && isDuplicateClaim(k.claim, claim.text));
    if (dup) {
      skipped.push({ reason: '与已有知识重复', detail: claim.text.slice(0, 60) });
      continue;
    }

    // ---- 2) 候选知识（可靠性决定入库状态）
    const eligible = SOURCE_RULES.knowledgeEligible.includes(reality);
    // ID 带 taskId：不同研究任务的同源资料不会撞 ID（内容去重另有逻辑）
    const knowledgeId = `${researchResult.taskId ?? 'task'}_knowledge_${String(candidateKnowledge.length + 1).padStart(3, '0')}`;
    candidateKnowledge.push({
      id: knowledgeId,
      topic,
      claim: claim.text,
      claim_type: claim.sourceType === 'primary' ? 'primary_source_statement' : 'interpretation',
      source_ids: [claim.sourceId],
      confidence: reality === 'high' ? 0.8 : reality === 'medium' ? 0.6 : 0.35,
      status: eligible ? 'active' : 'uncertain',
      lowQuality: !eligible,
      created_at: researchResult.finishedAt ?? new Date().toISOString(),
      expires_at: null,
    });
    evidenceIds.push(knowledgeId);

    // ---- 3) 观点更新建议：低可信来源同样提出建议，但标记低可靠性 → 交由 evaluator 拒绝
    //        （比「静默不产生」更可审计：决策日志里能看到「曾提出但被拒」及理由）
    if (!SOURCE_RULES.beliefEligible.includes(reality)) {
      for (const belief of beliefs) {
        if (belief.status !== 'active') continue;
        if (!isTopicRelated(topic, claim.text, belief.topic)) continue;
        candidateBeliefUpdates.push({
          beliefId: belief.id,
          beliefTopic: belief.topic,
          beliefType: belief.type,
          direction: detectChallenge(claim.text, belief.statement) ? 'challenge' : 'support',
          proposedStatement: null,
          reason: `低可信来源（${reality}）提出的${claim.sourceType === 'low_quality' ? '内容农场' : '可疑'}主张，不应改变角色观点`,
          evidenceIds: [knowledgeId],
          sourceReliability: reality,
          requiresHumanReview: false,
          lowReliability: true,
        });
      }
      skipped.push({
        reason: `来源可靠性 ${reality}，不满足观点更新门槛（已提出建议供 evaluator 拒绝审计）`,
        detail: claim.text.slice(0, 60),
      });
      continue;
    }

    for (const belief of beliefs) {
      if (belief.status !== 'active') continue;
      if (!isTopicRelated(topic, claim.text, belief.topic)) continue;

      const challenge = detectChallenge(claim.text, belief.statement);
      candidateBeliefUpdates.push({
        beliefId: belief.id,
        beliefTopic: belief.topic,
        beliefType: belief.type,
        direction: challenge ? 'challenge' : 'support',
        proposedStatement: null, // 价值判断不自动改写措辞，只记录证据与方向
        reason: challenge
          ? '新证据与现有观点存在张力，需要评估是否修正或保留不确定'
          : '新证据支持现有观点',
        evidenceIds: [knowledgeId],
        sourceReliability: reality,
        requiresHumanReview: belief.type !== 'interpretation',
      });
    }
  }

  // ---- 4) 兴趣证据：本次研究覆盖的主题/子主题（供 evaluator 判断是否达到升级门槛）
  const candidateInterestEvidence = [];
  const interestTopics = new Set();
  for (const claim of researchResult.claims ?? []) {
    if (claim.reliability === 'low' || claim.sourceType === 'untrusted') continue;
    const key = `${claim.topic ?? researchResult.topic}::${claim.subtopic ?? researchResult.subtopic}`;
    if (interestTopics.has(key)) continue;
    interestTopics.add(key);
    candidateInterestEvidence.push({
      topic: claim.topic ?? researchResult.topic,
      subtopic: claim.subtopic ?? researchResult.subtopic,
      taskId: researchResult.taskId,
      sourceIds: [...new Set((researchResult.sources ?? []).map((s) => s.id))],
      observedAt: researchResult.finishedAt ?? new Date().toISOString(),
      evidenceCount: 1,
    });
  }

  // ---- 5) 未确认问题 → 可回流好奇心队列
  for (const u of researchResult.unknowns ?? []) {
    if (typeof u === 'string' && u.trim().length > 0) openQuestions.push(u.trim());
  }

  // ---- 6) 被拦截来源要留痕（安全审计）
  for (const b of researchResult.blockedSources ?? []) {
    skipped.push({ reason: '来源被注入检测拦截', detail: `${b.id}：${b.blockReason}` });
  }

  return {
    candidateKnowledge,
    candidateInterestEvidence,
    candidateBeliefUpdates,
    openQuestions,
    skipped,
  };
}

/**
 * 判断一段话是「挑战」还是「支持」现有观点：
 * 出现否定/转折性表达视为挑战；否则视为支持。
 * 这是启发式规则（可解释优先），Phase 1 可替换为结构化模型判断。
 */
function detectChallenge(claimText, beliefStatement) {
  const t = String(claimText ?? '');
  const negativeMarkers = ['并不', '不是', '无需', '不必', '未必', '不同意', '反驳', '质疑', '相反', '反之', '其实不'];
  const direct = negativeMarkers.some((m) => t.includes(m));
  if (direct) return true;
  // 语义相反的关键词对（简单对照）
  const opposites = [
    ['重要', '不重要'],
    ['需要', '不需要'],
    ['越大越好', '不一定'],
    ['必须', '不必'],
  ];
  for (const [a, b] of opposites) {
    if (beliefStatement.includes(a) && t.includes(b)) return true;
  }
  return false;
}
