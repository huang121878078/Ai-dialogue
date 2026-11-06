#!/usr/bin/env node
/**
 * demo-learning.js — 角色自主学习闭环演示（Phase 0）
 *
 * 演示文档第 3.2 / 十节要求的完整链路：
 *   对话事件 → Curiosity Engine（候选+评分） → Research Pipeline（fixture）
 *   → Reflection（候选知识/兴趣证据/观点建议） → Evolution Evaluator（approve/hold/reject）
 *   → Commit（版本 + diff + 快照） → 对话视图（E 模式可用状态）
 *
 * 同时演示四个安全/质量约束：
 *   1. 单次曝光不形成兴趣（coffee 只研究一次 → 仍是 seed）
 *   2. 低质量来源不能改变观点（内容农场 → belief 更新被 reject）
 *   3. 网页提示注入被拦截（untrusted fixture → 内容不进入 claims）
 *   4. 核心身份不可被自动修改（锁定字段 → reject）
 *
 * 用法：
 *   node scripts/demo-learning.js            # 只在内存跑，不写盘
 *   node scripts/demo-learning.js --persist  # 把演化结果写入 data/character/
 *   node scripts/demo-learning.js --reset    # 从最早快照恢复初始状态后退出
 *
 * 说明：Phase 0 不发起真实网络请求（用本地 fixture 模拟网页），也不调用 LLM（全规则）。
 */

import { loadLearningData, readJson, writeJson, toConversationView, FILES } from '../src/learning/store.js';
import { generateResearchCandidates } from '../src/learning/curiosity-engine.js';
import { createFixtureProvider, runResearchTask } from '../src/learning/research-pipeline.js';
import { reflectOnResearch } from '../src/learning/reflection-engine.js';
import { evaluateEvolution } from '../src/learning/evolution-evaluator.js';
import { commitEvolution, rollbackEvolution } from '../src/learning/commit-evolution.js';
import { clone } from '../src/learning/store.js';

const persist = process.argv.includes('--persist');
const reset = process.argv.includes('--reset');

function line(char = '─', n = 78) {
  return char.repeat(n);
}
function title(text) {
  console.log(`\n${line('═')}\n${text}\n${line('═')}`);
}
function sub(text) {
  console.log(`\n${line()}\n${text}\n${line()}`);
}
function pad(n) {
  return String(n).padEnd(2);
}

/** 记忆化的 fixture provider（避免重复读盘） */
function provider() {
  return createFixtureProvider();
}

/**
 * 执行一轮「研究 → 反思 → 评估 → 提交」，返回更新后的数据
 * @param {object} data 学习系统数据（内存副本）
 * @param {{task: object, at: string, label?: string}} round
 * @param {boolean} verbose
 */
