/**
 * orchestrator.test.js — 编排层集成测试（mock 模型客户端，不联网）
 * ⚠️ 依赖 ajv（经 director.js → validators.js）：需先 npm install 再运行
 * 运行：npm test
 * 覆盖：四模式输入差异、事件序列、degraded 降级路径、metrics 完整性、JSONL 日志
 */
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { runTurn } from '../src/orchestrator.js';
import { SessionLogger } from '../src/logger.js';
import { isModelIoLogEnabled } from '../src/console-logger.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const memories = JSON.parse(readFileSync(path.join(ROOT, 'data/memories.json'), 'utf-8')).memories;
const data = {
  persona: { name: '小满' },
  userProfile: { nickname: '阿哲' },
  emotion: { recentEmotion: '疲惫' },
  relationship: { stage: 'gradually_familiar' },
  memories,
};

/** 合法 Brief 文本（C 模式，含策略） */
const VALID_BRIEF = JSON.stringify({
  version: '1.0',
  understanding: {
    userIntent: '倾诉', topic: '加班', emotions: [{ label: '疲惫', confidence: 0.8, evidence: ['累'] }],
    possibleNeeds: ['被理解'], uncertainties: [],
  },
  personalization: {
    selectedMemories: [{ memoryId: 'M001', relevance: 0.9, reason: 'r', usageSuggestion: 'u' }],
    relevantPreferences: [],
  },
  conversationStrategy: {
    primary: '共情', secondary: '陪伴', adviceLevel: 'low', memoryUsage: 'weave_in', followUpDirection: '音乐',
  },
  epistemicAssessment: { claims: [], overallDecision: 'confirm', beliefUpdateRequired: false },
  safety: { level: 'normal', reason: 'ok', responseRequirement: [] },
});

/** D 模式合法 Brief（无策略） */
const VALID_BRIEF_D = JSON.stringify({
  version: '1.0',
  understanding: {
    userIntent: '倾诉', topic: '加班', emotions: [], possibleNeeds: [], uncertainties: [],
  },
  personalization: { selectedMemories: [], relevantPreferences: [] },
  epistemicAssessment: { claims: [], overallDecision: 'confirm', beliefUpdateRequired: false },
  safety: { level: 'normal', reason: 'ok', responseRequirement: [] },
});

/**
 * 记录调用并按脚本回放 Director/Generator 行为的 mock client
 * 注意：Director 与 Generator 都走 streamChatCompletion（Director 为支持思考实时外推而改为流式），
 * 二者按「是否传 jsonSchema」区分——Director 一定带 json_schema 约束，Generator 不带。
 */
function makeMockClient({ directorReplies, generatorChunks }) {
  const calls = [];
  return {
    calls,
    async chatCompletion({ messages, temperature, responseFormat, jsonSchema }) {
      const reply = directorReplies[Math.min(calls.filter((c) => c.kind === 'director').length, directorReplies.length - 1)];
      calls.push({ kind: 'director', messages, temperature, responseFormat, jsonSchema });
      return { content: reply, reasoning: '', promptTokens: 100, completionTokens: 50, usageKnown: true, firstTokenMs: null };
    },
    async streamChatCompletion({
      messages,
      temperature,
      responseFormat,
      jsonSchema,
      enableThinking,
      onDelta,
      stage,
      label,
    }) {
      if (jsonSchema) {
        // Director：结构化输出不增量，一次性返回 JSON 文本
        const reply = directorReplies[Math.min(calls.filter((c) => c.kind === 'director').length, directorReplies.length - 1)];
        calls.push({ kind: 'director', messages, temperature, responseFormat, jsonSchema, enableThinking, stage, label });
        return { content: reply, reasoning: '', promptTokens: 100, completionTokens: 50, usageKnown: true, firstTokenMs: null };
      }
      // Generator：按 chunk 增量回调
      calls.push({ kind: 'generator', messages, temperature, stage, label });
      for (const chunk of generatorChunks) if (onDelta) onDelta(chunk);
      return {
        content: generatorChunks.join(''),
        reasoning: '',
        promptTokens: 200,
        completionTokens: 80,
        usageKnown: true,
        firstTokenMs: 123,
        firstContentMs: 130,
      };
    },
  };
}

