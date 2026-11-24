'use strict';

// 腾讯文档插件：把腾讯文档官方远程 MCP 服务（Streamable HTTP）接成 Cindy 的
// 两段式工具目录（list_tools / call_tool），并用随包 Node 进程处理本机文件。
// 个人版（docs.qq.com）与企业版（saas.docs.qq.com）各有 4 个服务：主服务、
// Word 文档、在线表格、幻灯片专用服务。登录由 Cindy 托管 OAuth 完成，
// access token 只由宿主注入请求头，本文件拿不到也不保存任何凭证。

const VERSION = '0.2.0';
const PROTOCOL_VERSION = '2025-06-18';
const CLIENT_INFO = { name: 'cindy-tencent-docs', version: VERSION };
const CHANNEL = 'tencent-docs';
const TOOLS_TTL_MS = 10 * 60 * 1000;
const CALL_DEADLINE_MS = 10 * 60 * 1000;
const HEARTBEAT_MS = 45 * 1000;
const READ_WAIT_MS = 20000;
const TEXT_TIMEOUT_MS = 60000;
const MAX_TEXT_CHARS = 120000;
const MAX_RAW_CHARS = 4000000;
const MAX_IMAGES = 2;
const MAX_INSTRUCTIONS_CHARS = 4000;

const EDITIONS = {
  personal: {
    label: '个人版',
    secret: 'tencent_docs_account',
    base: 'https://docs.qq.com',
    services: { main: '/openapi/mcp', doc: '/api/v6/doc/mcp', sheet: '/api/v6/sheet/mcp', slide: '/api/v6/slide/mcp' },
  },
  enterprise: {
    label: '企业版',
    secret: 'tencent_docs_saas_account',
    base: 'https://saas.docs.qq.com',
    services: { main: '/api/v6/open/agent/mcp', doc: '/api/v6/doc/mcp', sheet: '/api/v6/sheet/mcp', slide: '/api/v6/slide/mcp' },
  },
};
const ENGINE_SERVICES = ['doc', 'sheet', 'slide'];

const CATEGORY_LABELS = {
  common: '通用（读取正文、当前用户、上传图片）',
  smartcanvas: '在线文档（智能文档）',
  doc: 'Word 文档',
  smartsheet: '智能表格',
  sheet: '在线表格（Excel）',
  slide: '幻灯片',
  mind: '思维导图',
  flowchart: '流程图',
  aicanvas: 'AI 页面',
  space: '知识库空间',
  manage: '文件、目录与权限管理',
  ocr: '图片文字识别',
  scrape: '网页剪藏',
  search: '搜索',
  other: '其他',
};

// 跨品类的常用操作单独成类，方便先找到。
const COMMON_TOOLS = new Set(['get_content', 'get_user_info', 'upload_image', 'manage.get_content', 'manage.upload_image']);

// 不展示也不执行的操作：
// - check_skill_update / report_unsupported_feature：服务端给自家客户端的技能更新检查与功能缺失埋点，
//   后者会把用户原话外发，Cindy 不做；
// - smartsheet.commit_changeset / smartsheet.fetch：腾讯文档 App 内部链路，官方说明 AI 不应调用；
// - smartsheet.show_ui：需要宿主在对话里渲染腾讯文档自己的表格界面，Cindy 没有这个界面。
const HIDDEN_TOOLS = new Set([
  'check_skill_update',
  'report_unsupported_feature',
  'smartsheet.commit_changeset',
  'smartsheet.fetch',
  'smartsheet.show_ui',
]);

// 服务端写给其它客户端的“个人版与企业版同时连接时先问用户”提示；
// Cindy 由本插件的 edition 参数处理同一件事，去掉以免重复提问。
const FOREIGN_ACCOUNT_HINT = /\s*if both tencent-docs \(personal\) and tencent-docs-oa \(enterprise\) are connected,[^.]*\./gi;

// 不带点号前缀的操作名按关键词归类；顺序决定优先级。
const KEYWORD_CATEGORIES = [
  ['smartcanvas', 'smartcanvas'],
  ['smartsheet', 'smartsheet'],
  ['aicanvas', 'aicanvas'],
  ['flowchart', 'flowchart'],
  ['mind', 'mind'],
  ['space', 'space'],
  ['sheet', 'sheet'],
  ['slide', 'slide'],
  ['ppt', 'slide'],
  ['folder', 'manage'],
  ['permission', 'manage'],
  ['file', 'manage'],
  ['ocr', 'ocr'],
  ['scrape', 'scrape'],
  ['search', 'search'],
  ['doc', 'doc'],
];

// 服务端没有标注只读时，按操作名的动词推断；推断不出的一律按写入对待。
const READ_VERBS = /^(get|query|list|read|find|search|resolve|describe|compare|preview|check|recent)(_|$)/;
// 查询进度、列表、信息类的操作名常以这些词结尾。
const READ_SUFFIXES = /_(progress|list|info|meta|detail|status)$/;

const RULES = {
  write_requires_request:
    '创建、修改、删除、移动、复制、改分享权限等写入操作只在用户明确要求时执行；删除、覆盖已有内容或扩大分享范围前，先向用户说明影响范围并取得确认。',
  ids_from_listing:
    '需要文件、表格、子表、目录等 ID 时，先用查询或列表类操作取得，不要猜测 ID；用户给出 docs.qq.com 链接时，按参数说明直接传链接或从链接中取出 ID。',
  type_first:
    '改文档内容前先确认它是哪一类文档（看链接或用 manage.query_file_info），再用这一类的操作；拿别的品类的操作去改会报 400016。',
  batch_writes:
    '对同一份文档要连续写入 3 次以上时，改用一次提交多条的批量操作，不要逐条循环调用。',
  follow_tool_order:
    '按操作说明里写明的先后顺序调用（例如先列出表格或目录拿到 ID，再读写）；操作说明与这里的规则冲突时，以操作说明为准。',
  prefer_engine:
    '同一件事同时有带 forwarded 标记和不带标记的操作时，用不带标记的那个：它来自专用服务，能力更完整。',
  keep_links:
    '结果里的文档链接原样交给用户，不要改写或编造链接。',
  base64_params:
    '参数名以 base64_ 开头的（例如 base64_markdown），直接传去掉前缀的同名明文参数（例如 markdown），插件会自动转成 base64；不要自己手工编码。',
  local_files:
    '需要把用户电脑上的文件、HTML 页面或图片传上腾讯文档（导入、OCR、上传图片）时，用本插件的 local_files 工具，不要把文件内容自己转码塞进参数。',
};
const READ_RULES = ['ids_from_listing', 'follow_tool_order', 'keep_links'];
const WRITE_RULES = ['write_requires_request', 'ids_from_listing', 'type_first', 'batch_writes', 'follow_tool_order', 'keep_links'];

