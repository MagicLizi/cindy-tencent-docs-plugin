'use strict';

// 腾讯文档插件的本机工作进程：读取用户指定的本机文件，完成
// 「本地文件上云」「HTML 打包上云」「图片 OCR」「上传图片」四类需要传大文件的操作。
// 令牌只来自宿主每次注入的 request.cindy.secrets，不缓存、不落盘、不写日志。

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');
const zlib = require('node:zlib');

const EDITIONS = {
  personal: { url: 'https://docs.qq.com/openapi/mcp', secret: 'personal_token' },
  enterprise: { url: 'https://saas.docs.qq.com/api/v6/open/agent/mcp', secret: 'enterprise_token' },
};
const PROTOCOL_VERSION = '2025-06-18';
const CLIENT_INFO = { name: 'cindy-tencent-docs', version: '0.2.0' };
const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.bmp', '.webp']);
const UPLOAD_IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.bmp', '.webp', '.svg']);
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_IMAGES_TOTAL = 50 * 1024 * 1024;
const MAX_IMAGE_COUNT = 9;
const MAX_IMPORT_BYTES = 1024 * 1024 * 1024;
const MAX_AIPAGE_FILES = 2000;
const IMPORT_POLL_MS = 3000;
const IMPORT_POLL_LIMIT_MS = 120000;
const HTTP_TIMEOUT_MS = 120000;
const UPLOAD_TIMEOUT_MS = 10 * 60 * 1000;

class WorkerError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function send(message) {
  process.stdout.write(JSON.stringify(message) + '\n');
}

function progress(message) {
  send({ jsonrpc: '2.0', method: 'progress', params: { message } });
}

// ── 本机文件 ─────────────────────────────────────────────────────────

function requireFile(filePath, label) {
  if (typeof filePath !== 'string' || !filePath.trim()) {
    throw new WorkerError('INVALID_ARGS', label + '必须是本机文件的完整路径。');
  }
  const resolved = path.resolve(filePath.trim());
  let stat;
  try {
    stat = fs.statSync(resolved);
  } catch (_err) {
    throw new WorkerError('FILE_NOT_FOUND', '找不到文件：' + resolved + '。请确认路径正确、文件存在。');
  }
  if (!stat.isFile()) throw new WorkerError('INVALID_ARGS', '不是文件：' + resolved + '。');
  if (stat.size === 0) throw new WorkerError('INVALID_ARGS', '文件是空的：' + resolved + '。');
  return { path: resolved, size: stat.size, name: path.basename(resolved) };
}

function requireImage(filePath, allowed) {
  const file = requireFile(filePath, '图片');
  const ext = path.extname(file.name).toLowerCase();
  if (!allowed.has(ext)) {
    throw new WorkerError('INVALID_ARGS', '不支持的图片格式 ' + (ext || '（无扩展名）') + '，可用：' + [...allowed].join(' ') + '。');
  }
  if (file.size > MAX_IMAGE_BYTES) throw new WorkerError('INVALID_ARGS', '图片超过 10MB：' + file.path + '。');
  return file;
}

function md5Hex(buffer) {
  return crypto.createHash('md5').update(buffer).digest('hex');
}

// ── 最小 MCP 客户端（直连，令牌来自宿主注入） ──────────────────────────

function parseSse(text) {
  const messages = [];
  for (const block of text.replace(/\r\n/g, '\n').split('\n\n')) {
    const data = block.split('\n').filter((line) => line.startsWith('data:')).map((line) => line.slice(5).replace(/^ /, '')).join('\n');
    if (!data) continue;
    try {
      const parsed = JSON.parse(data);
      if (Array.isArray(parsed)) messages.push(...parsed);
      else messages.push(parsed);
    } catch (_err) {
      // 忽略非 JSON 事件
    }
  }
  return messages;
}

function httpError(status, body) {
  if (status === 401) {
    return new WorkerError('AUTH_REQUIRED', '腾讯文档拒绝了当前授权（可能已过期）。请到 Cindy 侧边栏「插件」→「腾讯文档」详情页重新连接账号后再试。');
  }
  if (status === 403) return new WorkerError('FORBIDDEN', '腾讯文档拒绝了这次操作：当前账号没有权限。');
  if (status === 429) return new WorkerError('RATE_LIMITED', '腾讯文档请求过于频繁，请稍后再试。');
  const detail = typeof body === 'string' ? body.trim().slice(0, 300) : '';
  return new WorkerError('SERVER_ERROR', '腾讯文档返回了 HTTP ' + status + (detail ? '：' + detail : '') + '。');
}

