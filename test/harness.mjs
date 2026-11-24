// 本地验收：模拟个人版 / 企业版各 4 个 MCP 服务与腾讯云上传地址，
// 用模拟 cindy 宿主运行 main.js，用真实子进程运行 node/worker.cjs。不访问网络。
// 用法：node test/harness.mjs（需要 Node 20 或更高版本）
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import zlib from 'node:zlib';
import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const pluginDir = process.argv[2] || path.resolve(here, '..');
const mainSource = fs.readFileSync(path.join(pluginDir, 'main.js'), 'utf8');

// ── 模拟服务 ──────────────────────────────────────────────────────────
const WB_SUFFIX = ' if both tencent-docs (personal) and tencent-docs-oa (enterprise) are connected, use AskUserQuestion to let the user pick the target account before invoking this tool.';
const obj = (props, required = []) => ({ type: 'object', properties: props, required });
const S = { type: 'string' };
const personalMain = [
  { name: 'manage.delete_file', description: '删除', inputSchema: obj({ file_id: S }, ['file_id']) },
  { name: 'manage.query_file_info', description: '文档信息', inputSchema: obj({ file_id: S, fail: { type: 'boolean' } }, ['file_id']) },
  { name: 'manage.pre_import', description: '预导入', inputSchema: obj({ file_name: S, file_size: { type: 'integer' }, file_md5: S }) },
  { name: 'manage.async_import', description: '导入', inputSchema: obj({}) },
  { name: 'manage.import_progress', description: '导入进度', inputSchema: obj({ task_id: S }, ['task_id']) },
  { name: 'get_content', description: '读正文', inputSchema: obj({ file_id: S }, ['file_id']) },
  { name: 'upload_image', description: '上传图片', inputSchema: obj({ image_base64: S, file_name: S }, ['image_base64', 'file_name']) },
  { name: 'doc.insert_text', description: '主服务转发版插入文字', inputSchema: obj({ file_id: S }) },
  { name: 'doc.ai_format_pure_text', description: '排版', inputSchema: obj({ title: S, xml: S, scenario: S }, ['title', 'xml', 'scenario']) },
  { name: 'sheet.set_cell_value', description: '主服务转发版写单元格', inputSchema: obj({ file_id: S }) },
  { name: 'slide_add_text', description: '主服务转发版加文字', inputSchema: obj({}) },
  { name: 'smartsheet.list_tables', description: '列出工作表', inputSchema: obj({ file_id: S }, ['file_id']) },
  { name: 'smartsheet.commit_changeset', description: '内部', inputSchema: obj({}) },
  { name: 'smartsheet.show_ui', description: '内部界面', inputSchema: obj({}) },
  { name: 'report_unsupported_feature', description: '上报', inputSchema: obj({ feature: S }, ['feature']) },
  { name: 'ocr.extract', description: 'OCR', inputSchema: obj({ image_base64: S }) },
  { name: 'create_smartcanvas_by_mdx', description: '新建智能文档' + WB_SUFFIX, inputSchema: obj({ title: S, mdx: S }, ['title', 'mdx']) },
];
const docTools = [
  { name: 'insert_text', description: 'Word 专用服务插入文字', inputSchema: obj({ file_id: S, idx: { type: 'integer' }, text: S }, ['file_id', 'text']) },
  { name: 'insert_markdown', description: 'Word 插入 Markdown', inputSchema: obj({ file_id: S, markdown: S }, ['file_id', 'markdown']) },
  { name: 'create_with_markdown', description: '用 base64 Markdown 新建', inputSchema: obj({ base64_markdown: S, title: S }, ['base64_markdown']) },
];
const sheetTools = [
  { name: 'set_cell_value', description: '表格专用服务写单元格', inputSchema: obj({ file_id: S }, ['file_id']) },
  { name: 'set_range_value', description: '批量写', inputSchema: obj({ file_id: S }, ['file_id']) },
];
const slideTools = [
  { name: 'slide_add_text', description: '幻灯片专用服务加文字', inputSchema: obj({}) },
  { name: 'slide_add_texts', description: '批量加文字', inputSchema: obj({}) },
];
const saasMain = [
  { name: 'manage.get_content', description: '读正文', inputSchema: obj({ file_id: S }, ['file_id']) },
  { name: 'manage.upload_image', description: '上传图片', inputSchema: obj({ image_base64: S, file_name: S }) },
  { name: 'manage.apply_upload', description: '申请上传', inputSchema: obj({ file_name: S, file_size: { type: 'integer' }, file_md5: S }, ['file_name', 'file_size']) },
  { name: 'manage.complete_upload', description: '完成上传', inputSchema: obj({ obj_key: S, task_id: S, file_name: S }, ['obj_key', 'task_id']) },
  { name: 'manage.query_task', description: '查任务', inputSchema: obj({ task_id: S }, ['task_id']) },
];
const SERVICES = {
  personal: { '/openapi/mcp': ['main', personalMain], '/api/v6/doc/mcp': ['doc', docTools], '/api/v6/sheet/mcp': ['sheet', sheetTools], '/api/v6/slide/mcp': ['slide', slideTools] },
  saas: { '/api/v6/open/agent/mcp': ['main', saasMain], '/api/v6/doc/mcp': ['doc', docTools], '/api/v6/sheet/mcp': ['sheet', sheetTools], '/api/v6/slide/mcp': ['slide', slideTools] },
};
const TOKENS = { personal: 'Bearer personal-token', saas: 'Bearer saas-token' };
const state = { sessions: new Set(), seq: 0, log: [], uploads: {}, progressCalls: 0, failSheet: false, tokenValue: null, acceptedPersonal: new Set(['Bearer personal-token']) };