// 腾讯文档在结果文本里给出的业务错误码与对应处理方式（同一错误码在两个版本含义可能不同）。
const KNOWN_ERRORS = {
  personal: [
    [/\b400001\b/, '参数校验失败：按返回的提示和 schema 修正参数（例如分页条数的上限）后重试。'],
    [/\b400006\b/, '登录凭证无效或已过期：请到 Cindy 侧边栏「插件」→「腾讯文档」详情页重新连接个人版账号。'],
    [/\b400007\b/, '这项能力需要腾讯文档会员：可告诉用户前往 https://docs.qq.com/vip 开通后再试。'],
    [/\b400014\b/, '这项能力需要腾讯文档会员：可告诉用户前往 https://docs.qq.com/vip 开通后再试。'],
    [/\b400008\b/, '腾讯文档 AI 积分不足：可告诉用户在腾讯文档的会员与积分页面（https://docs.qq.com/vip/asset-center）购买后再试。'],
    [/\b400016\b/, '文档类型和所用操作不匹配：先用 manage.query_file_info 确认文档类型，再换用该类型的操作。'],
    [/\b(11607|-32603)\b/, '参数有误：核对 file_id 等参数是否来自查询结果、格式是否符合 schema。'],
  ],
  enterprise: [
    [/\b400001\b/, '参数校验失败：核对 file_id 等参数是否来自查询结果、格式是否符合 schema。'],
    [/\b400006\b/, '登录凭证无效或已过期：请到 Cindy 侧边栏「插件」→「腾讯文档」详情页重新连接企业版账号。'],
    [/\b400007\b/, '企业版的调用次数已用完：可告诉用户联系企业管理员升级腾讯文档企业专业版。'],
    [/\b400014\b/, '这项能力需要腾讯文档企业专业版：可告诉用户联系企业管理员升级。'],
    [/\b-32603\b/, '参数有误：核对参数是否符合 schema。'],
  ],
};

class PluginError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

const sessions = new Map(); // `${edition}:${service}` → { id, protocolVersion, instructions }
const sessionPending = new Map();
const toolsCache = new Map(); // edition → { entries, fetchedAt, services }
const activeLocalCalls = new Set();
let nextRequestId = 1;

function resetAll() {
  sessions.clear();
  toolsCache.clear();
}

try {
  const channel = new BroadcastChannel(CHANNEL);
  channel.onmessage = (event) => {
    if (event && event.data && event.data.type === 'account-changed') resetAll();
  };
} catch (_err) {
  // 旧宿主没有 BroadcastChannel 时，只是账号切换后要等会话自然失效。
}

// ── 通用小工具 ──────────────────────────────────────────────────────────

function excerpt(text, limit) {
  const max = limit || 300;
  const value = typeof text === 'string' ? text.trim() : '';
  if (!value) return '';
  return value.length > max ? value.slice(0, max) + '…' : value;
}

function compactJson(value, limit) {
  let text;
  try {
    text = JSON.stringify(value);
  } catch (_err) {
    return '';
  }
  if (typeof text !== 'string') return '';
  return text.length > limit ? text.slice(0, limit) + '…' : text;
}

