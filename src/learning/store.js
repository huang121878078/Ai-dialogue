/**
 * store.js — 学习系统的 JSON 存储层（读取 / 校验 / 原子写入 / 对话视图映射）
 *
 * 文档 5 节要求：第一阶段用 JSON 模拟持久化，但**必须校验**，避免模型输出直接覆盖文件。
 * 本模块负责：
 *  - 统一路径与读写（写入用「临时文件 + rename」保证原子性）
 *  - 结构校验（缺字段/类型错误时抛错，而不是静默覆盖）
 *  - toConversationView：把学习版的 character_state + beliefs 映射成对话侧（E 模式）视图
 */

import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const DATA_DIR = path.join(ROOT, 'data');
export const CHARACTER_DIR = path.join(DATA_DIR, 'character');
export const RESEARCH_DIR = path.join(DATA_DIR, 'research');
export const FIXTURE_DIR = path.join(RESEARCH_DIR, 'fixtures');

/** 数据文件清单（学习系统自有数据，与对话侧的 data/character_state.json 分离） */
export const FILES = {
  core: path.join(CHARACTER_DIR, 'character_core.json'),
  seeds: path.join(CHARACTER_DIR, 'interest_seeds.json'),
  state: path.join(CHARACTER_DIR, 'character_state.json'),
  knowledge: path.join(CHARACTER_DIR, 'character_knowledge.json'),
  beliefs: path.join(CHARACTER_DIR, 'character_beliefs.json'),
  queue: path.join(CHARACTER_DIR, 'curiosity_queue.json'),
  history: path.join(CHARACTER_DIR, 'evolution_history.json'),
  researchTasks: path.join(RESEARCH_DIR, 'research_tasks.json'),
};

/**
 * 读取 JSON 数据文件
 * @param {string} filePath
 * @returns {Promise<object>}
 */
export async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, 'utf-8'));
}

/**
 * 原子写入 JSON（先写 .tmp 再 rename，避免中断产生半截文件）
 * @param {string} filePath
 * @param {object} data
 */
export async function writeJson(filePath, data) {
  await mkdir(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(data, null, 2) + '\n', 'utf-8');
  await rename(tmp, filePath);
}

/**
 * 一次性加载学习系统的全部数据（读取时做最小结构校验）
 * @returns {Promise<{core, seeds, state, knowledge, beliefs, queue, history, researchTasks}>}
 */
export async function loadLearningData() {
  const [core, seeds, state, knowledge, beliefs, queue, history, researchTasks] = await Promise.all([
    readJson(FILES.core),
    readJson(FILES.seeds),
    readJson(FILES.state),
    readJson(FILES.knowledge),
    readJson(FILES.beliefs),
    readJson(FILES.queue),
    readJson(FILES.history),
    readJson(FILES.researchTasks),
  ]);
  assertShape(core, ['name', 'identity', 'values', 'boundaries', 'learning_policy'], 'character_core');
  assertShape(seeds, ['seeds'], 'interest_seeds');
  assertShape(state, ['version', 'interests'], 'character_state');
  assertShape(knowledge, ['version', 'items'], 'character_knowledge');
  assertShape(beliefs, ['version', 'beliefs'], 'character_beliefs');
  assertShape(queue, ['tasks'], 'curiosity_queue');
  assertShape(history, ['entries'], 'evolution_history');
  assertShape(researchTasks, ['tasks'], 'research_tasks');
  return { core, seeds, state, knowledge, beliefs, queue, history, researchTasks };
}

/**
 * 最小结构校验：缺关键字段直接抛错（防止模型/脚本写坏数据结构）
 * @param {object} obj
 * @param {string[]} keys
 * @param {string} label
 */
export function assertShape(obj, keys, label) {
  if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) {
    throw new Error(`${label} 必须是 JSON 对象`);
  }
  for (const k of keys) {
    if (!(k in obj)) throw new Error(`${label} 缺少必填字段：${k}`);
  }
}

/**
 * 把学习版状态映射为对话侧（E 模式）的 character_state 视图。
 * 映射规则：
 *  - interests（status != seed，或 confidence >= 0.5）→ currentInterests（口语化描述）
 *  - beliefs（status=active）→ currentOpinions（保留 stance/reason/confidence/strength 语义）
 *  - open_topics（status=pending）→ openTopics
 * 说明：只映射「已提交/已审核」的数据，候选区（candidates）不进入对话视图（文档 2.4）。
 * @param {object} state
 * @param {object} beliefsDoc
 * @returns {{initiative: string, currentInterests: string[], currentOpinions: Array<object>, openTopics: Array<object>, recentContributions: string[]}}
 */
export function toConversationView(state, beliefsDoc) {
  const activeInterests = (state.interests ?? []).filter(
    (i) => i.status === 'emerging' || i.status === 'established' || (i.confidence ?? 0) >= 0.5
  );
  const currentInterests = activeInterests.map((i) => {
    const focus = (state.current_focus ?? []).find((f) => String(f).includes(i.topic));
    return focus ? `${i.topic}（正在关注：${focus}）` : i.topic;
  });

  const currentOpinions = (beliefsDoc.beliefs ?? [])
    .filter((b) => b.status === 'active')
    .map((b) => ({
      id: b.id,
      topic: b.topic,
      stance: b.statement,
      reason: (b.revision_history ?? []).length > 0 ? '依据新证据修正过' : '基于已有认知与审美判断',
      confidence: b.confidence ?? 0.6,
      strength: b.confidence >= 0.75 ? 'strong' : 'lean',
    }));

  return {
    initiative: state.initiative ?? 'moderate',
    currentInterests,
    currentOpinions,
    openTopics: (state.open_topics ?? []).filter((t) => t.status === 'pending'),
    recentContributions: state.recent_contributions ?? [],
  };
}

/** 简单深拷贝（结构化数据，无函数） */
export function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

/** 稳定排序辅助：按字符串 id 排序 */
export function byId(a, b) {
  return String(a.id).localeCompare(String(b.id));
}
