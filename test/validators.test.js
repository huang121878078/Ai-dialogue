/**
 * validators.test.js — Ajv 校验 / C-D schema 派生 / JSON 提取 / 记忆白名单
 * ⚠️ 依赖 ajv（validators.js 顶部 import ajv）：需先 npm install 再运行
 * 运行：npm test
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { validateBrief, extractJson, validateMemoryWhitelist, getStrictJsonSchema } from '../src/validators.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const memories = JSON.parse(readFileSync(path.join(ROOT, 'data/memories.json'), 'utf-8')).memories;

/** 构造一份合法的完整 Brief（C 可用） */
function makeValidBrief({ strategy = true, memoryIds = ['M001'] } = {}) {
  const brief = {
    version: '1.0',
    understanding: {
      userIntent: '倾诉工作压力',
      topic: '工作压力',
      emotions: [{ label: '疲惫', confidence: 0.8, evidence: ['又加班了'] }],
      possibleNeeds: ['被理解'],
      uncertainties: [],
    },
    personalization: {
      selectedMemories: memoryIds.map((id) => ({
        memoryId: id, relevance: 0.9, reason: '相关', usageSuggestion: '自然提及',
      })),
      relevantPreferences: ['不喜欢说教'],
    },
    epistemicAssessment: {
      claims: [],
      overallDecision: 'confirm',
      beliefUpdateRequired: false,
    },
    safety: { level: 'normal', reason: '无风险信号', responseRequirement: [] },
  };
  if (strategy) {
    brief.conversationStrategy = {
      primary: '共情优先', secondary: '陪伴', adviceLevel: 'low',
      memoryUsage: 'weave_in', followUpDirection: '聊点轻松的',
    };
  }
  return brief;
}

// ---------- extractJson ----------

test('extractJson：裸 JSON / 围栏 / 前后杂文本 / 嵌套括号与字符串内花括号', () => {
  assert.deepEqual(extractJson('{"a":1}'), { a: 1 });
  assert.deepEqual(extractJson('```json\n{"a":1}\n```'), { a: 1 });
  assert.deepEqual(extractJson('```\n{"a":1}\n```'), { a: 1 });
  assert.deepEqual(extractJson('好的，结果如下：{"a":1} 请查收'), { a: 1 });
  assert.deepEqual(extractJson('{"s":"包含 } 和 { 的字符串","o":{"x":1}}'), { s: '包含 } 和 { 的字符串', o: { x: 1 } });
  assert.deepEqual(extractJson('{"s":"转义\\"引号","a":1}'), { s: '转义"引号', a: 1 });
  assert.deepEqual(extractJson('{"a":1} 后面还有别的 {"b":2}'), { a: 1 }); // 只取第一个完整对象
});

test('extractJson：错误输入抛出（无 JSON / 未闭合）', () => {
  assert.throws(() => extractJson('没有任何花括号'));
  assert.throws(() => extractJson('{"a":1'));
  assert.throws(() => extractJson(''));
  assert.throws(() => extractJson(null));
});

// ---------- validateBrief：C/D 派生 ----------

test('C 模式：完整 Brief 通过；缺 conversationStrategy 失败', () => {
  assert.equal(validateBrief(makeValidBrief(), 'C').valid, true);
  const noStrategy = makeValidBrief({ strategy: false });
  const v = validateBrief(noStrategy, 'C');
  assert.equal(v.valid, false);
  assert.ok(v.errors.length > 0);
});

test('D 模式：无策略通过；出现 conversationStrategy 被拒绝（schema 禁字段生效）', () => {
  assert.equal(validateBrief(makeValidBrief({ strategy: false }), 'D').valid, true);
  const withStrategy = makeValidBrief({ strategy: true });
  const v = validateBrief(withStrategy, 'D');
  assert.equal(v.valid, false);
});

test('C/D：枚举违规（adviceLevel / overallDecision / safety.level）被拒', () => {
  const bad = makeValidBrief();
  bad.conversationStrategy.adviceLevel = 'ultra';
  assert.equal(validateBrief(bad, 'C').valid, false);

  const bad2 = makeValidBrief({ strategy: false });
  bad2.epistemicAssessment.overallDecision = 'maybe';
  assert.equal(validateBrief(bad2, 'D').valid, false);

  const bad3 = makeValidBrief({ strategy: false });
  bad3.safety.level = 'extreme';
  assert.equal(validateBrief(bad3, 'D').valid, false);
});

test('C/D：额外字段被拒（additionalProperties:false）；version 必须 "1.0"', () => {
  const extra = makeValidBrief();
  extra.selfInventedField = 'x';
  assert.equal(validateBrief(extra, 'C').valid, false);

  const badVersion = makeValidBrief({ strategy: false });
  badVersion.version = '2.0';
  assert.equal(validateBrief(badVersion, 'D').valid, false);
});

