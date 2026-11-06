/**
 * belief-revision.test.js — 观点修正验收（文档 9.2 第 4/5 条）
 * 覆盖：低质量来源被拒、高可信 + interpretation 登记证据、
 *       价值/审美判断必须 hold（需人工）、无证据直接拒
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reflectOnResearch } from '../src/learning/reflection-engine.js';
import { evaluateEvolution } from '../src/learning/evolution-evaluator.js';

const core = { locked_fields: ['identity'] };

function makeBeliefs() {
  return {
    beliefs: [
      {
        id: 'belief_interpretation',
        topic: '科幻文学',
        statement: '科幻作品里的时间设定大多是为了炫技',
        type: 'interpretation',
        status: 'active',
        confidence: 0.6,
        supporting_evidence_ids: [],
        counter_evidence_ids: [],
        revision_history: [],
      },
      {
        id: 'belief_value',
        topic: '科幻文学',
        statement: '故事的情感浓度比设定复杂度更重要',
        type: 'value_judgment',
        status: 'active',
        confidence: 0.7,
        supporting_evidence_ids: [],
        counter_evidence_ids: [],
        revision_history: [],
      },
    ],
  };
}

function makeResearch({ reliability = 'high', sourceType = 'reputable_secondary', text }) {
  return {
    taskId: `t_${reliability}_${sourceType}`,
    topic: '科幻文学',
    subtopic: '时间',
    finishedAt: '2026-11-05T00:00:00Z',
    sources: [{ id: `src_${reliability}`, reliability, source_type: sourceType }],
    blockedSources: [],
    claims: [
      {
        text: text ?? '作者认为，时间设定只有服务于人物选择时才真正成立',
        sourceId: `src_${reliability}`,
        sourceType,
        reliability,
        topic: '科幻文学',
        subtopic: '时间',
        publishedAt: '2026-11-01',
      },
    ],
    facts: [],
    unknowns: [],
  };
}

test('低质量来源：知识只记 uncertain，观点更新被 reject', () => {
  const research = makeResearch({ reliability: 'low', sourceType: 'low_quality' });
  const proposal = reflectOnResearch({
    researchResult: research,
    characterKnowledge: { items: [] },
    characterBeliefs: makeBeliefs(),
    characterState: { interests: [] },
  });
  assert.ok(proposal.candidateBeliefUpdates.length >= 1, '低质量来源也要留下「曾提出但被拒」的审计记录');
  const ev = evaluateEvolution({
    proposal,
    evidence: { sources: research.sources },
    characterCore: core,
    currentState: { interests: [] },
    now: '2026-11-05T00:00:00Z',
  });
  const rejections = ev.decisions.filter((d) => d.type === 'belief' && d.verdict === 'reject');
  assert.ok(rejections.length >= 1);
  assert.match(rejections[0].reason, /不足以改变角色观点/);
  assert.equal(ev.approved.beliefUpdates.length, 0);
});

test('高可信来源 + interpretation 类观点 → approve 登记证据，但不改措辞', () => {
  const research = makeResearch({ reliability: 'high' });
  const proposal = reflectOnResearch({
    researchResult: research,
    characterKnowledge: { items: [] },
    characterBeliefs: makeBeliefs(),
    characterState: { interests: [] },
  });
  const ev = evaluateEvolution({
    proposal,
    evidence: { sources: research.sources },
    characterCore: core,
    currentState: { interests: [] },
    now: '2026-11-05T00:00:00Z',
  });
  const approved = ev.approved.beliefUpdates.find((u) => u.beliefId === 'belief_interpretation');
  assert.ok(approved, 'interpretation 类应通过');
  assert.equal(approved.proposedStatement, null, '不自动改写观点措辞');
});

test('高可信来源 + 价值判断类观点 → hold（需人工审核）', () => {
  const research = makeResearch({ reliability: 'high' });
  const proposal = reflectOnResearch({
    researchResult: research,
    characterKnowledge: { items: [] },
    characterBeliefs: makeBeliefs(),
    characterState: { interests: [] },
  });
  const ev = evaluateEvolution({
    proposal,
    evidence: { sources: research.sources },
    characterCore: core,
    currentState: { interests: [] },
    now: '2026-11-05T00:00:00Z',
  });
  const held = ev.decisions.find(
    (d) => d.type === 'belief' && d.id === 'belief_value' && d.verdict === 'hold'
  );
  assert.ok(held, '价值判断不自动改写');
  assert.match(held.reason, /需人工审核/);
});

test('观点更新缺少证据 ID → 直接 reject', () => {
  const ev = evaluateEvolution({
    proposal: {
      candidateKnowledge: [],
      candidateInterestEvidence: [],
      candidateBeliefUpdates: [
        { beliefId: 'belief_interpretation', direction: 'challenge', evidenceIds: [], sourceReliability: 'high', beliefType: 'interpretation' },
      ],
    },
    characterCore: core,
    currentState: { interests: [] },
    now: '2026-11-05T00:00:00Z',
  });
  const d = ev.decisions.find((x) => x.type === 'belief');
  assert.equal(d.verdict, 'reject');
  assert.match(d.reason, /缺少证据/);
});

test('提交后观点带证据链与修订历史（可追溯）', async () => {
  const { commitEvolution } = await import('../src/learning/commit-evolution.js');
  const research = makeResearch({ reliability: 'high' });
  const proposal = reflectOnResearch({
    researchResult: research,
    characterKnowledge: { items: [] },
    characterBeliefs: makeBeliefs(),
    characterState: { interests: [] },
  });
  const ev = evaluateEvolution({
    proposal,
    evidence: { sources: research.sources },
    characterCore: core,
    currentState: { interests: [] },
    now: '2026-11-05T00:00:00Z',
  });
  const committed = commitEvolution({
    evaluation: ev,
    currentState: { version: 0, interests: [] },
    currentKnowledge: { version: 0, items: [] },
    currentBeliefs: makeBeliefs(),
    history: { version: 0, entries: [] },
    now: '2026-11-05T00:00:00Z',
  });
  const belief = committed.beliefs.beliefs.find((b) => b.id === 'belief_interpretation');
  assert.ok(belief.supporting_evidence_ids.length + belief.counter_evidence_ids.length >= 1);
  assert.equal(belief.revision_history.length, 1);
  assert.equal(belief.revision_history[0].statementChanged, false);
  assert.ok(committed.diff.some((d) => d.type === 'belief' && d.op === 'evidence'));
});
