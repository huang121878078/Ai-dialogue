/**
 * generator-messages.test.js — Generator 消息组装（无 ajv/dotenv 依赖，安装依赖前即可运行）
 * 覆盖：A/B 记忆注入差异、C/D 策略差异、历史 10 轮截断、记忆状态标注、空记忆、
 *       记忆编号（M###）与 Brief 内部标识绝不进入 Generator 输入（防泄露回归）
 * 运行：npm test
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  takeRecentHistory,
  buildSingleModelMessages,
  buildBriefDrivenMessages,
} from '../src/generator.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const memories = JSON.parse(readFileSync(path.join(ROOT, 'data/memories.json'), 'utf-8')).memories;
const data = {
  persona: { name: '小满' },
  userProfile: { nickname: '阿哲' },
  emotion: { recentEmotion: '疲惫' },
  relationship: { stage: 'gradually_familiar' },
  memories,
};

/** 记忆行格式：`- 内容（状态：xxx）`（渲染不再带 [M###] 前缀） */
const countMemoryLines = (s) => (s.match(/^- /gm) || []).length;
/** Generator 输入中绝不允许出现的记忆编号 */
const countMemoryIds = (s) => (s.match(/M\d{3}/g) || []).length;

test('takeRecentHistory：最多保留 10 轮（20 条），空/非法输入安全', () => {
  const mk = (n) => Array.from({ length: n }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: 'm' + i }));
  assert.equal(takeRecentHistory(mk(30)).length, 20);
  assert.equal(takeRecentHistory(mk(20)).length, 20);
  assert.equal(takeRecentHistory(mk(5)).length, 5);
  assert.equal(takeRecentHistory([]).length, 0);
  assert.equal(takeRecentHistory(null).length, 0);
  // 非法 role / 非 string content 被过滤
  const dirty = [{ role: 'system', content: 'x' }, { role: 'user', content: 'y' }, null, { role: 'user' }];
  assert.equal(takeRecentHistory(dirty).length, 1);
});

test('A 模式：注入全部 26 条记忆（含 expired/disputed/inferred），且不出现任何记忆编号', async () => {
  const msgs = await buildSingleModelMessages({ message: '最近好累', history: [], data, mode: 'A' });
  assert.equal(msgs.length, 2);
  assert.equal(msgs[0].role, 'system');
  assert.equal(msgs[1].role, 'user');
  assert.equal(countMemoryLines(msgs[1].content), 26);
  // 记忆渲染不带 id：通过内容特征而非编号断言注入了正确的记忆
  assert.ok(msgs[1].content.includes('弹吉他放松')); // M001
  assert.ok(msgs[1].content.includes('改成喝茶')); // M016 expired
  assert.ok(msgs[1].content.includes('宅家')); // M018 disputed
  assert.ok(msgs[1].content.includes('赶进度和改需求')); // M020 inferred
  // 硬性防泄露回归：user 输入中绝不出现 M### 编号
  assert.equal(countMemoryIds(msgs[1].content), 0, 'Generator 输入不得包含记忆编号');
  // system 注入 persona / 画像 / 情绪 / 关系
  assert.ok(msgs[0].content.includes('小满'));
  assert.ok(msgs[0].content.includes('阿哲'));
  assert.ok(msgs[0].content.includes('疲惫'));
});

test('B 模式：只注入 curated:true 的 4 条精选记忆，且不出现任何记忆编号', async () => {
  const msgs = await buildSingleModelMessages({ message: '最近好累', history: [], data, mode: 'B' });
  assert.equal(countMemoryLines(msgs[1].content), 4);
  assert.ok(msgs[1].content.includes('弹吉他放松')); // M001
  assert.ok(msgs[1].content.includes('塞尔达')); // M002
  assert.ok(msgs[1].content.includes('讲大道理')); // M003
  assert.ok(msgs[1].content.includes('万青')); // M004
  assert.ok(!msgs[1].content.includes('改成喝茶')); // M016 非 curated
  assert.equal(countMemoryIds(msgs[1].content), 0, 'Generator 输入不得包含记忆编号');
});

test('C 模式：Brief（含 conversationStrategy）完整进入 Generator 输入，记忆带状态标注且无编号', async () => {
  const brief = {
    version: '1.0',
    conversationStrategy: { primary: '共情优先', secondary: '轻提建议', adviceLevel: 'low', memoryUsage: 'weave_in', followUpDirection: '聊音乐' },
    personalization: { selectedMemories: [{ memoryId: 'M001', relevance: 0.9, reason: '放松方式相关', usageSuggestion: '轻提吉他' }] },
  };
  const msgs = await buildBriefDrivenMessages({
    message: '最近好累', history: [], data,
    selectedMemories: memories.slice(0, 2), brief, mode: 'C',
  });
  assert.ok(msgs[1].content.includes('conversationStrategy'));
  assert.ok(msgs[1].content.includes('共情优先'));
  assert.ok(msgs[1].content.includes('状态：')); // 记忆带状态标注
  assert.ok(msgs[0].content.includes('小满')); // persona 在 system
  // Brief 内的 memoryId 被清洗：编号不进入输入，但 reason/usageSuggestion 保留
  assert.equal(countMemoryIds(msgs[1].content), 0, 'Brief 清洗后不得残留 memoryId');
  assert.ok(msgs[1].content.includes('放松方式相关'));
  assert.ok(msgs[1].content.includes('轻提吉他'));
});

test('D 模式：策略从 Generator 输入中被剔除', async () => {
  const brief = {
    version: '1.0',
    conversationStrategy: { primary: 'SECRET-STRATEGY', secondary: 'x', adviceLevel: 'low', memoryUsage: 'x', followUpDirection: 'x' },
    personalization: { selectedMemories: [{ memoryId: 'M002', relevance: 0.8, reason: 'r', usageSuggestion: 'u' }] },
  };
  const msgs = await buildBriefDrivenMessages({
    message: 'x', history: [], data,
    selectedMemories: memories.slice(0, 2), brief, mode: 'D',
  });
  assert.ok(!msgs[1].content.includes('conversationStrategy'));
  assert.ok(!msgs[1].content.includes('SECRET-STRATEGY'));
  assert.equal(countMemoryIds(msgs[1].content), 0, 'D 模式同样不得泄露 memoryId');
});

test('空 selectedMemories：渲染「本轮无可用记忆」占位，不抛错', async () => {
  const brief = { version: '1.0', personalization: { selectedMemories: [] } };
  const msgs = await buildBriefDrivenMessages({ message: 'x', history: [], data, selectedMemories: [], brief, mode: 'C' });
  assert.ok(msgs[1].content.includes('（本轮无可用记忆）'));
});