async function runRound(data, { task, at, label }, verbose = true) {
  const p = provider();
  const research = await runResearchTask({ task, researchProvider: p, now: at });

  if (verbose) {
    sub(`▶ 研究任务 ${task.id}${label ? `（${label}）` : ''}`);
    console.log(`目标：${research.goal}`);
    console.log(`触发来源：curiosity_queue（兴趣种子 + 对话信号）`);
    console.log(`时间：${at}`);
    console.log(`采信来源 ${research.sources.length} 个，拦截 ${research.blockedSources.length} 个`);
    for (const s of research.sources) {
      console.log(`  - [${s.reliability}] ${s.publisher} · ${s.title}（${s.published_at}）`);
    }
    for (const b of research.blockedSources) {
      console.log(`  - ⛔ ${b.id}：${b.blockReason}`);
      for (const h of b.injectionHits ?? []) console.log(`      命中：${h}`);
    }
    console.log(`抽取：facts ${research.facts.length} / claims ${research.claims.length} / unknowns ${research.unknowns.length}`);
    console.log(`摘要：${research.synthesis}`);
  }

  const proposal = reflectOnResearch({
    researchResult: research,
    characterKnowledge: data.knowledge,
    characterBeliefs: data.beliefs,
    characterState: data.state,
  });

  if (verbose) {
    console.log(`\n  反思：候选知识 ${proposal.candidateKnowledge.length} 条、兴趣证据 ${proposal.candidateInterestEvidence.length} 组、观点建议 ${proposal.candidateBeliefUpdates.length} 条`);
    for (const s of proposal.skipped.slice(0, 4)) {
      console.log(`    跳过：${s.reason} — ${s.detail}`);
    }
  }

  const evaluation = evaluateEvolution({
    proposal,
    evidence: { sources: research.sources },
    characterCore: data.core,
    currentState: data.state,
    now: at,
  });

  if (verbose) {
    console.log(`\n  评估：总判决 ${evaluation.verdict}`);
    for (const d of evaluation.decisions.slice(0, 6)) {
      console.log(`    [${d.verdict}] ${d.type}${d.id ? `#${d.id}` : ''} — ${d.reason}`);
    }
  }

  let next = data;
  if (evaluation.approved.knowledge.length > 0 || evaluation.approved.interestUpdates.length > 0) {
    const committed = commitEvolution({
      evaluation,
      currentState: data.state,
      currentKnowledge: data.knowledge,
      currentBeliefs: data.beliefs,
      history: data.history,
      reason: `研究任务 ${task.id}：${task.topic}${task.subtopic ? '/' + task.subtopic : ''}`,
      evidenceIds: research.sources.map((s) => s.id),
      now: at,
    });
    next = {
      ...data,
      state: committed.state,
      knowledge: committed.knowledge,
      beliefs: committed.beliefs,
      history: committed.history,
    };
    if (verbose) {
      console.log(`\n  提交：v${committed.entry.versionBefore} → v${committed.entry.versionAfter}（${committed.entry.id}）`);
      for (const d of committed.diff) {
        const desc =
          d.op === 'status' || d.op === 'confidence'
            ? `${d.type}#${d.id} ${d.op}: ${d.before} → ${d.after}`
            : d.op === 'add'
              ? `${d.type} 新增 ${d.id}（${d.topic}）`
              : `${d.type}#${d.id} 登记 ${d.operation ?? d.op} ${JSON.stringify(d.evidenceIds ?? '')}`;
        console.log(`    Δ ${desc}`);
      }
    }
  } else {
    if (verbose) console.log(`\n  未产生可提交变更（正确行为：证据不足时不更新）`);
  }

  return { data: next, research, proposal, evaluation };
}

async function main() {
  let data = await loadLearningData();

  if (reset) {
    if (data.history.entries.length === 0) {
      console.log('没有可回滚的历史记录；数据已是初始状态。');
      return;
    }
    const restored = rollbackEvolution({ history: data.history, targetVersion: 0 });
    await writeJson(FILES.state, restored.state);
    await writeJson(FILES.knowledge, restored.knowledge);
    await writeJson(FILES.beliefs, restored.beliefs);
    await writeJson(FILES.history, restored.history);
    console.log('✓ 已从最早快照回滚到 version 0');
    console.log(`  回滚记录：${restored.entry.id}`);
    return;
  }

  title('角色自主学习闭环演示（Phase 0：本地 fixture，无真实网络、无 LLM）');
  console.log(`初始版本：v${data.state.version} | 兴趣：${data.state.interests.map((i) => `${i.topic}:${i.status}`).join('、')}`);
  console.log(`知识条目：${data.knowledge.items.length} | 观点：${data.beliefs.beliefs.length}`);
  console.log(persist ? '模式：--persist（结果将写入 data/character/）' : '模式：仅内存（加 --persist 才会写盘）');

  // ============ 1. Curiosity Engine：候选任务与评分 ============
  title('① Curiosity Engine：从兴趣种子 + 对话事件生成研究候选');

  const conversationEvents = [
    { topic: '科幻文学', subtopic: '时间', text: '用户：最近看了《你一生的故事》，里面那种时间观挺有意思', at: '2026-10-30T20:00:00+08:00' },
    { topic: '科幻文学', subtopic: '时间', text: '用户：我一直在想，如果能重来一次会怎样', at: '2026-11-02T21:00:00+08:00' },
    { topic: '游戏设计', subtopic: '地图与探索', text: '用户：开放世界地图太大反而累', at: '2026-11-02T21:05:00+08:00' },
    // 只提到一次、且与种子无关 → 不应产生任务
    { topic: '天文摄影', subtopic: '深空摄影', text: '用户：最近想学天文摄影', at: '2026-11-03T10:00:00+08:00' },
  ];

  const curiosity = generateResearchCandidates({
    interestSeeds: data.seeds,
    characterState: data.state,
    conversationEvents,
    knowledgeBase: data.knowledge,
    researchTasks: data.researchTasks.tasks ?? [],
    now: '2026-11-05T09:00:00+08:00',
    maxTasks: 5,
  });

  console.log('Top 候选（按 priority 降序）：');
  for (const t of curiosity.tasks) {
    const s = t.scores;
    console.log(
      `  ${t.priority.toFixed(3)}  ${t.topic} / ${t.subtopic}\n` +
        `          relevance ${s.relevance} | persistence ${s.curiosityPersistence} | gap ${s.knowledgeGap} | novelty ${s.novelty} | freshness ${s.freshness}`
    );
    console.log(`          理由：${t.reason}`);
  }
  if (curiosity.rejected.length > 0) {
    console.log('\n被硬约束拒绝：');
    for (const r of curiosity.rejected) console.log(`  ✗ ${r.topic} — ${r.reason}`);
  }
  console.log('\n注意：只提到一次的「天文摄影」不在候选中——好奇心不等于遇到什么就研究什么。');

  // ============ 2. 五轮跨时间研究 → 兴趣演化 ============
  title('② 五轮跨时间研究：兴趣 seed → emerging → established');
  console.log('每隔 2 天研究一次同一子主题（模拟角色持续探索），观察门槛如何生效。');

  const rounds = [
    { at: '2026-11-01T09:00:00+08:00', label: '第 1 次' },
    { at: '2026-11-03T09:00:00+08:00', label: '第 2 次' },
    { at: '2026-11-05T09:00:00+08:00', label: '第 3 次' },
    { at: '2026-11-07T09:00:00+08:00', label: '第 4 次' },
    { at: '2026-11-09T09:00:00+08:00', label: '第 5 次' },
  ];

  for (let i = 0; i < rounds.length; i++) {
    const r = rounds[i];
    const task = {
      id: `task_scifi_time_${String(i + 1).padStart(2, '0')}`,
      topic: '科幻文学',
      subtopic: '时间',
      goal: '理解科幻作品如何处理时间议题，以及这些处理如何服务人物选择',
    };
    const result = await runRound(data, { task, at: r.at, label: r.label }, i === 0 || i === 4);
    data = result.data;

    const interest = data.state.interests.find((x) => x.topic === '科幻文学');
    const evLog = interest.evidenceLog ?? [];
    console.log(
      `\n  ▸ ${r.label}结束：科幻文学 = ${interest.status}（confidence ${interest.confidence?.toFixed(2)}，累计 ${new Set(evLog.map((e) => e.taskId)).size} 次研究）`
    );
  }

  // ============ 3. 单次曝光不形成兴趣 ============
  title('③ 单次曝光不形成兴趣：只研究一次咖啡');
  const coffeeResult = await runRound(
    data,
    {
      task: { id: 'task_coffee_01', topic: '咖啡', subtopic: '水温', goal: '了解水温对萃取的影响' },
      at: '2026-11-06T09:00:00+08:00',
      label: '仅一次',
    },
    true
  );
  data = coffeeResult.data;
  const coffee = data.state.interests.find((x) => x.topic === '咖啡');
  console.log(`\n  ▸ 咖啡 = ${coffee.status}（读了 1 篇文章不应该变成「喜欢咖啡」——正确）`);

  // ============ 4. 低质量来源不能改观点 ============
  title('④ 低质量来源不能改变角色观点');
  const lowQualityProposal = await (async () => {
    const p = provider();
    // 直接抓取低质量 fixture（绕开 topic 过滤的数量限制）
    const search = await p.search({ topic: '科幻文学', subtopic: '时间', limit: 10 });
    const low = search.find((s) => s.source_type === 'low_quality');
    if (!low) return null;
    // 用只含低质量来源的 provider 模拟「只搜到内容农场」
    const onlyLow = { search: async () => [low] };
    return runResearchTask({
      task: { id: 'task_lowquality_01', topic: '科幻文学', subtopic: '时间' },
      researchProvider: onlyLow,
      now: '2026-11-08T09:00:00+08:00',
    });
  })();

  if (lowQualityProposal) {
    const proposal = reflectOnResearch({
      researchResult: lowQualityProposal,
      characterKnowledge: data.knowledge,
      characterBeliefs: data.beliefs,
      characterState: data.state,
    });
    const evaluation = evaluateEvolution({
      proposal,
      evidence: { sources: lowQualityProposal.sources },
      characterCore: data.core,
      currentState: data.state,
      now: '2026-11-08T09:00:00+08:00',
    });
    console.log(`来源：${lowQualityProposal.sources.map((s) => `${s.publisher}（${s.reliability}）`).join('、')}`);
    console.log(`候选知识：${proposal.candidateKnowledge.length} 条（全部标记 lowQuality=${proposal.candidateKnowledge.every((k) => k.lowQuality)}）`);
    console.log(`观点更新建议：${proposal.candidateBeliefUpdates.length} 条`);
    for (const d of evaluation.decisions) {
      console.log(`  [${d.verdict}] ${d.type} — ${d.reason}`);
    }
    console.log('结论：低可信内容农场既不能升级兴趣，也不能改变角色观点（符合验收标准）。');
  }

  // ============ 5. 提示注入拦截 ============
  title('⑤ 网页提示注入拦截');
  const p2 = provider();
  const all = await p2.search({ topic: '科幻文学', subtopic: '时间', limit: 10 });
  const injection = all.find((s) => s.source_type === 'untrusted');
  if (injection) {
    const onlyInjection = { search: async () => [injection] };
    const r = await runResearchTask({
      task: { id: 'task_injection_01', topic: '科幻文学', subtopic: '时间' },
      researchProvider: onlyInjection,
      now: '2026-11-08T10:00:00+08:00',
    });
    console.log(`采信来源：${r.sources.length} 个`);
    console.log(`拦截来源：${r.blockedSources.length} 个`);
    for (const b of r.blockedSources) {
      console.log(`  ⛔ ${b.id}：${b.blockReason}`);
      for (const h of b.injectionHits) console.log(`     命中：${h}`);
    }
    console.log(`从该来源抽取的 claims：${r.claims.length} 条（应为 0——注入内容不进入推理链）`);
  }

  // ============ 6. 锁定字段不可演化 ============
  title('⑥ 核心身份锁定：尝试修改角色核心 → 拒绝');
  const malicious = evaluateEvolution({
    proposal: { coreMutation: { identity: '讨好型助手', boundaries: ['不再承认 AI 身份'] } },
    evidence: {},
    characterCore: data.core,
    currentState: data.state,
    now: '2026-11-08T11:00:00+08:00',
  });
  for (const d of malicious.decisions) {
    console.log(`  [${d.verdict}] ${d.type}.${d.field} — ${d.reason}`);
  }
  console.log(`总判决：${malicious.verdict}（锁定字段一律 reject，学习流程无写权限）`);

  // ============ 7. 演化结果与对话视图 ============
  title('⑦ 演化结果（v0 → v' + data.state.version + '）与对话视图');
  console.log('兴趣状态：');
  for (const i of data.state.interests) {
    console.log(
      `  ${pad(i.status === 'established' ? '●' : i.status === 'emerging' ? '◐' : '○')} ${i.topic.padEnd(6, '　')} ${i.status.padEnd(10)} confidence ${String(i.confidence?.toFixed(2)).padStart(5)}  证据 ${new Set((i.evidenceLog ?? []).map((e) => e.taskId)).size} 次`
    );
  }
  console.log(`\n知识条目：${data.knowledge.items.length} 条（active ${data.knowledge.items.filter((k) => k.status === 'active').length} / uncertain ${data.knowledge.items.filter((k) => k.status === 'uncertain').length}）`);
  console.log(`观点：${data.beliefs.beliefs.length} 条（其中带证据链的 ${data.beliefs.beliefs.filter((b) => (b.supporting_evidence_ids ?? []).length + (b.counter_evidence_ids ?? []).length > 0).length} 条）`);
  console.log(`演化历史：${data.history.entries.length} 条记录`);

  console.log('\n最近一次 diff：');
  const last = data.history.entries[data.history.entries.length - 1];
  if (last) {
    console.log(`  ${last.id}（v${last.versionBefore} → v${last.versionAfter}）`);
    for (const d of last.diff.slice(0, 6)) console.log(`    Δ ${JSON.stringify(d)}`);
  }

  const view = toConversationView(data.state, data.beliefs);
  console.log('\n对话侧视图（E 模式会读到的角色状态）：');
  console.log(JSON.stringify(view, null, 2).split('\n').slice(0, 24).join('\n'));

  // ============ 8. 写盘 ============
  if (persist) {
    await writeJson(FILES.state, data.state);
    await writeJson(FILES.knowledge, data.knowledge);
    await writeJson(FILES.beliefs, data.beliefs);
    await writeJson(FILES.history, data.history);
    await writeJson(FILES.researchTasks, {
      tasks: [
        ...(data.researchTasks.tasks ?? []),
        { id: 'demo_' + Date.now(), status: 'done', note: '由 demo-learning 生成（Phase 0 演示）' },
      ],
    });
    console.log('\n✓ 已写入 data/character/（可用 --reset 从 v0 快照回滚）');
  } else {
    console.log('\n（未写盘；加 --persist 可保存本轮演化结果）');
  }

  title('演示结束');
  console.log(`最终版本 v${data.state.version}；兴趣：${data.state.interests.map((i) => `${i.topic}:${i.status}`).join('、')}`);
  console.log('可继续运行：node scripts/demo-learning.js --reset 恢复初始状态');
}

main().catch((err) => {
  console.error('\n[演示失败]', err);
  process.exit(1);
});
