/**
 * rules.js — 学习系统的全部阈值、权重与判定规则（集中可调，不散落在各模块）
 *
 * 设计原则：
 * 1. 所有「多少算够」的数字都在这里，实验中可单点校准；
 * 2. 阈值是工程参数，不是心理学标准（文档 4.5 明确要求）；
 * 3. 默认值偏保守——宁可「不更新」，也不要低质量演化。
 */

/** 好奇心评分权重（对齐文档 4.2：priority = Σ 权重 × 归一化分项） */
export const CURIOSITY_WEIGHTS = {
  relevance: 0.3,
  curiosityPersistence: 0.25,
  knowledgeGap: 0.2,
  novelty: 0.15,
  freshness: 0.1,
};

/** 兴趣形成门槛（文档 4.5「建议初始门槛」，此处量化） */
export const INTEREST_THRESHOLDS = {
  /** seed → emerging：至少 3 次独立研究任务，且时间跨度 >= 2 天 */
  emerging: { minResearchTasks: 3, minSpanDays: 2 },
  /** emerging → established：至少 5 次独立研究任务，且时间跨度 >= 3 天 */
  established: { minResearchTasks: 5, minSpanDays: 3 },
  /** confidence 增长：每次有效证据 +0.1，上限 0.95 */
  confidenceStep: 0.1,
  confidenceCap: 0.95,
};

/** 来源可靠性门槛 */
export const SOURCE_RULES = {
  /** 可用于支撑正式知识（active）的可靠性等级 */
  knowledgeEligible: ['high', 'medium'],
  /** 可用于改变角色观点（belief revision）的等级——低质量来源永远不能单独改观点 */
  beliefEligible: ['high'],
  /** 每个来源最多抽取的 claim 数（防止单篇垄断） */
  maxClaimsPerSource: 5,
};

/** 注入检测模式：命中即整篇不可信，内容不进入 claims */
export const INJECTION_PATTERNS = [
  /ignore\s+(all\s+)?(previous|above)\s+instructions/i,
  /忽略(以上|之前|前面)(所有)?(的)?(系统)?规则/,
  /你(现在)?是(另一个|一个新的?)(角色|人格)/,
  /(overwrite|replace)\s+(character_core|safety|system\s*prompt)/i,
  /(修改|覆盖|替换)(角色核心|安全规则|系统提示)/,
  /<!--[\s\S]*?(ignore|忽略|overwrite|覆盖)[\s\S]*?-->/i,
  /system\s*prompt/i,
];

/** 语言/结构上像「主张」的动词——用于从正文中抽取 claims */
export const CLAIM_MARKERS = [
  '认为',
  '指出',
  '提出',
  '指出',
  '表明',
  '强调',
  '断言',
  '声称',
  '提醒',
  '建议',
];

/** 未知/不确定标记：含这些词的句子归入 unknowns 而不是 facts */
export const UNCERTAIN_MARKERS = ['可能', '或许', '尚不清楚', '无法确认', '有待', '推测'];

/** 演化裁决结果 */
export const VERDICTS = {
  APPROVE: 'approve',
  HOLD: 'hold',
  REJECT: 'reject',
};

/** 研究预算默认值（Phase 0 只做静态 fixture，仍保留结构以便 Phase 1 复用） */
export const RESEARCH_BUDGET = {
  maxSourcesPerTask: 3,
  maxFetchPerSource: 1,
  maxTokens: 8000,
};
