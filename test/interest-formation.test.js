/**
 * interest-formation.test.js — 兴趣形成门槛验收（文档 9.2 第 1/2/3 条）
 * 覆盖：单次曝光不升级、3 次+2 天→emerging、5 次+3 天→established、
 *       同一 taskId 不重复计数、证据日志累积
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateEvolution } from '../src/learning/evolution-evaluator.js';

const core = {
  locked_fields: ['identity', 'values', 'boundaries'],
};

function makeState(status = 'seed', confidence = 0.3) {
  return {
    interests: [
      {
        id: 'interest_scifi',
        topic: '科幻文学',
        status,
        confidence,
        evidence_ids: [],
        evidenceLog: [],
      },
    ],
  };
}

/** 构造一轮反射产出（只含兴趣证据，不含知识/观点） */
function makeProposal(taskId, at) {
  return {
    candidateKnowledge: [],
    candidateInterestEvidence: [
      {
        topic: '科幻文学',
        subtopic: '时间',
        taskId,
        sourceIds: [`src_${taskId}`],
        observedAt: at,
      },
    ],
    candidateBeliefUpdates: [],
  };
}

test('单次研究不形成兴趣（仍是 seed）', () => {
  const state = makeState();
  const ev = evaluateEvolution({
    proposal: makeProposal('t1', '2026-11-01T00:00:00Z'),
    characterCore: core,
    currentState: state,
    now: '2026-11-01T00:00:00Z',
  });
  const decision = ev.decisions.find((d) => d.type === 'interest');
  assert.equal(decision.verdict, 'hold');
  assert.match(decision.reason, /需 ≥3 次且 ≥2 天/);
  // 证据仍应落库以便累积
  const upd = ev.approved.interestUpdates.find((u) => u.id === 'interest_scifi');
  assert.equal(upd.status, 'seed');
  assert.equal(upd.evidenceLog.length, 1);
});

test('3 次跨 2 天研究 → 升级 emerging', () => {
  const state = makeState();
  // 先累积两次
  state.interests[0].evidenceLog = [
    { taskId: 't1', at: '2026-11-01T00:00:00Z', sourceIds: ['s1'] },
    { taskId: 't2', at: '2026-11-03T00:00:00Z', sourceIds: ['s2'] },
  ];
  const ev = evaluateEvolution({
    proposal: makeProposal('t3', '2026-11-05T00:00:00Z'),
    characterCore: core,
    currentState: state,
    now: '2026-11-05T00:00:00Z',
  });
  const decision = ev.decisions.find((d) => d.type === 'interest' && d.to);
  assert.equal(decision.to, 'emerging');
  assert.equal(decision.verdict, 'approve');
  const upd = ev.approved.interestUpdates.find((u) => u.id === 'interest_scifi');
  assert.equal(upd.status, 'emerging');
  assert.equal(upd.evidenceLog.length, 3);
});

test('5 次跨 3 天研究 → 升级 established（跳过中间等级）', () => {
  const state = makeState();
  state.interests[0].evidenceLog = [
    { taskId: 't1', at: '2026-11-01T00:00:00Z', sourceIds: ['s1'] },
    { taskId: 't2', at: '2026-11-02T00:00:00Z', sourceIds: ['s2'] },
    { taskId: 't3', at: '2026-11-03T00:00:00Z', sourceIds: ['s3'] },
    { taskId: 't4', at: '2026-11-04T00:00:00Z', sourceIds: ['s4'] },
  ];
  const ev = evaluateEvolution({
    proposal: makeProposal('t5', '2026-11-05T00:00:00Z'),
    characterCore: core,
    currentState: state,
    now: '2026-11-05T00:00:00Z',
  });
  const decision = ev.decisions.find((d) => d.type === 'interest' && d.to);
  assert.equal(decision.to, 'established');
  assert.match(decision.reason, /5 次独立研究/);
});

test('同一 taskId 的多条证据只计一次（防重复刷数）', () => {
  const state = makeState();
  state.interests[0].evidenceLog = [
    { taskId: 'same', at: '2026-11-01T00:00:00Z', sourceIds: ['a'] },
    { taskId: 'same', at: '2026-11-01T00:00:00Z', sourceIds: ['b'] },
    { taskId: 'same', at: '2026-11-01T00:00:00Z', sourceIds: ['c'] },
  ];
  const ev = evaluateEvolution({
    proposal: makeProposal('same', '2026-11-01T00:00:00Z'),
    characterCore: core,
    currentState: state,
    now: '2026-11-01T00:00:00Z',
  });
  const decision = ev.decisions.find((d) => d.type === 'interest');
  assert.equal(decision.verdict, 'hold');
  assert.match(decision.reason, /1 次研究/);
});

test('已达 emerging 后继续研究：保持状态但 confidence 提升', () => {
  const state = makeState('emerging', 0.4);
  state.interests[0].evidenceLog = [
    { taskId: 't1', at: '2026-11-01T00:00:00Z', sourceIds: ['s1'] },
    { taskId: 't2', at: '2026-11-02T00:00:00Z', sourceIds: ['s2'] },
    { taskId: 't3', at: '2026-11-03T00:00:00Z', sourceIds: ['s3'] },
  ];
  const ev = evaluateEvolution({
    proposal: makeProposal('t4', '2026-11-04T00:00:00Z'),
    characterCore: core,
    currentState: state,
    now: '2026-11-04T00:00:00Z',
  });
  const upd = ev.approved.interestUpdates.find((u) => u.id === 'interest_scifi');
  assert.equal(upd.status, 'emerging');
  assert.ok(upd.confidence > 0.4, 'confidence 应随证据增加');
  assert.ok(upd.confidence <= 0.95, 'confidence 有上限');
});