class McpClient {
  // authorization：完整的 Authorization 头值；缺省用 OAuth access token 拼 Bearer。
  constructor(url, token, authorization) {
    this.url = url;
    this.token = token;
    this.authorization = authorization || 'Bearer ' + token;
    this.sessionId = null;
    this.protocolVersion = PROTOCOL_VERSION;
    this.nextId = 1;
  }

  headers() {
    const headers = {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      Authorization: this.authorization,
    };
    if (this.sessionId) {
      headers['Mcp-Session-Id'] = this.sessionId;
      headers['MCP-Protocol-Version'] = this.protocolVersion;
    }
    return headers;
  }

  async post(payload) {
    let response;
    try {
      response = await fetch(this.url, {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
      });
    } catch (error) {
      throw new WorkerError('RESULT_UNKNOWN', '连接腾讯文档时中断（' + (error && error.message) + '）。操作可能已经执行，请先确认结果再决定是否重试。');
    }
    const text = await response.text();
    return { response, text };
  }

  async initialize() {
    const id = this.nextId++;
    const { response, text } = await this.post({
      jsonrpc: '2.0', id, method: 'initialize',
      params: { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: CLIENT_INFO },
    });
    if (!response.ok) throw httpError(response.status, text);
    const message = this.pick(response, text, id);
    if (message.error) throw new WorkerError('SERVER_ERROR', '腾讯文档初始化失败：' + (message.error.message || '未知错误'));
    this.sessionId = response.headers.get('mcp-session-id');
    if (message.result && typeof message.result.protocolVersion === 'string') this.protocolVersion = message.result.protocolVersion;
    try {
      await this.post({ jsonrpc: '2.0', method: 'notifications/initialized' });
    } catch (_err) {
      // 通知失败不影响后续调用
    }
  }

  pick(response, text, id) {
    const contentType = response.headers.get('content-type') || '';
    let messages;
    if (contentType.includes('text/event-stream')) {
      messages = parseSse(text);
    } else {
      try {
        const parsed = JSON.parse(text);
        messages = Array.isArray(parsed) ? parsed : [parsed];
      } catch (_err) {
        throw new WorkerError('PROTOCOL_ERROR', '腾讯文档返回了无法识别的内容。');
      }
    }
    const found = messages.find((m) => m && String(m.id) === String(id) && ('result' in m || 'error' in m));
    if (!found) throw new WorkerError('PROTOCOL_ERROR', '腾讯文档的返回里没有这次请求的结果。');
    return found;
  }

  async listTools() {
    if (!this.sessionId && this.nextId === 1) await this.initialize();
    const tools = [];
    let cursor;
    let pages = 0;
    do {
      const id = this.nextId++;
      const { response, text } = await this.post({ jsonrpc: '2.0', id, method: 'tools/list', params: cursor ? { cursor } : {} });
      if (!response.ok) throw httpError(response.status, text);
      const message = this.pick(response, text, id);
      if (message.error) throw new WorkerError('SERVER_ERROR', '读取腾讯文档操作列表失败：' + (message.error.message || '未知错误'));
      const result = message.result || {};
      for (const tool of Array.isArray(result.tools) ? result.tools : []) tools.push(tool);
      cursor = typeof result.nextCursor === 'string' && result.nextCursor ? result.nextCursor : undefined;
      pages += 1;
    } while (cursor && pages < 20);
    return tools;
  }

  async callTool(name, args) {
    if (!this.sessionId && this.nextId === 1) await this.initialize();
    const id = this.nextId++;
    const { response, text } = await this.post({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } });
    if (!response.ok) throw httpError(response.status, text);
    const message = this.pick(response, text, id);
    if (message.error) {
      throw new WorkerError('TOOL_ERROR', '腾讯文档执行「' + name + '」失败：' + (message.error.message || '未知错误'));
    }
    return message.result || {};
  }
}

function resultText(result) {
  const content = Array.isArray(result.content) ? result.content : [];
  return content.filter((c) => c && c.type === 'text' && typeof c.text === 'string').map((c) => c.text).join('\n\n');
}

