/**
 * server.js — 原生 node:http 服务：静态文件 + API（/api/chat SSE、/api/data、/api/reset、/api/memory/reset）
 * 无状态：会话历史由前端维护并随请求传入
 */

import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import 'dotenv/config';
import { createModelClient } from './model-client.js';
import { runTurn } from './orchestrator.js';
import { createMem0Client } from './mem0-client.js';
import { createCompanionMemClient } from './companionmem-client.js';
import { toConversationView } from './learning/store.js';

let globalMem0Client = null;
let globalCompanionMemClient = null;
/** 当前 CompanionMem 生效的 agentId（reset 接口校验用） */
let globalCmAgentId = null;

/**
 * 默认测试设备 ID（写死）：CM_AGENT_ID 未配置时使用。
 * 与生产设备完全隔离的专属记忆库——实验台对话可安全写入（默认开）、蒸馏、召回，
 * 不污染 Yodada 生产记忆；需要接生产数据时在 .env 显式配置 CM_AGENT_ID。
 */
const DEFAULT_TEST_AGENT_ID = 'c8:47:8c:de:ad:01';

import { isModelIoLogEnabled } from './console-logger.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC_DIR = path.join(ROOT, 'public');
const DATA_DIR = path.join(ROOT, 'data');

const PORT = Number(process.env.PORT ?? 3000);
const HOST = process.env.HOST ?? '127.0.0.1';

/** 请求体大小上限（字节） */
const MAX_BODY_BYTES = 1_000_000;

/** 静态文件 content-type 映射 */
const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

/** 启动即校验 API Key（缺失直接报清晰错误退出） */
function assertApiKey() {
  if (!process.env.DASHSCOPE_API_KEY) {
    console.error(
      [
        '[启动失败] 缺少 DASHSCOPE_API_KEY。',
        '请复制 .env.example 为 .env，并填入百炼控制台（https://bailian.console.aliyun.com）获取的 API Key。',
      ].join('\n')
    );
    process.exit(1);
  }
}

/** 静态数据在启动时一次性加载（不接数据库，纯静态 JSON） */
async function loadStaticData() {
  const readJson = async (name) =>
    JSON.parse(await readFile(path.join(DATA_DIR, name), 'utf-8'));
  const [persona, userProfile, memoriesRaw, emotion, relationship, characterCore, characterState] =
    await Promise.all([
      readJson('persona.json'),
      readJson('user_profile.json'),
      readJson('memories.json'),
      readJson('emotion.json'),
      readJson('relationship.json'),
      // 角色自身认知数据（Character Cognition）：stable = 价值观/偏好，dynamic = 当前关注/观点/待续话题
      readJson('character_core.json'),
      readJson('character_state.json'),
    ]);

  // 角色动态状态来源（E 模式用）：
  //  static（默认）：data/character_state.json —— 手写基线，便于对照组实验
  //  learning      ：data/character/ 下学习系统已提交的状态（version > 0 时生效），
  //                  经 toConversationView 映射（只暴露已审核状态，不含候选研究结果）
  let effectiveCharacterState = characterState;
  const stateSource = (process.env.CHARACTER_STATE_SOURCE ?? 'static').trim().toLowerCase();
  if (stateSource === 'learning') {
    try {
      const learningState = await readJson('character/character_state.json');
      const learningBeliefs = await readJson('character/character_beliefs.json');
      const view = toConversationView(learningState, learningBeliefs);
      // 学习系统尚未产生任何演化（version 0）时保持手写基线，避免空状态让 E 模式"失忆"
      if (Number(learningState.version ?? 0) > 0 && view.currentOpinions.length + view.currentInterests.length > 0) {
        effectiveCharacterState = view;
        console.log(
          `[角色状态] 来源=learning（学习系统 v${learningState.version}：兴趣 ${view.currentInterests.length} 项 / 观点 ${view.currentOpinions.length} 条）`
        );
      } else {
        console.log('[角色状态] 来源=learning 但学习系统尚无演化（v0），回落手写基线');
      }
    } catch (err) {
      console.warn(`[角色状态] 读取学习系统状态失败，回落手写基线：${err?.message ?? err}`);
    }
  }

  return {
    persona,
    userProfile,
    memories: memoriesRaw.memories,
    emotion,
    relationship,
    characterCore,
    characterState: effectiveCharacterState,
  };
}

