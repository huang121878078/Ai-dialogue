/**
 * tools.js — function calling 工具注册表与执行器（对齐 Yodada 的工具设计）
 *
 * 工具模式（与百炼 enable_search 直通模式的区别）：
 *  1. 模型按工具描述里的「调用原则」自主判断是否搜索（何时该搜/不该搜有明确规则）
 *  2. 搜索结果为结构化条目（标题/来源/链接/摘要）转 Markdown 回填，带来源、可控可审计
 *  3. IQS 独立搜索 API（engineType=LiteAdvanced），延迟与质量优于模型内置搜索
 *
 * 时间工具与每轮时间注入（buildTimeContext）双保险并存——同 Yodada 的
 * TimeSituationInjector + TimeFunctionProvider 设计。
 */

/** 阿里云 IQS 统一搜索配置（key 从环境变量读取，与 Yodada sys_config id=53 同一服务） */
const IQS_API_URL = 'https://cloud-iqs.aliyuncs.com/search/unified';

/** 工具循环的最大轮数（防止模型反复调用工具不收敛） */
export const MAX_TOOL_ROUNDS = 3;

/**
 * IQS 联网搜索（复用 Yodada 的 AlibabaSearchProvider 协议）
 * @param {string} query 搜索关键词
 * @param {{ apiKey: string, fetchImpl?: Function, timeoutMs?: number }} options
 * @returns {Promise<Array<{title: string, link: string, snippet: string, source: string}>>}
 */
async function iqsSearch(query, { apiKey, fetchImpl = fetch, timeoutMs = 8000 }) {
  if (!apiKey) throw new Error('未配置 IQS_API_KEY，联网搜索不可用');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(IQS_API_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        query,
        engineType: 'LiteAdvanced',
        contents: { summary: true },
      }),
      signal: controller.signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`IQS 搜索返回非 2xx：HTTP ${res.status}；${text.slice(0, 200)}`);
    }
    const json = await res.json();
    const items = Array.isArray(json.pageItems) ? json.pageItems : [];
    return items.map((it) => ({
      title: String(it.title ?? ''),
      link: String(it.link ?? ''),
      snippet: String(it.snippet ?? ''),
      source: String(it.hostname ?? ''),
    }));
  } finally {
    clearTimeout(timer);
  }
}

/** 工具执行结果统一为一行用户可读的中文标签（前端状态条用） */
function toolCallLabel(name, args) {
  if (name === 'web_search') return `正在联网搜索「${String(args?.query ?? '').slice(0, 30)}」…`;
  if (name === 'getLocalTime') return '正在查询当前时间…';
  return `正在调用工具 ${name}…`;
}

/**
 * 获取本轮挂载的工具定义（OpenAI tools 格式）
 * web_search 仅在用户开启「联网搜索」时挂载（IQS key 也必须已配置）；
 * getLocalTime 始终挂载（零成本：模型不调用就无事发生，调用即返回本地时钟）
 * @param {{ enableSearch?: boolean, iqsApiKey?: string }} options
 * @returns {Array<object>} OpenAI 格式的 tools 数组
 */
export function getToolDefinitions({ enableSearch = false, iqsApiKey } = {}) {
  const tools = [];

  tools.push({
    type: 'function',
    function: {
      name: 'getLocalTime',
      description: [
        '获取当前的本地时间（格式 yyyy-MM-dd HH:mm:ss，含星期与时区）。',
        '[必须调用] 用户明确问：现在几点、当前时间、今天几号、今天是星期几、现在是什么时候。',
        '[禁止调用] 用户只是打招呼或闲聊；输入上下文已给出当前时间且用户未质疑时无需重复查询；设置闹钟提醒类诉求不归本工具管。',
      ].join('\n'),
      parameters: { type: 'object', properties: {}, required: [] },
    },
  });

  if (enableSearch && iqsApiKey) {
    tools.push({
      type: 'function',
      function: {
        name: 'web_search',
        description: [
          '【工具功能】调用公网搜索引擎，获取公开的实时动态信息、最新资讯与外部公开知识。',
          '',
          '【核心调用原则（必须严格遵守）】',
          '1. 优先使用自身知识回答，仅当自身无法准确作答、且属于下方「适用场景」时，才可调用本工具。',
          '2. 能通过推理、计算、常识直接回答的问题，绝对禁止调用联网搜索。',
          '',
          '【适用场景（满足任一，且自身知识无准确答案时才可调用）】',
          '• 实时动态数据：实时天气、空气质量、股票价格、赛事比分、汇率等随时间变化的信息',
          '• 时效性资讯：近期新闻事件、最新政策、刚发布的产品/版本、近期上映的影视演出',
          '• 特定实体查询：用户明确提及的小众机构、地点、产品参数，且确认自身无准确信息',
          '• 用户明确指令：用户主动说出「帮我搜一下」「查一下网上」「联网查」等表述',
          '',
          '【绝对禁止调用场景】',
          '• 常识科普、概念解释、历史事实等自身可回答的内容',
          '• 逻辑推理、数学计算、文案创作、观点建议类问题',
          '• 纯闲聊问候、情绪陪伴类对话',
          '• 查询当前时间/日期：应调用 getLocalTime 工具',
          '',
          '【参数规则】',
          '• query：必填，提炼后的精准搜索关键词，去除口语化冗余表述',
          '• 用户未指定时间范围时，默认以当日为基准构造搜索关键词',
        ].join('\n'),
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string', description: '搜索关键词' },
          },
          required: ['query'],
        },
      },
    });
  }

  return tools;
}

/**
 * 执行一次工具调用
 * @param {{ name: string, arguments: string }} toolCall 模型发起的工具调用（arguments 为 JSON 字符串）
 * @param {{ iqsApiKey?: string, fetchImpl?: Function, now?: () => Date }} options
 * @returns {Promise<{ output: string, label: string }>} output 为回填给模型的结果文本；label 为前端状态条文案
 */
export async function executeTool(toolCall, options = {}) {
  const name = toolCall?.name ?? '';
  let args = {};
  try {
    args = toolCall.arguments ? JSON.parse(toolCall.arguments) : {};
  } catch {
    args = {};
  }
  const label = toolCallLabel(name, args);

  if (name === 'getLocalTime') {
    const now = options.now ? options.now() : new Date();
    const fmt = new Intl.DateTimeFormat('zh-CN', {
      timeZone: 'Asia/Shanghai',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      weekday: 'long',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    });
    return { output: `${fmt.format(now)}（UTC+8 北京时间）`, label };
  }

  if (name === 'web_search') {
    const query = String(args.query ?? '').trim();
    if (!query) return { output: '搜索失败：搜索词为空', label };
    try {
      const results = await iqsSearch(query, {
        apiKey: options.iqsApiKey,
        fetchImpl: options.fetchImpl,
      });
      if (results.length === 0) return { output: '联网搜索未找到相关信息。', label };
      // 对齐 Yodada WebSearchFunction 的回填格式：前 5 条转 Markdown，带来源与链接
      const content = results
        .slice(0, 5)
        .map(
          (r) =>
            `### ${r.title}\n来源: ${r.source}\n链接: ${r.link}\n摘要: ${r.snippet}`
        )
        .join('\n\n---\n\n');
      return { output: `# 关于【${query}】的联网搜索结果如下：\n\n${content}`, label };
    } catch (err) {
      return { output: `联网搜索服务暂时出现问题：${err?.message ?? err}`, label };
    }
  }

  return { output: `未知工具：${name}`, label };
}