function headerValue(response, name) {
  const headers = (response && response.headers) || {};
  const value = headers[name] ?? headers[name.toLowerCase()];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function isEventStream(contentType) {
  return typeof contentType === 'string' && contentType.toLowerCase().includes('text/event-stream');
}

function heartbeat(ctx, message) {
  if (!ctx.callId) return;
  const payload = { type: 'tool-progress', callId: ctx.callId };
  if (message) payload.message = message;
  Promise.resolve(cindy.send(payload)).catch(() => {});
}

function endpointKey(endpoint) {
  return endpoint.edition + ':' + endpoint.service;
}

function endpointOf(edition, service) {
  const config = EDITIONS[edition];
  return { edition, service, url: config.base + config.services[service] };
}

function buildHeaders(endpoint) {
  const headers = {
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
  };
  const session = endpoint ? sessions.get(endpointKey(endpoint)) : null;
  if (session) {
    if (session.protocolVersion) headers['MCP-Protocol-Version'] = session.protocolVersion;
    if (session.id) headers['Mcp-Session-Id'] = session.id;
  }
  return headers;
}

function reconnectHint(edition) {
  return '请到 Cindy 侧边栏「插件」→「腾讯文档」详情页重新连接' + EDITIONS[edition].label + '账号后再试。';
}

// ── 网络错误与 HTTP 状态 ───────────────────────────────────────────────

function networkError(response, mayHaveExecuted) {
  const code = response && response.errorCode;
  const message = (response && response.message) || '请求腾讯文档失败';
  if (code === 'NETWORK_CREDENTIAL_UNAVAILABLE' || !code) {
    // 宿主守门类失败（未连接账号、授权失效等）自带处理指引，原样转告。
    return new PluginError('AUTH_REQUIRED', message);
  }
  if (mayHaveExecuted && (code === 'NETWORK_TIMEOUT' || code === 'CONNECTION_RESET' || code === 'NETWORK_ERROR')) {
    return new PluginError(
      'RESULT_UNKNOWN',
      '连接腾讯文档时中断（' + message + '）。这次操作可能已经执行，请先在腾讯文档中确认结果，再决定是否重试。',
    );
  }
  return new PluginError('NETWORK', '连接腾讯文档失败：' + message + '。请检查网络后重试。');
}

function checkHttpStatus(endpoint, status, body, hadSession) {
  if (status >= 200 && status < 300) return;
  const detail = excerpt(body);
  if (status === 401) {
    throw new PluginError('AUTH_REQUIRED', '腾讯文档拒绝了当前授权（可能已过期或被撤销）。' + reconnectHint(endpoint.edition));
  }
  if (hadSession && (status === 404 || (status === 400 && /session/i.test(detail)))) {
    throw new PluginError('SESSION_EXPIRED', '腾讯文档会话已过期');
  }
  if (status === 403) {
    throw new PluginError(
      'FORBIDDEN',
      '腾讯文档拒绝了这次操作：当前账号没有该文档或该操作的权限' + (detail ? '（' + detail + '）' : '') + '。请确认账号对目标文档有相应权限。',
    );
  }
  if (status === 429) {
    throw new PluginError('RATE_LIMITED', '腾讯文档请求过于频繁，请稍等片刻再试。');
  }
  if (status >= 500) {
    throw new PluginError('SERVER_ERROR', '腾讯文档服务暂时不可用（HTTP ' + status + '），请稍后再试。');
  }
  throw new PluginError('SERVER_ERROR', '腾讯文档返回了 HTTP ' + status + (detail ? '：' + detail : '') + '。');
}

// ── JSON-RPC 响应解析（JSON 或 SSE） ────────────────────────────────────

function takeSseMessages(state) {
  state.buffer = state.buffer.replace(/\r\n/g, '\n');
  const messages = [];
  let index = state.buffer.indexOf('\n\n');
  while (index >= 0) {
    const block = state.buffer.slice(0, index);
    state.buffer = state.buffer.slice(index + 2);
    const data = block
      .split('\n')
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).replace(/^ /, ''))
      .join('\n');
    if (data) {
      try {
        const parsed = JSON.parse(data);
        if (Array.isArray(parsed)) messages.push(...parsed);
        else messages.push(parsed);
      } catch (_err) {
        // 非 JSON 的事件（如心跳注释）直接忽略。
      }
    }
    index = state.buffer.indexOf('\n\n');
  }
  return messages;
}

function matchResponse(messages, id) {
  for (const message of messages) {
    if (message && typeof message === 'object' && String(message.id) === String(id) &&
        (Object.prototype.hasOwnProperty.call(message, 'result') || Object.prototype.hasOwnProperty.call(message, 'error'))) {
      return message;
    }
  }
  return null;
}

