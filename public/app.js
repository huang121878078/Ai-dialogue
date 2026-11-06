/**
 * app.js — 前端逻辑（原生 JS，ES Module）
 * SSE 解析：不能用 EventSource（不支持 POST），用 fetch + getReader + TextDecoder 手动按 \n\n 分割。
 */

const state = {
  /** @type {'A'|'B'|'C'|'D'} 当前实验模式 */
  mode: 'A',
  /** @type {Array<{role: string, content: string}>} 会话历史（后端无状态，由前端维护） */
  history: [],
  /** 是否正在发送 */
  sending: false,
  /** @type {object|null} 最近一轮的 done metrics */
  lastMetrics: null,
  /** 是否开启模型思考模式（qwen3.7 enable_thinking，思考过程实时展示） */
  includeThinking: false,
  /** 是否开启联网搜索（百炼 enable_search，Generator 参考实时搜索结果） */
  enableSearch: false,
};

// ---------- DOM 引用 ----------

const $ = (id) => document.getElementById(id);
const messagesEl = $('messages');
const inputEl = $('input');
const sendBtnEl = $('send-btn');
const resetBtnEl = $('reset-btn');
const modePickerEl = $('mode-picker');
const thinkingToggleEl = $('thinking-toggle');
const searchToggleEl = $('search-toggle');

// ---------- 工具函数 ----------

/** HTML 转义 */
function escapeHtml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/** JSON 语法高亮（简单正则版，供 pre 展示） */
function highlightJson(value) {
  const json = JSON.stringify(value, null, 2);
  const escaped = escapeHtml(json);
  return escaped.replace(
    /("(?:\\u[0-9a-fA-F]{4}|\\[^u]|[^\\"])*"(\s*:)?|\b(?:true|false|null)\b|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/g,
    (match) => {
      let cls = 'json-number';
      if (match.startsWith('"')) {
        cls = /:$/.test(match) ? 'json-key' : 'json-string';
      } else if (match === 'true' || match === 'false') {
        cls = 'json-bool';
      } else if (match === 'null') {
        cls = 'json-null';
      }
      return `<span class="${cls}">${match}</span>`;
    }
  );
}

/** 滚动聊天区到底部 */
function scrollBottom() {
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

// ---------- 聊天区渲染 ----------

/** 移除空提示 */
function clearEmptyHint() {
  const hint = $('empty-hint');
  if (hint) hint.remove();
}

/** 创建一个消息气泡，返回内容节点 */
function createBubble(role, text = '') {
  clearEmptyHint();
  const bubble = document.createElement('div');
  bubble.className = `bubble ${role}`;
  const roleLabel = document.createElement('div');
  roleLabel.className = 'bubble-role';
  roleLabel.textContent = role === 'user' ? '阿哲' : '小满';
  const content = document.createElement('div');
  content.className = 'bubble-content';
  content.textContent = text;
  bubble.appendChild(roleLabel);
  bubble.appendChild(content);
  messagesEl.appendChild(bubble);
  scrollBottom();
  return content;
}

/** 显示错误气泡（红边） */
function showErrorBubble(message) {
  clearEmptyHint();
  const el = document.createElement('div');
  el.className = 'bubble error';
  el.textContent = `出错了：${message}`;
  messagesEl.appendChild(el);
  scrollBottom();
}

/**
 * 在助手气泡内追加思考文本（流式；按来源分段显示）
 * @param {HTMLElement} contentEl 气泡正文节点（思考块插在它上方）
 * @param {string} text 本次思考增量
 * @param {'director'|'generator'} source 来源（Director 分析思考 / Generator 表达思考）
 */
function appendReasoning(contentEl, text, source) {
  const bubble = contentEl.parentElement;
  let block = bubble.querySelector('.thinking-block');
  if (!block) {
    block = document.createElement('details');
    block.className = 'thinking-block';
    block.open = true; // 默认展开，便于观察过程；用户可手动折叠
    block.title = '思考内容由模型生成，语言由模型自选（qwen3.7-flash 实测多为英文），无法通过指令控制';
    const summary = document.createElement('summary');
    summary.textContent = '思考过程';
    block.appendChild(summary);
    bubble.insertBefore(block, contentEl);
  }
  let section = block.querySelector(`.thinking-section[data-source="${source}"]`);
  if (!section) {
    section = document.createElement('div');
    section.className = 'thinking-section';
    section.dataset.source = source;
    const label = document.createElement('div');
    label.className = 'thinking-source';
    label.textContent = source === 'director' ? 'Director · 分析思考' : 'Generator · 表达思考';
    const pre = document.createElement('pre');
    pre.className = 'thinking-text';
    section.appendChild(label);
    section.appendChild(pre);
    block.appendChild(section);
  }
  const pre = section.querySelector('.thinking-text');
  pre.textContent += text;
  // 思考区超长时自动滚到底部（保持过程感）
  pre.scrollTop = pre.scrollHeight;
}

// ---------- 右侧面板：Tab 切换 ----------

document.querySelectorAll('.panel-tab').forEach((tab) => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.panel-tab').forEach((t) => t.classList.remove('active'));
    document.querySelectorAll('.tab-page').forEach((p) => p.classList.remove('active'));
    tab.classList.add('active');
    $(`tab-${tab.dataset.tab}`).classList.add('active');
  });
});