function sse(res, messages) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  const text = messages.map((m) => 'data: ' + JSON.stringify(m) + '\n\n').join('');
  let i = 0;
  const step = () => { if (i >= text.length) { res.end(); return; } res.write(text.slice(i, i + 11)); i += 11; setImmediate(step); };
  step();
}
const ok = (data) => ({ content: [{ type: 'text', text: JSON.stringify(data) }], structuredContent: data });

function callTool(edition, service, name, args) {
  if (name === 'manage.query_file_info' && args.fail) return { isError: true, content: [{ type: 'text', text: '{"error":"type mismatch","code":400016}' }] };
  if (name === 'manage.pre_import') return ok({ upload_url: 'https://cos.example.test/upload/k1', file_key: 'k1', task_id: 't1' });
  if (name === 'manage.async_import') return ok({ task_id: 't1', received: args });
  if (name === 'manage.import_progress') { state.progressCalls += 1; return ok(state.progressCalls < 2 ? { progress: 50 } : { progress: 100, file_url: 'https://docs.qq.com/doc/abc', file_id: 'abc' }); }
  if (name === 'manage.apply_upload') return ok({ upload_url: 'https://cos.example.test/upload/k2', obj_key: 'k2', task_id: 't2', received: args });
  if (name === 'manage.complete_upload') return ok({ task_id: 't2', received: args });
  if (name === 'manage.query_task') return ok({ status: 'done', url: 'https://saas.docs.qq.com/doc/x' });
  if (name === 'ocr.extract') return ok({ texts: ['hello'], base64Length: (args.image_base64 || '').length });
  if (name === 'upload_image' || name === 'manage.upload_image') return ok({ image_id: 'img-' + edition });
  return { content: [{ type: 'text', text: 'OK ' + edition + '/' + service + '/' + name + ' ' + JSON.stringify(args) }] };
}

