#!/usr/bin/env node
// NetLens MCP server.
//
// An MCP client (Claude Code, Claude Desktop, Cursor…) launches this over
// stdio. The extension can't be spawned by anyone, so it dials in instead: it
// connects to a WebSocket on 127.0.0.1 and answers the calls each tool makes.
//
//   AI client ──stdio/MCP──▶ this process ◀──ws://127.0.0.1──── NetLens
//
// stdout belongs to the MCP protocol; everything human-readable goes to
// stderr.

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');
const { z } = require('zod');
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const lib = require('./lib.js');
const { version } = require('./package.json');

const PORT = Number(process.env.NETLENS_MCP_PORT) || 17373;
const HOME = process.env.NETLENS_MCP_HOME || path.join(os.homedir(), '.netlens-mcp');
const TOKEN_FILE = path.join(HOME, 'token');
const CALL_TIMEOUT_MS = 35000; // the page-side replay gives up at 30s
const BIND_RETRY_MS = 5000;

const log = (...args) => console.error('[netlens-mcp]', ...args);

// ------------------------------------------------------------------- token

function loadToken() {
  if (process.env.NETLENS_MCP_TOKEN) return process.env.NETLENS_MCP_TOKEN.trim();
  try {
    const t = fs.readFileSync(TOKEN_FILE, 'utf8').trim();
    if (t) return t;
  } catch {}
  const t = crypto.randomBytes(24).toString('base64url');
  fs.mkdirSync(HOME, { recursive: true, mode: 0o700 });
  fs.writeFileSync(TOKEN_FILE, `${t}\n`, { mode: 0o600 });
  return t;
}

const TOKEN = loadToken();

if (process.argv.includes('--token')) {
  process.stdout.write(`${TOKEN}\n`);
  process.exit(0);
}

// --------------------------------------------------------------- extension

let ext = null;          // the authenticated extension socket, if any
let extInfo = null;      // what it said about itself in its hello
let bindError = null;    // why the port isn't ours, if it isn't
let nextCallId = 0;
const pending = new Map();

function listen() {
  const wss = new WebSocketServer({
    host: '127.0.0.1',
    port: PORT,
    maxPayload: 64 * 1024 * 1024,
    verifyClient: ({ origin }) => lib.originAllowed(origin),
  });
  wss.on('listening', () => {
    bindError = null;
    log(`waiting for the NetLens extension on ws://127.0.0.1:${PORT}`);
  });
  wss.on('error', (err) => {
    // Another MCP client already started its own copy of this server. Keep
    // serving MCP and take the port over once that copy exits.
    bindError = err.code === 'EADDRINUSE'
      ? `Port ${PORT} is held by another process (probably another NetLens MCP server started by a different AI client). Close that client, or set NETLENS_MCP_PORT here and the same port in NetLens settings.`
      : `Could not listen on port ${PORT}: ${err.message}`;
    log(bindError);
    wss.close();
    setTimeout(listen, BIND_RETRY_MS).unref();
  });
  wss.on('connection', onConnection);
}

function onConnection(ws) {
  let state = 'hello';
  let serverNonce = null;
  const fail = (why) => { log(`rejected extension: ${why}`); ws.close(4001, why); };
  const authTimer = setTimeout(() => fail('handshake timed out'), 10000);

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(String(raw)); } catch { return fail('bad json'); }
    if (state === 'hello') {
      if (msg.type !== 'hello' || typeof msg.nonce !== 'string') return fail('expected hello');
      serverNonce = lib.newNonce();
      ws.send(JSON.stringify({ type: 'hello', nonce: serverNonce, proof: lib.proof(TOKEN, 'server', msg.nonce), version }));
      extInfo = { version: msg.version, browser: msg.browser };
      state = 'auth';
      return;
    }
    if (state === 'auth') {
      if (msg.type !== 'auth' || !lib.safeEqual(msg.proof, lib.proof(TOKEN, 'client', serverNonce))) {
        return fail('token mismatch');
      }
      clearTimeout(authTimer);
      state = 'ready';
      // Newest connection wins: a reloaded extension reconnects before the
      // old socket notices it is dead.
      if (ext && ext !== ws) ext.close(4002, 'replaced');
      ext = ws;
      ws.send(JSON.stringify({ type: 'ready' }));
      log(`extension connected (NetLens ${extInfo.version || '?'})`);
      return;
    }
    if (msg.type === 'ping') { ws.send('{"type":"pong"}'); return; }
    if (msg.type === 'result' && pending.has(msg.id)) {
      const p = pending.get(msg.id);
      pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.ok) p.resolve(msg.result);
      else p.reject(new Error(msg.error || 'extension error'));
    }
  });

  ws.on('close', () => {
    clearTimeout(authTimer);
    if (ext !== ws) return;
    ext = null;
    log('extension disconnected');
    for (const [id, p] of pending) {
      clearTimeout(p.timer);
      p.reject(new Error('NetLens extension disconnected mid-call'));
      pending.delete(id);
    }
  });
}