function parseRpcBody(contentType, body, id) {
  const text = typeof body === 'string' ? body : '';
  if (isEventStream(contentType)) {
    const found = matchResponse(takeSseMessages({ buffer: text + '\n\n' }), id);
    if (found) return found;
    throw new PluginError('PROTOCOL_ERROR', '腾讯文档的返回里没有这次请求的结果，请稍后重试。');
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (_err) {
    throw new PluginError('PROTOCOL_ERROR', '腾讯文档返回了无法识别的内容' + (text ? '：' + excerpt(text, 200) : '') + '。请稍后重试。');
  }
  const found = matchResponse(Array.isArray(parsed) ? parsed : [parsed], id);
  if (found) return found;
  throw new PluginError('PROTOCOL_ERROR', '腾讯文档的返回里没有这次请求的结果，请稍后重试。');
}

// ── MCP 会话 ───────────────────────────────────────────────────────────

async function postText(ctx, endpoint, payload, withSession) {
  const response = await cindy.fetch({
    url: endpoint.url,
    method: 'POST',
    headers: buildHeaders(withSession ? endpoint : null),
    body: JSON.stringify(payload),
    timeoutMs: TEXT_TIMEOUT_MS,
    callId: ctx.callId,
  });
  if (!response || !response.ok) throw networkError(response, false);
  return response;
}

async function openSession(ctx, endpoint) {
  const id = nextRequestId++;
  const response = await postText(ctx, endpoint, {
    jsonrpc: '2.0',
    id,
    method: 'initialize',
    params: { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: CLIENT_INFO },
  }, false);
  checkHttpStatus(endpoint, response.status, response.body, false);
  const message = parseRpcBody(headerValue(response, 'content-type'), response.body, id);
  if (message.error) throw rpcError(message.error, null, endpoint.edition);
  const result = message.result || {};
  const opened = {
    id: headerValue(response, 'mcp-session-id'),
    protocolVersion: typeof result.protocolVersion === 'string' ? result.protocolVersion : PROTOCOL_VERSION,
    instructions: typeof result.instructions === 'string' ? result.instructions : '',
  };
  sessions.set(endpointKey(endpoint), opened);
  try {
    // 通知没有结果，只看授权是否被拒；其它失败不影响后续请求。
    const ack = await postText(ctx, endpoint, { jsonrpc: '2.0', method: 'notifications/initialized' }, true);
    if (ack.status === 401) checkHttpStatus(endpoint, 401, ack.body, false);
  } catch (error) {
    if (error && error.code === 'AUTH_REQUIRED') {
      sessions.delete(endpointKey(endpoint));
      throw error;
    }
  }
  return opened;
}

async function ensureSession(ctx, endpoint) {
  const key = endpointKey(endpoint);
  if (sessions.has(key)) return sessions.get(key);
  if (!sessionPending.has(key)) {
    sessionPending.set(key, openSession(ctx, endpoint).finally(() => {
      sessionPending.delete(key);
    }));
  }
  return sessionPending.get(key);
}

async function requestText(ctx, endpoint, method, params) {
  const id = nextRequestId++;
  const session = sessions.get(endpointKey(endpoint));
  const hadSession = Boolean(session && session.id);
  const response = await postText(ctx, endpoint, { jsonrpc: '2.0', id, method, params }, true);
  checkHttpStatus(endpoint, response.status, response.body, hadSession);
  return parseRpcBody(headerValue(response, 'content-type'), response.body, id);
}

// 执行类请求走流式连接：不受 60 秒文本超时限制，长操作期间持续给宿主续命。
async function requestStream(ctx, endpoint, method, params) {
  const id = nextRequestId++;
  const session = sessions.get(endpointKey(endpoint));
  const hadSession = Boolean(session && session.id);
  const response = await cindy.fetch({
    url: endpoint.url,
    method: 'POST',
    headers: buildHeaders(endpoint),
    body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
    as: 'stream',
    callId: ctx.callId,
  });
  if (!response || !response.ok) throw networkError(response, true);
  const connectionId = response.connectionId;
  const contentType = headerValue(response, 'content-type') || '';
  const success = response.status >= 200 && response.status < 300;
  const sse = success && isEventStream(contentType);
  const sseState = { buffer: '' };
  let raw = '';
  let cursor = 0;
  let lastBeat = Date.now();
  const deadline = Date.now() + CALL_DEADLINE_MS;
  const interrupted = (detail) => new PluginError(
    'RESULT_UNKNOWN',
    '读取腾讯文档返回结果时连接中断' + (detail ? '（' + detail + '）' : '') + '。操作可能已经执行，请先在腾讯文档中确认结果，再决定是否重试。',
  );
  try {
    for (;;) {
      if (Date.now() > deadline) {
        throw new PluginError(
          'RESULT_UNKNOWN',
          '腾讯文档超过 10 分钟仍未返回结果。操作可能仍在进行或已经完成，请先在腾讯文档中确认，再决定是否重试。',
        );
      }
      const part = await cindy.network.read({ connectionId, cursor, waitMs: READ_WAIT_MS });
      if (!part || !part.ok) throw interrupted(part && part.message);
      if (part.resetRequired) throw interrupted('返回内容出现缺口');
      for (const event of part.events || []) {
        if (event.type === 'error') throw interrupted(event.errorCode || event.message);
        if (event.type !== 'text' || typeof event.data !== 'string') continue;
        if (sse) {
          sseState.buffer += event.data;
          const found = matchResponse(takeSseMessages(sseState), id);
          if (found) return found;
        } else {
          raw += event.data;
          if (raw.length > MAX_RAW_CHARS) throw new PluginError('PROTOCOL_ERROR', '腾讯文档返回的内容过大，请缩小读取范围后重试。');
        }
      }
      cursor = part.nextCursor;
      if (part.closed) break;
      if (Date.now() - lastBeat >= HEARTBEAT_MS) {
        heartbeat(ctx);
        lastBeat = Date.now();
      }
    }
  } finally {
    Promise.resolve(cindy.network.close({ connectionId })).catch(() => {});
  }
  if (!success) checkHttpStatus(endpoint, response.status, raw, hadSession);
  if (sse) {
    const found = matchResponse(takeSseMessages({ buffer: sseState.buffer + '\n\n' }), id);
    if (found) return found;
    throw interrupted('结果送达前连接已结束');
  }
  return parseRpcBody(contentType, raw, id);
}

async function rpc(ctx, endpoint, method, params, options) {
  const stream = Boolean(options && options.stream);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    await ensureSession(ctx, endpoint);
    try {
      return stream ? await requestStream(ctx, endpoint, method, params) : await requestText(ctx, endpoint, method, params);
    } catch (error) {
      // 会话过期时服务端尚未执行请求，重建会话后重试一次是安全的。
      if (error && error.code === 'SESSION_EXPIRED' && attempt === 0) {
        sessions.delete(endpointKey(endpoint));
        continue;
      }
      if (error && error.code === 'AUTH_REQUIRED') sessions.delete(endpointKey(endpoint));
      throw error;
    }
  }
  throw new PluginError('SERVER_ERROR', '腾讯文档会话反复失效，请稍后重试。');
}

function knownErrorHint(edition, text) {
  for (const [pattern, hint] of KNOWN_ERRORS[edition] || KNOWN_ERRORS.personal) {
    if (pattern.test(text)) return hint;
  }
  return '';
}

function rpcError(error, entry, edition) {
  const code = error && typeof error.code === 'number' ? error.code : null;
  const message = excerpt(error && error.message, 1000) || '未知错误';
  const hint = knownErrorHint(edition || "personal", message);
  if (code === -32602 && entry) {
    return new PluginError('INVALID_ARGS', '参数不符合「' + entry.name + '」的要求：' + message + '。' + schemaHint(entry));
  }
  if (code === -32601) {
    return new PluginError('UNKNOWN_TOOL', '腾讯文档当前不支持这个操作：' + message + '。请先调用 list_tools 查看最新可用操作。');
  }
  return new PluginError('TOOL_ERROR', '腾讯文档返回错误：' + message + (hint ? ' ' + hint : '') + (entry ? '。' + schemaHint(entry) : ''));
}

// ── 版本（个人版 / 企业版） ──────────────────────────────────────────────

async function configuredEditions() {
  try {
    const response = await fetch('/oauth');
    if (!response.ok) return null;
    const list = await response.json();
    if (!Array.isArray(list)) return null;
    const found = new Set();
    for (const [edition, config] of Object.entries(EDITIONS)) {
      const entry = list.find((item) => item && item.key === config.secret);
      if (entry && Array.isArray(entry.accounts) && entry.accounts.length > 0) found.add(edition);
    }
    return found;
  } catch (_err) {
    return null;
  }
}