function resultData(result) {
  if (result.structuredContent && typeof result.structuredContent === 'object') return result.structuredContent;
  const text = resultText(result);
  try {
    return JSON.parse(text);
  } catch (_err) {
    return null;
  }
}

function ensureOk(name, result) {
  if (result.isError) {
    throw new WorkerError('TOOL_ERROR', '腾讯文档执行「' + name + '」失败：' + (resultText(result).slice(0, 1000) || '没有返回原因'));
  }
  return result;
}

// ── ZIP（.aipage）打包 ───────────────────────────────────────────────

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  let crc = 0xffffffff;
  for (let i = 0; i < buffer.length; i += 1) crc = CRC_TABLE[(crc ^ buffer[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function dosTime(date) {
  const time = (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2);
  const day = ((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  return { time, day };
}

// entries: [{ name: 'index.html', data: Buffer }]；扁平、无目录条目，按需 DEFLATE。
function buildZip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  const { time, day } = dosTime(new Date());
  for (const entry of entries) {
    const nameBytes = Buffer.from(entry.name, 'utf8');
    const crc = crc32(entry.data);
    let method = 8;
    let payload = zlib.deflateRawSync(entry.data, { level: 9 });
    if (payload.length >= entry.data.length) {
      method = 0;
      payload = entry.data;
    }
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // UTF-8 文件名
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(day, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(payload.length, 18);
    local.writeUInt32LE(entry.data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, nameBytes, payload);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(day, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(payload.length, 20);
    central.writeUInt32LE(entry.data.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBytes);
    offset += local.length + nameBytes.length + payload.length;
  }
  const centralSize = centrals.reduce((sum, b) => sum + b.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, ...centrals, end]);
}

function skipName(name) {
  return name === '__MACOSX' || name === '.DS_Store' || name === 'Thumbs.db' || name.startsWith('._');
}

function collectDir(root, rel, out) {
  for (const name of fs.readdirSync(path.join(root, rel))) {
    if (skipName(name)) continue;
    const relPath = rel ? rel + '/' + name : name;
    const stat = fs.statSync(path.join(root, relPath));
    if (stat.isDirectory()) collectDir(root, relPath, out);
    else if (stat.isFile()) out.push(relPath);
    if (out.length > MAX_AIPAGE_FILES) throw new WorkerError('INVALID_ARGS', '目录里的文件太多（超过 ' + MAX_AIPAGE_FILES + ' 个）。');
  }
  return out;
}

function htmlTitle(buffer) {
  const match = buffer.toString('utf8').match(/<title>([\s\S]*?)<\/title>/i);
  return match ? match[1].trim() : '';
}

// 单个 HTML：入口改名为 index.html，同级 assets/ 一并带上；目录：整目录打包，唯一入口改名为 index.html。
function packAipage(source, title) {
  if (typeof source !== 'string' || !source.trim()) throw new WorkerError('INVALID_ARGS', 'path 必须是 HTML 文件或 HTML 所在目录的完整路径。');
  const resolved = path.resolve(source.trim());
  let stat;
  try {
    stat = fs.statSync(resolved);
  } catch (_err) {
    throw new WorkerError('FILE_NOT_FOUND', '找不到：' + resolved + '。');
  }
  const files = new Map();
  let stem;
  if (stat.isFile()) {
    if (!/\.html?$/i.test(resolved)) throw new WorkerError('INVALID_ARGS', '只能打包 .html / .htm 文件：' + resolved + '。');
    files.set('index.html', fs.readFileSync(resolved));
    stem = path.basename(resolved).replace(/\.html?$/i, '');
    const assets = path.join(path.dirname(resolved), 'assets');
    if (fs.existsSync(assets) && fs.statSync(assets).isDirectory()) {
      for (const rel of collectDir(assets, '', [])) files.set('assets/' + rel, fs.readFileSync(path.join(assets, rel)));
    }
  } else if (stat.isDirectory()) {
    const names = fs.readdirSync(resolved);
    let entry = names.find((n) => n === 'index.html') || names.find((n) => n === 'index.htm');
    if (!entry) {
      const candidates = names.filter((n) => /\.html?$/i.test(n));
      if (candidates.length === 0) throw new WorkerError('INVALID_ARGS', '目录里没有 HTML 入口文件：' + resolved + '。');
      if (candidates.length > 1) throw new WorkerError('INVALID_ARGS', '目录里有多个 HTML（' + candidates.join('、') + '），请直接传入口 HTML 文件的路径。');
      entry = candidates[0];
    }
    for (const rel of collectDir(resolved, '', [])) {
      const target = rel === entry ? 'index.html' : rel;
      if (rel !== entry && target === 'index.html') continue;
      files.set(target, fs.readFileSync(path.join(resolved, rel)));
    }
    stem = path.basename(resolved);
  } else {
    throw new WorkerError('INVALID_ARGS', '不是文件或目录：' + resolved + '。');
  }
  const finalTitle = (typeof title === 'string' && title.trim()) || htmlTitle(files.get('index.html')) || stem;
  files.set('manifest.json', Buffer.from(JSON.stringify({ entry: 'index.html', title: finalTitle, version: '1.0' }, null, 2), 'utf8'));
  files.set('janus.manifest.json', Buffer.from('{"version":"1.0.0","render_engine":"native","scene":""}', 'utf8'));
  const zip = buildZip([...files.entries()].map(([name, data]) => ({ name, data })));
  // 导入后的文档名取自包文件名：优先用网页标题，比文件夹名更好认。
  const safeName = (finalTitle || stem).replace(/[\\/:*?"<>|\r\n\t]/g, '_').trim().slice(0, 80) || 'page';
  return { name: safeName + '.aipage', data: zip, title: finalTitle, fileCount: files.size };
}

// ── 业务动作 ─────────────────────────────────────────────────────────

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// 只用于不会重复产生副作用的步骤（申请上传地址、查询进度）：失败后间隔 5 秒最多再试 2 次。
async function withRetry(label, task) {
  let lastError;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await task();
    } catch (error) {
      lastError = error;
      if (error && (error.code === 'AUTH_REQUIRED' || error.code === 'FORBIDDEN' || error.code === 'INVALID_ARGS')) throw error;
      if (attempt < 2) {
        progress(label + '失败，5 秒后重试');
        await sleep(5000);
      }
    }
  }
  throw lastError;
}

async function putUpload(uploadUrl, data) {
  progress('正在上传文件');
  let put;
  try {
    put = await fetch(uploadUrl, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: data,
      signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS),
    });
  } catch (error) {
    throw new WorkerError('UPLOAD_FAILED', '上传文件时中断（' + (error && error.message) + '），请重试。');
  }
  if (!put.ok) throw new WorkerError('UPLOAD_FAILED', '上传文件失败（HTTP ' + put.status + '），请重试。');
}

function doneFields(data) {
  if (!data || typeof data !== 'object') return false;
  const progressValue = Number(data.progress);
  return Boolean(data.url || data.file_url || data.file_id || progressValue >= 100 ||
    /^(done|success|succeeded|finished|completed)$/i.test(String(data.status || data.state || '')));
}

async function pollTask(client, tool, args, name) {
  const deadline = Date.now() + IMPORT_POLL_LIMIT_MS;
  let last = null;
  let failures = 0;
  while (Date.now() < deadline) {
    await sleep(IMPORT_POLL_MS);
    let polled;
    try {
      polled = await client.callTool(tool, args);
    } catch (error) {
      if (error && error.code === 'AUTH_REQUIRED') throw error;
      failures += 1;
      if (failures > 2) break;
      continue;
    }
    if (polled.isError) {
      last = { error: resultText(polled).slice(0, 500) };
      break;
    }
    last = resultData(polled) || { text: resultText(polled) };
    if (doneFields(last)) return { status: 'done', file_name: name, result: last };
    const progressValue = Number(last.progress);
    progress('导入中' + (Number.isFinite(progressValue) ? '（' + progressValue + '%）' : ''));
  }
  return {
    status: 'pending',
    file_name: name,
    result: last,
    next: '导入还没确认完成。用 call_tool 调用 ' + tool + '（参数 ' + JSON.stringify(args) + '）继续查询；完成后结果里会有文档链接。若失败，把其中的 trace_id 告诉用户。',
  };
}

// 个人版：manage.pre_import → PUT → manage.async_import → manage.import_progress。
async function importPersonal(client, name, data) {
  const size = data.length;
  const md5 = md5Hex(data);
  progress('正在申请上传地址');
  const pre = await withRetry('申请上传地址', async () => ensureOk('manage.pre_import',
    await client.callTool('manage.pre_import', { file_name: name, file_size: size, file_md5: md5 })));
  const preData = resultData(pre) || {};
  if (!preData.upload_url || !preData.file_key) {
    throw new WorkerError('SERVER_ERROR', '腾讯文档没有返回上传地址：' + resultText(pre).slice(0, 300));
  }
  await putUpload(preData.upload_url, data);
  progress('正在导入');
  const started = ensureOk('manage.async_import', await client.callTool('manage.async_import', {
    task_id: preData.task_id, file_size: String(size), file_key: preData.file_key, file_name: name, file_md5: md5,
  }));
  const startedData = resultData(started) || {};
  const taskId = startedData.task_id || preData.task_id;
  if (!taskId) return { status: 'started', file_name: name, result: startedData };
  const outcome = await pollTask(client, 'manage.import_progress', { task_id: taskId }, name);
  outcome.task_id = taskId;
  return outcome;
}

// 按服务端实时 schema 填参数：企业版导入接口没有公开文档，只填 schema 里确实存在的字段。
function fillBySchema(tool, known) {
  const schema = (tool && tool.inputSchema) || {};
  const properties = schema.properties || {};
  const aliases = {
    file_name: ['file_name', 'filename', 'name', 'title'],
    file_size: ['file_size', 'size', 'filesize'],
    file_md5: ['file_md5', 'md5'],
    obj_key: ['obj_key', 'object_key', 'file_key', 'key'],
    task_id: ['task_id', 'taskid'],
  };
  const args = {};
  for (const [field, names] of Object.entries(aliases)) {
    if (known[field] === undefined || known[field] === null || known[field] === '') continue;
    const target = names.find((n) => Object.prototype.hasOwnProperty.call(properties, n));
    if (!target) continue;
    const type = properties[target] && properties[target].type;
    args[target] = type === 'string' ? String(known[field]) : (type === 'integer' || type === 'number') ? Number(known[field]) : known[field];
  }
  const missing = (Array.isArray(schema.required) ? schema.required : []).filter((key) => args[key] === undefined);
  if (missing.length) {
    throw new WorkerError('UNSUPPORTED', '腾讯文档企业版「' + tool.name + '」需要的参数（' + missing.join('、') + '）无法自动填写。请改用 call_tool 按它的 schema 手动完成导入。');
  }
  return args;
}

// 企业版：manage.apply_upload → PUT → manage.complete_upload → manage.query_task。
async function importEnterprise(client, name, data) {
  const size = data.length;
  const md5 = md5Hex(data);
  const tools = await client.listTools();
  const byName = new Map(tools.map((tool) => [tool.name, tool]));
  const apply = byName.get('manage.apply_upload');
  const complete = byName.get('manage.complete_upload');
  if (!apply || !complete) {
    throw new WorkerError('UNSUPPORTED', '腾讯文档企业版当前没有提供文件上传接口（manage.apply_upload / manage.complete_upload）。');
  }
  progress('正在申请上传地址');
  const applied = await withRetry('申请上传地址', async () => ensureOk('manage.apply_upload',
    await client.callTool(apply.name, fillBySchema(apply, { file_name: name, file_size: size, file_md5: md5 }))));
  const appliedData = resultData(applied) || {};
  const uploadUrl = appliedData.upload_url || appliedData.url || appliedData.cos_url;
  const objKey = appliedData.obj_key || appliedData.object_key || appliedData.file_key;
  if (!uploadUrl) throw new WorkerError('SERVER_ERROR', '腾讯文档企业版没有返回上传地址：' + resultText(applied).slice(0, 300));
  await putUpload(uploadUrl, data);
  progress('正在导入');
  const completed = ensureOk('manage.complete_upload', await client.callTool(complete.name, fillBySchema(complete, {
    file_name: name, file_size: size, file_md5: md5, obj_key: objKey, task_id: appliedData.task_id,
  })));
  const completedData = resultData(completed) || {};
  if (doneFields(completedData)) return { status: 'done', file_name: name, result: completedData };
  const taskId = completedData.task_id || appliedData.task_id;
  const query = byName.get('manage.query_task');
  if (!taskId || !query) return { status: 'started', file_name: name, result: completedData };
  const outcome = await pollTask(client, query.name, fillBySchema(query, { task_id: taskId }), name);
  outcome.task_id = taskId;
  return outcome;
}

async function importBuffer(client, edition, name, data) {
  if (data.length > MAX_IMPORT_BYTES) throw new WorkerError('INVALID_ARGS', '文件超过 1GB，无法导入。');
  return edition === 'enterprise' ? importEnterprise(client, name, data) : importPersonal(client, name, data);
}

function personalOnly(edition, what) {
  if (edition === 'enterprise') {
    throw new WorkerError('UNSUPPORTED', '腾讯文档企业版不提供' + what + '，只有个人版可以用。');
  }
}

async function runAction(edition, params, token) {
  const config = EDITIONS[edition];
  const client = new McpClient(config.url, token);
  const action = params.action;
  if (action === 'import_file') {
    const file = requireFile(params.path, '要上传的文件');
    if (file.size > MAX_IMPORT_BYTES) throw new WorkerError('INVALID_ARGS', '文件超过 1GB，无法导入。');
    const data = fs.readFileSync(file.path);
    return importBuffer(client, edition, file.name, data);
  }
  if (action === 'import_html') {
    personalOnly(edition, 'HTML 页面导入');
    const packed = packAipage(params.path, params.title);
    progress('已打包 ' + packed.fileCount + ' 个文件');
    const imported = await importBuffer(client, edition, packed.name, packed.data);
    imported.title = packed.title;
    return imported;
  }
  if (action === 'ocr_extract' || action === 'ocr_to_word' || action === 'ocr_to_excel') {
    personalOnly(edition, '图片文字识别（OCR）');
  }
  if (action === 'ocr_extract') {
    const image = requireImage(params.path, IMAGE_EXTS);
    const args = {
      image_base64: fs.readFileSync(image.path).toString('base64'),
      extract_type: ['basic', 'accurate', 'efficient'].includes(params.extract_type) ? params.extract_type : 'basic',
      with_positions: params.with_positions === true,
    };
    progress('正在识别 ' + image.name);
    const result = ensureOk('ocr.extract', await client.callTool('ocr.extract', args));
    return { text: resultText(result), data: result.structuredContent };
  }
  if (action === 'ocr_to_word' || action === 'ocr_to_excel') {
    const list = Array.isArray(params.paths) ? params.paths : (params.path ? [params.path] : []);
    if (list.length === 0) throw new WorkerError('INVALID_ARGS', 'paths 至少要有一张图片的完整路径。');
    if (list.length > MAX_IMAGE_COUNT) throw new WorkerError('INVALID_ARGS', '一次最多 ' + MAX_IMAGE_COUNT + ' 张图片。');
    const images = list.map((p) => requireImage(p, IMAGE_EXTS));
    const total = images.reduce((sum, img) => sum + img.size, 0);
    if (total > MAX_IMAGES_TOTAL) throw new WorkerError('INVALID_ARGS', '图片总大小超过 50MB。');
    const tool = action === 'ocr_to_word' ? 'ocr.toword' : 'ocr.toexcel';
    const args = { images: images.map((img) => ({ image_base64: fs.readFileSync(img.path).toString('base64') })) };
    if (typeof params.title === 'string' && params.title.trim()) args.title = params.title.trim();
    progress('正在处理 ' + images.length + ' 张图片');
    const result = ensureOk(tool, await client.callTool(tool, args));
    return { text: resultText(result), data: result.structuredContent };
  }
  if (action === 'upload_image') {
    const image = requireImage(params.path, UPLOAD_IMAGE_EXTS);
    // 企业版的同一操作带 manage. 前缀。
    const tool = edition === 'enterprise' ? 'manage.upload_image' : 'upload_image';
    const result = ensureOk(tool, await client.callTool(tool, {
      image_base64: fs.readFileSync(image.path).toString('base64'),
      file_name: image.name,
    }));
    return { text: resultText(result), data: result.structuredContent };
  }
  throw new WorkerError('INVALID_ARGS', '未知的 action：' + action + '。');
}

// ── 个人 Token：补充一键登录拿不到的管理权限 ─────────────────────────────

const PERSONAL_SERVICES = {
  main: 'https://docs.qq.com/openapi/mcp',
  doc: 'https://docs.qq.com/api/v6/doc/mcp',
  sheet: 'https://docs.qq.com/api/v6/sheet/mcp',
  slide: 'https://docs.qq.com/api/v6/slide/mcp',
};

function tokenHeaderCandidates(token) {
  const value = token.trim();
  if (/^bearer\s+/i.test(value)) return [value];
  // 开放平台的个人 Token 按说明原样放进 Authorization；不行再试 Bearer 写法。
  return [value, 'Bearer ' + value];
}

async function tokenCall(params, token) {
  const url = PERSONAL_SERVICES[params.service];
  if (!url) throw new WorkerError('INVALID_ARGS', '未知的服务：' + params.service);
  if (typeof params.tool !== 'string' || !params.tool) throw new WorkerError('INVALID_ARGS', '缺少操作名。');
  const candidates = tokenHeaderCandidates(token);
  for (let i = 0; i < candidates.length; i += 1) {
    const client = new McpClient(url, null, candidates[i]);
    try {
      // 先单独完成会话初始化：令牌写法不对会在这里被拒，不会执行任何操作。
      await client.initialize();
    } catch (error) {
      if (error && error.code === 'AUTH_REQUIRED' && i < candidates.length - 1) continue;
      if (error && error.code === 'AUTH_REQUIRED') {
        throw new WorkerError('TOKEN_INVALID', '腾讯文档个人 Token 无效或已过期。请到 https://docs.qq.com/open/auth/mcp.html 重新获取，并在 Cindy 侧边栏「插件」→「腾讯文档」详情页更新后再试。');
      }
      throw error;
    }
    try {
      const result = await client.callTool(params.tool, params.args && typeof params.args === 'object' ? params.args : {});
      return { result };
    } catch (error) {
      if (error && error.code === 'AUTH_REQUIRED') {
        throw new WorkerError('TOKEN_INVALID', '腾讯文档拒绝了个人 Token。请到 https://docs.qq.com/open/auth/mcp.html 重新获取，并在 Cindy 侧边栏「插件」→「腾讯文档」详情页更新后再试。');
      }
      throw error;
    }
  }
  throw new WorkerError('TOKEN_INVALID', '腾讯文档个人 Token 无效。');
}

async function handle(request) {
  if (request.method === 'personal/token-call') {
    const secrets = (request.cindy && request.cindy.secrets) || {};
    try {
      const token = secrets.personal_mcp_token;
      if (!token) throw new WorkerError('TOKEN_REQUIRED', '还没有填写腾讯文档个人 Token。');
      const result = await tokenCall(request.params || {}, token);
      send({ jsonrpc: '2.0', id: request.id, result });
    } catch (error) {
      const code = error && error.code ? error.code : 'WORKER_ERROR';
      send({ jsonrpc: '2.0', id: request.id, error: { code: -32000, message: (error && error.message) || '执行失败', data: { code } } });
    }
    return;
  }
  const match = /^(personal|enterprise)\/local$/.exec(request.method || '');
  if (!match) {
    send({ jsonrpc: '2.0', id: request.id, error: { code: -32601, message: 'Method not found' } });
    return;
  }
  const edition = match[1];
  const secrets = (request.cindy && request.cindy.secrets) || {};
  const token = secrets[EDITIONS[edition].secret];
  try {
    if (!token) throw new WorkerError('AUTH_REQUIRED', '还没有连接腾讯文档' + (edition === 'enterprise' ? '企业版' : '个人版') + '账号，请先在插件详情页连接。');
    const result = await runAction(edition, request.params || {}, token);
    send({ jsonrpc: '2.0', id: request.id, result });
  } catch (error) {
    const code = error && error.code ? error.code : 'WORKER_ERROR';
    const message = error && error.message ? error.message : '本机处理失败';
    send({ jsonrpc: '2.0', id: request.id, error: { code: -32000, message, data: { code } } });
  }
}

// 本地测试用环境变量关闭 stdin 监听，只导出纯函数；宿主运行时始终监听。
if (!process.env.TDOCS_WORKER_TEST) {
  readline.createInterface({ input: process.stdin }).on('line', (line) => {
    let request;
    try {
      request = JSON.parse(line);
    } catch (_err) {
      return;
    }
    if (request && request.id !== undefined) void handle(request);
  });
}

module.exports = { buildZip, packAipage, crc32, parseSse, handle };