function notConnectedMessage() {
  if (bindError) return bindError;
  return [
    'The NetLens extension is not connected.',
    'In the browser: open the NetLens side panel → Settings (gear) → "AI access (MCP)",',
    `turn it on, and paste this server's token (run \`node ${path.join(__dirname, 'server.js')} --token\`).`,
    `The port there must be ${PORT}. The extension retries about every 30 seconds.`,
  ].join(' ');
}

function callExtension(cmd, args = {}) {
  if (!ext) return Promise.reject(new Error(notConnectedMessage()));
  const id = ++nextCallId;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`NetLens did not answer "${cmd}" within ${CALL_TIMEOUT_MS / 1000}s`));
    }, CALL_TIMEOUT_MS);
    pending.set(id, { resolve, reject, timer });
    ext.send(JSON.stringify({ type: 'call', id, cmd, args }));
  });
}

// --------------------------------------------------------------------- MCP

const mcp = new McpServer(
  { name: 'netlens', version },
  {
    instructions: [
      'NetLens is a browser extension that records the fetch/XHR calls, WebSocket/SSE traffic and console logs of every open tab.',
      'Start with list_tabs, then list_requests to find calls, and get_request for full headers and bodies.',
      'Omitting tab_id means the active tab of the focused browser window.',
      'Credential headers (Authorization, Cookie, API keys) are redacted unless include_secrets is true; only ask for them when the user needs them.',
    ].join(' '),
  }
);

const text = (value) => ({ content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }] });

function tool(name, config, handler) {
  mcp.registerTool(name, config, async (args) => {
    try {
      return text(await handler(args || {}));
    } catch (err) {
      return { ...text(String((err && err.message) || err)), isError: true };
    }
  });
}

const tabIdArg = z.number().int().optional().describe('Browser tab id from list_tabs. Defaults to the active tab of the focused window.');

async function dump(tabId) {
  const res = await callExtension('dump', { tabId });
  return { tab: res.tab, buffer: res.buffer || [] };
}

async function findEntry(tabId, id) {
  const { tab, buffer } = await dump(tabId);
  const entry = lib.dedupe(buffer).find((d) => String(d.id) === String(id));
  if (!entry) {
    throw new Error(`No captured entry with id ${id} in tab ${tab ? tab.id : '?'}. NetLens keeps the last 200 entries per tab and drops them on reload; call list_requests for current ids.`);
  }
  return { tab, entry };
}

tool('list_tabs', {
  title: 'List browser tabs',
  description: 'List open browser tabs NetLens can see, with their ids, titles and URLs.',
  inputSchema: {},
  annotations: { readOnlyHint: true },
}, async () => callExtension('tabs'));

tool('list_requests', {
  title: 'List captured traffic',
  description: 'List what NetLens captured in a tab: fetch/XHR requests by default, or sockets/console logs. Returns compact summaries (id, method, URL, status, timing); use get_request for bodies and headers. The query searches URL, method, headers and request/response bodies, as plain text or /regex/flags.',
  inputSchema: {
    tab_id: tabIdArg,
    kind: z.enum(['requests', 'sockets', 'logs', 'all']).optional().describe('What to list. Default: requests (fetch + XHR).'),
    query: z.string().optional().describe('Substring or /regex/flags matched against URL, method, headers and bodies.'),
    method: z.string().optional().describe('HTTP method, e.g. POST.'),
    status: z.string().optional().describe('Exact status like "404", or a class like "4xx" / "5xx".'),
    errors_only: z.boolean().optional().describe('Only failed requests (status ≥ 400 or network error), or error-level logs.'),
    limit: z.number().int().min(1).max(200).optional().describe('Most recent N matches. Default 50.'),
  },
  annotations: { readOnlyHint: true },
}, async (a) => {
  const { tab, buffer } = await dump(a.tab_id);
  const { total, entries } = lib.filterEntries(buffer, {
    kind: a.kind, query: a.query, method: a.method, status: a.status, errorsOnly: a.errors_only, limit: a.limit,
  });
  return { tab, total, shown: entries.length, entries: entries.map(lib.summarize) };
});