/**
 * 读取请求体（JSON）
 * @param {http.IncomingMessage} req
 * @returns {Promise<object>} 解析后的 JSON；解析失败抛错
 */
function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('请求体过大（上限 1MB）'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf-8')));
      } catch {
        reject(new Error('请求体不是合法 JSON'));
      }
    });
    req.on('error', (err) => reject(err));
  });
}

/**
 * 提供静态文件（public/ 下），带路径穿越防护
 * @param {string} urlPath 形如 '/' 或 '/app.js'
 * @returns {Promise<{status: number, body: Buffer, contentType: string}|null>} null 表示 404
 */
async function serveStatic(urlPath) {
  const relative = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '');
  const absolute = path.normalize(path.join(PUBLIC_DIR, relative));
  // 防目录穿越：只允许命中 public/ 内部（含边界目录本身）
  if (absolute !== PUBLIC_DIR && !absolute.startsWith(PUBLIC_DIR + path.sep)) return null;
  const ext = path.extname(absolute).toLowerCase();
  const contentType = MIME_TYPES[ext];
  if (!contentType) return null; // 只提供映射内的类型
  try {
    const info = await stat(absolute);
    if (!info.isFile()) return null;
    const body = await readFile(absolute);
    return { status: 200, body, contentType };
  } catch {
    return null;
  }
}

/** 统一 JSON 响应 */
function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

/**
 * 处理 POST /api/chat（SSE 流式响应）
 * 事件序列：stage(director) → brief → stage(generator) → delta* → done / error
 */
async function handleChat(req, res, client, data) {
  let body;
  try {
    body = await readJsonBody(req);
  } catch (err) {
    sendJson(res, 400, { error: err.message });
    return;
  }

  const { message, mode, history, includeThinking, enableSearch } = body ?? {};
  if (typeof message !== 'string' || message.trim().length === 0) {
    sendJson(res, 400, { error: 'message 必须为非空字符串' });
    return;
  }
  if (!['A', 'B', 'C', 'D', 'E', 'R'].includes(mode)) {
    sendJson(res, 400, { error: 'mode 必须为 A/B/C/D/E/R 之一' });
    return;
  }
  if (includeThinking !== undefined && typeof includeThinking !== 'boolean') {
    sendJson(res, 400, { error: 'includeThinking 必须为布尔值' });
    return;
  }
  if (enableSearch !== undefined && typeof enableSearch !== 'boolean') {
    sendJson(res, 400, { error: 'enableSearch 必须为布尔值' });
    return;
  }
  if (
    history !== undefined &&
    (!Array.isArray(history) ||
      history.some((h) => !h || typeof h.content !== 'string' || !['user', 'assistant'].includes(h.role)))
  ) {
    sendJson(res, 400, { error: 'history 必须是 {role, content} 数组' });
    return;
  }

  // SSE 响应头
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });

  /** 每条 SSE 消息：event 行 + data 行 */
  const send = (event, payload) => {
    if (res.writableEnded || res.destroyed) return;
    try {
      res.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
    } catch {
      // 连接已断开，忽略写入错误
    }
  };

  // 客户端断开（关闭页面等）时中止上游模型调用。
  // 注意：必须监听 res 的 close 并用 writableEnded 守卫——req 的 close 在请求体
  // 读完后会立即同步触发（此时再挂监听已错过事件），而 res 的 close 在连接真正
  // 断开时触发；正常结束时 writableEnded 已为 true，不会误 abort 自己的请求。
  const abortController = new AbortController();
  res.on('close', () => {
    if (!res.writableEnded) abortController.abort();
  });

  try {
    await runTurn({
      client,
      data,
      message: message.trim(),
      history: Array.isArray(history) ? history : [],
      mode,
      emit: send,
      externalSignal: abortController.signal,
      includeThinking: includeThinking === true,
      enableSearch: enableSearch === true,
      // R 模式的路由引擎配置：DECISION_WORKSPACE_ID 配置时用百炼决策模型，否则规则引擎
      decisionConfig:
        mode === 'R'
          ? { workspaceId: process.env.DECISION_WORKSPACE_ID, apiKey: process.env.DASHSCOPE_API_KEY }
          : undefined,
      // Mem0 长记忆（配置 MEM0_API_URL/MEM0_API_KEY/MEM0_AGENT_ID 后，Director 候选记忆实时检索）
      mem0Client: globalMem0Client,
      // CompanionMem 长记忆（Yodada 生产同款：分层蒸馏 + context 分区；优先级高于 Mem0）
      companionMemClient: globalCompanionMemClient,
      // 工具执行配置（IQS 联网搜索 key）
      toolOptions: { iqsApiKey: process.env.IQS_API_KEY },
    });
  } catch (err) {
    const msg =
      err?.name === 'AbortError'
        ? '请求已中断'
        : err?.message ?? String(err);
    send('error', { message: msg });
  } finally {
    if (!res.writableEnded) res.end();
  }
}

