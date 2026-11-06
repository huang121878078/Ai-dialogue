/**
 * data-validation.test.js — 静态数据文件校验（纯 fs，无网络、无第三方依赖，安装依赖前即可运行）
 * 运行：npm test（或 node --test test/data-validation.test.js）
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const readJson = (p) => JSON.parse(readFileSync(path.join(ROOT, p), 'utf-8'));

const memories = readJson('data/memories.json').memories;
const persona = readJson('data/persona.json');
const userProfile = readJson('data/user_profile.json');
const emotion = readJson('data/emotion.json');
const relationship = readJson('data/relationship.json');
const schema = readJson('schemas/director-brief.schema.json');

test('memories.json：共 26 条且 id 唯一、符合 M### 模式', () => {
  assert.equal(memories.length, 26);
  const ids = memories.map((m) => m.id);
  assert.equal(new Set(ids).size, 26);
  for (const id of ids) assert.match(id, /^M\d{3}$/);
});

test('memories.json：五类分布符合需求（4 curated / 2 expired / 2 disputed / 3 inferred）', () => {
  assert.deepEqual(
    memories.filter((m) => m.curated === true).map((m) => m.id),
    ['M001', 'M002', 'M003', 'M004']
  );
  assert.deepEqual(
    memories.filter((m) => m.status === 'expired').map((m) => m.id),
    ['M016', 'M017']
  );
  assert.deepEqual(
    memories.filter((m) => m.status === 'disputed').map((m) => m.id),
    ['M018', 'M019']
  );
  assert.deepEqual(
    memories.filter((m) => m.status === 'inferred' || m.type === 'inference').map((m) => m.id),
    ['M020', 'M021', 'M022']
  );
});

test('memories.json：字段结构一致且类型正确（与 schema memoryId 候选集匹配）', () => {
  const KEY_SET = ['id', 'type', 'content', 'importance', 'source', 'status', 'curated'];
  for (const m of memories) {
    assert.deepEqual(Object.keys(m).sort(), [...KEY_SET].sort(), `字段不一致：${m.id}`);
    assert.equal(typeof m.curated, 'boolean', `curated 必须为布尔：${m.id}`);
    assert.equal(typeof m.importance, 'number', `importance 必须为数字：${m.id}`);
    assert.equal(typeof m.content, 'string');
    assert.ok(m.importance >= 0 && m.importance <= 1, `importance 应在 0~1：${m.id}`);
  }
});

test('persona / user_profile：角色「小满」与用户「阿哲」', () => {
  assert.equal(persona.name, '小满');
  assert.equal(userProfile.nickname, '阿哲');
});

test('emotion / relationship：结构存在且非空', () => {
  assert.ok(emotion.recentEmotion);
  assert.ok(relationship.stage);
});

test('schema：枚举值与 draft-07 声明', () => {
  assert.equal(schema.$schema, 'http://json-schema.org/draft-07/schema#');
  assert.deepEqual(
    schema.properties.conversationStrategy.properties.adviceLevel.enum,
    ['none', 'low', 'medium', 'high']
  );
  assert.deepEqual(
    schema.properties.epistemicAssessment.properties.overallDecision.enum,
    ['confirm', 'disagree', 'uncertain', 'revise']
  );
  assert.deepEqual(
    schema.properties.safety.properties.level.enum,
    ['normal', 'watch', 'elevated', 'critical']
  );
  assert.equal(schema.properties.personalization.properties.selectedMemories.maxItems, 5);
  assert.equal(schema.properties.understanding.properties.emotions.maxItems, 5);
  // conversationStrategy 不在基础 required 中（由代码派生 C/D）
  assert.ok(!schema.required.includes('conversationStrategy'));
  // 各对象 additionalProperties: false
  assert.equal(schema.additionalProperties, false);
  for (const key of ['understanding', 'personalization', 'conversationStrategy', 'epistemicAssessment', 'safety']) {
    assert.equal(schema.properties[key].additionalProperties, false, `${key} 应禁额外字段`);
  }
});