async function resolveEdition(requested) {
  const value = typeof requested === 'string' ? requested.trim().toLowerCase() : '';
  if (value && !EDITIONS[value]) {
    throw new PluginError('INVALID_ARGS', 'edition 只能是 personal（个人版）或 enterprise（企业版）。');
  }
  const configured = await configuredEditions();
  if (value) {
    if (configured && configured.size > 0 && !configured.has(value)) {
      throw new PluginError(
        'EDITION_NOT_CONNECTED',
        '还没有连接腾讯文档' + EDITIONS[value].label + '账号。请让用户到 Cindy 侧边栏「插件」→「腾讯文档」详情页连接，或改用已连接的' +
          [...configured].map((e) => EDITIONS[e].label).join('、') + '。',
      );
    }
    return value;
  }
  if (configured && configured.size === 1) return [...configured][0];
  if (configured && configured.size > 1) {
    throw new PluginError(
      'EDITION_REQUIRED',
      '用户同时连接了腾讯文档个人版和企业版。请先问用户这次要操作哪一个，再带上 edition 参数（personal 或 enterprise）重新调用。',
    );
  }
  return 'personal';
}

// ── 工具目录 ───────────────────────────────────────────────────────────

function stripForeignHint(text) {
  return typeof text === 'string' ? text.replace(FOREIGN_ACCOUNT_HINT, '').trim() : text;
}

function cleanTool(tool) {
  if (typeof tool.description !== 'string') return tool;
  return Object.assign({}, tool, { description: stripForeignHint(tool.description) });
}

function exposedName(service, raw) {
  if (service === 'doc') return raw.startsWith('doc.') ? raw : 'doc.' + raw;
  if (service === 'sheet') return raw.startsWith('sheet.') ? raw : 'sheet.' + raw;
  if (service === 'slide') return /^slide[._]/.test(raw) ? raw : 'slide_' + raw;
  return raw;
}

async function listServiceTools(ctx, endpoint) {
  const tools = [];
  let cursor;
  let pages = 0;
  do {
    const message = await rpc(ctx, endpoint, 'tools/list', cursor ? { cursor } : {});
    if (message.error) throw rpcError(message.error, null, endpoint.edition);
    const result = message.result || {};
    for (const tool of Array.isArray(result.tools) ? result.tools : []) {
      if (tool && typeof tool.name === 'string' && tool.name && !HIDDEN_TOOLS.has(tool.name)) tools.push(cleanTool(tool));
    }
    cursor = typeof result.nextCursor === 'string' && result.nextCursor ? result.nextCursor : undefined;
    pages += 1;
  } while (cursor && pages < 20);
  return tools;
}

async function getCatalog(ctx, edition, force) {
  const cached = toolsCache.get(edition);
  if (!force && cached && Date.now() - cached.fetchedAt < TOOLS_TTL_MS) return cached;
  const services = {};
  const entries = [];
  const byName = new Map();
  // 专用服务（Word / 表格 / 幻灯片）先取；任何一个失败都不影响主服务。
  const engineResults = await Promise.all(ENGINE_SERVICES.map(async (service) => {
    try {
      return { service, tools: await listServiceTools(ctx, endpointOf(edition, service)) };
    } catch (error) {
      if (error && error.code === 'AUTH_REQUIRED') throw error;
      return { service, error: error && error.message ? error.message : '不可用' };
    }
  }));
  const liveEngines = new Set();
  for (const result of engineResults) {
    if (result.error) {
      services[result.service] = { available: false, reason: excerpt(result.error, 200) };
      continue;
    }
    services[result.service] = { available: true, count: result.tools.length };
    if (result.tools.length > 0) liveEngines.add(result.service);
    for (const tool of result.tools) {
      const name = exposedName(result.service, tool.name);
      if (byName.has(name)) continue;
      const entry = { name, raw: tool.name, service: result.service, tool };
      byName.set(name, entry);
      entries.push(entry);
    }
  }
  const mainTools = await listServiceTools(ctx, endpointOf(edition, 'main'));
  let replaced = 0;
  for (const tool of mainTools) {
    if (byName.has(tool.name)) {
      replaced += 1;
      continue;
    }
    const entry = { name: tool.name, raw: tool.name, service: 'main', tool };
    if (liveEngines.has(categoryOf(tool.name))) entry.forwarded = true;
    byName.set(tool.name, entry);
    entries.push(entry);
  }
  services.main = { available: true, count: mainTools.length, replacedByEngine: replaced };
  const catalog = { entries, byName, services, fetchedAt: Date.now() };
  toolsCache.set(edition, catalog);
  return catalog;
}

function categoryOf(name) {
  if (COMMON_TOOLS.has(name)) return 'common';
  const dot = name.indexOf('.');
  if (dot > 0) return name.slice(0, dot).toLowerCase();
  const lower = name.toLowerCase();
  for (const [keyword, category] of KEYWORD_CATEGORIES) {
    if (lower.includes(keyword)) return category;
  }
  return 'other';
}

function categoryLabel(category) {
  return CATEGORY_LABELS[category] || category;
}

function actionVerb(name) {
  let tail = name.slice(name.lastIndexOf('.') + 1).toLowerCase();
  const category = categoryOf(name);
  if (tail.startsWith(category + '_')) tail = tail.slice(category.length + 1);
  return tail;
}

// { readOnly, inferred }：服务端标注优先；未标注时按动词推断。
function accessOf(entry) {
  const annotations = entry.tool.annotations || {};
  if (typeof annotations.readOnlyHint === 'boolean') return { readOnly: annotations.readOnlyHint, inferred: false };
  const verb = actionVerb(entry.name);
  return { readOnly: READ_VERBS.test(verb) || READ_SUFFIXES.test(verb), inferred: true };
}

function base64Props(entry) {
  const properties = schemaOf(entry).properties || {};
  return Object.keys(properties).filter((key) => key.startsWith('base64_') && key.length > 7 && !Object.prototype.hasOwnProperty.call(properties, key.slice(7)));
}

function ruleKeys(entry) {
  const keys = accessOf(entry).readOnly ? READ_RULES.slice() : WRITE_RULES.slice();
  if (entry.forwarded) keys.push('prefer_engine');
  if (base64Props(entry).length) keys.push('base64_params');
  return keys;
}

