/**
 * validators.js — Ajv 校验、记忆白名单校验、JSON 提取
 * 三个模式从基础 schema 派生：
 *  C：conversationStrategy 必填，characterContribution 禁止
 *  D：conversationStrategy 禁止，characterContribution 禁止
 *  E（C + Character Agency）：conversationStrategy 与 characterContribution 均必填
 */

import { readFileSync } from 'node:fs';
import Ajv from 'ajv';

/** 读取基础 schema（conversationStrategy / characterContribution 均不在必填里，由代码按模式派生） */
const baseSchema = JSON.parse(
  readFileSync(new URL('../schemas/director-brief.schema.json', import.meta.url), 'utf-8')
);

const ajv = new Ajv({ allErrors: true, strict: false }); // 默认 draft-07

function cloneSchema(schema) {
  return JSON.parse(JSON.stringify(schema));
}

/** C 模式 schema：conversationStrategy 必填；characterContribution 禁止（draft-07 中 false = 该 key 不可存在） */
const schemaC = cloneSchema(baseSchema);
schemaC.required = [...baseSchema.required, 'conversationStrategy'];
schemaC.properties.characterContribution = false;

/** D 模式 schema：conversationStrategy 与 characterContribution 均禁止 */
const schemaD = cloneSchema(baseSchema);
schemaD.required = baseSchema.required.filter((k) => k !== 'conversationStrategy');
schemaD.properties.conversationStrategy = false;
schemaD.properties.characterContribution = false;

/** E 模式 schema：C + Character Agency——策略与角色贡献均必填 */
const schemaE = cloneSchema(baseSchema);
schemaE.required = [...baseSchema.required, 'conversationStrategy', 'characterContribution'];

const validateC = ajv.compile(schemaC);
const validateD = ajv.compile(schemaD);
const validateE = ajv.compile(schemaE);

/**
 * 把 schema 节点递归转为 OpenAI 系 strict json_schema 兼容的「严格变体」：
 * - 所有带 properties 的对象节点：required 补全为其全部 properties（strict 惯例）
 * - 所有带 properties 的对象节点：强制 additionalProperties: false
 * - properties 中值为 false 的禁字段直接删除（additionalProperties:false 已实现禁令，
 *   且部分供应商的 strict 模式不支持 false 子模式）
 * - const 转为单值 enum（部分供应商 strict 模式不支持 const 关键字）
 * - 剥除 $schema / title / description 等非校验关键字，减少供应商兼容面
 * 注意：这是一个纯转换函数，不改变 Ajv 校验用的原始 schema（双保险：json_schema
 * 约束解码 + Ajv 复核，两者宽松度不同属预期行为）
 * @param {object|Array|*} node schema 节点（对象 / 数组 / 标量）
 * @returns {object|Array|*} 转换后的深拷贝节点（不改入参）
 */
function toStrictNode(node) {
  if (Array.isArray(node)) return node.map(toStrictNode);
  if (node === null || typeof node !== 'object') return node;
  const out = {};
  for (const [key, value] of Object.entries(node)) {
    if (key === '$schema' || key === 'title' || key === 'description') continue;
    if (key === 'const') {
      out.enum = [value];
      continue;
    }
    if (key === 'properties' && value !== null && typeof value === 'object' && !Array.isArray(value)) {
      const props = {};
      for (const [propKey, propSchema] of Object.entries(value)) {
        // false 表示该字段被禁止（D 模式的 conversationStrategy）：删除即可，
        // 对象级 additionalProperties:false 会同时封死该 key
        if (propSchema === false) continue;
        props[propKey] = toStrictNode(propSchema);
      }
      out.properties = props;
      out.required = Object.keys(props); // strict：所有属性必填
      out.additionalProperties = false;
    } else {
      out[key] = toStrictNode(value);
    }
  }
  return out;
}

/** C 模式严格变体（供 json_schema 严格模式使用，模块加载时一次性生成） */
const strictSchemaC = toStrictNode(cloneSchema(schemaC));
/** D 模式严格变体（conversationStrategy 被移除，靠根级 additionalProperties:false 禁死） */
const strictSchemaD = toStrictNode(cloneSchema(schemaD));
/** E 模式严格变体（策略 + 角色贡献均必填） */
const strictSchemaE = toStrictNode(cloneSchema(schemaE));

/**
 * 获取指定模式的 strict json_schema 变体（用于 response_format json_schema 严格模式）
 * @param {'C'|'D'|'E'} mode 实验模式
 * @returns {object} 严格变体 schema（同一引用，调用方不得修改）
 */
export function getStrictJsonSchema(mode) {
  if (mode === 'E') return strictSchemaE;
  return mode === 'C' ? strictSchemaC : strictSchemaD;
}

/**
 * 校验 Brief
 * @param {object} brief 待校验对象
 * @param {'C'|'D'|'E'} mode 实验模式
 * @returns {{valid: boolean, errors: string[]}}
 */
export function validateBrief(brief, mode) {
  if (brief === null || typeof brief !== 'object' || Array.isArray(brief)) {
    return { valid: false, errors: ['Brief 必须是 JSON 对象'] };
  }
  const validator = mode === 'E' ? validateE : mode === 'C' ? validateC : validateD;
  const valid = validator(brief);
  if (valid) return { valid: true, errors: [] };
  const errors = (validator.errors ?? []).map(
    (e) => `${e.instancePath || '(根对象)'} ${e.message ?? ''}`.trim()
  );
  return { valid: false, errors };
}

/**
 * 从模型原始输出中提取 JSON（剥 ```json 围栏 / 首尾杂文本）
 * @param {string} text 模型原始输出
 * @returns {object} 解析出的 JSON 对象
 * @throws {Error} 找不到 JSON / 未闭合 / 解析失败
 */
export function extractJson(text) {
  let s = String(text ?? '').trim();
  // 1) 剥 Markdown 代码围栏
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) s = fence[1].trim();
  // 2) 定位首个 {，括号计数找到配对的 }（容忍首尾杂文本）
  const start = s.indexOf('{');
  if (start === -1) throw new Error('输出中未找到 JSON 对象');
  let depth = 0;
  let end = -1;
  let inString = false;
  let escape = false;
  for (let i = start; i < s.length; i++) {
    const ch = s[i];
    if (escape) {
      escape = false;
      continue;
    }
    if (ch === '\\') {
      if (inString) escape = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  if (end === -1) throw new Error('JSON 对象未闭合');
  const jsonStr = s.slice(start, end + 1);
  try {
    return JSON.parse(jsonStr);
  } catch (err) {
    throw new Error(`JSON 解析失败：${err.message}`);
  }
}

/**
 * 记忆白名单校验：selectedMemories.memoryId 必须存在于候选集
 * @param {Array<{memoryId: string}>} selectedMemories Director 选中的记忆项
 * @param {Array<{id: string}>} candidates memories.json 候选集
 * @returns {{kept: Array<object>, removed: Array<object>}} 保留项与违规项（removed 为原始对象）
 */
export function validateMemoryWhitelist(selectedMemories, candidates) {
  const validIds = new Set(candidates.map((m) => m.id));
  const kept = [];
  const removed = [];
  for (const item of Array.isArray(selectedMemories) ? selectedMemories : []) {
    if (item && typeof item === 'object' && validIds.has(item.memoryId)) {
      kept.push(item);
    } else {
      removed.push(item);
    }
  }
  return { kept, removed };
}
