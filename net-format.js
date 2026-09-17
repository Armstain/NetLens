// Shared formatting and classification for captured requests. Pure functions,
// no DOM — loaded into both the side panel and the page's content script so the
// toast and the request list agree on what counts as an error, an API call, or
// a write.

function fmtDuration(ms) {
  if (ms == null) return '';
  return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(2)}s`;
}

function fmtSize(bytes) {
  if (!bytes) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function statusClass(d) {
  if (d.failed || d.status === 0) return 'failed';
  if (d.status >= 500) return 's5xx';
  if (d.status >= 400) return 's4xx';
  if (d.status >= 300) return 's3xx';
  if (d.status >= 200) return 's2xx';
  return '';
}

function isError(d) {
  if (d.kind === 'log') return d.level === 'error';
  return d.failed || d.status === 0 || d.status >= 400;
}

function isLog(d) {
  return d.kind === 'log';
}

function isApi(d) {
  return /json|xml|graphql/i.test(d.contentType || '');
}

function pathOf(url) {
  try {
    const u = new URL(url);
    return u.pathname + u.search;
  } catch {
    return url;
  }
}

function isGraphql(d) {
  return /graphql/i.test(d.url) || /graphql/i.test(d.contentType || '');
}

// ponytail: keyword sniff, parse the document if a query named e.g. mutationLog misfires
function isGqlMutation(d) {
  return /(^|[\s"{[(])mutation[\s({]/.test(d.requestBody || '');
}

// ------------------------------------------------------------ toast settings
// No OPTIONS: a CORS preflight is issued by the browser itself, never through
// the patched fetch/XHR in injected.js, and there's no webRequest permission —
// so an OPTIONS chip could never match anything.
const TOAST_METHOD_GROUPS = {
  reads: ['GET', 'HEAD'],
  writes: ['POST', 'PUT', 'PATCH', 'DELETE'],
};
const TOAST_METHODS = [...TOAST_METHOD_GROUPS.reads, ...TOAST_METHOD_GROUPS.writes];
const TOAST_STATUS_CLASSES = ['s2xx', 's3xx', 's4xx', 's5xx', 'failed'];
const TOAST_POSITIONS = ['bottom-right', 'bottom-left', 'top-right', 'top-left'];

const ALL_METHODS_ON = { GET: true, HEAD: true, POST: true, PUT: true, PATCH: true, DELETE: true };

const DEFAULT_TOAST_SETTINGS = {
  enabled: false,
  status: { s2xx: false, s3xx: false, s4xx: true, s5xx: true, failed: true },
  methods: { ...ALL_METHODS_ON },
  slowMs: 0,
  urlMatch: '',
  gqlMutationsOnly: false,
  dismissMs: 4000,
  errorDismissMs: 8000,
  maxStack: 4,
  dedupe: true,
  position: 'bottom-right',
  bodyPeek: false,
};

const TOAST_PRESETS = {
  errors: {
    status: { s2xx: false, s3xx: false, s4xx: true, s5xx: true, failed: true },
    methods: { ...ALL_METHODS_ON },
    slowMs: 0,
    gqlMutationsOnly: false,
  },
  mutations: {
    status: { s2xx: true, s3xx: true, s4xx: true, s5xx: true, failed: true },
    methods: { GET: false, HEAD: false, POST: true, PUT: true, PATCH: true, DELETE: true },
    slowMs: 0,
    gqlMutationsOnly: true,
  },
  slow: {
    status: { s2xx: false, s3xx: false, s4xx: false, s5xx: false, failed: false },
    methods: { ...ALL_METHODS_ON },
    slowMs: 1000,
    gqlMutationsOnly: false,
  },
  all: {
    status: { s2xx: true, s3xx: true, s4xx: true, s5xx: true, failed: true },
    methods: { ...ALL_METHODS_ON },
    slowMs: 0,
    gqlMutationsOnly: false,
  },
};

function clampNum(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

// Stored settings are merged over the defaults rather than trusted wholesale, so
// a field added in a later version still has a value on an old saved object.
function normalizeToastSettings(raw) {
  const d = DEFAULT_TOAST_SETTINGS;
  const s = raw && typeof raw === 'object' ? raw : {};
  return {
    enabled: !!s.enabled,
    status: { ...d.status, ...(s.status || {}) },
    methods: { ...d.methods, ...(s.methods || {}) },
    slowMs: clampNum(s.slowMs, d.slowMs, 0, 600000),
    urlMatch: typeof s.urlMatch === 'string' ? s.urlMatch : '',
    gqlMutationsOnly: !!s.gqlMutationsOnly,
    dismissMs: clampNum(s.dismissMs, d.dismissMs, 500, 120000),
    errorDismissMs: clampNum(s.errorDismissMs, d.errorDismissMs, 500, 120000),
    maxStack: clampNum(s.maxStack, d.maxStack, 1, 20),
    dedupe: s.dedupe !== false,
    position: TOAST_POSITIONS.includes(s.position) ? s.position : d.position,
    bodyPeek: !!s.bodyPeek,
  };
}

// `/pattern/flags` is treated as a regex, anything else as a case-insensitive
// substring. A regex that does not compile falls back to substring rather than
// throwing on every single request.
function buildUrlTest(src) {
  const re = /^\/(.*)\/([a-z]*)$/i.exec(src);
  if (re) {
    try {
      const compiled = new RegExp(re[1], re[2]);
      return (url) => compiled.test(url);
    } catch {}
  }
  const needle = src.toLowerCase();
  return (url) => String(url).toLowerCase().includes(needle);
}

let urlTestCache = { src: null, test: null };

function urlAllows(settings, url) {
  const src = settings.urlMatch || '';
  if (!src) return true;
  if (urlTestCache.src !== src) urlTestCache = { src, test: buildUrlTest(src) };
  return urlTestCache.test(url);
}

// A fetch rejection carries no contentType, so isApi() alone would drop exactly
// the calls worth interrupting for: dead endpoints, CORS blocks, offline.
// An unlisted method (PROPFIND, custom verbs) passes unless explicitly unticked.
function toastMatch(d, settings) {
  const s = settings;
  if (!s || !s.enabled || d.kind === 'log') return false;
  if (!isApi(d) && !d.failed) return false;
  if (s.methods[d.method] === false) return false;
  if (s.gqlMutationsOnly && isGraphql(d) && !isGqlMutation(d)) return false;
  if (!urlAllows(s, d.url)) return false;
  if (s.status[statusClass(d)]) return true;
  if (s.slowMs > 0 && d.duration > s.slowMs) return true;
  return false;
}

// Headers are edited as text, so they have to survive a round trip through it.
// Split on the FIRST colon only: values routinely contain colons (URLs, IPv6,
// timestamps) and splitting on all of them silently corrupts the header.
function parseHeaderLines(text) {
  const out = {};
  const raw = text == null ? '' : String(text);
  for (const line of raw.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const i = t.indexOf(':');
    if (i <= 0) continue;
    const k = t.slice(0, i).trim();
    if (k) out[k] = t.slice(i + 1).trim();
  }
  return out;
}

function formatHeaderLines(headers) {
  return Object.keys(headers || {}).map((k) => `${k}: ${headers[k]}`).join('\n');
}

// Pretty-prints a JSON body so it can be edited and diffed line by line.
// Returns null for anything that is not JSON, so callers can fall back to the
// raw text rather than mangling form-encoded or plain-text bodies.
function prettyJson(text) {
  if (typeof text !== 'string') return null;
  const t = text.trim();
  if (!t || (t[0] !== '{' && t[0] !== '[')) return null;
  try {
    return JSON.stringify(JSON.parse(t), null, 2);
  } catch {
    return null;
  }
}

const DIFF_MAX_LINES = 1200;

// Longest-common-subsequence line diff. Returns null above the cap instead of
// locking the panel up.
// ponytail: O(n*m) table, ~5.7MB at the cap. Swap in Myers if the cap ever
// needs lifting.
function diffLines(before, after) {
  const a = String(before == null ? '' : before).split('\n');
  const b = String(after == null ? '' : after).split('\n');
  if (a.length > DIFF_MAX_LINES || b.length > DIFF_MAX_LINES) return null;

  const n = a.length;
  const m = b.length;
  const dp = [];
  for (let i = 0; i <= n; i++) dp.push(new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }

  const out = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { out.push({ type: ' ', text: a[i] }); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { out.push({ type: '-', text: a[i] }); i++; }
    else { out.push({ type: '+', text: b[j] }); j++; }
  }
  while (i < n) { out.push({ type: '-', text: a[i] }); i++; }
  while (j < m) { out.push({ type: '+', text: b[j] }); j++; }
  return out;
}

// Long runs of identical lines are noise — a 600-line response with three
// changed fields should not render 597 unchanged ones. Collapsed runs become a
// single '@' row carrying the count.
function collapseDiff(rows, context = 3) {
  if (!Array.isArray(rows)) return [];
  const keep = new Array(rows.length).fill(false);
  for (let i = 0; i < rows.length; i++) {
    if (rows[i].type === ' ') continue;
    for (let j = Math.max(0, i - context); j <= Math.min(rows.length - 1, i + context); j++) keep[j] = true;
  }
  const out = [];
  let run = 0;
  for (let i = 0; i < rows.length; i++) {
    if (keep[i]) {
      if (run > 0) { out.push({ type: '@', text: `${run} unchanged line${run === 1 ? '' : 's'}`, count: run }); run = 0; }
      out.push(rows[i]);
    } else {
      run++;
    }
  }
  if (run > 0) out.push({ type: '@', text: `${run} unchanged line${run === 1 ? '' : 's'}`, count: run });
  return out;
}

// Groups saved sessions by day. Compares against local midnight rather than a
// rolling 24h window, so a session from 11pm last night reads as Yesterday at
// 1am, not Today.
function dayLabel(ts, now) {
  const n = new Date(now == null ? Date.now() : now);
  const midnight = new Date(n.getFullYear(), n.getMonth(), n.getDate()).getTime();
  const DAY = 86400000;
  if (ts >= midnight) return 'Today';
  if (ts >= midnight - DAY) return 'Yesterday';
  const d = new Date(ts);
  if (ts >= midnight - 6 * DAY) return d.toLocaleDateString([], { weekday: 'long' });
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

if (typeof module !== 'undefined') {
  module.exports = {
    fmtDuration, fmtSize, statusClass, isError, isLog, isApi, pathOf,
    parseHeaderLines, formatHeaderLines,
    prettyJson, diffLines, collapseDiff,
    dayLabel,
    TOAST_METHODS, TOAST_METHOD_GROUPS, TOAST_STATUS_CLASSES, TOAST_POSITIONS,
    DEFAULT_TOAST_SETTINGS, TOAST_PRESETS, normalizeToastSettings, buildUrlTest, toastMatch,
  };
}