const server = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const body = Buffer.concat(chunks);
    const url = new URL(req.url, 'http://x');
    if (url.pathname.startsWith('/cos/')) {
      state.uploads[url.pathname] = body;
      res.writeHead(200); res.end(); return;
    }
    const edition = url.pathname.startsWith('/saas') ? 'saas' : 'personal';
    const svcPath = url.pathname.replace(/^\/(saas|personal)/, '');
    const svc = SERVICES[edition][svcPath];
    if (!svc) { res.writeHead(404); res.end('no'); return; }
    const [service, tools] = svc;
    const msg = JSON.parse(body.toString('utf8'));
    state.log.push({ edition, service, method: msg.method, tool: msg.params && msg.params.name, args: msg.params && msg.params.arguments, auth: req.headers.authorization, sid: req.headers['mcp-session-id'] });
    const authOk = edition === 'personal' ? state.acceptedPersonal.has(req.headers.authorization) : req.headers.authorization === TOKENS[edition];
    if (!authOk) { res.writeHead(401, { 'Content-Type': 'application/json' }); res.end('{"error":"invalid_token"}'); return; }
    if (service === 'sheet' && state.failSheet) { res.writeHead(500); res.end('boom'); return; }
    if (msg.method === 'initialize') {
      const sid = 'sid-' + (++state.seq);
      state.sessions.add(sid);
      res.writeHead(200, { 'Content-Type': 'application/json', 'Mcp-Session-Id': sid });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2025-06-18', capabilities: {}, serverInfo: { name: service } } }));
      return;
    }
    const sid = req.headers['mcp-session-id'];
    if (!state.sessions.has(sid)) { res.writeHead(404); res.end('session not found'); return; }
    if (msg.method === 'notifications/initialized') { res.writeHead(202); res.end(); return; }
    if (msg.method === 'tools/list') { sse(res, [{ jsonrpc: '2.0', id: msg.id, result: { tools } }]); return; }
    if (msg.method === 'tools/call' && msg.params.name === 'manage.delete_file' && req.headers.authorization === 'Bearer personal-token') {
      sse(res, [{ jsonrpc: '2.0', id: msg.id, error: { code: -32000, message: 'insufficient_scope: tool manage.delete_file requires scope docs:manage' } }]);
      return;
    }
    if (msg.method === 'tools/call') {
      sse(res, [{ jsonrpc: '2.0', method: 'notifications/progress', params: {} }, { jsonrpc: '2.0', id: msg.id, result: callTool(edition, service, msg.params.name, msg.params.arguments || {}) }]);
      return;
    }
    res.writeHead(400); res.end('bad');
  });
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = 'http://127.0.0.1:' + server.address().port;

// ── 真实 Node 工作进程（宿主注入令牌） ─────────────────────────────────
const worker = spawn(process.execPath, ['--require', path.join(here, 'redirect.cjs'), path.join(pluginDir, 'node', 'worker.cjs')], {
  env: Object.assign({}, process.env, { TDOCS_MOCK_BASE: base }),
  stdio: ['pipe', 'pipe', 'inherit'],
});
const pendingNode = new Map();
const nodeNotifications = [];
let nodeSeq = 0;
let stdoutBuf = '';
worker.stdout.on('data', (chunk) => {
  stdoutBuf += chunk;
  let idx;
  while ((idx = stdoutBuf.indexOf('\n')) >= 0) {
    const line = stdoutBuf.slice(0, idx); stdoutBuf = stdoutBuf.slice(idx + 1);
    const msg = JSON.parse(line);
    if (msg.id !== undefined && pendingNode.has(msg.id)) { pendingNode.get(msg.id)(msg); pendingNode.delete(msg.id); }
    else if (msg.method) nodeNotifications.push(msg);
  }
});
const BINDINGS = { 'personal/local': { personal_token: 'personal-token' }, 'enterprise/local': { enterprise_token: 'saas-token' } };
const bindingsFor = (method) => method === 'personal/token-call' ? (state.tokenValue ? { personal_mcp_token: state.tokenValue } : {}) : (BINDINGS[method] || {});
function nodeRequest(req) {
  const id = ++nodeSeq;
  return new Promise((resolve) => {
    pendingNode.set(id, (msg) => resolve(msg.error ? { ok: false, errorCode: 'PROTOCOL_ERROR', message: msg.error.message, data: msg.error.data } : { ok: true, result: msg.result }));
    worker.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method: req.method, params: req.params, cindy: { secrets: bindingsFor(req.method) } }) + '\n');
  });
}