/** 折叠/展开右侧面板 */
$('panel-collapse').addEventListener('click', () => {
  const panel = $('panel');
  panel.classList.toggle('collapsed');
  $('panel-collapse').textContent = panel.classList.contains('collapsed') ? '«' : '»';
});

// ---------- 右侧面板：本轮分析 ----------

/** 渲染本轮分析（brief 事件后调用；A/B 模式无 brief 事件，直接渲染占位） */
function renderAnalysis(payload) {
  $('analysis-placeholder').classList.add('hidden');
  $('analysis-content').classList.remove('hidden');

  const { brief, validation, degraded } = payload;

  // 降级提示条
  $('degraded-banner').classList.toggle('hidden', !degraded);

  // 校验徽标
  const badge = $('validation-badge');
  badge.className = 'badge';
  if (!validation) {
    badge.classList.add('skip');
    badge.textContent = '单模型模式 · 无 Director';
    $('validation-detail').textContent = '';
  } else if (degraded) {
    badge.classList.add('degraded');
    badge.textContent = '校验失败 · 已降级';
    $('validation-detail').textContent = (validation.ajvErrors ?? []).join('；');
  } else if (validation.retried) {
    badge.classList.add('retry-pass');
    badge.textContent = '修复重试后通过';
    $('validation-detail').textContent = '';
  } else {
    badge.classList.add('pass');
    badge.textContent = '校验通过';
    $('validation-detail').textContent = '';
  }
  if (validation && Array.isArray(validation.removedMemoryIds) && validation.removedMemoryIds.length > 0) {
    $('validation-detail').textContent = `白名单剔除的记忆：${validation.removedMemoryIds.join(', ')}`;
  }

  // 选中记忆卡片
  const cardsEl = $('memory-cards');
  cardsEl.innerHTML = '';
  const selected = brief?.personalization?.selectedMemories ?? [];
  if (selected.length === 0) {
    cardsEl.innerHTML = '<div class="muted small">（本轮未选用任何记忆）</div>';
  } else {
    for (const item of selected) {
      const card = document.createElement('div');
      card.className = 'memory-card';
      card.innerHTML = `
        <div><span class="memory-id">${escapeHtml(item.memoryId ?? '?')}</span>
        <span class="memory-rel">相关度 ${Number(item.relevance ?? 0).toFixed(2)}</span></div>
        <div>${escapeHtml(item.reason ?? '')}</div>
        <div class="muted small">${escapeHtml(item.usageSuggestion ?? '')}</div>`;
      cardsEl.appendChild(card);
    }
  }

  // Brief JSON（降级时无 brief）
  const briefPre = $('brief-json');
  if (brief) {
    briefPre.innerHTML = highlightJson(brief);
  } else {
    briefPre.textContent = degraded
      ? '（Director 校验失败，Brief 已被丢弃，本轮按单模型模式生成）'
      : '（单模型模式，无 Brief）';
  }
}