function utf8ToBase64(text) {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

// 服务端要求 base64 的参数：允许传明文同名参数，由插件编码（等同腾讯文档说明里的本地脚本方式）。
function applyBase64Aliases(entry, args) {
  for (const key of base64Props(entry)) {
    const plain = key.slice(7);
    if (args[key] === undefined && typeof args[plain] === 'string') {
      args[key] = utf8ToBase64(args[plain]);
      delete args[plain];
    }
  }
  return args;
}

function ruleTexts(keys) {
  const out = {};
  for (const key of keys) out[key] = RULES[key];
  return out;
}

function schemaOf(entry) {
  const schema = entry.tool.inputSchema;
  return schema && typeof schema === 'object' ? schema : { type: 'object', properties: {} };
}

function schemaHint(entry) {
  const keys = ruleKeys(entry);
  return '该操作的参数 schema：' + compactJson(schemaOf(entry), 4000) +
    '；调用规则：' + keys.map((key) => RULES[key]).join(' ') +
    ' 也可调用 list_tools({ category: "' + categoryOf(entry.name) + '" }) 查看完整说明。';
}

function groupEntries(entries) {
  const groups = new Map();
  for (const entry of entries) {
    const category = categoryOf(entry.name);
    if (!groups.has(category)) groups.set(category, []);
    groups.get(category).push(entry);
  }
  return groups;
}

async function handleListTools(ctx, args) {
  const edition = await resolveEdition(args.edition);
  const requested = typeof args.category === 'string' ? args.category.trim().toLowerCase() : '';
  const catalog = await getCatalog(ctx, edition, false);
  const groups = groupEntries(catalog.entries);
  if (!requested) {
    const categories = [...groups.entries()]
      .sort((a, b) => b[1].length - a[1].length)
      .map(([category, items]) => ({
        category,
        label: categoryLabel(category),
        count: items.length,
        examples: items.filter((e) => !e.forwarded).slice(0, 4).map((e) => e.name),
      }));
    const overview = {
      edition,
      editionLabel: EDITIONS[edition].label,
      totalTools: catalog.entries.length,
      categories,
      services: catalog.services,
      localFiles: '本机文件上云、HTML 页面上云、图片 OCR、上传图片：使用本插件的 local_files 工具。',
      manual: '多步流程、智能文档 MDX 写法与各品类注意事项见本插件手册：ghost_manual({ ghost_id: "tencent-docs", path: "guide" })。',
      next: '调用 list_tools({ category }) 查看某一类操作的参数与 RULES，再用 call_tool({ name, args }) 执行。',
    };
    const instructions = [...sessions.entries()]
      .filter(([key]) => key.startsWith(edition + ':'))
      .map(([, s]) => s.instructions)
      .find((text) => text && !/^MCP server is ready$/i.test(text.trim()));
    if (instructions) overview.serverInstructions = excerpt(instructions, MAX_INSTRUCTIONS_CHARS);
    if (catalog.entries.length === 0) overview.note = '腾讯文档当前没有返回任何可用操作，请稍后重试。';
    return overview;
  }
  const items = groups.get(requested);
  if (!items) {
    throw new PluginError(
      'UNKNOWN_CATEGORY',
      '没有名为「' + requested + '」的类目。可用类目：' +
        [...groups.keys()].map((key) => key + '（' + categoryLabel(key) + '）').join('、') +
        '。不传 category 调用 list_tools 可查看概览。',
    );
  }
  const usedRules = new Set();
  const detail = items.map((entry) => {
    const keys = ruleKeys(entry);
    keys.forEach((key) => usedRules.add(key));
    const annotations = entry.tool.annotations || {};
    const access = accessOf(entry);
    const out = {
      name: entry.name,
      description: typeof entry.tool.description === 'string' ? entry.tool.description : '',
      readOnly: access.readOnly,
      parameters: schemaOf(entry),
      rules: keys,
    };
    if (access.inferred) out.readOnlyInferred = true;
    if (entry.forwarded) out.forwarded = true;
    if (typeof entry.tool.title === 'string' && entry.tool.title) out.title = entry.tool.title;
    else if (typeof annotations.title === 'string' && annotations.title) out.title = annotations.title;
    if (annotations.destructiveHint === true) out.destructive = true;
    return out;
  });
  return {
    edition,
    category: requested,
    label: categoryLabel(requested),
    tools: detail,
    rules: ruleTexts([...usedRules]),
    note: 'readOnly 为 false 表示该操作可能修改文档或设置；带 readOnlyInferred 的是按操作名推断的，拿不准时按写入对待。',
    next: '用 call_tool({ name, args' + (args.edition ? ', edition: "' + edition + '"' : '') + ' }) 执行，name 逐字使用上面的 tools[].name。',
  };
}

// ── 执行操作 ───────────────────────────────────────────────────────────

function normalizeArgs(value) {
  if (value === undefined || value === null) return {};
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
    } catch (_err) {
      // 落到下面统一报错。
    }
    return null;
  }
  if (typeof value === 'object' && !Array.isArray(value)) return value;
  return null;
}

function missingRequired(entry, args) {
  const schema = schemaOf(entry);
  const required = Array.isArray(schema.required) ? schema.required : [];
  return required.filter((key) => typeof key === 'string' && (args[key] === undefined || args[key] === null || args[key] === ''));
}

function suggestNames(entries, name) {
  const lower = name.toLowerCase();
  const tail = lower.includes('.') ? lower.slice(lower.lastIndexOf('.') + 1) : lower;
  return entries
    .map((entry) => entry.name)
    .filter((candidate) => {
      const c = candidate.toLowerCase();
      return c.includes(tail) || tail.includes(c.slice(c.lastIndexOf('.') + 1)) || categoryOf(candidate) === categoryOf(name);
    })
    .slice(0, 8);
}

// 腾讯文档常把同一份 JSON 同时放在文本和结构化结果里；相同就只保留文本，省上下文。
function sameJson(text, value) {
  if (!text) return false;
  try {
    return JSON.stringify(JSON.parse(text)) === JSON.stringify(value);
  } catch (_err) {
    return false;
  }
}