// ── 模拟 cindy 宿主 ─────────────────────────────────────────────────
const KEEP = ['content-type', 'mcp-session-id'];
function makePlugin(oauthKeys) {
  const sent = [];
  const streams = new Map();
  const nodeCalls = [];
  let streamSeq = 0;
  let handler = null;
  async function hostFetch(req) {
    const u = new URL(req.url);
    assert.ok(['docs.qq.com', 'saas.docs.qq.com'].includes(u.hostname), '只应请求腾讯文档域名：' + req.url);
    const edition = u.hostname === 'saas.docs.qq.com' ? 'saas' : 'personal';
    const headers = {};
    for (const [k, v] of Object.entries(req.headers || {})) if (k.toLowerCase() !== 'authorization') headers[k] = v;
    headers.Authorization = TOKENS[edition];
    const response = await fetch(base + '/' + edition + u.pathname, { method: req.method, headers, body: req.body });
    const outHeaders = {};
    for (const k of KEEP) { const v = response.headers.get(k); if (v !== null) outHeaders[k] = v; }
    if (req.as === 'stream') {
      const id = 'c' + (++streamSeq);
      const entry = { events: [], closed: false };
      streams.set(id, entry);
      (async () => { const reader = response.body.getReader(); const dec = new TextDecoder(); for (;;) { const { done, value } = await reader.read(); if (done) break; entry.events.push({ type: 'text', data: dec.decode(value, { stream: true }) }); } entry.closed = true; })();
      return { ok: true, status: response.status, headers: outHeaders, connectionId: id };
    }
    return { ok: true, status: response.status, headers: outHeaders, body: await response.text() };
  }
  const cindy = {
    onHostMessage(fn) { handler = fn; },
    async send(msg) { sent.push(msg); return { ok: true }; },
    fetch: hostFetch,
    network: {
      async read({ connectionId, cursor }) {
        const entry = streams.get(connectionId);
        for (let i = 0; i < 200 && entry.events.length <= cursor && !entry.closed; i += 1) await new Promise((r) => setTimeout(r, 5));
        const events = entry.events.slice(cursor);
        return { ok: true, events, nextCursor: cursor + events.length, closed: entry.closed && cursor + events.length >= entry.events.length };
      },
      async close({ connectionId }) { streams.delete(connectionId); return { ok: true }; },
    },
    node: { request: async (req) => { nodeCalls.push(req); return nodeRequest(req); } },
  };
  const pageFetch = async (url) => {
    assert.equal(url, '/oauth');
    const list = ['tencent_docs_account', 'tencent_docs_saas_account'].map((key) => ({ key, accounts: oauthKeys.includes(key) ? [{ id: 'a1', status: 'connected' }] : [] }));
    return { ok: true, json: async () => list };
  };
  const context = vm.createContext({ cindy, fetch: pageFetch, TextEncoder, btoa, console, setTimeout, clearTimeout, setInterval, clearInterval, Promise, Date });
  vm.runInContext(mainSource, context, { filename: 'main.js' });
  let callSeq = 0;
  return {
    sent, nodeCalls,
    async call(tool, args) {
      const callId = 'call-' + (++callSeq);
      await handler({ type: 'tool-call', tool, args, callId });
      const result = sent.filter((m) => m.type === 'tool-result' && m.callId === callId);
      assert.equal(result.length, 1, '每次调用恰好交卷一次');
      return result[0];
    },
  };
}

