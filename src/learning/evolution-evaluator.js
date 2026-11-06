/**
 * evolution-evaluator.js — Character Evolution Evaluator（角色演化评估器）
 *
 * 职责（文档 6.5）：判断候选变化能否写入正式状态。输出 approve / hold / reject 与理由。
 * 六项检查：
 *  1. 证据是否存在
 *  2. 来源是否足够可靠
 *  3. 是否重复或冲突
 *  4. 是否触及锁定字段（character_core.locked_fields）
 *  5. 兴趣证据是否跨时间、跨任务
 *  6. 输出判决
 *
 * 本模块是**确定性规则**（无 LLM 调用）：可复现、可审计、可单测。
 * 价值判断类观点的自动改写被禁用——只能 hold 待人工审核（文档 4.5「不允许自动演化」）。
 */

import { INTEREST_THRESHOLDS, SOURCE_RULES, VERDICTS } from './rules.js';

/** 兴趣等级顺序 */
const INTEREST_LEVEL = { seed: 0, emerging: 1, established: 2 };

/**
 * 依据证据日志计算兴趣应处的状态
 * @param {{evidenceLog?: Array<{taskId: string, at: string, sourceIds?: string[]}>, status?: string}} interest
 * @param {{minResearchTasks: number, minSpanDays: number}} threshold
 * @returns {{qualified: boolean, taskCount: number, spanDays: number, reason: string}}
 */
function assessInterestEvidence(interest, threshold) {
  const log = Array.isArray(interest?.evidenceLog) ? interest.evidenceLog : [];
  // 同一任务只算一次（一个任务多个来源不重复计数）
  const byTask = new Map();
  for (const e of log) {
    if (!e || !e.taskId) continue;
    if (!byTask.has(e.taskId)) byTask.set(e.taskId, e.at);
  }
  const taskCount = byTask.size;
  const times = [...byTask.values()].filter(Boolean).map((t) => Date.parse(t)).filter((n) => !Number.isNaN(n));
  const spanDays = times.length >= 2 ? (Math.max(...times) - Math.min(...times)) / 86_400_000 : 0;

  const qualified = taskCount >= threshold.minResearchTasks && spanDays >= threshold.minSpanDays;
  const reason = qualified
    ? `${taskCount} 次独立研究、跨度 ${spanDays.toFixed(1)} 天，达到门槛（≥${threshold.minResearchTasks} 次 / ≥${threshold.minSpanDays} 天）`
    : `证据不足：${taskCount} 次研究、跨度 ${spanDays.toFixed(1)} 天（需 ≥${threshold.minResearchTasks} 次且 ≥${threshold.minSpanDays} 天）`;
  return { qualified, taskCount, spanDays, reason };
}

/**
 * 评估一次反思产出的候选更新
 * @param {{
 *   proposal: {candidateKnowledge?: Array<object>, candidateInterestEvidence?: Array<object>, candidateBeliefUpdates?: Array<object>, openQuestions?: string[]},
 *   evidence?: {sources?: Array<object>},
 *   characterCore: object,
 *   currentState: {interests: Array<object>, evidenceLogByInterest?: object},
 *   now?: string,
 * }} params
 * @returns {{
 *   verdict: 'approve'|'hold'|'reject',
 *   decisions: Array<object>,
 *   approved: {knowledge: Array<object>, interestUpdates: Array<object>, beliefUpdates: Array<object>},
 *   held: Array<object>,
 *   rejected: Array<object>,
 * }}
 */