/** 渲染路由决策卡片（R 模式 route 事件；其他模式隐藏） */
function renderRoute(data) {
  const card = $('route-card');
  const detail = $('route-detail');
  if (!card || !detail) return;
  if (!data) {
    card.classList.add('hidden');
    return;
  }
  card.classList.remove('hidden');
  // R 模式激活分析面板
  $('analysis-placeholder').classList.add('hidden');
  $('analysis-content').classList.remove('hidden');
  const pathText = data.path === 'fast' ? 'Fast Path · Generator 直答' : 'Cognitive Path · 完整双模型';
  const engineText = data.engine === 'decision-model' ? '百炼决策模型' : '规则引擎';
  const conf = Number.isFinite(data.confidence) ? Number(data.confidence).toFixed(2) : '—';
  detail.innerHTML = `
    <div><span class="route-path ${data.path === 'fast' ? 'route-fast' : 'route-cognitive'}">${escapeHtml(pathText)}</span>
    <span class="memory-rel">置信度 ${conf} · ${escapeHtml(engineText)} · ${data.latencyMs ?? 0} ms${data.fallback ? ' · <b>决策模型降级</b>' : ''}</span></div>
    <div class="muted small">${escapeHtml(data.reason ?? '')}</div>
    ${data.safetyHint ? '<div class="route-safety">⚠ 安全信号：已强制走完整认知路径</div>' : ''}`;
  // Fast Path：无 brief/记忆，面板给出对应提示（Cognitive Path 由后续 brief 事件覆盖）
  if (data.path === 'fast') {
    const badge = $('validation-badge');
    badge.className = 'badge skip';
    badge.textContent = 'Fast Path · 无 Director';
    $('validation-detail').textContent = '';
    $('memory-cards').innerHTML = '<div class="muted small">（Fast Path 不加载记忆资料）</div>';
    $('brief-json').textContent = '（Fast Path：路由判定为简单对话，跳过 Director 分析与记忆筛选）';
    $('degraded-banner').classList.add('hidden');
  }
}

// ---------- 右侧面板：指标 ----------

/** 渲染指标表（done 事件后调用） */
function renderMetrics(metrics) {
  state.lastMetrics = metrics;
  $('metrics-placeholder').classList.add('hidden');
  $('metrics-content').classList.remove('hidden');

  const costText = `¥ ${Number(metrics.estimatedCostCNY ?? 0).toFixed(4)}`;
  const genTokensNote = metrics.generatorUsageKnown ? '' : '（流式未返回 usage，记为 0）';
  const firstToken = metrics.generatorFirstTokenMs;
  const firstContent = metrics.generatorFirstContentMs ?? firstToken;
  // 思考模式：firstToken 是思考开始、firstContent 是正文首字；两者不同时分别展示
  const hasThinking =
    (firstToken !== null && firstToken !== undefined) &&
    (firstContent !== null && firstContent !== undefined) &&
    firstToken !== firstContent;
  const rows = [
    ['实验模式', metrics.mode],
    metrics.routerLatencyMs != null
      ? ['路由', `${metrics.routerPath === 'fast' ? 'Fast Path' : 'Cognitive Path'} · ${metrics.routerEngine === 'decision-model' ? '决策模型' : '规则引擎'} · ${metrics.routerLatencyMs} ms`]
      : null,
    ['Director 耗时', `${metrics.directorLatencyMs ?? 0} ms`],
    hasThinking
      ? ['Generator 思考开始 / 正文首字', `${firstToken} ms / ${firstContent} ms`]
      : ['Generator 首字', firstContent === null || firstContent === undefined ? '—' : `${firstContent} ms`],
    ['总耗时', `${metrics.totalLatencyMs ?? 0} ms`],
    ['Director tokens', `输入 ${metrics.directorTokens?.input ?? 0} / 输出 ${metrics.directorTokens?.output ?? 0}`],
    ['Generator tokens', `输入 ${metrics.generatorTokens?.input ?? 0} / 输出 ${metrics.generatorTokens?.output ?? 0}${genTokensNote}`],
    ['估算成本', costText],
    // 角色主体性（E 模式）：本轮角色是否贡献了自身内容、主动度、观点强度
    metrics.characterHasContribution != null
      ? ['角色贡献', `${metrics.characterHasContribution ? '有' : '无'} · ${metrics.characterMove ?? 'none'} · 强度 ${metrics.characterStrength ?? 'none'} · 主动度 ${metrics.characterInitiative ?? '—'}${metrics.characterTopic ? ` · ${metrics.characterTopic}` : ''}`]
      : null,
    ['Director 修复重试', `${metrics.retries ?? 0} 次`],
    ['降级', metrics.degraded ? '是（已降级为单模型）' : '否'],
  ].filter(Boolean);

  const table = $('metrics-table');
  table.innerHTML = rows
    .map((r) => `<tr><td>${escapeHtml(String(r[0]))}</td><td>${escapeHtml(String(r[1]))}</td></tr>`)
    .join('');
}