tool('get_request', {
  title: 'Get a captured request',
  description: 'Full detail of one captured entry: request/response headers, bodies (JSON pretty-printed), timing, and a ready-to-run curl command. Also works for WebSocket frames and console logs.',
  inputSchema: {
    tab_id: tabIdArg,
    id: z.union([z.number(), z.string()]).describe('Entry id from list_requests.'),
    max_body_chars: z.number().int().min(100).max(2000000).optional().describe('Truncate each body to this many characters. Default 20000.'),
    include_secrets: z.boolean().optional().describe('Show Authorization/Cookie/API-key headers instead of redacting them. Default false.'),
  },
  annotations: { readOnlyHint: true },
}, async (a) => {
  const { tab, entry } = await findEntry(a.tab_id, a.id);
  return { tab, ...lib.detail(entry, { maxBodyChars: a.max_body_chars, includeSecrets: a.include_secrets }) };
});

tool('replay_request', {
  title: 'Replay a captured request',
  description: 'Re-send a captured request from inside the page, so it carries the page\'s real cookies and session, optionally with a changed URL, method, headers or body. This performs a live request as the signed-in user and can change data on the server. It is off unless the user has enabled "Allow replay" in NetLens settings.',
  inputSchema: {
    tab_id: tabIdArg,
    id: z.union([z.number(), z.string()]).describe('Entry id from list_requests to use as the template.'),
    url: z.string().optional().describe('Replacement URL.'),
    method: z.string().optional().describe('Replacement HTTP method.'),
    headers: z.record(z.string()).optional().describe('Headers merged over the original ones.'),
    body: z.string().optional().describe('Replacement request body.'),
    max_body_chars: z.number().int().min(100).max(2000000).optional(),
  },
  annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
}, async (a) => {
  const { tab, entry } = await findEntry(a.tab_id, a.id);
  if (entry.kind !== 'fetch' && entry.kind !== 'xhr') throw new Error('Only fetch/XHR requests can be replayed.');
  const req = {
    method: a.method || entry.method,
    url: a.url || entry.url,
    headers: { ...(entry.requestHeaders || {}), ...(a.headers || {}) },
    body: a.body !== undefined ? a.body : entry.requestBody,
    credentials: entry.credentials || undefined,
    mode: entry.mode || undefined,
    redirect: entry.redirect || undefined,
  };
  const res = await callExtension('replay', { tabId: tab && tab.id, req });
  if (!res || !res.ok) throw new Error((res && res.error) || 'Replay failed');
  const shaped = lib.detail({ ...res, id: `replay-of-${entry.id}`, kind: 'fetch', startedAt: Date.now() }, { maxBodyChars: a.max_body_chars });
  delete shaped.curl;
  return { tab, original: { id: entry.id, status: entry.status }, replay: shaped };
});

tool('get_page_styles', {
  title: 'Get page fonts and colours',
  description: 'Scan a tab\'s page for the fonts and colours in use, with usage counts and the sizes and weights each font family appears at.',
  inputSchema: { tab_id: tabIdArg },
  annotations: { readOnlyHint: true },
}, async (a) => callExtension('pagestyles', { tabId: a.tab_id }));

tool('netlens_status', {
  title: 'NetLens connection status',
  description: 'Whether the NetLens browser extension is connected to this server, and how to connect it if not.',
  inputSchema: {},
  annotations: { readOnlyHint: true },
}, async () => (ext
  ? { connected: true, extensionVersion: extInfo && extInfo.version, browser: extInfo && extInfo.browser, port: PORT }
  : { connected: false, port: PORT, help: notConnectedMessage() }));

// -------------------------------------------------------------------- main

listen();
mcp.connect(new StdioServerTransport()).catch((err) => {
  log('failed to start MCP transport:', err);
  process.exit(1);
});
log(`token file: ${process.env.NETLENS_MCP_TOKEN ? '(from NETLENS_MCP_TOKEN)' : TOKEN_FILE}`);