function unzip(buffer) {
  const files = {};
  const eocd = buffer.length - 22;
  assert.equal(buffer.readUInt32LE(eocd), 0x06054b50, 'zip 结尾记录');
  const count = buffer.readUInt16LE(eocd + 10);
  let p = buffer.readUInt32LE(eocd + 16);
  for (let i = 0; i < count; i += 1) {
    assert.equal(buffer.readUInt32LE(p), 0x02014b50);
    const method = buffer.readUInt16LE(p + 10);
    const csize = buffer.readUInt32LE(p + 20);
    const nameLen = buffer.readUInt16LE(p + 28);
    const local = buffer.readUInt32LE(p + 42);
    const name = buffer.slice(p + 46, p + 46 + nameLen).toString('utf8');
    const localNameLen = buffer.readUInt16LE(local + 26);
    const data = buffer.slice(local + 30 + localNameLen, local + 30 + localNameLen + csize);
    files[name] = method === 8 ? zlib.inflateRawSync(data) : data;
    p += 46 + nameLen;
  }
  return files;
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tdocs-'));
const results = [];
async function check(name, fn) {
  try { await fn(); results.push(['PASS', name]); } catch (e) { results.push(['FAIL', name, e && e.stack ? e.stack.split('\n').slice(0, 3).join(' | ') : String(e)]); }
}

const personalOnly = makePlugin(['tencent_docs_account']);

await check('合并四个服务：专用服务的操作替换主服务转发版，隐藏内部操作', async () => {
  const r = await personalOnly.call('list_tools', {});
  assert.equal(r.ok, true, r.message);
  assert.equal(r.result.edition, 'personal');
  assert.deepEqual(Object.keys(r.result.services).sort(), ['doc', 'main', 'sheet', 'slide']);
  assert.equal(r.result.services.main.replacedByEngine, 3);
  const names = new Set();
  for (const c of r.result.categories) for (const e of c.examples) names.add(e);
  const doc = await personalOnly.call('list_tools', { category: 'doc' });
  const docNames = Array.from(doc.result.tools, (t) => t.name).sort();
  assert.deepEqual(docNames, ['doc.ai_format_pure_text', 'doc.create_with_markdown', 'doc.insert_markdown', 'doc.insert_text']);
  assert.equal(doc.result.tools.find((t) => t.name === 'doc.insert_text').description, 'Word 专用服务插入文字');
  const fmt = doc.result.tools.find((t) => t.name === 'doc.ai_format_pure_text');
  assert.equal(fmt.forwarded, true);
  assert.ok(fmt.rules.includes('prefer_engine'));
  const ss = await personalOnly.call('list_tools', { category: 'smartsheet' });
  assert.deepEqual(Array.from(ss.result.tools, (t) => t.name), ['smartsheet.list_tables']);
  const other = await personalOnly.call('list_tools', { category: 'smartcanvas' });
  assert.doesNotMatch(other.result.tools[0].description, /AskUserQuestion/);
});

await check('Word 操作走 Word 专用服务，用原始操作名', async () => {
  const before = state.log.length;
  const r = await personalOnly.call('call_tool', { name: 'doc.insert_text', args: { file_id: 'f1', text: 'hi' } });
  assert.equal(r.ok, true, r.message);
  assert.match(r.result.text, /^OK personal\/doc\/insert_text /);
  const sent = state.log.slice(before).filter((e) => e.method === 'tools/call');
  assert.equal(sent.length, 1);
  assert.equal(sent[0].service, 'doc');
  assert.equal(sent[0].tool, 'insert_text');
});

await check('base64 参数可以直接传明文，由插件编码', async () => {
  const md = '# 标题\n\n中文内容 ✅';
  const r = await personalOnly.call('call_tool', { name: 'doc.create_with_markdown', args: { title: 't', markdown: md } });
  assert.equal(r.ok, true, r.message);
  const sent = state.log.filter((e) => e.tool === 'create_with_markdown').pop();
  assert.equal(Buffer.from(sent.args.base64_markdown, 'base64').toString('utf8'), md);
  assert.equal(sent.args.markdown, undefined);
  const doc = await personalOnly.call('list_tools', { category: 'doc' });
  assert.ok(doc.result.tools.find((t) => t.name === 'doc.create_with_markdown').rules.includes('base64_params'));
});

await check('被隐藏的内部操作不能执行', async () => {
  const r = await personalOnly.call('call_tool', { name: 'smartsheet.commit_changeset', args: {} });
  assert.equal(r.errorCode, 'UNKNOWN_TOOL');
});

await check('腾讯文档业务错误码附带处理提示', async () => {
  const r = await personalOnly.call('call_tool', { name: 'manage.query_file_info', args: { file_id: 'f', fail: true } });
  assert.equal(r.errorCode, 'TOOL_ERROR');
  assert.match(r.message, /文档类型和所用操作不匹配/);
});

await check('专用服务会话过期后自动重建', async () => {
  state.sessions.clear();
  const r = await personalOnly.call('call_tool', { name: 'doc.insert_markdown', args: { file_id: 'f', markdown: '# x' } });
  assert.equal(r.ok, true, r.message);
});

await check('某个专用服务不可用时退回主服务转发版并标明原因', async () => {
  state.failSheet = true;
  const p = makePlugin(['tencent_docs_account']);
  const r = await p.call('list_tools', {});
  assert.equal(r.result.services.sheet.available, false);
  const sheet = await p.call('list_tools', { category: 'sheet' });
  const t = sheet.result.tools.find((x) => x.name === 'sheet.set_cell_value');
  assert.equal(t.description, '主服务转发版写单元格');
  assert.equal(t.forwarded, undefined);
  state.failSheet = false;
});

const both = makePlugin(['tencent_docs_account', 'tencent_docs_saas_account']);
await check('两个版本都连接时要求先选版本', async () => {
  const r = await both.call('list_tools', {});
  assert.equal(r.errorCode, 'EDITION_REQUIRED');
  const r2 = await both.call('call_tool', { name: 'manage.get_content', args: { file_id: 'x' } });
  assert.equal(r2.errorCode, 'EDITION_REQUIRED');
});

await check('指定企业版时请求发往 saas.docs.qq.com', async () => {
  const before = state.log.length;
  const r = await both.call('call_tool', { name: 'manage.get_content', args: { file_id: 'x' }, edition: 'enterprise' });
  assert.equal(r.ok, true, r.message);
  assert.match(r.result.text, /^OK saas\/main\/manage\.get_content/);
  assert.ok(state.log.slice(before).every((e) => e.edition === 'saas'));
  const list = await both.call('list_tools', { category: 'common', edition: 'enterprise' });
  assert.deepEqual(Array.from(list.result.tools, (t) => t.name).sort(), ['manage.get_content', 'manage.upload_image']);
});

await check('指定了没连接的版本时给出指引', async () => {
  const r = await personalOnly.call('list_tools', { edition: 'enterprise' });
  assert.equal(r.errorCode, 'EDITION_NOT_CONNECTED');
});

await check('缺管理权限时改用个人 Token 重发一次（Token 原样放进请求头）', async () => {
  state.tokenValue = 'tok-123';
  state.acceptedPersonal.add('tok-123');
  await personalOnly.call('call_tool', { name: 'manage.query_file_info', args: { file_id: 'warm' } });
  const before = state.log.length;
  const r = await personalOnly.call('call_tool', { name: 'manage.delete_file', args: { file_id: 'f9' } });
  assert.equal(r.ok, true, r.message);
  assert.equal(r.result.via, 'personal-token');
  const deletes = state.log.slice(before).filter((e) => e.tool === 'manage.delete_file');
  assert.equal(deletes.length, 2);
  assert.equal(deletes[0].auth, 'Bearer personal-token');
  assert.equal(deletes[1].auth, 'tok-123');
  assert.equal(personalOnly.nodeCalls.pop().method, 'personal/token-call');
});

await check('个人 Token 需要 Bearer 写法时自动换写法，不会重复执行', async () => {
  state.tokenValue = 'tok-bearer';
  state.acceptedPersonal.add('Bearer tok-bearer');
  const before = state.log.length;
  const r = await personalOnly.call('call_tool', { name: 'manage.delete_file', args: { file_id: 'f8' } });
  assert.equal(r.ok, true, r.message);
  const deletes = state.log.slice(before).filter((e) => e.tool === 'manage.delete_file');
  assert.deepEqual(deletes.map((e) => e.auth), ['Bearer personal-token', 'Bearer tok-bearer']);
});

await check('没填个人 Token 时说明怎么补上管理权限', async () => {
  state.tokenValue = null;
  const r = await personalOnly.call('call_tool', { name: 'manage.delete_file', args: { file_id: 'f7' } });
  assert.equal(r.errorCode, 'SCOPE_REQUIRED');
  assert.match(r.message, /docs\.qq\.com\/open\/auth\/mcp\.html/);
});

await check('个人 Token 无效时提示重新获取', async () => {
  state.tokenValue = 'tok-wrong';
  const r = await personalOnly.call('call_tool', { name: 'manage.delete_file', args: { file_id: 'f6' } });
  assert.equal(r.errorCode, 'TOKEN_INVALID');
  state.tokenValue = null;
});

// ── 本机文件 ─────────────────────────────────────────────────────────
const docx = path.join(tmp, '季度报告.docx');
fs.writeFileSync(docx, Buffer.from('fake-docx-bytes-' + 'x'.repeat(5000)));

await check('本机文件导入（个人版）：申请地址、上传原文件、触发导入并等到完成', async () => {
  state.progressCalls = 0;
  const r = await personalOnly.call('local_files', { action: 'import_file', path: docx });
  assert.equal(r.ok, true, r.message);
  assert.equal(r.result.status, 'done');
  assert.equal(r.result.result.file_url, 'https://docs.qq.com/doc/abc');
  assert.deepEqual(state.uploads['/cos/upload/k1'], fs.readFileSync(docx));
  const asyncCall = state.log.filter((e) => e.tool === 'manage.async_import').pop();
  assert.equal(asyncCall.args.file_name, '季度报告.docx');
  assert.equal(asyncCall.args.file_size, String(fs.statSync(docx).size));
  assert.equal(personalOnly.nodeCalls.pop().method, 'personal/local');
});

await check('HTML 导入：入口改名 index.html、带上 assets、生成两个清单文件', async () => {
  const site = path.join(tmp, 'site');
  fs.mkdirSync(path.join(site, 'assets'), { recursive: true });
  fs.writeFileSync(path.join(site, '邀请函.html'), '<html><head><title>年会邀请</title></head><body>hi</body></html>');
  fs.writeFileSync(path.join(site, 'assets', 'a.css'), 'body{color:red}');
  fs.writeFileSync(path.join(site, 'assets', '.DS_Store'), 'junk');
  state.progressCalls = 0;
  const r = await personalOnly.call('local_files', { action: 'import_html', path: path.join(site, '邀请函.html') });
  assert.equal(r.ok, true, r.message);
  assert.equal(r.result.title, '年会邀请');
  const pre = state.log.filter((e) => e.tool === 'manage.pre_import').pop();
  assert.equal(pre.args.file_name, '年会邀请.aipage');
  const files = unzip(state.uploads['/cos/upload/k1']);
  assert.deepEqual(Object.keys(files).sort(), ['assets/a.css', 'index.html', 'janus.manifest.json', 'manifest.json']);
  assert.equal(JSON.parse(files['manifest.json']).title, '年会邀请');
  assert.equal(JSON.parse(files['manifest.json']).entry, 'index.html');
  assert.equal(files['janus.manifest.json'].toString(), '{"version":"1.0.0","render_engine":"native","scene":""}');
  assert.match(files['index.html'].toString(), /年会邀请/);
});

await check('OCR：本机图片由 Node 进程转码后发送', async () => {
  const img = path.join(tmp, 'a.png');
  const bytes = Buffer.alloc(300000, 7);
  fs.writeFileSync(img, bytes);
  const r = await personalOnly.call('local_files', { action: 'ocr_extract', path: img, extract_type: 'accurate' });
  assert.equal(r.ok, true, r.message);
  assert.equal(r.result.data.base64Length, bytes.toString('base64').length);
  const call = state.log.filter((e) => e.tool === 'ocr.extract').pop();
  assert.equal(call.args.extract_type, 'accurate');
});

await check('企业版没有 OCR 时明确拒绝', async () => {
  const r = await both.call('local_files', { action: 'ocr_extract', path: path.join(tmp, 'a.png'), edition: 'enterprise' });
  assert.equal(r.ok, false);
  assert.equal(r.errorCode, 'UNSUPPORTED');
  assert.match(r.message, /企业版不提供图片文字识别/);
});

await check('企业版导入：按服务端 schema 填参数，走 apply/complete/query', async () => {
  const r = await both.call('local_files', { action: 'import_file', path: docx, edition: 'enterprise' });
  assert.equal(r.ok, true, r.message);
  assert.equal(r.result.status, 'done');
  const apply = state.log.filter((e) => e.tool === 'manage.apply_upload').pop();
  assert.equal(apply.edition, 'saas');
  assert.equal(apply.args.file_size, fs.statSync(docx).size);
  assert.equal(typeof apply.args.file_size, 'number');
  const complete = state.log.filter((e) => e.tool === 'manage.complete_upload').pop();
  assert.equal(complete.args.obj_key, 'k2');
  assert.equal(complete.args.task_id, 't2');
  assert.deepEqual(state.uploads['/cos/upload/k2'], fs.readFileSync(docx));
  assert.equal(both.nodeCalls.pop().method, 'enterprise/local');
});

await check('上传图片：企业版用 manage.upload_image', async () => {
  const r = await both.call('local_files', { action: 'upload_image', path: path.join(tmp, 'a.png'), edition: 'enterprise' });
  assert.equal(r.ok, true, r.message);
  assert.equal(r.result.data.image_id, 'img-saas');
});

await check('找不到本机文件时给出明确原因', async () => {
  const r = await personalOnly.call('local_files', { action: 'import_file', path: path.join(tmp, 'nope.docx') });
  assert.equal(r.ok, false);
  assert.equal(r.errorCode, 'FILE_NOT_FOUND');
  assert.match(r.message, /找不到文件/);
});

await check('没给路径时在调用 Node 之前就拒绝', async () => {
  const before = personalOnly.nodeCalls.length;
  const r = await personalOnly.call('local_files', { action: 'import_file' });
  assert.equal(r.errorCode, 'INVALID_ARGS');
  assert.equal(personalOnly.nodeCalls.length, before);
});

worker.kill();
server.close();
fs.rmSync(tmp, { recursive: true, force: true });
for (const r of results) console.log(r.join(' | '));
const failed = results.filter((r) => r[0] === 'FAIL').length;
console.log(failed ? failed + ' FAILED' : 'ALL PASSED (' + results.length + ')');
setTimeout(() => process.exit(failed ? 1 : 0), 50);
