// End-to-end check: starts the real server, plays the extension's side of
// the WebSocket handshake with a fake capture buffer, and drives the tools
// through a real MCP client.

const assert = require('assert');
const os = require('os');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const WebSocket = require('ws');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');

const PORT = 17000 + Math.floor(Math.random() * 1000);
const TOKEN = 'test-token';
const hmac = (role, nonce) => crypto.createHmac('sha256', TOKEN).update(`${role}:${nonce}`).digest('hex');

const TAB = { id: 7, title: 'Transfers', url: 'https://app.test/', active: true };
const BUFFER = [
  { id: 1, kind: 'fetch', method: 'POST', url: 'https://app.test/api/transfer/search', status: 200, startedAt: 1,
    requestHeaders: { authorization: 'Bearer secret' }, requestBody: '{"to":"Dubai Mall"}',
    responseHeaders: {}, responseBody: '{"dropoff":{"address":{"line":"Dubai (center)"}}}' },
  { id: 2, kind: 'fetch', method: 'GET', url: 'https://app.test/api/me', status: 401, startedAt: 2 },
];

function connectFakeExtension(origin, token = TOKEN) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}`, { origin });
    const nonce = crypto.randomBytes(8).toString('hex');
    ws.on('open', () => ws.send(JSON.stringify({ type: 'hello', nonce, version: 'test' })));
    ws.on('error', reject);
    ws.on('close', (code) => resolve({ ws, closed: code }));
    ws.on('message', (raw) => {
      const msg = JSON.parse(String(raw));
      if (msg.type === 'hello') {
        assert.strictEqual(msg.proof, hmac('server', nonce), 'server must prove it knows the token');
        const p = crypto.createHmac('sha256', token).update(`client:${msg.nonce}`).digest('hex');
        ws.send(JSON.stringify({ type: 'auth', proof: p }));
      } else if (msg.type === 'ready') {
        resolve({ ws });
      } else if (msg.type === 'call') {
        let result;
        if (msg.cmd === 'tabs') result = [TAB];
        else if (msg.cmd === 'dump') result = { tab: TAB, buffer: BUFFER };
        else if (msg.cmd === 'replay') {
          ws.send(JSON.stringify({ type: 'result', id: msg.id, ok: false, error: 'Replay is turned off.' }));
          return;
        }
        ws.send(JSON.stringify({ type: 'result', id: msg.id, ok: true, result }));
      }
    });
  });
}

const waitFor = async (fn) => {
  for (let i = 0; i < 50; i++) {
    try { return await fn(); } catch (err) { if (i === 49) throw err; }
    await new Promise((r) => setTimeout(r, 100));
  }
};

(async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'netlens-mcp-'));
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(__dirname, 'server.js')],
    env: { ...process.env, NETLENS_MCP_PORT: String(PORT), NETLENS_MCP_TOKEN: TOKEN, NETLENS_MCP_HOME: home },
    stderr: 'ignore',
  });
  const client = new Client({ name: 'test', version: '0' });
  await client.connect(transport);
  const call = async (name, args = {}) => {
    const res = await client.callTool({ name, arguments: args });
    return { ...res, body: res.content[0].text };
  };

  try {
    const { tools } = await client.listTools();
    assert.deepStrictEqual(tools.map((t) => t.name).sort(),
      ['get_page_styles', 'get_request', 'list_requests', 'list_tabs', 'netlens_status', 'replay_request']);

    // Before the extension connects, tools explain how to connect it.
    const early = await call('list_requests');
    assert.ok(early.isError && /not connected/.test(early.body));

    // A website can't connect, and neither can someone with the wrong token.
    await waitFor(async () => {
      const r = await connectFakeExtension('https://evil.example').catch((e) => ({ err: e }));
      assert.ok(r.err && /Unexpected server response: 40[13]/.test(String(r.err.message)), 'website origin must be refused');
    });
    const wrong = await connectFakeExtension('chrome-extension://abc', 'nope');
    assert.strictEqual(wrong.closed, 4001);

    const { ws } = await connectFakeExtension('chrome-extension://abc');

    const status = JSON.parse((await call('netlens_status')).body);
    assert.strictEqual(status.connected, true);

    const list = JSON.parse((await call('list_requests', { query: 'transfer/search' })).body);
    assert.strictEqual(list.total, 1);
    assert.strictEqual(list.entries[0].id, 1);

    const errs = JSON.parse((await call('list_requests', { errors_only: true })).body);
    assert.deepStrictEqual(errs.entries.map((e) => e.id), [2]);

    const detail = JSON.parse((await call('get_request', { id: 1 })).body);
    assert.ok(detail.responseBody.includes('Dubai (center)'));
    assert.strictEqual(detail.requestHeaders.authorization, '[redacted]');
    assert.ok(!detail.curl.includes('secret'));

    const missing = await call('get_request', { id: 99 });
    assert.ok(missing.isError && /No captured entry/.test(missing.body));

    const replay = await call('replay_request', { id: 1 });
    assert.ok(replay.isError && /turned off/.test(replay.body));

    ws.close();
    console.log('mcp e2e: all passed');
  } finally {
    await client.close();
    fs.rmSync(home, { recursive: true, force: true });
  }
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