export function evaluateEvolution({
  proposal,
  evidence = {},
  characterCore,
  currentState,
  now = new Date().toISOString(),
}) {
  const decisions = [];
  const approved = { knowledge: [], interestUpdates: [], beliefUpdates: [] };
  const held = [];
  const rejected = [];
  const lockedFields = new Set(characterCore?.locked_fields ?? []);

  // ---------- 检查 4：锁定字段（任何试图修改 core 的提案直接 reject） ----------
  const coreMutation = proposal?.coreMutation ?? proposal?.core_mutation ?? null;
  if (coreMutation) {
    for (const field of Object.keys(coreMutation)) {
      const isLocked = lockedFields.has(field);
      const d = {
        type: 'core_mutation',
        field,
        verdict: isLocked ? VERDICTS.REJECT : VERDICTS.HOLD,
        reason: isLocked
          ? `字段 ${field} 属于锁定字段（Core Identity），学习流程不得修改`
          : `字段 ${field} 不在允许自动演化的范围内，需人工审核`,
      };
      decisions.push(d);
      (d.verdict === VERDICTS.REJECT ? rejected : held).push(d);
    }
  }

  // ---------- 检查 1/2：知识条目（证据存在 + 来源可靠） ----------
  for (const item of proposal?.candidateKnowledge ?? []) {
    if (!item || !Array.isArray(item.source_ids) || item.source_ids.length === 0) {
      const d = { type: 'knowledge', id: item?.id, verdict: VERDICTS.REJECT, reason: '缺少来源 ID，不能作为正式知识' };
      decisions.push(d);
      rejected.push(d);
      continue;
    }
    if (item.lowQuality) {
      const d = {
        type: 'knowledge',
        id: item.id,
        verdict: VERDICTS.HOLD,
        reason: '来源可靠性不足：仅记为 uncertain 候选，不进入 active 知识',
      };
      decisions.push(d);
      // 低质量只入库为 uncertain（可追溯），不参与兴趣/观点证据
      approved.knowledge.push({ ...item, status: 'uncertain' });
      held.push(d);
      continue;
    }
    const d = {
      type: 'knowledge',
      id: item.id,
      verdict: VERDICTS.APPROVE,
      reason: `来源可靠（${item.source_ids.join(',')}），置信度 ${item.confidence}`,
    };
    decisions.push(d);
    approved.knowledge.push({ ...item, status: 'active' });
  }

  // ---------- 检查 5：兴趣升级（跨时间、跨任务） ----------
  const interests = currentState?.interests ?? [];
  const evidenceByTopic = new Map();
  for (const ev of proposal?.candidateInterestEvidence ?? []) {
    const key = ev.topic;
    const list = evidenceByTopic.get(key) ?? [];
    list.push(ev);
    evidenceByTopic.set(key, list);
  }

  for (const interest of interests) {
    const incoming = evidenceByTopic.get(interest.topic) ?? [];
    // 组装证据日志：历史 + 本轮新增（按 taskId 去重）
    const existingLog = Array.isArray(interest.evidenceLog) ? interest.evidenceLog : [];
    const merged = new Map();
    for (const e of existingLog) if (e?.taskId) merged.set(e.taskId, e);
    for (const ev of incoming) {
      if (!ev?.taskId) continue;
      merged.set(ev.taskId, {
        taskId: ev.taskId,
        at: ev.observedAt ?? now,
        sourceIds: ev.sourceIds ?? [],
      });
    }
    const evidenceLog = [...merged.values()];

    // 只对「有新增证据」的兴趣做评估
    if (incoming.length === 0) continue;

    const currentLevel = INTEREST_LEVEL[interest.status] ?? 0;
    // 先看 established，再看 emerging（一次性评估到可达到的最高等级）
    const estThreshold = INTEREST_THRESHOLDS.established;
    const emeThreshold = INTEREST_THRESHOLDS.emerging;

    let targetStatus = interest.status;
    let reason = '';
    let qualified = false;

    const estAssess = assessInterestEvidence({ evidenceLog }, estThreshold);
    const emeAssess = assessInterestEvidence({ evidenceLog }, emeThreshold);

    if (estAssess.qualified && currentLevel < 2) {
      targetStatus = 'established';
      qualified = true;
      reason = estAssess.reason;
    } else if (emeAssess.qualified && currentLevel < 1) {
      targetStatus = 'emerging';
      qualified = true;
      reason = emeAssess.reason;
    } else if (currentLevel >= 1) {
      // 已是 emerging/established：本次只是加固，不升级
      targetStatus = interest.status;
      reason = `保持 ${interest.status}，本次新增证据加固（累计 ${emeAssess.taskCount} 次研究）`;
      qualified = true;
    } else {
      reason = emeAssess.reason;
    }

    if (!qualified) {
      const d = {
        type: 'interest',
        id: interest.id,
        verdict: VERDICTS.HOLD,
        reason,
        evidenceLog,
      };
      decisions.push(d);
      held.push(d);
      // 即使不升级，也把证据日志保存下来（累积用）
      approved.interestUpdates.push({
        id: interest.id,
        status: interest.status,
        evidenceLog,
        lastReinforcedAt: now,
      });
      continue;
    }

    const upgraded = targetStatus !== interest.status;
    const d = {
      type: 'interest',
      id: interest.id,
      from: interest.status,
      to: targetStatus,
      verdict: upgraded ? VERDICTS.APPROVE : VERDICTS.HOLD,
      reason,
      evidenceLog,
    };
    decisions.push(d);

    // 无论是否升级，证据日志与加固时间都必须落库（否则跨时间门槛永远无法累积）
    approved.interestUpdates.push({
      id: interest.id,
      status: targetStatus,
      evidenceLog,
      lastReinforcedAt: now,
      confidence: Math.min(
        INTEREST_THRESHOLDS.confidenceCap,
        (interest.confidence ?? 0.3) + INTEREST_THRESHOLDS.confidenceStep
      ),
    });
    if (!upgraded) held.push(d);
  }

  // ---------- 检查 3/6：观点更新（可靠性 + 类型限制） ----------
  for (const upd of proposal?.candidateBeliefUpdates ?? []) {
    if (!upd?.evidenceIds?.length) {
      const d = { type: 'belief', id: upd?.beliefId, verdict: VERDICTS.REJECT, reason: '缺少证据 ID' };
      decisions.push(d);
      rejected.push(d);
      continue;
    }
    if (!SOURCE_RULES.beliefEligible.includes(upd.sourceReliability)) {
      const d = {
        type: 'belief',
        id: upd.beliefId,
        verdict: VERDICTS.REJECT,
        reason: `来源可靠性 ${upd.sourceReliability} 不足以改变角色观点`,
      };
      decisions.push(d);
      rejected.push(d);
      continue;
    }
    if (upd.requiresHumanReview) {
      const d = {
        type: 'belief',
        id: upd.beliefId,
        verdict: VERDICTS.HOLD,
        reason: `${upd.beliefType} 类观点属于价值/审美判断，不自动改写，需人工审核（附证据 ${upd.evidenceIds.join(',')}）`,
      };
      decisions.push(d);
      held.push(d);
      continue;
    }
    const d = {
      type: 'belief',
      id: upd.beliefId,
      verdict: VERDICTS.APPROVE,
      reason: `${upd.direction === 'challenge' ? '新证据挑战' : '新证据支持'}可解释型观点，允许登记证据链`,
    };
    decisions.push(d);
    approved.beliefUpdates.push(upd);
  }

  // ---------- 汇总判决 ----------
  let verdict = VERDICTS.HOLD;
  if (decisions.some((d) => d.verdict === VERDICTS.REJECT)) verdict = VERDICTS.REJECT;
  else if (decisions.some((d) => d.verdict === VERDICTS.APPROVE)) verdict = VERDICTS.APPROVE;
  else verdict = VERDICTS.HOLD;

  return { verdict, decisions, approved, held, rejected };
}