// ---------- 右侧面板：静态数据 ----------

/** 加载并渲染五个静态 JSON（只读折叠树） */
async function loadDataPanel() {
  try {
    const res = await fetch('/api/data');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const groups = [
      ['persona（稳定人格）', data.persona],
      ['user_profile（用户画像）', data.userProfile],
      ['memories（记忆候选集）', data.memories],
      ['emotion（近期情绪）', data.emotion],
      ['relationship（关系状态）', data.relationship],
    ];
    $('data-content').innerHTML = groups
      .map(
        ([title, value], i) => `
      <details ${i === 0 ? 'open' : ''}>
        <summary>${escapeHtml(title)}</summary>
        <pre class="json-pre">${highlightJson(value)}</pre>
      </details>`
      )
      .join('');
  } catch (err) {
    $('data-content').innerHTML = `<div class="degraded-banner">静态数据加载失败：${escapeHtml(
      err.message
    )}</div>`;
  }
}

// ---------- 模式选择与重置 ----------

modePickerEl.addEventListener('change', () => {
  const checked = modePickerEl.querySelector('input:checked');
  if (checked) state.mode = checked.value;
});

thinkingToggleEl.addEventListener('change', () => {
  state.includeThinking = thinkingToggleEl.checked;
});

searchToggleEl.addEventListener('change', () => {
  state.enableSearch = searchToggleEl.checked;
});

resetBtnEl.addEventListener('click', () => {
  state.history = [];
  state.lastMetrics = null;
  messagesEl.innerHTML =
    '<div class="empty-hint" id="empty-hint">会话已重置。历史保存在前端本地，后端不留状态。</div>';
  $('analysis-content').classList.add('hidden');
  $('analysis-placeholder').classList.remove('hidden');
  $('route-card').classList.add('hidden');
  $('metrics-content').classList.add('hidden');
  $('metrics-placeholder').classList.remove('hidden');
});

// 清空测试记忆：调后端 /api/memory/reset 清掉默认测试设备在 CompanionMem 的全部记忆，
// 同时本地会话一并重置——测试前使用，保证每轮实验从零记忆开始
$('memory-reset-btn').addEventListener('click', async () => {
  const btn = $('memory-reset-btn');
  if (btn.disabled) return;
  btn.disabled = true;
  const original = btn.textContent;
  btn.textContent = '清空中…';
  try {
    const res = await fetch('/api/memory/reset', { method: 'POST' });
    const json = await res.json().catch(() => ({}));
    clearEmptyHint();
    const el = document.createElement('div');
    el.className = json.ok ? 'bubble system' : 'bubble error';
    el.textContent = json.ok
      ? `测试记忆已清空（${json.message ?? 'ok'}）。本地会话同步重置，可以开始新测试。`
      : `清空失败：${json.error ?? json.message ?? `HTTP ${res.status}`}`;
    messagesEl.appendChild(el);
    scrollBottom();
    if (json.ok) resetBtnEl.click(); // 本地会话一并重置
  } catch (err) {
    clearEmptyHint();
    const el = document.createElement('div');
    el.className = 'bubble error';
    el.textContent = `清空请求失败：${err?.message ?? err}`;
    messagesEl.appendChild(el);
    scrollBottom();
  } finally {
    btn.disabled = false;
    btn.textContent = original;
  }
});

// ---------- 发送与 SSE 解析 ----------

/** 设置发送中的禁用状态 */
function setSending(sending) {
  state.sending = sending;
  inputEl.disabled = sending;
  sendBtnEl.disabled = sending;
  if (!sending) inputEl.focus();
}

/**
 * 发送一条消息并处理 SSE 流
 * 前端用 fetch + getReader + TextDecoder 解析（EventSource 不支持 POST）
 */