function collectEvents() {
  const events = [];
  const emit = (event, payload) => events.push({ event, payload });
  return { events, emit };
}

/**
 * 测试专用日志目录：runTurn 内部会 new SessionLogger() 写 JSONL，
 * 默认目录是项目的 results/（真实实验日志）。测试必须重定向到临时目录，
 * 否则每跑一次 npm test 就往 results/ 灌一批 session-*.jsonl，与真实实验数据混淆。
 * 用 mkdtempSync 而非 Date.now() 命名：原子创建、并发跑测试也不会撞名。
 */
const TEST_LOG_DIR = mkdtempSync(path.join(tmpdir(), 'companion-test-'));
after(() => {
  rmSync(TEST_LOG_DIR, { recursive: true, force: true });
});

const baseTurn = {
  data,
  message: '最近好累',
  history: [],
  client: null,
  mode: 'A',
  // 全部用例经 baseTurn 展开，因此这里注入即可覆盖每次 runTurn 调用
  logDir: TEST_LOG_DIR,
};

test('A 模式：跳过 Director，事件序列 stage(generator)→delta*→done，无 brief 事件', async () => {
  const client = makeMockClient({ directorReplies: [VALID_BRIEF], generatorChunks: ['你', '好'] });
  const { events, emit } = collectEvents();
  const result = await runTurn({ ...baseTurn, client, mode: 'A', emit });

  const seq = events.map((e) => e.event);
  assert.deepEqual(seq, ['stage', 'delta', 'delta', 'done']);
  assert.equal(events[0].payload.stage, 'generator');
  assert.equal(client.calls.filter((c) => c.kind === 'director').length, 0);
  assert.equal(result.reply, '你好');
  // A 模式注入全部 26 条记忆（渲染格式：`- 内容（状态：xxx）`，不带编号）
  const genMsg = client.calls.find((c) => c.kind === 'generator').messages[1].content;
  assert.equal((genMsg.match(/^- /gm) || []).length, 26);
  assert.equal((genMsg.match(/M\d{3}/g) || []).length, 0, 'Generator 输入不得包含记忆编号');
  // metrics 完整性
  const m = result.metrics;
  assert.equal(m.mode, 'A');
  assert.equal(m.directorLatencyMs, 0);
  assert.equal(m.generatorFirstTokenMs, 123);
  assert.equal(m.degraded, false);
  assert.equal(m.retries, 0);
  assert.deepEqual(m.generatorTokens, { input: 200, output: 80 });
  assert.ok('totalLatencyMs' in m && 'estimatedCostCNY' in m);
});

test('B 模式：只注入 curated 4 条记忆', async () => {
  const client = makeMockClient({ directorReplies: [VALID_BRIEF], generatorChunks: ['好'] });
  await runTurn({ ...baseTurn, client, mode: 'B', emit: () => {} });
  const genMsg = client.calls.find((c) => c.kind === 'generator').messages[1].content;
  assert.equal((genMsg.match(/^- /gm) || []).length, 4);
  // 按内容断言：curated 记忆（M001~M004）进入，非 curated（M016 改成喝茶）不进入
  assert.ok(genMsg.includes('弹吉他放松') && !genMsg.includes('改成喝茶'));
  assert.equal((genMsg.match(/M\d{3}/g) || []).length, 0, 'Generator 输入不得包含记忆编号');
});

