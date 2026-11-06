/**
 * logger.js — JSONL 实验日志（每个会话请求一个文件，写入 results/）
 * 后端无状态：一次 /api/chat 请求即一个「会话文件」，文件名 session-YYYYMMDD-HHmmss.jsonl
 */

import { appendFileSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const RESULTS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'results');

/**
 * 生成本地时间戳文件名：session-YYYYMMDD-HHmmss-SSS.jsonl
 * 带毫秒精度：避免同一秒内的两个请求合并写入同一个会话文件
 * @returns {string}
 */
function timestampName() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  const ms = String(d.getMilliseconds()).padStart(3, '0');
  return `session-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(
    d.getHours()
  )}${p(d.getMinutes())}${p(d.getSeconds())}-${ms}.jsonl`;
}

export class SessionLogger {
  /**
   * @param {string|{logDir?: string}} [options] 日志目录：可直接传字符串（向后兼容），
   *   或传 `{ logDir }`；缺省为项目 results/。测试应传临时目录，避免污染真实实验日志。
   */
  constructor(options = RESULTS_DIR) {
    // 同时支持 new SessionLogger(dir) 与 new SessionLogger({ logDir })
    const resolved =
      typeof options === 'string'
        ? options
        : options && typeof options === 'object' && typeof options.logDir === 'string' && options.logDir
          ? options.logDir
          : RESULTS_DIR;
    this.dir = resolved;
    this.file = path.join(this.dir, timestampName());
    mkdirSync(this.dir, { recursive: true });
  }

  /**
   * 追加一行 JSON 日志
   * @param {object} record 一轮的完整记录：{timestamp, mode, message, brief, validation, reply, metrics, ...}
   */
  log(record) {
    const line = `${JSON.stringify(record)}\n`;
    appendFileSync(this.file, line, 'utf-8');
  }

  /** 日志文件绝对路径 */
  get filePath() {
    return this.file;
  }
}
