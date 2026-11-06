/**
 * commit-evolution.js — 版本化提交与回滚
 *
 * 文档 5.8 / 9.4：每次正式演化都必须有变更记录并可回滚。
 * 设计要点：
 *  - commitEvolution 是**纯函数**：返回新状态，不直接写盘（写盘由调用方 store 完成，便于测试）
 *  - 每个 entry 保存 before/after 快照（数据量小），使 rollback 无需重放
 *  - 版本号单调递增；rollback 不删除历史，而是追加一条 rollback 记录
 */

import { clone } from './store.js';

let seq = 0;
/** 生成 entry id（时间戳 + 进程内序号，避免同毫秒冲突） */
function nextEntryId(now) {
  seq += 1;
  const ts = String(now).replace(/[-:.TZ]/g, '').slice(0, 14);
  return `evo_${ts}_${String(seq).padStart(3, '0')}`;
}

/**
 * 应用一次已批准的演化，产出新版本
 * @param {{
 *   evaluation: {approved: {knowledge: Array<object>, interestUpdates: Array<object>, beliefUpdates: Array<object>}, verdict: string, decisions: Array<object>},
 *   currentState: object,
 *   currentKnowledge: object,
 *   currentBeliefs: object,
 *   history: {version: number, entries: Array<object>},
 *   reason?: string,
 *   evidenceIds?: string[],
 *   now?: string,
 * }} params
 * @returns {{state: object, knowledge: object, beliefs: object, history: object, entry: object, diff: Array<object>}}
 */
export function commitEvolution({
  evaluation,
  currentState,
  currentKnowledge,
  currentBeliefs,
  history,
  reason = '',
  evidenceIds = [],
  now = new Date().toISOString(),
}) {
  const before = {
    state: clone(currentState),
    knowledge: clone(currentKnowledge),
    beliefs: clone(currentBeliefs),
  };

  const state = clone(currentState);
  const knowledge = clone(currentKnowledge);
  const beliefs = clone(currentBeliefs);
  const diff = [];

  // ---------- 知识入库（按 id 去重，同 claim 不重复入库） ----------
  const existingIds = new Set((knowledge.items ?? []).map((i) => i.id));
  for (const item of evaluation?.approved?.knowledge ?? []) {
    if (!item || !item.id || existingIds.has(item.id)) continue;
    knowledge.items.push(item);
    existingIds.add(item.id);
    diff.push({ type: 'knowledge', op: 'add', id: item.id, topic: item.topic, claim: item.claim });
  }

  // ---------- 兴趣状态更新 ----------
  for (const upd of evaluation?.approved?.interestUpdates ?? []) {
    const interest = (state.interests ?? []).find((i) => i.id === upd.id);
    if (!interest) continue;
    const prevStatus = interest.status;
    const prevConfidence = interest.confidence ?? 0;
    if (upd.status && upd.status !== interest.status) {
      interest.status = upd.status;
      diff.push({ type: 'interest', op: 'status', id: interest.id, before: prevStatus, after: upd.status });
    }
    if (upd.evidenceLog) {
      interest.evidenceLog = upd.evidenceLog;
      interest.evidence_ids = upd.evidenceLog.flatMap((e) => e.sourceIds ?? []);
      if (upd.evidenceLog.length > 0) {
        const times = upd.evidenceLog.map((e) => e.at).filter(Boolean).sort();
        interest.first_observed_at = interest.first_observed_at ?? times[0] ?? null;
        interest.last_reinforced_at = times[times.length - 1] ?? interest.last_reinforced_at;
      }
    }
    if (Number.isFinite(upd.confidence) && upd.confidence !== prevConfidence) {
      interest.confidence = upd.confidence;
      diff.push({ type: 'interest', op: 'confidence', id: interest.id, before: prevConfidence, after: upd.confidence });
    }
  }

  // ---------- 观点证据登记（不自动改写 statement） ----------
  for (const upd of evaluation?.approved?.beliefUpdates ?? []) {
    const belief = (beliefs.beliefs ?? []).find((b) => b.id === upd.beliefId);
    if (!belief) continue;
    if (upd.direction === 'challenge') {
      belief.counter_evidence_ids = [...new Set([...(belief.counter_evidence_ids ?? []), ...upd.evidenceIds])];
    } else {
      belief.supporting_evidence_ids = [...new Set([...(belief.supporting_evidence_ids ?? []), ...upd.evidenceIds])];
    }
    belief.revision_history.push({
      at: now,
      direction: upd.direction,
      evidenceIds: upd.evidenceIds,
      reason: upd.reason,
      statementChanged: false,
    });
    diff.push({
      type: 'belief',
      op: 'evidence',
      id: belief.id,
      direction: upd.direction,
      evidenceIds: upd.evidenceIds,
    });
  }

  // ---------- 版本推进 ----------
  const versionBefore = Number(currentState.version ?? 0);
  const versionAfter = versionBefore + 1;
  state.version = versionAfter;
  state.last_updated_at = now;
  knowledge.version = versionAfter;
  beliefs.version = versionAfter;

  const entry = {
    id: nextEntryId(now),
    at: now,
    versionBefore,
    versionAfter,
    verdict: evaluation?.verdict ?? 'approve',
    reason: reason || '研究学习闭环：候选更新通过评估',
    evidenceIds: [...new Set(evidenceIds)],
    decisions: evaluation?.decisions ?? [],
    diff,
    // 快照用于回滚（数据量小，避免重放复杂度过高）
    beforeSnapshot: before,
    afterSnapshot: {
      state: clone(state),
      knowledge: clone(knowledge),
      beliefs: clone(beliefs),
    },
  };

  const nextHistory = clone(history);
  nextHistory.version = versionAfter;
  nextHistory.entries.push(entry);

  return { state, knowledge, beliefs, history: nextHistory, entry, diff };
}

/**
 * 回滚到指定版本（追加 rollback 记录，不删除历史）
 * @param {{
 *   history: {version: number, entries: Array<object>},
 *   targetVersion: number,
 *   now?: string,
 * }} params
 * @returns {{state: object, knowledge: object, beliefs: object, history: object, entry: object}}
 */
export function rollbackEvolution({ history, targetVersion, now = new Date().toISOString() }) {
  const entries = history?.entries ?? [];
  // 找到 versionBefore === targetVersion 的那次提交的 beforeSnapshot（即目标版本的真实内容）
  const candidate = [...entries].reverse().find((e) => e.versionBefore === targetVersion);
  const target = candidate?.beforeSnapshot
    ?? [...entries].reverse().find((e) => e.versionAfter === targetVersion)?.afterSnapshot;

  if (!target) {
    throw new Error(`找不到版本 ${targetVersion} 的快照，无法回滚`);
  }

  const restored = {
    state: clone(target.state),
    knowledge: clone(target.knowledge),
    beliefs: clone(target.beliefs),
  };
  const currentVersion = history.version ?? 0;

  const entry = {
    id: nextEntryId(now),
    at: now,
    type: 'rollback',
    versionBefore: currentVersion,
    versionAfter: targetVersion,
    reason: `回滚到版本 ${targetVersion}`,
    diff: [{ type: 'rollback', op: 'restore', fromVersion: currentVersion, toVersion: targetVersion }],
    beforeSnapshot: null,
    afterSnapshot: clone(restored),
  };

  const nextHistory = clone(history);
  nextHistory.version = targetVersion;
  nextHistory.entries.push(entry);

  return { ...restored, history: nextHistory, entry };
}
