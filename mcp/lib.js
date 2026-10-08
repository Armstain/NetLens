// Pure helpers for the NetLens MCP server: everything that shapes captured
// entries for a model, kept free of sockets and stdio so it can be tested in
// plain Node.

const crypto = require('crypto');

// Headers that carry credentials. A model reading traffic rarely needs the
// actual secret, and whatever it reads may end up in a log or a chat, so
// they are masked unless a tool call asks for them explicitly.
const SECRET_HEADERS = new Set([
  'authorization', 'proxy-authorization', 'cookie', 'set-cookie',
  'x-api-key', 'api-key', 'x-auth-token', 'x-csrf-token', 'x-xsrf-token',
]);

const REDACTED = '[redacted]';

function redactHeaders(headers, includeSecrets) {
  if (!headers || typeof headers !== 'object') return {};
  if (includeSecrets) return { ...headers };
  const out = {};
  for (const [k, v] of Object.entries(headers)) {
    out[k] = SECRET_HEADERS.has(String(k).toLowerCase()) ? REDACTED : v;
  }
  return out;
}

function clip(text, max) {
  if (typeof text !== 'string') return text;
  if (!max || text.length <= max) return text;
  return `${text.slice(0, max)}\n…[${text.length - max} more chars truncated; raise max_body_chars to see them]`;
}

function isRequest(d) {
  return d && (d.kind === 'fetch' || d.kind === 'xhr');
}

function isFailed(d) {
  return !!d.error || d.status === 0 || (typeof d.status === 'number' && d.status >= 400);
}

// A plain substring, or a /pattern/flags regex — the same syntax the panel's
// filter box takes.
function buildMatcher(query) {
  if (!query) return () => true;
  const m = /^\/(.+)\/([a-z]*)$/.exec(query);
  if (m) {
    let re;
    try { re = new RegExp(m[1], m[2]); } catch (err) {
      throw new Error(`Invalid regex ${query}: ${err.message}`);
    }
    return (s) => { re.lastIndex = 0; return re.test(s); };
  }
  const needle = query.toLowerCase();
  return (s) => s.toLowerCase().includes(needle);
}

function haystack(d) {
  if (d.kind === 'log') return `${d.level || ''} ${d.message || ''}\n${d.stack || ''}`;
  const parts = [d.method || '', d.url || ''];
  for (const h of [d.requestHeaders, d.responseHeaders]) {
    for (const [k, v] of Object.entries(h || {})) parts.push(`${k}: ${v}`);
  }
  if (typeof d.requestBody === 'string') parts.push(d.requestBody);
  if (typeof d.responseBody === 'string') parts.push(d.responseBody);
  if (typeof d.data === 'string') parts.push(d.data);
  return parts.join('\n');
}

// The buffer holds a pending placeholder until a request finishes, then the
// finished entry under the same id. Keep only the latest per id.
function dedupe(buffer) {
  const byId = new Map();
  for (const d of buffer || []) {
    if (!d || d.id == null) continue;
    const prev = byId.get(d.id);
    if (!prev || prev.pending || !d.pending) byId.set(d.id, d);
  }
  return [...byId.values()];
}

function summarize(d) {
  if (d.kind === 'log') {
    return { id: d.id, kind: 'log', level: d.level, message: clip(d.message, 300), at: iso(d.startedAt) };
  }
  if (d.kind === 'ws' || d.kind === 'wsframe') {
    const out = { id: d.id, kind: d.kind, transport: d.transport, url: d.url, at: iso(d.startedAt) };
    if (d.kind === 'ws') out.event = d.event;
    else { out.dir = d.dir; out.size = d.size; out.preview = clip(d.data, 200); }
    return out;
  }
  const out = {
    id: d.id,
    kind: d.kind,
    method: d.method,
    url: d.url,
    status: d.pending ? 'pending' : d.status,
    durationMs: typeof d.duration === 'number' ? Math.round(d.duration) : undefined,
    responseSize: d.responseSize,
    contentType: d.contentType || undefined,
    at: iso(d.startedAt),
  };
  if (d.error) out.error = d.error;
  return out;
}

function iso(ts) {
  return typeof ts === 'number' ? new Date(ts).toISOString() : undefined;
}

