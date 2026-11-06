/**
 * model-client.test.js — 模型客户端纯逻辑（无网络依赖部分，安装依赖前即可运行）
 * 覆盖：成本估算、配置常量（enable_thinking 为顶层参数的关键由代码评审保证，此处锁配置值）
 * 运行：npm test
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { MODEL_CONFIG, TEMPERATURES, estimateCostCNY, createModelClient, ApiError } from '../src/model-client.js';

test('MODEL_CONFIG：endpoint / 模型名 / 重试策略锁定（防止意外漂移）', () => {
  assert.equal(MODEL_CONFIG.model, 'qwen3.7-flash');
  assert.equal(
    MODEL_CONFIG.endpoint,
    'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions'
  );
  assert.equal(MODEL_CONFIG.networkRetries, 1);
  assert.ok(MODEL_CONFIG.timeoutMs > 0);
});

test('TEMPERATURES：Director 0.1 / Generator 0.8', () => {
  assert.equal(TEMPERATURES.director, 0.1);
  assert.equal(TEMPERATURES.generator, 0.8);
});

test('estimateCostCNY：按单价正确累加 Director+Generator tokens', () => {
  const cost = estimateCostCNY({
    directorTokens: { input: 1_000_000, output: 500_000 },
    generatorTokens: { input: 500_000, output: 1_000_000 },
  });
  // 1M*0.2 + 0.5M*0.2 + 0.5M*0.8 + 1M*0.8 = 0.2 + 0.1 + 0.4 + 0.8 = 1.5
  assert.equal(cost, 1.5);
});

test('estimateCostCNY：缺字段 / 全 0 / null 容错', () => {
  assert.equal(estimateCostCNY({ directorTokens: null, generatorTokens: undefined }), 0);
  assert.equal(
    estimateCostCNY({ directorTokens: { input: 0, output: 0 }, generatorTokens: { input: 0, output: 0 } }),
    0
  );
});

test('estimateCostCNY：典型一轮对话量级合理（小额）', () => {
  const cost = estimateCostCNY({
    directorTokens: { input: 4000, output: 600 },
    generatorTokens: { input: 3000, output: 200 },
  });
  assert.ok(cost > 0 && cost < 0.01, `典型一轮应远小于 0.01 元，实际 ${cost}`);
});

// ---------- chatCompletion：json_schema 构造与 response_format 回退链（stub fetch，不联网） ----------

/** 构造伪 fetch 响应（OpenAI 兼容结构） */
function fakeResponse(ok, body) {
  return {
    ok,
    status: ok ? 200 : 400,
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

test('chatCompletion：jsonSchema 参数构造 strict json_schema；400 时逐级回退 json_object → 无格式', async () => {
  const sentBodies = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    sentBodies.push(JSON.parse(init.body));
    if (sentBodies.length === 1) {
      // 第一次：供应商拒绝 json_schema
      return fakeResponse(false, { error: { message: "Invalid parameter: 'response_format' with type json_schema is not supported" } });
    }
    if (sentBodies.length === 2) {
      // 第二次：连 json_object 也不支持（极端情况）
      return fakeResponse(false, { error: { message: "Invalid parameter: 'response_format'" } });
    }
    return fakeResponse(true, {
      choices: [{ message: { content: '{"ok":1}' } }],
      usage: { prompt_tokens: 1, completion_tokens: 2 },
    });
  };
  try {
    const client = createModelClient({ apiKey: 'test-key' });
    const schema = { type: 'object', properties: { a: { type: 'string' } }, required: ['a'], additionalProperties: false };
    const result = await client.chatCompletion({
      messages: [{ role: 'user', content: 'x' }],
      jsonSchema: { name: 't', schema },
    });
    assert.equal(result.content, '{"ok":1}');
    assert.equal(result.promptTokens, 1);
    assert.equal(result.completionTokens, 2);

    // 请求 1：strict json_schema（原样传入 schema）
    assert.deepEqual(sentBodies[0].response_format, {
      type: 'json_schema',
      json_schema: { name: 't', strict: true, schema },
    });
    assert.equal(sentBodies[0].enable_thinking, false);
    // 请求 2：回退 json_object
    assert.deepEqual(sentBodies[1].response_format, { type: 'json_object' });
    // 请求 3：最终兜底为无 response_format
    assert.ok(!('response_format' in sentBodies[2]));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('chatCompletion：与 response_format 无关的 400 不触发回退，直接抛 ApiError', async () => {
  const sentBodies = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    sentBodies.push(JSON.parse(init.body));
    return fakeResponse(false, { error: { message: 'Invalid API key provided' } });
  };
  try {
    const client = createModelClient({ apiKey: 'test-key' });
    await assert.rejects(
      () =>
        client.chatCompletion({
          messages: [{ role: 'user', content: 'x' }],
          jsonSchema: { name: 't', schema: { type: 'object' } },
        }),
      (err) => err instanceof ApiError && err.status === 400
    );
    assert.equal(sentBodies.length, 1, '无关 400 不应发起回退重试');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('chatCompletion：仅传 responseFormat 时原样透传（旧 json_object 路径保留）', async () => {
  const sentBodies = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    sentBodies.push(JSON.parse(init.body));
    return fakeResponse(true, {
      choices: [{ message: { content: '{}' } }],
      usage: { prompt_tokens: 0, completion_tokens: 0 },
    });
  };
  try {
    const client = createModelClient({ apiKey: 'test-key' });
    const result = await client.chatCompletion({
      messages: [{ role: 'user', content: 'x' }],
      responseFormat: { type: 'json_object' },
    });
    assert.equal(result.content, '{}');
    assert.deepEqual(sentBodies[0].response_format, { type: 'json_object' });
  } finally {
    globalThis.fetch = originalFetch;
  }
});