function formatToolResult(result, edition) {
  const content = Array.isArray(result && result.content) ? result.content : [];
  const texts = [];
  const images = [];
  const resources = [];
  for (const item of content) {
    if (!item || typeof item !== 'object') continue;
    if (item.type === 'text' && typeof item.text === 'string') {
      texts.push(item.text);
    } else if (item.type === 'image' && typeof item.data === 'string') {
      if (images.length < MAX_IMAGES) images.push({ data: item.data });
    } else if (item.type === 'resource' && item.resource && typeof item.resource === 'object') {
      resources.push({
        type: 'resource',
        uri: item.resource.uri,
        mimeType: item.resource.mimeType,
        text: typeof item.resource.text === 'string' ? excerpt(item.resource.text, 20000) : undefined,
      });
    } else if (item.type === 'resource_link') {
      resources.push({ type: 'resource_link', uri: item.uri, name: item.name, description: item.description });
    }
  }
  let text = texts.join('\n\n');
  const out = {};
  if (text.length > MAX_TEXT_CHARS) {
    text = text.slice(0, MAX_TEXT_CHARS);
    out.truncated = '内容过长，只保留了前 ' + MAX_TEXT_CHARS + ' 个字符；需要后面的内容时，请用该操作的分页或范围参数分段读取。';
  }
  out.text = text;
  if (result && result.structuredContent !== undefined && !sameJson(text, result.structuredContent)) {
    const structured = compactJson(result.structuredContent, 60001);
    if (!text || structured.length <= 60000) out.structuredContent = result.structuredContent;
  }
  if (resources.length) out.resources = resources;
  const hint = knownErrorHint(edition, text);
  if (hint) out.hint = hint;
  return { isError: Boolean(result && result.isError), text, out, images };
}

async function handleCallTool(ctx, args) {
  const name = typeof args.name === 'string' ? args.name.trim() : '';
  if (!name) {
    throw new PluginError('INVALID_ARGS', 'name 必填：请先调用 list_tools 找到要执行的操作，再把 tools[].name 逐字传入。');
  }
  const toolArgs = normalizeArgs(args.args);
  if (!toolArgs) {
    throw new PluginError('INVALID_ARGS', 'args 必须是 JSON 对象（例如 {"file_id": "..."}），请按 list_tools(category) 返回的参数 schema 填写。');
  }
  const edition = await resolveEdition(args.edition);
  let catalog = await getCatalog(ctx, edition, false);
  let entry = catalog.byName.get(name);
  if (!entry) {
    catalog = await getCatalog(ctx, edition, true);
    entry = catalog.byName.get(name);
  }
  if (!entry) {
    const suggestions = suggestNames(catalog.entries, name);
    throw new PluginError(
      'UNKNOWN_TOOL',
      '腾讯文档' + EDITIONS[edition].label + '没有名为「' + name + '」的操作。' +
        (suggestions.length ? '相近的操作：' + suggestions.join('、') + '。' : '') +
        '可用类目：' + [...groupEntries(catalog.entries).keys()].join('、') + '；请调用 list_tools({ category }) 查看准确的操作名。',
    );
  }
  applyBase64Aliases(entry, toolArgs);
  const missing = missingRequired(entry, toolArgs);
  if (missing.length) {
    throw new PluginError('INVALID_ARGS', '缺少必填参数：' + missing.join('、') + '。' + schemaHint(entry));
  }
  const endpoint = endpointOf(edition, entry.service);
  let message;
  try {
    message = await rpc(ctx, endpoint, 'tools/call', { name: entry.raw, arguments: toolArgs }, { stream: true });
  } catch (error) {
    if (isScopeError(error && error.message)) return manageFallback(ctx, edition, entry, toolArgs);
    throw error;
  }
  if (message.error && isScopeError(message.error.message)) return manageFallback(ctx, edition, entry, toolArgs);
  if (message.error) throw rpcError(message.error, entry, edition);
  const formatted = formatToolResult(message.result, edition);
  if (formatted.isError && isScopeError(formatted.text)) return manageFallback(ctx, edition, entry, toolArgs);
  if (formatted.isError) {
    const hint = knownErrorHint(edition, formatted.text);
    throw new PluginError(
      'TOOL_ERROR',
      '腾讯文档执行「' + name + '」失败：' + (excerpt(formatted.text, 2000) || '没有返回原因') + '。' +
        (hint ? hint + ' ' : '请根据提示调整后重试。') + schemaHint(entry),
    );
  }
  return formatted;
}

// ── 管理权限：一键登录拿不到 docs:manage，改用用户填写的个人 Token ─────────────

function isScopeError(text) {
  return typeof text === 'string' && /insufficient_scope/i.test(text);
}

const MANAGE_SCOPE_HINT =
  '这个操作需要腾讯文档的管理权限（删除、移动、改分享等）。Cindy 的一键登录只能拿到读写权限，' +
  '需要用户在腾讯文档开放平台（https://docs.qq.com/open/auth/mcp.html）复制个人 Token，' +
  '填到 Cindy 侧边栏「插件」→「腾讯文档」详情页后再试；也可以请用户直接在腾讯文档网页里操作。';

