// AI access (MCP) bridge.
//
// The NetLens MCP server (mcp/server.js) is started by an AI client over
// stdio, so the extension can't be its parent — it dials in instead, over a
// WebSocket on 127.0.0.1, and answers the server's calls by asking the
// tab's content script for its ring buffer, exactly as the side panel does.
//
// Every AI client runs its own server copy, each on the first free port of a
// small span, so the extension keeps one socket per live server.
//
// Off by default. When on, both ends prove they hold the same token (shown
// by `node mcp/server.js --token`) before anything is sent, so a stray
// process on the port gets nothing.

const MCP_KEY = 'netlensMcp';
const MCP_ALARM = 'netlens-mcp-reconnect';
const MCP_DEFAULTS = { enabled: false, port: 17373, token: '', allowReplay: false };
const MCP_PORT_SPAN = 5; // keep in sync with PORT_SPAN in mcp/server.js
const MCP_PING_MS = 20000; // keeps Chrome's MV3 service worker alive while connected
const MCP_RETRY_MIN_MS = 3000;
const MCP_RETRY_MAX_MS = 15000;

const mcpConns = new Map(); // port -> { ws, ready, authFailed, info, ping }
let mcpOff = 'off';         // 'off' | 'no-token' | null while running
let mcpRetryTimer = null;
let mcpRetryMs = MCP_RETRY_MIN_MS;
let mcpConnecting = false;

function mcpNormalize(raw) {
  const s = { ...MCP_DEFAULTS, ...(raw || {}) };
  s.port = Math.min(65535 - MCP_PORT_SPAN, Math.max(1024, Number(s.port) || MCP_DEFAULTS.port));
  s.token = String(s.token || '').trim();
  s.enabled = !!s.enabled;
  s.allowReplay = !!s.allowReplay;
  return s;
}

async function mcpSettings() {
  const res = await chrome.storage.local.get(MCP_KEY);
  return mcpNormalize(res && res[MCP_KEY]);
}

function mcpState() {
  const servers = [...mcpConns]
    .filter(([, c]) => c.ready)
    .map(([port, c]) => ({ ...c.info, port }));
  let status = mcpOff;
  if (!status) {
    if (servers.length) status = 'connected';
    else if ([...mcpConns.values()].some((c) => c.authFailed)) status = 'auth-failed';
    else status = 'waiting';
  }
  return { status, servers };
}

function mcpPublish() {
  try {
    chrome.runtime.sendMessage({ type: 'netlens:mcp:status', ...mcpState() }).catch(() => {});
  } catch {}
}