test('C 模式：事件序列 stage(director)→brief→stage(generator)→delta→done；策略进入 Generator 输入', async () => {
  const client = makeMockClient({ directorReplies: [VALID_BRIEF], generatorChunks: ['嗯'] });
  const { events, emit } = collectEvents();
  const result = await runTurn({ ...baseTurn, client, mode: 'C', emit });

  const seq = events.map((e) => e.event);
  assert.deepEqual(seq, ['stage', 'brief', 'stage', 'delta', 'done']);
  assert.equal(events[0].payload.stage, 'director');
  assert.equal(events[2].payload.stage, 'generator');
  const briefEvt = events[1].payload;
  assert.equal(briefEvt.validation.passed, true);
  assert.equal(briefEvt.degraded, undefined);
  assert.equal(result.brief.conversationStrategy.primary, '共情');
  const genMsg = client.calls.find((c) => c.kind === 'generator').messages[1].content;
  assert.ok(genMsg.includes('conversationStrategy'));
  // Generator 只拿被选中的记忆原文（M001 的内容），不是全部 26 条
  assert.ok(genMsg.includes('弹吉他放松'));
  assert.ok(!genMsg.includes('改成喝茶')); // M016 未被选中
  assert.equal((genMsg.match(/M\d{3}/g) || []).length, 0, 'Brief 清洗后不得残留 memoryId');
  assert.equal(result.metrics.retries, 0);
});

test('D 模式：Director 收到的 system prompt 不含 Strategy 段且带禁令；策略不进入 Generator', async () => {
  const client = makeMockClient({ directorReplies: [VALID_BRIEF_D], generatorChunks: ['嗯'] });
  const result = await runTurn({ ...baseTurn, client, mode: 'D', emit: () => {} });
  const dirCall = client.calls.find((c) => c.kind === 'director');
  assert.ok(!dirCall.messages[0].content.includes('### 3. Strategy'));
  assert.ok(dirCall.messages[0].content.includes('D 模式附加要求'));
  const genMsg = client.calls.find((c) => c.kind === 'generator').messages[1].content;
  assert.ok(!genMsg.includes('conversationStrategy'));
  assert.equal(result.brief.conversationStrategy, undefined);
});

test('C 模式：Director 调用带 strict json_schema（不再用 json_object）与 temperature 0.1', async () => {
  const client = makeMockClient({ directorReplies: [VALID_BRIEF], generatorChunks: ['嗯'] });
  await runTurn({ ...baseTurn, client, mode: 'C', emit: () => {} });
  const dirCall = client.calls.find((c) => c.kind === 'director');
  // json_schema 严格模式：传 {name, schema}，由 model-client 构造 response_format
  assert.equal(dirCall.responseFormat, undefined);
  assert.equal(dirCall.jsonSchema.name, 'dynamic_conversation_brief');
  assert.ok(dirCall.jsonSchema.schema && typeof dirCall.jsonSchema.schema === 'object');
  // 严格变体特征：根级全属性必填 + additionalProperties:false + conversationStrategy 在列
  const s = dirCall.jsonSchema.schema;
  assert.ok(s.required.includes('conversationStrategy'));
  assert.ok(s.required.includes('safety'));
  assert.equal(s.additionalProperties, false);
  assert.equal(dirCall.temperature, 0.1);
  const genCall = client.calls.find((c) => c.kind === 'generator');
  assert.equal(genCall.temperature, 0.8);
});

test('校验失败一次 → 带错误回传修复一次 → 通过（retries=1，validation.retried=true，tokens 累加）', async () => {
  const client = makeMockClient({
    directorReplies: ['这不是 JSON', VALID_BRIEF], // 第一次坏输出，第二次修复
    generatorChunks: ['好'],
  });
  const result = await runTurn({ ...baseTurn, client, mode: 'C', emit: () => {} });
  const directorCalls = client.calls.filter((c) => c.kind === 'director');
  assert.equal(directorCalls.length, 2);
  // 第二次调用的消息应包含上一次的错误信息
  assert.ok(directorCalls[1].messages.some((m) => /未通过校验|未找到 JSON/.test(m.content)));
  assert.equal(result.metrics.retries, 1);
  assert.equal(result.validation.retried, true);
  assert.equal(result.metrics.degraded, false);
  // P2-3 回归：重试时两次调用的 tokens 累加（mock 每次返回 input:100/output:50）
  assert.deepEqual(result.metrics.directorTokens, { input: 200, output: 100 });
  // P2-3 回归：latencyMs 为两次调用耗时之和（> 0）
  assert.ok(result.metrics.directorLatencyMs >= 0);
});