// 服务端以权限不足拒绝时请求没有执行，用个人 Token 重发一次是安全的。
async function manageFallback(ctx, edition, entry, toolArgs) {
  if (edition !== 'personal') {
    throw new PluginError('SCOPE_REQUIRED', '这个操作需要腾讯文档企业版的管理权限，当前授权没有。请用户在腾讯文档网页里手动操作，或联系企业管理员。');
  }
  if (typeof cindy.node !== 'object' || typeof cindy.node.request !== 'function') {
    throw new PluginError('SCOPE_REQUIRED', MANAGE_SCOPE_HINT);
  }
  heartbeat(ctx, '改用个人 Token 执行需要管理权限的操作');
  const response = await cindy.node.request({
    method: 'personal/token-call',
    params: { service: entry.service, tool: entry.raw, args: toolArgs },
    callId: ctx.callId,
    cancelWithCall: true,
    timeoutMs: 120000,
    maxTotalMs: 600000,
  });
  if (!response || !response.ok) {
    const workerCode = response && response.data && typeof response.data.code === 'string' ? response.data.code : null;
    const message = (response && response.message) || '';
    if (workerCode === 'TOKEN_INVALID') throw new PluginError('TOKEN_INVALID', message);
    if (workerCode && workerCode !== 'TOKEN_REQUIRED') {
      throw new PluginError(workerCode, message + (isScopeError(message) ? ' 个人 Token 也没有这项权限。' : ''));
    }
    // 没填 Token、用户取消了安全输入框，或宿主不支持安全输入。
    throw new PluginError('SCOPE_REQUIRED', MANAGE_SCOPE_HINT);
  }
  const formatted = formatToolResult((response.result && response.result.result) || {}, edition);
  if (formatted.isError) {
    if (isScopeError(formatted.text)) throw new PluginError('SCOPE_REQUIRED', '个人 Token 也没有这项管理权限：' + excerpt(formatted.text, 500));
    const hint = knownErrorHint(edition, formatted.text);
    throw new PluginError('TOOL_ERROR', '腾讯文档执行「' + entry.name + '」失败：' + (excerpt(formatted.text, 2000) || '没有返回原因') + '。' + (hint ? hint + ' ' : '') + schemaHint(entry));
  }
  formatted.out.via = 'personal-token';
  return formatted;
}

// ── 本机文件（Node 工作进程） ───────────────────────────────────────────

const LOCAL_ACTIONS = new Set(['import_file', 'import_html', 'ocr_extract', 'ocr_to_word', 'ocr_to_excel', 'upload_image']);

async function handleLocalFiles(ctx, args) {
  const action = typeof args.action === 'string' ? args.action.trim() : '';
  if (!LOCAL_ACTIONS.has(action)) {
    throw new PluginError('INVALID_ARGS', 'action 只能是 ' + [...LOCAL_ACTIONS].join('、') + ' 之一。');
  }
  const edition = await resolveEdition(args.edition);
  const params = { action };
  for (const key of ['path', 'title', 'extract_type']) {
    if (typeof args[key] === 'string' && args[key].trim()) params[key] = args[key].trim();
  }
  if (Array.isArray(args.paths)) params.paths = args.paths.filter((p) => typeof p === 'string' && p.trim()).map((p) => p.trim());
  if (args.with_positions === true) params.with_positions = true;
  if (!params.path && !(params.paths && params.paths.length)) {
    throw new PluginError('INVALID_ARGS', '请在 path（或 OCR 多图时的 paths）里给出本机文件的完整路径。');
  }
  if (typeof cindy.node !== 'object' || typeof cindy.node.request !== 'function') {
    throw new PluginError('UNSUPPORTED', '当前 Cindy 版本不支持插件处理本机文件，请升级 Cindy 后再试。');
  }
  activeLocalCalls.add(ctx.callId);
  const timer = setInterval(() => heartbeat(ctx), HEARTBEAT_MS);
  try {
    const response = await cindy.node.request({
      method: edition + '/local',
      params,
      callId: ctx.callId,
      cancelWithCall: true,
      timeoutMs: 120000,
      maxTotalMs: 900000,
    });
    if (!response || !response.ok) {
      const message = (response && response.message) || '本机处理失败';
      // 工作进程的业务错误码在 data.code；宿主自己的错误（取消、超时、进程退出、权限）沿用宿主错误码。
      const workerCode = response && response.data && typeof response.data.code === 'string' ? response.data.code : null;
      const hostCode = response && response.errorCode && response.errorCode !== 'PROTOCOL_ERROR' ? response.errorCode : null;
      const hint = knownErrorHint(edition, message);
      throw new PluginError(workerCode || hostCode || 'LOCAL_FAILED', message + (hint && !message.includes(hint) ? ' ' + hint : ''));
    }
    return Object.assign({ edition }, response.result || {});
  } finally {
    clearInterval(timer);
    activeLocalCalls.delete(ctx.callId);
  }
}

// ── 入口 ───────────────────────────────────────────────────────────────

async function reply(callId, payload) {
  await cindy.send(Object.assign({ type: 'tool-result', callId }, payload));
}

cindy.onHostMessage(async (msg) => {
  if (!msg) return;
  if (msg.type === 'event' && msg.name === 'node-notification') {
    const message = msg.params && typeof msg.params.message === 'string' ? msg.params.message : undefined;
    for (const callId of activeLocalCalls) heartbeat({ callId }, message);
    return;
  }
  if (msg.type !== 'tool-call') return;
  const callId = msg.callId;
  const ctx = { callId };
  const args = msg.args && typeof msg.args === 'object' ? msg.args : {};
  try {
    if (msg.tool === 'list_tools') {
      const result = await handleListTools(ctx, args);
      await reply(callId, { ok: true, result });
      return;
    }
    if (msg.tool === 'call_tool') {
      const formatted = await handleCallTool(ctx, args);
      const payload = { ok: true, result: formatted.out };
      if (formatted.images.length) payload.images = formatted.images;
      await reply(callId, payload);
      return;
    }
    if (msg.tool === 'local_files') {
      const result = await handleLocalFiles(ctx, args);
      await reply(callId, { ok: true, result });
      return;
    }
    await reply(callId, {
      ok: false,
      errorCode: 'UNKNOWN_TOOL',
      message: '本插件提供 list_tools、call_tool 和 local_files 三个工具，请先调用 list_tools。',
    });
  } catch (error) {
    const code = error && typeof error.code === 'string' && error.code !== 'SESSION_EXPIRED' ? error.code : 'PLUGIN_ERROR';
    const message = error && error.message ? String(error.message) : '腾讯文档插件出现未知错误，请稍后重试。';
    await reply(callId, { ok: false, errorCode: code, message });
  }
});
