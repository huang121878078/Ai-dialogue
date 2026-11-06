/**
 * evolution-commit.test.js — 版本化提交与回滚验收（文档 5.8、9.4 第 5 条）
 * 覆盖：版本单调递增、diff 记录、快照可回滚、回滚不删除历史、重复知识不重复入库
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { commitEvolution, rollbackEvolution } from '../src/learning/commit-evolution.js';

function makeInput(overrides = {}) {
  return {
    evaluation: {
      verdict: 'approve',
      approved: {
        knowledge: [],
        interestUpdates: [],
        beliefUpdates: [],
      },
      decisions: [],
    },
    currentState: { version: 0, interests: [{ id: 'i1', topic: '科幻文学', status: 'seed', confidence: 0.3, evidenceLog: [] }] },
    currentKnowledge: { version: 0, items: [] },
    currentBeliefs: { version: 0, beliefs: [] },
    history: { version: 0, entries: [] },
    now: '2026-11-05T00:00:00Z',
    ...overrides,
  };
}

test('提交推进版本号并记录 diff 与快照', () => {
  const input = makeInput({
    evaluation: {
      verdict: 'approve',
      approved: {
        knowledge: [{ id: 'k1', topic: '科幻文学', claim: '时间设定服务人物', source_ids: ['s1'], confidence: 0.8, status: 'active' }],
        interestUpdates: [{ id: 'i1', status: 'emerging', evidenceLog: [{ taskId: 't1', at: '2026-11-05T00:00:00Z', sourceIds: ['s1'] }], lastReinforcedAt: '2026-11-05T00:00:00Z', confidence: 0.4 }],
        beliefUpdates: [],
      },
      decisions: [{ type: 'interest', id: 'i1', verdict: 'approve', from: 'seed', to: 'emerging' }],
    },
  });
  const out = commitEvolution(input);
  assert.equal(out.state.version, 1);
  assert.equal(out.knowledge.version, 1);
  assert.equal(out.history.entries.length, 1);
  assert.ok(out.diff.some((d) => d.type === 'interest' && d.op === 'status' && d.after === 'emerging'));
  assert.ok(out.diff.some((d) => d.type === 'knowledge' && d.op === 'add'));
  assert.ok(out.entry.beforeSnapshot && out.entry.afterSnapshot);
  assert.equal(out.state.interests[0].status, 'emerging');
});

test('重复知识（同 id）不会重复入库', () => {
  const input = makeInput({
    currentKnowledge: { version: 0, items: [{ id: 'k1', topic: 'x', claim: 'y', source_ids: ['s'], confidence: 0.8, status: 'active' }] },
    evaluation: {
      verdict: 'approve',
      approved: { knowledge: [{ id: 'k1', topic: 'x', claim: 'y', source_ids: ['s'], confidence: 0.8, status: 'active' }], interestUpdates: [], beliefUpdates: [] },
      decisions: [],
    },
  });
  const out = commitEvolution(input);
  assert.equal(out.knowledge.items.length, 1);
  assert.equal(out.diff.length, 0);
});

test('回滚到指定版本：恢复快照并追加 rollback 记录（不删历史）', () => {
  // v0 → v1
  const first = commitEvolution(
    makeInput({
      evaluation: {
        verdict: 'approve',
        approved: {
          knowledge: [{ id: 'k1', topic: '科幻文学', claim: 'a', source_ids: ['s1'], confidence: 0.8, status: 'active' }],
          interestUpdates: [{ id: 'i1', status: 'emerging', evidenceLog: [], lastReinforcedAt: '2026-11-05T00:00:00Z', confidence: 0.4 }],
          beliefUpdates: [],
        },
        decisions: [],
      },
    })
  );
  // v1 → v2
  const second = commitEvolution({
    evaluation: {
      verdict: 'approve',
      approved: {
        knowledge: [{ id: 'k2', topic: '科幻文学', claim: 'b', source_ids: ['s2'], confidence: 0.8, status: 'active' }],
        interestUpdates: [],
        beliefUpdates: [],
      },
      decisions: [],
    },
    currentState: first.state,
    currentKnowledge: first.knowledge,
    currentBeliefs: first.beliefs,
    history: first.history,
    now: '2026-11-06T00:00:00Z',
  });
  assert.equal(second.state.version, 2);
  assert.equal(second.knowledge.items.length, 2);

  // 回滚到 v1
  const rolled = rollbackEvolution({ history: second.history, targetVersion: 1, now: '2026-11-07T00:00:00Z' });
  assert.equal(rolled.state.version, 1);
  assert.equal(rolled.knowledge.items.length, 1, 'v1 只有 1 条知识');
  assert.equal(rolled.state.interests[0].status, 'emerging');
  assert.ok(rolled.history.entries.length > second.history.entries.length, '回滚追加记录而非删除');
  assert.equal(rolled.history.entries.at(-1).type, 'rollback');
});

test('回滚到不存在的版本会抛错', () => {
  assert.throws(
    () => rollbackEvolution({ history: { version: 0, entries: [] }, targetVersion: 99 }),
    /找不到版本 99/
  );
});
