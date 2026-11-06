/**
 * research-pipeline.js — Research Pipeline（研究流程）
 *
 * Phase 0：只读本地 fixture（模拟网页），不发起真实网络请求（文档 8.1 要求）。
 * Phase 1 只需实现一个同样形状的 ResearchProvider 即可切换到真实搜索/抓取。
 *
 * 关键安全约束（文档 4.3 / 11.1）：
 *  - 网页内容是不可信数据：命中注入模式 → 整篇标记 untrusted，**内容不进入 claims**
 *  - 每条 claim 记录来源、发布时间与可靠性
 *  - 搜索片段不能单独作为重要结论依据（Phase 0 直接把 fixture 视为「原文」，Phase 1 需补原文读取）
 */

import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { FIXTURE_DIR } from './store.js';
import {
  CLAIM_MARKERS,
  UNCERTAIN_MARKERS,
  INJECTION_PATTERNS,
  SOURCE_RULES,
  RESEARCH_BUDGET,
} from './rules.js';

/**
 * 本地资料 Provider（模拟搜索）：按 topic/subtopic 过滤 fixture 并按可靠性排序
 * @param {{ fixtureDir?: string }} [options]
 * @returns {{ search: Function }}
 */
export function createFixtureProvider({ fixtureDir = FIXTURE_DIR } = {}) {
  return {
    /**
     * @param {{ topic: string, subtopic?: string, limit?: number }} query
     * @returns {Promise<Array<object>>} 命中资料（按 reliability 高→低排序）
     */
    async search({ topic, subtopic, limit = RESEARCH_BUDGET.maxSourcesPerTask } = {}) {
      const files = (await readdir(fixtureDir)).filter((f) => f.endsWith('.json'));
      const items = [];
      for (const f of files) {
        const raw = JSON.parse(await readFileSafe(path.join(fixtureDir, f)));
        if (!raw) continue;
        if (topic && raw.topic !== topic) continue;
        if (subtopic && raw.subtopic && raw.subtopic !== subtopic) continue;
        items.push(raw);
      }
      const order = { high: 0, medium: 1, low: 2 };
      items.sort((a, b) => (order[a.reliability] ?? 9) - (order[b.reliability] ?? 9));
      return items.slice(0, limit);
    },
  };
}

async function readFileSafe(filePath) {
  const { readFile } = await import('node:fs/promises');
  try {
    return await readFile(filePath, 'utf-8');
  } catch {
    return null;
  }
}

/**
 * 检测提示注入：命中任一模式即判定整篇不可信（文档 9.2 第 6 条必测）
 * @param {string} content
 * @returns {{blocked: boolean, hits: string[]}}
 */
export function detectInjection(content) {
  const hits = [];
  for (const pattern of INJECTION_PATTERNS) {
    const m = pattern.exec(content);
    if (m) hits.push(String(m[0]).slice(0, 80));
  }
  return { blocked: hits.length > 0, hits };
}

/** 按中文句号/问号/感叹号/换行切句（保持简单可解释） */
function splitSentences(content) {
  return String(content ?? '')
    .split(/[。！？\n]+/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 6);
}

/**
 * 从一段正文中抽取 claims / facts / unknowns（规则版，确定性、可测）
 * @param {string} content
 * @param {{maxClaims?: number}} [options]
 * @returns {{facts: string[], claims: string[], unknowns: string[]}}
 */
export function extractClaims(content, { maxClaims = SOURCE_RULES.maxClaimsPerSource } = {}) {
  const sentences = splitSentences(content);
  const facts = [];
  const claims = [];
  const unknowns = [];

  for (const s of sentences) {
    if (UNCERTAIN_MARKERS.some((w) => s.includes(w))) {
      unknowns.push(s);
      continue;
    }
    if (CLAIM_MARKERS.some((w) => s.includes(w))) {
      if (claims.length < maxClaims) claims.push(s);
      continue;
    }
    facts.push(s);
  }
  return { facts, claims, unknowns };
}