async function sendMessage() {
  if (state.sending) return;
  const text = inputEl.value.trim();
  if (text.length === 0) return;

  setSending(true);
  inputEl.value = '';
  createBubble('user', text);

  const contentEl = createBubble('assistant', '');
  const bubble = contentEl.parentElement;
  bubble.classList.add('typing');
  let reply = '';
  let hadError = false;
  /** 是否收到正常结束的 done 事件（用于识别不完整轮次） */
  let receivedDone = false;

  /** 逐事件分发 */
  const handleEvent = (event, data) => {
    switch (event) {
      case 'route': {
        // R 模式路由决策：显示在分析面板顶部
        renderRoute(data);
        break;
      }
      case 'stage': {
        if (data.stage === 'router') {
          contentEl.textContent = '';
          bubble.querySelector('.bubble-role').textContent = '小满 · 路由判断中…';
        } else if (data.stage === 'director') {
          contentEl.textContent = '';
          bubble.querySelector('.bubble-role').textContent = '小满 · Director 分析中…';
        } else if (data.stage === 'generator') {
          const roleEl = bubble.querySelector('.bubble-role');
          if (!roleEl.textContent.includes('思考')) roleEl.textContent = '小满';
        }
        break;
      }
      case 'reasoning': {
        // 思考增量（开启「显示模型思考」后才有）：流式追加到气泡思考折叠区
        if (typeof data.text === 'string' && data.text.length > 0) {
          const source = data.source === 'director' ? 'director' : 'generator';
          appendReasoning(contentEl, data.text, source);
          const roleEl = bubble.querySelector('.bubble-role');
          roleEl.textContent =
            source === 'director' ? '小满 · Director 思考中…' : '小满 · Generator 思考中…';
          scrollBottom();
        }
        break;
      }
      case 'brief': {
        renderAnalysis({
          brief: data.brief,
          validation: data.validation,
          degraded: Boolean(data.degraded),
        });
        break;
      }
      case 'tool_call': {
        // 工具调用中（web_search / getLocalTime）：气泡内显示状态条
        const label = typeof data.label === 'string' ? data.label : `正在调用 ${data.name ?? '工具'}…`;
        let statusEl = bubble.querySelector('.tool-status');
        if (!statusEl) {
          statusEl = document.createElement('div');
          statusEl.className = 'tool-status';
          bubble.insertBefore(statusEl, contentEl);
        }
        statusEl.textContent = `🔧 ${label}`;
        const roleEl = bubble.querySelector('.bubble-role');
        roleEl.textContent = '小满 · 使用工具中…';
        scrollBottom();
        break;
      }
      case 'tool_result': {
        // 工具结果回填：状态条转为完成态（保留摘要，淡化为灰色）
        const statusEl = bubble.querySelector('.tool-status');
        if (statusEl) {
          statusEl.classList.add('tool-status-done');
          statusEl.textContent = `🔧 ${data.label ?? data.name ?? '工具'} 已完成`;
        }
        break;
      }
      case 'delta': {
        if (typeof data.text === 'string' && data.text.length > 0) {
          const roleEl = bubble.querySelector('.bubble-role');
          if (roleEl.textContent.includes('思考') || roleEl.textContent.includes('分析') || roleEl.textContent.includes('工具')) {
            roleEl.textContent = '小满';
          }
          reply += data.text;
          contentEl.textContent = reply;
          scrollBottom();
        }
        break;
      }
      case 'done': {
        receivedDone = true;
        renderMetrics(data.metrics ?? {});
        break;
      }
      case 'error': {
        hadError = true;
        if (reply.length === 0) bubble.remove();
        showErrorBubble(data.message ?? '未知错误');
        break;
      }
      default:
        break;
    }
  };

  try {
    const res = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: text,
        mode: state.mode,
        history: state.history,
        includeThinking: state.includeThinking,
        enableSearch: state.enableSearch,
      }),
    });

    if (!res.ok || !res.body) {
      // 非 SSE 的普通错误响应（400 等是 JSON）
      let message = `HTTP ${res.status}`;
      try {
        const errJson = await res.json();
        if (errJson.error) message = errJson.error;
      } catch {
        /* 忽略，保留状态码信息 */
      }
      bubble.remove();
      showErrorBubble(message);
      return;
    }

    // 手动解析 SSE 流：按 \n\n 分隔事件块
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let finished = false;

    while (!finished) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const blocks = buffer.split('\n\n');
      buffer = blocks.pop(); // 末块可能不完整
      for (const block of blocks) {
        const parsed = parseSseBlock(block);
        if (parsed) {
          handleEvent(parsed.event, parsed.data);
          if (parsed.event === 'done' || parsed.event === 'error') finished = true;
        }
      }
    }
    // 处理残余
    if (buffer.trim().length > 0) {
      const parsed = parseSseBlock(buffer);
      if (parsed) handleEvent(parsed.event, parsed.data);
    }
  } catch (err) {
    hadError = true; // 已通过错误气泡向用户呈现，避免再叠加不完整提示
    if (reply.length === 0) bubble.remove();
    showErrorBubble(err?.message ?? '网络错误，请检查服务是否在运行');
  } finally {
    bubble.classList.remove('typing');
    // 历史写入策略（完整与不完整轮次统一）：
    // 不完整轮次（error 事件 / 静默 EOF / 异常 / 请求被拒）也把已展示的部分
    // 同步写入 history——保证聊天区展示内容与随请求传给后端的 history 一致，
    // 下一轮上下文不会凭空缺失用户已看到的回复
    state.history.push({ role: 'user', content: text });
    if (reply.length > 0) {
      state.history.push({ role: 'assistant', content: reply });
    }
    if (!receivedDone && !hadError && bubble.isConnected) {
      // 静默 EOF：流结束但既无 done 也无 error（如服务中途退出），提示不完整
      const notice = document.createElement('div');
      notice.className = 'bubble-notice';
      notice.textContent = '（连接中断，以上回复可能不完整）';
      bubble.appendChild(notice);
      scrollBottom();
    }
    setSending(false);
  }
}