// kinds: 'requests' (fetch/xhr), 'sockets' (ws/sse + frames), 'logs', or 'all'.
function filterEntries(buffer, { kind = 'requests', query, method, status, errorsOnly, limit = 50 } = {}) {
  const match = buildMatcher(query);
  const wantMethod = method ? String(method).toUpperCase() : null;
  let list = dedupe(buffer).filter((d) => {
    if (kind === 'requests' && !isRequest(d)) return false;
    if (kind === 'sockets' && d.kind !== 'ws' && d.kind !== 'wsframe') return false;
    if (kind === 'logs' && d.kind !== 'log') return false;
    if (wantMethod && d.method !== wantMethod) return false;
    if (status != null && !statusMatches(d.status, status)) return false;
    if (errorsOnly) {
      if (d.kind === 'log') { if (d.level !== 'error') return false; }
      else if (!isRequest(d) || !isFailed(d)) return false;
    }
    return match(haystack(d));
  });
  list.sort((a, b) => (a.startedAt || 0) - (b.startedAt || 0));
  const total = list.length;
  if (limit && list.length > limit) list = list.slice(-limit);
  return { total, entries: list };
}

// 404, "4xx", or "5xx".
function statusMatches(actual, want) {
  const w = String(want).toLowerCase();
  if (/^[1-5]xx$/.test(w)) return typeof actual === 'number' && Math.floor(actual / 100) === Number(w[0]);
  return String(actual) === w;
}

function shellQuote(s) {
  return `'${String(s).replace(/'/g, "'\\''")}'`;
}

const BODY_PLACEHOLDER = /^\[(FormData|Blob|Binary|Unserializable)/;

function usableBody(body) {
  return typeof body === 'string' && body && !BODY_PLACEHOLDER.test(body) ? body : null;
}

// Mirrors the panel's "Copy as cURL".
function buildCurl(d, includeSecrets) {
  const parts = ['curl', shellQuote(d.url)];
  if (d.method && d.method !== 'GET') parts.push('-X', d.method);
  for (const [k, v] of Object.entries(redactHeaders(d.requestHeaders, includeSecrets))) {
    parts.push('-H', shellQuote(`${k}: ${v}`));
  }
  const body = usableBody(d.requestBody);
  if (body) parts.push('--data-raw', shellQuote(body));
  return parts.join(' ');
}

function prettyBody(body) {
  if (typeof body !== 'string') return body;
  const t = body.trim();
  if (!t || (t[0] !== '{' && t[0] !== '[')) return body;
  try { return JSON.stringify(JSON.parse(t), null, 2); } catch { return body; }
}

function detail(d, { maxBodyChars = 20000, includeSecrets = false } = {}) {
  const out = { ...summarize(d) };
  if (d.kind === 'log') {
    out.message = d.message;
    if (d.stack) out.stack = d.stack;
    return out;
  }
  if (d.kind === 'wsframe') {
    out.data = clip(d.data, maxBodyChars);
    out.binary = !!d.binary;
    return out;
  }
  if (!isRequest(d)) return { ...d };
  out.statusText = d.statusText;
  out.requestHeaders = redactHeaders(d.requestHeaders, includeSecrets);
  out.requestBody = clip(prettyBody(d.requestBody), maxBodyChars);
  if (d.requestBodyTruncated) out.requestBodyTruncatedAtCapture = true;
  out.responseHeaders = redactHeaders(d.responseHeaders, includeSecrets);
  out.responseBody = clip(prettyBody(d.responseBody), maxBodyChars);
  if (d.responseBodyTruncated || d.truncated) out.responseBodyTruncatedAtCapture = true;
  out.curl = buildCurl(d, includeSecrets);
  return out;
}

// --------------------------------------------------------------- handshake
// Both sides prove they know the shared token without sending it: each
// answers the other's random nonce with an HMAC. The 'server:'/'client:'
// prefixes stop one side's proof being replayed back as the other's.

function proof(token, role, nonce) {
  return crypto.createHmac('sha256', token).update(`${role}:${nonce}`).digest('hex');
}

function safeEqual(a, b) {
  const x = Buffer.from(String(a || ''));
  const y = Buffer.from(String(b || ''));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

function newNonce() {
  return crypto.randomBytes(16).toString('hex');
}

// Only the extension may connect: browsers stamp a page's real origin on its
// WebSocket handshake, so this keeps websites from talking to the port.
function originAllowed(origin) {
  return typeof origin === 'string' && /^(chrome|moz)-extension:\/\/[a-z0-9-]+$/i.test(origin);
}

module.exports = {
  SECRET_HEADERS, REDACTED, redactHeaders, clip, buildMatcher, dedupe,
  summarize, filterEntries, statusMatches, buildCurl, detail,
  proof, safeEqual, newNonce, originAllowed,
};