test('两次均失败 → degraded=true，按 A 组方式生成（全量记忆），brief=null，Director JSON 绝不当回复', async () => {
  const client = makeMockClient({
    directorReplies: ['坏输出1', '坏输出2'],
    generatorChunks: ['降', '级', '回复'],
  });
  const { events, emit } = collectEvents();
  const result = await runTurn({ ...baseTurn, client, mode: 'C', emit });

  assert.equal(result.metrics.degraded, true);
  assert.equal(result.brief, null);
  assert.equal(result.validation.passed, false);
  const briefEvt = events.find((e) => e.event === 'brief').payload;
  assert.equal(briefEvt.degraded, true);
  assert.equal(briefEvt.brief, null);
  // 降级后 Generator 输入 = A 组（全量 26 条记忆）
  const genMsg = client.calls.find((c) => c.kind === 'generator').messages[1].content;
  assert.equal((genMsg.match(/^- /gm) || []).length, 26);
  // 回复来自 Generator 流，而不是 Director 的坏输出
  assert.equal(result.reply, '降级回复');
});

test('白名单违规：编造 memoryId 被剔除且不触发重试', async () => {
  const brief = JSON.parse(VALID_BRIEF);
  brief.personalization.selectedMemories.push({ memoryId: 'M999', relevance: 0.5, reason: 'r', usageSuggestion: 'u' });
  const client = makeMockClient({ directorReplies: [JSON.stringify(brief)], generatorChunks: ['好'] });
  const result = await runTurn({ ...baseTurn, client, mode: 'C', emit: () => {} });
  assert.equal(client.calls.filter((c) => c.kind === 'director').length, 1); // 不重试
  assert.deepEqual(result.validation.removedMemoryIds, ['M999']);
  assert.ok(result.brief.personalization.selectedMemories.every((m) => m.memoryId !== 'M999'));
  // Generator 只拿到 M001 原文内容（编号已被清洗，绝不出现在输入中）
  const genMsg = client.calls.find((c) => c.kind === 'generator').messages[1].content;
  assert.ok(genMsg.includes('弹吉他放松'));
  assert.equal((genMsg.match(/M\d{3}/g) || []).length, 0, 'Generator 输入不得包含任何记忆编号');
});

test('无效模式 / 空消息：抛出明确错误', async () => {
  const client = makeMockClient({ directorReplies: [VALID_BRIEF], generatorChunks: [] });
  await assert.rejects(() => runTurn({ ...baseTurn, client, mode: 'X' }), /无效的实验模式/);
  await assert.rejects(() => runTurn({ ...baseTurn, client, mode: 'A', message: '   ' }), /message 不能为空/);
});

test('模型调用抛错：留痕 error 字段并向上抛出', async () => {
  // Director 走 streamChatCompletion（流式），故错误从该入口抛出
  const client = {
    chatCompletion: async () => { throw new Error('Director 不应再走非流式入口'); },
    streamChatCompletion: async () => { throw new Error('模拟网络错误'); },
  };
  await assert.rejects(() => runTurn({ ...baseTurn, client, mode: 'C', emit: () => {} }), /模拟网络错误/);
});