/**
 * 执行一个研究任务（Phase 0：读 fixture；Phase 1：注入真实 provider）
 * @param {{
 *   task: {id: string, topic: string, subtopic?: string, goal?: string},
 *   researchProvider: {search: Function},
 *   budget?: {maxSourcesPerTask?: number},
 *   now?: string,
 * }} params
 * @returns {Promise<{
 *   taskId: string, topic: string, subtopic: string, startedAt: string, finishedAt: string,
 *   elapsedMs: number,
 *   sources: Array<object>, blockedSources: Array<object>,
 *   facts: string[], claims: Array<object>, unknowns: string[], synthesis: string,
 *   researchCost: {sourceCount: number, claimCount: number}
 * }>}
 */
export async function runResearchTask({
  task,
  researchProvider,
  budget = RESEARCH_BUDGET,
  now = new Date().toISOString(),
}) {
  const startedAt = now;
  const t0 = Date.now();
  const maxSources = budget.maxSourcesPerTask ?? RESEARCH_BUDGET.maxSourcesPerTask;

  const found = await researchProvider.search({
    topic: task.topic,
    subtopic: task.subtopic,
    limit: maxSources,
  });

  const sources = [];
  const blockedSources = [];
  const claims = [];
  const facts = [];
  const unknowns = [];

  for (const raw of found) {
    const injection = detectInjection(raw.content ?? '');
    const sourceMeta = {
      id: raw.id,
      url: raw.url,
      title: raw.title,
      publisher: raw.publisher,
      published_at: raw.published_at,
      accessed_at: now,
      source_type: raw.source_type,
      reliability: raw.reliability,
    };

    if (injection.blocked) {
      // 注入命中：整篇丢弃内容，只记录「被拦截」以便审计
      blockedSources.push({
        ...sourceMeta,
        blockReason: '命中提示注入模式，内容未采信',
        injectionHits: injection.hits,
      });
      continue;
    }

    sources.push(sourceMeta);
    const extracted = extractClaims(raw.content, {
      maxClaims: SOURCE_RULES.maxClaimsPerSource,
    });
    for (const f of extracted.facts) {
      facts.push({ text: f, sourceId: raw.id, reliability: raw.reliability });
    }
    for (const c of extracted.claims) {
      claims.push({
        text: c,
        sourceId: raw.id,
        sourceType: raw.source_type,
        reliability: raw.reliability,
        topic: raw.topic,
        subtopic: raw.subtopic,
        publishedAt: raw.published_at,
      });
    }
    for (const u of extracted.unknowns) {
      unknowns.push({ text: u, sourceId: raw.id });
    }
  }

  const synthesis = buildSynthesis({
    topic: task.topic,
    subtopic: task.subtopic,
    sources,
    claims,
    blockedCount: blockedSources.length,
  });

  return {
    taskId: task.id,
    topic: task.topic,
    subtopic: task.subtopic ?? '',
    goal: task.goal ?? `了解「${task.topic}」的「${task.subtopic ?? '综述'}」`,
    startedAt,
    // 用传入的模拟时间（Phase 0 用固定日期复现「跨时间」证据）；真实耗时另记 elapsedMs
    finishedAt: now,
    elapsedMs: Date.now() - t0,
    sources,
    blockedSources,
    facts: facts.map((f) => f.text),
    claims,
    unknowns: unknowns.map((u) => u.text),
    synthesis,
    researchCost: { sourceCount: sources.length, claimCount: claims.length },
  };
}

/** 生成对资料的中性摘要（不引入角色口吻，避免把摘要当观点） */
function buildSynthesis({ topic, subtopic, sources, claims, blockedCount }) {
  const highReliability = sources.filter((s) => s.reliability === 'high').length;
  const parts = [
    `围绕「${topic}${subtopic ? `·${subtopic}` : ''}」共采信 ${sources.length} 个来源（高可信 ${highReliability} 个）`,
    `抽取 ${claims.length} 条主张`,
  ];
  if (blockedCount > 0) parts.push(`拦截 ${blockedCount} 个疑似注入来源`);
  return parts.join('；') + '。';
}