test('C/D：selectedMemories 超过 maxItems=5 被拒；memoryId 模式校验（M### 与 cm-### 均合法）', () => {
  const six = makeValidBrief({ memoryIds: ['M001', 'M002', 'M003', 'M004', 'M005', 'M026'] });
  assert.equal(validateBrief(six, 'C').valid, false);

  const fake = makeValidBrief({ memoryIds: ['M999'] }); // 模式合法但不在候选集（交给白名单）
  assert.equal(validateBrief(fake, 'C').valid, true);

  // CompanionMem 检索源的记忆 ID（cm-001 形态）模式合法（真实值域同样由白名单校验）
  const cmIds = makeValidBrief({ memoryIds: ['cm-001', 'cm-002'] });
  assert.equal(validateBrief(cmIds, 'C').valid, true);

  const badPattern = makeValidBrief({ memoryIds: ['M0 1!'] }); // 含空格/特殊字符
  assert.equal(validateBrief(badPattern, 'C').valid, false);

  const badPattern2 = makeValidBrief({ memoryIds: ['1abc'] }); // 必须字母开头
  assert.equal(validateBrief(badPattern2, 'C').valid, false);
});

test('validateBrief：非对象输入（null/数组/字符串）返回无效', () => {
  for (const input of [null, [], 'x', 42]) {
    const v = validateBrief(input, 'C');
    assert.equal(v.valid, false);
    assert.ok(v.errors.length > 0);
  }
});

// ---------- 记忆白名单 ----------

test('白名单：合法 id 保留、编造 id 剔除、非对象项剔除', () => {
  const selected = [
    { memoryId: 'M001', relevance: 0.9 },
    { memoryId: 'M999', relevance: 0.5 }, // 编造
    'garbage', // 非对象
    null,
    { memoryId: 'M004', relevance: 0.7 },
  ];
  const { kept, removed } = validateMemoryWhitelist(selected, memories);
  assert.deepEqual(kept.map((k) => k.memoryId), ['M001', 'M004']);
  assert.equal(removed.length, 3);
});

test('白名单：空数组 / 非数组输入安全', () => {
  assert.deepEqual(validateMemoryWhitelist([], memories), { kept: [], removed: [] });
  assert.deepEqual(validateMemoryWhitelist(null, memories), { kept: [], removed: [] });
  assert.deepEqual(validateMemoryWhitelist(undefined, memories), { kept: [], removed: [] });
});

// ---------- strict json_schema 变体（json_schema 严格模式用） ----------

test('strict 变体：C 模式根对象 required 补全为全部属性，conversationStrategy 在列', () => {
  const s = getStrictJsonSchema('C');
  assert.deepEqual([...s.required].sort(), [
    'conversationStrategy', 'epistemicAssessment', 'personalization', 'safety', 'understanding', 'version',
  ]);
  assert.equal(s.additionalProperties, false);
  assert.ok(s.properties.conversationStrategy, 'C 模式应保留 conversationStrategy');
});

test('strict 变体：D 模式 conversationStrategy 被移除（靠根级 additionalProperties:false 禁死）', () => {
  const s = getStrictJsonSchema('D');
  assert.ok(!s.properties.conversationStrategy, 'D 模式不应包含 conversationStrategy 属性定义');
  assert.ok(!s.required.includes('conversationStrategy'));
  // D 变体下输出该字段会被 additionalProperties:false 拒绝（约束解码层面）
  assert.equal(s.additionalProperties, false);
});

test('strict 变体：递归生效——嵌套对象全部 required 补全 + additionalProperties:false', () => {
  const s = getStrictJsonSchema('C');
  // understanding 节点
  const u = s.properties.understanding;
  assert.deepEqual([...u.required].sort(), ['emotions', 'possibleNeeds', 'topic', 'uncertainties', 'userIntent']);
  assert.equal(u.additionalProperties, false);
  // 数组 items 内的对象节点（emotions.items）
  const emo = u.properties.emotions.items;
  assert.deepEqual([...emo.required].sort(), ['confidence', 'evidence', 'label']);
  assert.equal(emo.additionalProperties, false);
  // selectedMemories.items
  const sel = s.properties.personalization.properties.selectedMemories.items;
  assert.deepEqual([...sel.required].sort(), ['memoryId', 'reason', 'relevance', 'usageSuggestion']);
  // claims.items：原可选的 relatedMemories 也被补进 required（strict 惯例：全属性必填）
  const claim = s.properties.epistemicAssessment.properties.claims.items;
  assert.deepEqual([...claim.required].sort(), ['assessment', 'claim', 'relatedMemories']);
});

test('strict 变体：const 转单值 enum，meta 关键字被剥除', () => {
  const s = getStrictJsonSchema('C');
  const version = s.properties.version;
  assert.ok(!('const' in version), 'const 应转为 enum');
  assert.deepEqual(version.enum, ['1.0']);
  assert.ok(!('$schema' in s) && !('title' in s) && !('description' in s), 'meta 关键字应被剥除');
  // 枚举字段原样保留
  assert.deepEqual(s.properties.conversationStrategy.properties.adviceLevel.enum, ['none', 'low', 'medium', 'high']);
  assert.equal(s.properties.personalization.properties.selectedMemories.maxItems, 5);
});

test('strict 变体：不污染 Ajv 校验用的原始 schema（双保险互不影响）', () => {
  // Ajv 侧 version 仍走 const 校验（非 enum），说明原始 schema 未被就地修改
  const s = getStrictJsonSchema('C');
  assert.ok('enum' in s.properties.version);
  const badVersion = makeValidBrief({ strategy: false });
  badVersion.version = '2.0';
  assert.equal(validateBrief(badVersion, 'D').valid, false);
});