async function mcpHmac(token, message) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', enc.encode(token), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(message));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function mcpNonce() {
  return [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function mcpScheduleRetry() {
  clearTimeout(mcpRetryTimer);
  mcpRetryTimer = setTimeout(mcpConnect, mcpRetryMs);
  // Keep scanning even while connected: a second AI client may start its own
  // server later. The alarm is the floor once the worker has been put to
  // sleep and this timer with it.
  mcpRetryMs = Math.min(mcpRetryMs * 2, MCP_RETRY_MAX_MS);
}

function mcpDisconnect() {
  clearTimeout(mcpRetryTimer);
  for (const conn of mcpConns.values()) {
    clearInterval(conn.ping);
    try { conn.ws.close(1000, 'disabled'); } catch {}
  }
  mcpConns.clear();
}

async function mcpConnect() {
  if (mcpConnecting) return;
  mcpConnecting = true;
  let s;
  try { s = await mcpSettings(); } finally { mcpConnecting = false; }
  if (!s.enabled) { mcpOff = 'off'; mcpPublish(); return; }
  if (!s.token) { mcpOff = 'no-token'; mcpPublish(); return; }
  mcpOff = null;

  for (let p = s.port; p < s.port + MCP_PORT_SPAN; p++) {
    if (!mcpConns.has(p)) mcpOpen(p, s);
  }
  mcpPublish();
  mcpScheduleRetry();
}

function mcpOpen(port, s) {
  let ws;
  try {
    ws = new WebSocket(`ws://127.0.0.1:${port}`);
  } catch {
    return;
  }
  const conn = { ws, ready: false, authFailed: false, info: null, ping: null };
  mcpConns.set(port, conn);

  const clientNonce = mcpNonce();
  let stage = 'hello';
  // Message handlers await Web Crypto, so run them one at a time in order.
  let queue = Promise.resolve();

  ws.addEventListener('open', () => {
    const manifest = chrome.runtime.getManifest();
    const browser = typeof navigator !== 'undefined' && /Firefox\//.test(navigator.userAgent) ? 'firefox' : 'chrome';
    ws.send(JSON.stringify({ type: 'hello', nonce: clientNonce, version: manifest.version, browser }));
  });

  ws.addEventListener('message', (event) => {
    queue = queue.then(async () => {
      let msg;
      try { msg = JSON.parse(event.data); } catch { return; }
      if (stage === 'hello') {
        if (msg.type !== 'hello' || msg.proof !== await mcpHmac(s.token, `server:${clientNonce}`)) {
          conn.authFailed = true;
          ws.close(4001, 'server proof mismatch');
          return;
        }
        ws.send(JSON.stringify({ type: 'auth', proof: await mcpHmac(s.token, `client:${msg.nonce}`) }));
        stage = 'auth';
        return;
      }
      if (stage === 'auth') {
        if (msg.type !== 'ready') return;
        stage = 'ready';
        conn.ready = true;
        conn.info = msg.info || {};
        mcpRetryMs = MCP_RETRY_MIN_MS;
        mcpPublish();
        conn.ping = setInterval(() => {
          try { ws.send('{"type":"ping"}'); } catch {}
        }, MCP_PING_MS);
        return;
      }
      if ((msg.type === 'info' || msg.type === 'pong') && msg.info) {
        const changed = JSON.stringify(msg.info) !== JSON.stringify(conn.info);
        conn.info = msg.info;
        if (changed) mcpPublish();
        return;
      }
      if (msg.type === 'call') {
        let reply;
        try {
          reply = { type: 'result', id: msg.id, ok: true, result: await mcpHandle(msg.cmd, msg.args || {}) };
        } catch (err) {
          reply = { type: 'result', id: msg.id, ok: false, error: String((err && err.message) || err) };
        }
        try { ws.send(JSON.stringify(reply)); } catch {}
      }
    });
  });

  ws.addEventListener('close', (event) => {
    clearInterval(conn.ping);
    if (mcpConns.get(port) !== conn) return; // disabled or replaced on purpose
    conn.ready = false;
    // A token mismatch would just fail again, so keep the entry (which stops
    // the rescan) until the token changes and everything restarts.
    if (!(conn.authFailed || event.code === 4001)) mcpConns.delete(port);
    mcpPublish();
  });
}

// ------------------------------------------------------------- tool calls

async function mcpResolveTab(tabId) {
  if (tabId != null) {
    try {
      return await chrome.tabs.get(Number(tabId));
    } catch {
      throw new Error(`No browser tab with id ${tabId}. Call list_tabs for current ids.`);
    }
  }
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!tab) throw new Error('No active tab found. Pass a tab_id from list_tabs.');
  return tab;
}

function mcpTabInfo(tab) {
  return { id: tab.id, windowId: tab.windowId, active: tab.active, title: tab.title, url: tab.url };
}

function mcpAskTab(tabId, message) {
  return new Promise((resolve, reject) => {
    // bridge:true tells content.js this isn't the side panel speaking, so it
    // keeps its "panel closed" backoff instead of resuming live batches.
    chrome.tabs.sendMessage(tabId, { ...message, bridge: true }, (res) => {
      if (chrome.runtime.lastError || res === undefined) {
        reject(new Error("NetLens isn't running in this tab. It can't capture on browser-internal pages or the Web Store, and a tab opened before NetLens was installed or updated needs a reload."));
        return;
      }
      resolve(res);
    });
  });
}

async function mcpHandle(cmd, args) {
  if (cmd === 'tabs') {
    const tabs = await chrome.tabs.query({});
    return tabs.map(mcpTabInfo);
  }
  const tab = await mcpResolveTab(args.tabId);
  if (cmd === 'dump') {
    const res = await mcpAskTab(tab.id, { type: 'netlens:dump' });
    return { tab: mcpTabInfo(tab), buffer: res.buffer || [] };
  }
  if (cmd === 'pagestyles') {
    return { tab: mcpTabInfo(tab), ...(await mcpAskTab(tab.id, { type: 'netlens:pagestyles' })) };
  }
  if (cmd === 'replay') {
    const s = await mcpSettings();
    if (!s.allowReplay) {
      throw new Error('Replay is turned off. The user can enable "Allow replay" under AI access (MCP) in NetLens settings.');
    }
    return mcpAskTab(tab.id, { type: 'netlens:replay', req: args.req || {} });
  }
  throw new Error(`Unknown command: ${cmd}`);
}

// ---------------------------------------------------------------- wiring

async function mcpSync() {
  const s = await mcpSettings();
  if (s.enabled) {
    chrome.alarms.create(MCP_ALARM, { periodInMinutes: 0.5 });
    mcpConnect();
  } else {
    chrome.alarms.clear(MCP_ALARM);
    mcpDisconnect();
    mcpOff = 'off';
    mcpPublish();
  }
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !changes[MCP_KEY]) return;
  // Port or token changed: drop the old connections and start over.
  mcpDisconnect();
  mcpRetryMs = MCP_RETRY_MIN_MS;
  mcpSync();
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === MCP_ALARM) mcpConnect();
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || msg.type !== 'netlens:mcp:getStatus') return;
  sendResponse(mcpState());
});

mcpSync();