/** 主入口：启动服务 */
async function main() {
  assertApiKey();
  const data = await loadStaticData();
  const client = createModelClient({ apiKey: process.env.DASHSCOPE_API_KEY });
  // Mem0 长记忆客户端（复用 Yodada 的自建 Mem0 服务；未配置三项 env 时为 null → 用静态记忆）
  globalMem0Client = createMem0Client({
    apiUrl: process.env.MEM0_API_URL,
    apiKey: process.env.MEM0_API_KEY,
    agentId: process.env.MEM0_AGENT_ID,
  });
  // CompanionMem 长记忆客户端（Yodada 生产同款服务：recall 分层记忆 + context 分区覆盖
  // 情绪/关系输入 + 轮后 add 异步蒸馏；未配置 CM_API_URL/CM_API_KEY 时为 null。优先级：companionmem > mem0 > static）
  // agentId 缺省时使用写死的默认测试设备（与生产记忆完全隔离，可安全开启写入闭环）
  const cmAgentId = process.env.CM_AGENT_ID?.trim() || DEFAULT_TEST_AGENT_ID;
  globalCmAgentId = cmAgentId;
  // 写入开关：MEMORY_WRITE 显式配置时按配置；否则仅在使用默认测试设备时默认开启
  // （生产 agent 必须显式 MEMORY_WRITE=on 才写，防止污染生产记忆库）
  const memoryWriteConfigured = process.env.MEMORY_WRITE !== undefined;
  const cmWriteEnabled = memoryWriteConfigured
    ? /^(on|1|true)$/i.test(process.env.MEMORY_WRITE)
    : cmAgentId === DEFAULT_TEST_AGENT_ID;
  globalCompanionMemClient = createCompanionMemClient({
    apiUrl: process.env.CM_API_URL,
    apiKey: process.env.CM_API_KEY,
    agentId: cmAgentId,
    writeEnabled: cmWriteEnabled,
  });

  const server = http.createServer(async (req, res) => {
    const urlPath = (req.url ?? '/').split('?')[0];

    // GET 且非 /api/*：一律按 public/ 下静态文件处理（/ → index.html）
    if (req.method === 'GET' && !urlPath.startsWith('/api/')) {
      const file = await serveStatic(urlPath);
      if (file) {
        res.writeHead(file.status, { 'Content-Type': file.contentType });
        res.end(file.body);
      } else {
        sendJson(res, 404, { error: '未找到资源' });
      }
      return;
    }

    if (req.method === 'GET' && urlPath === '/api/data') {

      sendJson(res, 200, data);
      return;
    }

    if (req.method === 'GET' && urlPath === '/api/status') {
      // 运行时状态（前端展示当前记忆归属设备等；不暴露任何密钥）
      sendJson(res, 200, {
        memorySource: globalCompanionMemClient ? 'companionmem' : globalMem0Client ? 'mem0' : 'static',
        companionMemAgentId: globalCompanionMemClient ? globalCmAgentId : null,
        isDefaultTestAgent: globalCompanionMemClient ? globalCmAgentId === DEFAULT_TEST_AGENT_ID : false,
        memoryWriteEnabled: cmWriteEnabled,
        searchEnabled: Boolean(process.env.IQS_API_KEY),
      });
      return;
    }

    if (req.method === 'POST' && urlPath === '/api/chat') {
      await handleChat(req, res, client, data);
      return;
    }

    if (req.method === 'POST' && urlPath === '/api/reset') {
      // 后端无会话状态，重置由前端完成；此处仅返回确认
      sendJson(res, 200, { ok: true, note: '后端无状态，会话重置在前端本地完成' });
      return;
    }

    if (req.method === 'POST' && urlPath === '/api/memory/reset') {
      // 清空 CompanionMem 测试设备的全部记忆（测试前重置）。
      // 防误清：只允许作用于默认测试设备——当前配置了其他 agent（如 Yodada 生产设备）时拒绝
      if (!globalCompanionMemClient) {
        sendJson(res, 400, { ok: false, error: '未配置 CompanionMem（CM_API_URL / CM_API_KEY）' });
        return;
      }
      if (globalCmAgentId !== DEFAULT_TEST_AGENT_ID) {
        sendJson(res, 403, {
          ok: false,
          error: `当前 agent（${globalCmAgentId}）不是默认测试设备，拒绝清空——清空生产设备记忆请走 Yodada 侧管理`,
        });
        return;
      }
      const result = await globalCompanionMemClient.clearAll();
      console.log(`[companionmem] 测试记忆重置（agent=${DEFAULT_TEST_AGENT_ID}）：${result.message}`);
      sendJson(res, result.ok ? 200 : 500, result);
      return;
    }

    sendJson(res, 404, { error: '未找到路由' });
  });

  server.listen(PORT, HOST, () => {
    console.log(`双模型陪伴实验台已启动：http://${HOST}:${PORT}`);
    console.log(`模式：A/B（单模型） · C/D（双模型 Director→Generator） · R（智能路由 Fast/Cognitive） · 模型 qwen3.7-flash`);
    console.log(
      process.env.DECISION_WORKSPACE_ID
        ? 'R 模式路由引擎：百炼决策模型（decision-model-preview）'
        : 'R 模式路由引擎：规则引擎（在 .env 配置 DECISION_WORKSPACE_ID 可切换为百炼决策模型）'
    );
    console.log(
      globalCompanionMemClient
        ? `记忆源：CompanionMem 实时召回（agent=${process.env.CM_AGENT_ID?.trim() || DEFAULT_TEST_AGENT_ID}${process.env.CM_AGENT_ID?.trim() ? '' : ' · 默认测试设备，与生产隔离'}，L0/L1 分层蒸馏 + context 情绪/关系覆盖）${cmWriteEnabled ? ' · 写入已开启（对话→蒸馏→召回闭环）' : ' · 写入关闭（MEMORY_WRITE=on 开启）'}`
        : globalMem0Client
          ? `记忆源：Mem0 实时检索（agent=${process.env.MEM0_AGENT_ID}，复用 Yodada 记忆服务；配置 CM_API_URL / CM_API_KEY / CM_AGENT_ID 可切换 CompanionMem）`
          : '记忆源：静态 data/memories.json（配置 CM_* 三项用 CompanionMem，或 MEM0_* 三项用 Mem0）'
    );
    console.log(
      process.env.IQS_API_KEY
        ? '联网搜索：IQS 工具模式（web_search function calling，开启「联网搜索」开关后模型按需调用）'
        : '联网搜索：未配置 IQS_API_KEY（「联网搜索」开关将不挂载 web_search 工具）'
    );
    // 角色认知状态来源（E 模式）：static=手写基线，learning=学习系统已提交状态
    {
      const src = (process.env.CHARACTER_STATE_SOURCE ?? 'static').trim().toLowerCase();
      const interestCount = Array.isArray(data.characterState?.currentInterests)
        ? data.characterState.currentInterests.length
        : 0;
      const opinionCount = Array.isArray(data.characterState?.currentOpinions)
        ? data.characterState.currentOpinions.length
        : 0;
      console.log(
        src === 'learning'
          ? `角色认知状态：来源=learning（学习系统已提交状态：兴趣 ${interestCount} 项 / 观点 ${opinionCount} 条）——运行 npm run demo:learning:persist 可产生演化`
          : `角色认知状态：来源=static（手写 data/character_state.json：兴趣 ${interestCount} 项 / 观点 ${opinionCount} 条）；设置 CHARACTER_STATE_SOURCE=learning 可读取学习系统演化结果`
      );
    }
    // 模型 IO 调试日志状态（启动即告知，避免「为什么终端没打印」的困惑）
    console.log(
      isModelIoLogEnabled()
        ? '模型 IO 调试日志：已开启（完整打印每次调用的上下文与返回；设置 LOG_MODEL_IO=off 可关闭，LOG_MAX_CHARS=2000 可截断超长内容）'
        : '模型 IO 调试日志：已关闭（设置 LOG_MODEL_IO=on 可开启）'
    );
  });
}

main().catch((err) => {
  console.error('[启动失败]', err);
  process.exit(1);
});