test('SessionLogger：JSONL 追加且行可解析；毫秒精度文件名，不同毫秒不合并', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'qa-logger-'));
  try {
    const logger = new SessionLogger(dir);
    logger.log({ a: 1 });
    logger.log({ a: 2 });
    const content = readFileSync(logger.filePath, 'utf-8');
    const lines = content.trim().split('\n');
    assert.equal(lines.length, 2);
    assert.deepEqual(JSON.parse(lines[0]), { a: 1 });
    // P2-5 回归：文件名含毫秒（session-YYYYMMDD-HHmmss-SSS.jsonl）
    assert.match(path.basename(logger.filePath), /^session-\d{8}-\d{6}-\d{3}\.jsonl$/);
    // 同一实例始终写同一文件
    logger.log({ a: 3 });
    assert.equal(readFileSync(logger.filePath, 'utf-8').trim().split('\n').length, 3);
    // 确保跨毫秒后新建 logger → 新文件（不再合并同一秒的多个请求）
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 3); // 同步睡 3ms
    const logger2 = new SessionLogger(dir);
    logger2.log({ b: 1 });
    assert.notEqual(logger2.filePath, logger.filePath);
    assert.equal(readFileSync(logger2.filePath, 'utf-8').trim().split('\n').length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('P2-4 回归：Director 输入历史同样截断为最近 10 轮（20 条）', async () => {
  const client = makeMockClient({ directorReplies: [VALID_BRIEF_D], generatorChunks: ['嗯'] });
  const longHistory = Array.from({ length: 30 }, (_, i) => ({
    role: i % 2 ? 'assistant' : 'user',
    content: '历史消息' + i,
  }));
  await runTurn({ ...baseTurn, client, mode: 'D', history: longHistory, emit: () => {} });
  const dirUserMsg = client.calls.find((c) => c.kind === 'director').messages[1].content;
  // 最早的 10 条（历史消息0~9）被截掉，最近 20 条保留
  assert.ok(!dirUserMsg.includes('历史消息0'));
  assert.ok(!dirUserMsg.includes('历史消息9'));
  assert.ok(dirUserMsg.includes('历史消息10'));
  assert.ok(dirUserMsg.includes('历史消息29'));
});

// ---------- 控制台模型 IO 日志接入（stage/label 透传 + 轮次摘要） ----------

/** 在 console.log 被替换的情况下执行 fn，返回捕获到的全部输出 */
async function captureConsole(fn) {
  const logs = [];
  const originalLog = console.log;
  console.log = (...args) => logs.push(args.map((a) => String(a)).join(' '));
  try {
    await fn();
  } finally {
    console.log = originalLog;
  }
  return logs.join('\n');
}

test('控制台日志接入：Director/Generator 的 stage 与修复重试 label 正确透传', async () => {
  const client = makeMockClient({ directorReplies: ['坏输出', VALID_BRIEF], generatorChunks: ['嗯'] });
  await captureConsole(() => runTurn({ ...baseTurn, client, mode: 'C', emit: () => {} }));

  const directorCalls = client.calls.filter((c) => c.kind === 'director');
  assert.equal(directorCalls.length, 2);
  assert.equal(directorCalls[0].stage, 'director', 'Director 首次调用应带 stage=director');
  assert.equal(directorCalls[0].label, undefined, '首次调用不应带修复重试 label');
  assert.equal(directorCalls[1].stage, 'director');
  assert.equal(directorCalls[1].label, '修复重试', '第二次调用应标注修复重试');
  assert.equal(
    client.calls.find((c) => c.kind === 'generator').stage,
    'generator',
    'Generator 调用应带 stage=generator'
  );
});

test('控制台日志接入：成功轮次在 done 后打印摘要（含模式/降级/Brief 摘要）', async () => {
  const client = makeMockClient({ directorReplies: [VALID_BRIEF], generatorChunks: ['嗯'] });
  const text = await captureConsole(() => runTurn({ ...baseTurn, client, mode: 'C', emit: () => {} }));
  if (!isModelIoLogEnabled()) return; // LOG_MODEL_IO=off 时零输出，无需断言
  assert.match(text, /■ 轮次完成/);
  assert.match(text, /模式 C/);
  assert.match(text, /降级 否/);
  assert.match(text, /Brief 摘要：情绪 \[疲惫 0\.80\] \| 策略 共情 \+ 陪伴 \| 记忆 M001/);
});

test('控制台日志接入：A 模式 brief=null 时摘要仍输出且提示无 Brief', async () => {
  const client = makeMockClient({ directorReplies: [VALID_BRIEF], generatorChunks: ['嗯'] });
  const text = await captureConsole(() => runTurn({ ...baseTurn, client, mode: 'A', emit: () => {} }));
  if (!isModelIoLogEnabled()) return;
  assert.match(text, /■ 轮次完成/);
  assert.match(text, /模式 A/);
  assert.match(text, /Brief 摘要：（无 Brief/);
});
