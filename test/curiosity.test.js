/**
 * curiosity.test.js — Curiosity Engine 验收
 * 覆盖：候选排序、单次提及不生成、隐私拒绝、近期重复研究跳过、评分字段完整
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateResearchCandidates } from '../src/learning/curiosity-engine.js';

const seeds = {
  seeds: [
    { id: 'seed_scifi', topic: '科幻文学', suggested_subtopics: ['时间', '意识'] },
    { id: 'seed_coffee', topic: '咖啡', suggested_subtopics: ['水温'] },
  ],
};

const emptyState = {
  interests: [
    { id: 'i1', topic: '科幻文学', seed_id: 'seed_scifi', status: 'seed', evidence_ids: [] },
    { id: 'i2', topic: '咖啡', seed_id: 'seed_coffee', status: 'seed', evidence_ids: [] },
  ],
};

test('候选按 priority 降序排列，且每个任务带完整评分子项', () => {
  const { tasks } = generateResearchCandidates({
    interestSeeds: seeds,
    characterState: emptyState,
    conversationEvents: [
      { topic: '科幻文学', subtopic: '时间', text: '聊到时间', at: '2026-11-01T00:00:00Z' },
      { topic: '科幻文学', subtopic: '时间', text: '又聊到时间', at: '2026-11-02T00:00:00Z' },
    ],
    knowledgeBase: { items: [] },
    researchTasks: [],
    now: '2026-11-05T00:00:00Z',
  });
  assert.ok(tasks.length > 0);
  for (let i = 1; i < tasks.length; i++) {
    assert.ok(tasks[i - 1].priority >= tasks[i].priority, 'priority 必须降序');
  }
  for (const t of tasks) {
    for (const k of ['relevance', 'curiosityPersistence', 'knowledgeGap', 'novelty', 'freshness']) {
      assert.ok(t.scores[k] >= 0 && t.scores[k] <= 1, `${k} 应在 0-1`);
    }
    assert.ok(typeof t.reason === 'string' && t.reason.length > 0);
  }
});

test('反复出现的对话话题会提高 relevance（相比只出现零次）', () => {
  const base = generateResearchCandidates({
    interestSeeds: seeds,
    characterState: emptyState,
    conversationEvents: [],
    now: '2026-11-05T00:00:00Z',
  });
  const withConv = generateResearchCandidates({
    interestSeeds: seeds,
    characterState: emptyState,
    conversationEvents: [
      { topic: '科幻文学', subtopic: '时间', text: 'a', at: '2026-11-01T00:00:00Z' },
      { topic: '科幻文学', subtopic: '时间', text: 'b', at: '2026-11-02T00:00:00Z' },
      { topic: '科幻文学', subtopic: '时间', text: 'c', at: '2026-11-03T00:00:00Z' },
    ],
    now: '2026-11-05T00:00:00Z',
  });
  const t1 = base.tasks.find((t) => t.subtopic === '时间');
  const t2 = withConv.tasks.find((t) => t.subtopic === '时间');
  assert.ok(t2.scores.relevance > t1.scores.relevance);
});

test('与兴趣种子无关、且只提到一次的话题不产生研究任务', () => {
  const { tasks } = generateResearchCandidates({
    interestSeeds: seeds,
    characterState: emptyState,
    conversationEvents: [
      { topic: '天文摄影', subtopic: '深空摄影', text: '想学天文摄影', at: '2026-11-03T00:00:00Z' },
    ],
    now: '2026-11-05T00:00:00Z',
  });
  assert.equal(tasks.some((t) => t.topic === '天文摄影'), false);
});

test('涉及用户隐私的话题不进入候选（隐私最小化）', () => {
  const { tasks } = generateResearchCandidates({
    interestSeeds: seeds,
    characterState: emptyState,
    conversationEvents: [
      { topic: '科幻文学', subtopic: '时间', text: '用户说身份证号是 110101199001011234', at: '2026-11-01T00:00:00Z' },
      { topic: '科幻文学', subtopic: '时间', text: '用户说他家住在某小区', at: '2026-11-02T00:00:00Z' },
    ],
    now: '2026-11-05T00:00:00Z',
  });
  // 隐私内容被过滤，不贡献 relevance 加成（relevance 仍为基准 0.7）
  const t = tasks.find((x) => x.subtopic === '时间');
  assert.equal(t.scores.relevance, 0.7);
});

test('近 7 天内已研究过的子主题被跳过（防重复研究）', () => {
  const { tasks, rejected } = generateResearchCandidates({
    interestSeeds: seeds,
    characterState: emptyState,
    conversationEvents: [],
    researchTasks: [
      { id: 'old', topic: '科幻文学', subtopic: '时间', status: 'done', finished_at: '2026-11-03T00:00:00Z' },
    ],
    now: '2026-11-05T00:00:00Z',
  });
  assert.equal(tasks.some((t) => t.subtopic === '时间'), false);
  assert.ok(rejected.some((r) => r.topic.includes('时间') && r.reason.includes('7 天')));
});

test('超出 maxTasks 时只返回前 N 个（队列预算）', () => {
  const { tasks } = generateResearchCandidates({
    interestSeeds: seeds,
    characterState: emptyState,
    maxTasks: 2,
    now: '2026-11-05T00:00:00Z',
  });
  assert.equal(tasks.length, 2);
});