/**
 * 解析一个 SSE 事件块（event: 行 + data: 行）
 * @param {string} block
 * @returns {{event: string, data: object}|null}
 */
function parseSseBlock(block) {
  let event = 'message';
  let dataText = '';
  for (const line of block.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.startsWith('event:')) {
      event = trimmed.slice(6).trim();
    } else if (trimmed.startsWith('data:')) {
      dataText = trimmed.slice(5).trim();
    }
  }
  if (!dataText) return null;
  try {
    return { event, data: JSON.parse(dataText) };
  } catch {
    return null;
  }
}

// ---------- 输入事件 ----------

sendBtnEl.addEventListener('click', sendMessage);

inputEl.addEventListener('keydown', (e) => {
  // Enter 发送，Shift+Enter 换行
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendMessage();
  }
});

// ---------- 初始化 ----------

/**
 * 拉取运行时状态并展示「记忆归属设备号」（显示在「清空测试记忆」按钮旁）。
 * 设备号来自后端 /api/status——改 .env 的 CM_AGENT_ID 重启后前端自动跟随，
 * 不做任何前端硬编码，避免显示值与实际写入/召回用的 agent 不一致。
 */
async function loadRuntimeStatus() {
  const el = $('memory-agent');
  if (!el) return;
  try {
    const res = await fetch('/api/status');
    const s = await res.json();
    if (s.memorySource !== 'companionmem' || !s.companionMemAgentId) {
      el.textContent = s.memorySource === 'mem0' ? 'Mem0' : '静态记忆';
      return;
    }
    // 设备号（紧凑显示，完整值在 title 中）：默认测试设备加「测试」标识与绿色样式
    el.textContent = `${s.companionMemAgentId}${s.isDefaultTestAgent ? ' · 测试' : ''}${s.memoryWriteEnabled ? ' · 写入' : ''}`;
    el.title = `当前记忆归属设备：${s.companionMemAgentId}${s.isDefaultTestAgent ? '（默认测试设备，与生产隔离）' : ''}${s.memoryWriteEnabled ? ' · 写入已开启' : ' · 写入关闭'}`;
    el.classList.toggle('is-test', Boolean(s.isDefaultTestAgent));
  } catch {
    el.textContent = '设备信息不可用';
  }
}

(async function init() {
  await Promise.all([loadDataPanel(), loadRuntimeStatus()]);
  // 数据面板加载完即允许输入（模型调用在发送时才发生）
  inputEl.disabled = false;
  sendBtnEl.disabled = false;
  inputEl.focus();
})();
