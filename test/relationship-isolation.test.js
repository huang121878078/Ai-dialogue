/**
 * relationship-isolation.test.js — 用户/角色数据隔离验收（文档 2.2、9.2 第 7 条）
 * 覆盖：用户偏好不写入角色兴趣、对话话题只贡献相关性不加兴趣证据、
 *       toConversationView 只映射已提交状态（不泄露候选区）
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateResearchCandidates } from '../src/learning/curiosity-engine.js';
import { reflectOnResearch } from '../src/learning/reflection-engine.js';
import { toConversationView } from '../src/learning/store.js';

const seeds = {
  seeds: [{ id: 'seed_scifi', topic: '科幻文学', suggested_subtopics: ['时间'] }],
};

const state = {
  interests: [{ id: 'i1', topic: '科幻文学', seed_id: 'seed_scifi', status: 'seed', evidence_ids: [] }],
};

test('用户在对话中提到的偏好不会变成角色的兴趣', () => {
  // 用户说「我喜欢万青/独立音乐」，但它不是角色的 seed（此处 seeds 只有科幻）
  const { tasks } = generateResearchCandidates({
    interestSeeds: seeds,
    characterState: state,
    conversationEvents: [
      { topic: '独立音乐', subtopic: '编曲', text: '用户：我特别喜欢万青的编曲', at: '2026-11-01T00:00:00Z' },
      { topic: '独立音乐', subtopic: '编曲', text: '用户：万青的歌我听了十年', at: '2026-11-02T00:00:00Z' },
    ],
    now: '2026-11-05T00:00:00Z',
  });
  assert.equal(tasks.some((t) => t.topic === '独立音乐'), false, '用户偏好不能生成角色研究任务');
});

test('对话话题只影响相关性评分，不直接产生兴趣证据', () => {
  const proposal = reflectOnResearch({
    researchResult: {
      taskId: 't1',
      topic: '科幻文学',
      subtopic: '时间',
      finishedAt: '2026-11-05T00:00:00Z',
      sources: [],
      blockedSources: [],
      claims: [],
      facts: [],
      unknowns: [],
    },
    characterKnowledge: { items: [] },
    characterBeliefs: { beliefs: [] },
    characterState: state,
  });
  assert.equal(proposal.candidateInterestEvidence.length, 0, '没有研究证据就不该有兴趣证据');
});

test('toConversationView 只暴露已提交的兴趣与观点（不含候选区）', () => {
  const learningState = {
    version: 3,
    initiative: 'moderate',
    interests: [
      { id: 'a', topic: '科幻文学', status: 'emerging', confidence: 0.6, evidenceLog: [] },
      { id: 'b', topic: '咖啡', status: 'seed', confidence: 0.3, evidenceLog: [] },
    ],
    current_focus: ['比较不同作品处理时间悖论的方式'],
    open_topics: [{ topic: '游戏结局', status: 'pending' }],
    recent_contributions: ['讨论过时间议题'],
  };
  const beliefs = {
    beliefs: [
      { id: 'bp1', topic: '科幻文学', statement: '时间设定要服务于人物选择', type: 'interpretation', status: 'active', confidence: 0.8, revision_history: [] },
      { id: 'bp2', topic: '咖啡', statement: '手冲的关键是稳定', type: 'aesthetic_opinion', status: 'retracted', confidence: 0.5, revision_history: [] },
    ],
  };
  const view = toConversationView(learningState, beliefs);
  assert.equal(view.currentInterests.length, 1, 'seed 状态且低置信度的兴趣不进对话视图');
  assert.ok(view.currentInterests[0].includes('科幻文学'));
  assert.equal(view.currentOpinions.length, 1, 'retracted 观点不进对话视图');
  assert.equal(view.currentOpinions[0].id, 'bp1');
  assert.equal(view.openTopics.length, 1);
});

test('对话视图不包含候选知识/研究中间产物', () => {
  const view = toConversationView({ interests: [], current_focus: [], open_topics: [] }, { beliefs: [] });
  const keys = Object.keys(view).sort();
  assert.deepEqual(keys, ['currentInterests', 'currentOpinions', 'initiative', 'openTopics', 'recentContributions']);
  assert.equal(JSON.stringify(view).includes('candidate'), false);
});
