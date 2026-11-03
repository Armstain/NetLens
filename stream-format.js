const STREAM_CONTENT_TYPE = /event-stream|x-ndjson|stream\+json|jsonl|json-seq/i;
const MAX_STREAM_EVENTS = 5000;
const MAX_JSON_CHARS = 256 * 1024;

function isStreamEntry(d) {
  return !!(d && (d.streaming || d.streamed || STREAM_CONTENT_TYPE.test(d.contentType || '')));
}

function tryJson(text) {
  if (typeof text !== 'string' || text.length > MAX_JSON_CHARS) return undefined;
  const s = text.trim();
  if (!s || (s[0] !== '{' && s[0] !== '[' && s[0] !== '"')) return undefined;
  try { return JSON.parse(s); } catch { return undefined; }
}

function eventTime(timeline, offset) {
  if (!Array.isArray(timeline) || !timeline.length) return null;
  let lo = 0;
  let hi = timeline.length - 1;
  if (offset > timeline[hi][0]) return timeline[hi][1];
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (timeline[mid][0] >= offset) hi = mid; else lo = mid + 1;
  }
  return timeline[lo][1];
}

function forEachLine(raw, done, fn) {
  const re = /\r\n|\r|\n/g;
  let pos = 0;
  let m;
  while ((m = re.exec(raw))) {
    if (m[0] === '\r' && m.index === raw.length - 1 && !done) break;
    fn(raw.slice(pos, m.index), m.index + m[0].length);
    pos = m.index + m[0].length;
  }
  if (done && pos < raw.length) {
    fn(raw.slice(pos), raw.length);
    pos = raw.length;
  }
  return pos;
}

function detectFormat(raw) {
  const head = raw.slice(0, 4096);
  if (/^(data|event|id|retry):/m.test(head)) return 'sse';
  const lines = head.split(/\r\n|\r|\n/);
  if (raw.length > head.length || !/[\r\n]$/.test(head)) lines.pop();
  const full = lines.filter((l) => l.trim());
  if (full.length && full.every((l) => tryJson(l) !== undefined)) return 'ndjson';
  if (/^:/m.test(head)) return 'sse';
  return 'text';
}

function makeEvent(events, fields, offset, timeline) {
  if (events.length >= MAX_STREAM_EVENTS) return false;
  const data = fields.data;
  const json = tryJson(data);
  events.push({
    index: events.length,
    type: fields.type || 'message',
    id: fields.id || null,
    data,
    json,
    sentinel: json === undefined && /^\[?DONE\]?$/i.test(data.trim()),
    offset,
    t: eventTime(timeline, offset),
  });
  return true;
}

function parseSse(raw, done, timeline) {
  const events = [];
  let overflow = 0;
  let block = { data: [], type: null, id: null };
  let lastId = null;
  let blockStart = 0;

  const dispatch = (offset) => {
    const lines = block.data;
    if (lines.length) {
      const joined = lines.join('\n');
      const split = lines.length > 1 && tryJson(joined) === undefined && lines.every((l) => tryJson(l) !== undefined);
      for (const data of split ? lines : [joined]) {
        if (!makeEvent(events, { data, type: block.type, id: lastId }, offset, timeline)) overflow++;
      }
    }
    block = { data: [], type: null, id: null };
    blockStart = offset;
  };

  forEachLine(raw, done, (line, end) => {
    if (line === '') return dispatch(end);
    if (line[0] === ':') return;
    const c = line.indexOf(':');
    const field = c === -1 ? line : line.slice(0, c);
    let value = c === -1 ? '' : line.slice(c + 1);
    if (value[0] === ' ') value = value.slice(1);
    if (field === 'data') block.data.push(value);
    else if (field === 'event') block.type = value;
    else if (field === 'id') { if (!value.includes('\0')) lastId = value; }
    else if (field !== 'retry' && (line[0] === '{' || line[0] === '[')) block.data.push(line);
  });
  if (done) dispatch(raw.length);
  return { events, overflow, rest: raw.slice(blockStart) };
}

function parseNdjson(raw, done, timeline) {
  const events = [];
  let overflow = 0;
  const consumed = forEachLine(raw, done, (line, end) => {
    if (!line.trim()) return;
    if (!makeEvent(events, { data: line }, end, timeline)) overflow++;
  });
  return { events, overflow, rest: raw.slice(consumed) };
}

function parseStream(raw, opts) {
  const { timeline = null, done = false } = opts || {};
  const text = typeof raw === 'string' ? raw : '';
  const format = detectFormat(text);
  if (format === 'text') return { format, events: [], overflow: 0, rest: text };
  const parsed = format === 'sse' ? parseSse(text, done, timeline) : parseNdjson(text, done, timeline);
  return { format, ...parsed };
}

const SKIP_TEXT_KEY = /(^|\.)(id|_id|object|model|created|type|event|role|index|finish_reason|stop_reason|system_fingerprint|status|logprobs)$/i;
const ID_LIKE = /^[\w:.\-#]{12,}$/;
const ISO_DATE = /^\d{4}-\d\d-\d\d[T ]/;
const KEY_FIELD = /(^|_)(id|uid|key|code|ref)$/i;
const GROUP_HINT = /supplier|source|provider|vendor|channel|origin|airline|carrier|category|group|kind/i;
const MAX_WALK_DEPTH = 8;

function inferShape(events) {
  const shape = { texts: [], collections: [], types: {}, timing: streamTiming(events) };
  for (const e of events) shape.types[e.type] = (shape.types[e.type] || 0) + 1;

  const strPaths = new Map();
  const arrPaths = new Map();

  const walk = (node, path, ei, multi, depth) => {
    if (depth > MAX_WALK_DEPTH || node == null) return;
    if (Array.isArray(node)) {
      let rec = arrPaths.get(path);
      if (!rec) arrPaths.set(path, (rec = { path, events: new Set(), maxLen: 0, items: [] }));
      rec.events.add(ei);
      rec.maxLen = Math.max(rec.maxLen, node.length);
      for (const item of node) {
        if (item && typeof item === 'object' && !Array.isArray(item)) rec.items.push({ item, ei });
      }
      if (node.length === 1) walk(node[0], `${path}[]`, ei, multi, depth + 1);
      return;
    }
    if (typeof node === 'object') {
      for (const k of Object.keys(node)) walk(node[k], path ? `${path}.${k}` : k, ei, multi, depth + 1);
      return;
    }
    if (typeof node !== 'string' || multi || SKIP_TEXT_KEY.test(path)) return;
    let rec = strPaths.get(path);
    if (!rec) strPaths.set(path, (rec = { path, values: [] }));
    rec.values.push({ v: node, ei });
  };

  const jsonEvents = events.filter((e) => e.json && typeof e.json === 'object');
  jsonEvents.forEach((e) => walk(e.json, '', e.index, false, 0));

  const multiArrays = [...arrPaths.values()].filter((a) => a.maxLen > 1).map((a) => a.path);
  const underMulti = (p) => multiArrays.some((a) => p === a || p.startsWith(`${a}[]`));

  for (const rec of strPaths.values()) {
    const vals = rec.values.map((x) => x.v);
    if (vals.length < 2 || underMulti(rec.path)) continue;
    if (new Set(vals).size < 2) continue;
    if (vals.every((v) => ID_LIKE.test(v) || ISO_DATE.test(v))) continue;
    const snapshot = vals.every((v, i) => i === 0 || v.startsWith(vals[i - 1]));
    const text = snapshot ? vals[vals.length - 1] : vals.join('');
    if (!text.trim()) continue;
    shape.texts.push({ path: rec.path, mode: snapshot ? 'snapshot' : 'delta', count: vals.length, text });
  }
  shape.texts.sort((a, b) => b.text.length - a.text.length);
  shape.texts = shape.texts.slice(0, 3);

  const textPaths = shape.texts.map((t) => t.path);
  for (const rec of arrPaths.values()) {
    if (rec.items.length < 2) continue;
    if (rec.maxLen < 2 && textPaths.some((p) => p.startsWith(`${rec.path}[]`))) continue;
    if (rec.maxLen < 2 && rec.events.size < 2) continue;
    shape.collections.push(describeCollection(rec, events));
  }
  shape.collections.sort((a, b) => b.total - a.total);
  return shape;
}

function scalarFields(item, prefix, out, depth) {
  for (const k of Object.keys(item)) {
    const v = item[k];
    const p = prefix ? `${prefix}.${k}` : k;
    if (v == null) continue;
    if (typeof v === 'object') {
      if (!Array.isArray(v) && depth < 1) scalarFields(v, p, out, depth + 1);
    } else {
      out[p] = v;
    }
  }
  return out;
}

function describeCollection(rec, events) {
  const rows = rec.items.map(({ item, ei }) => ({ item, ei, fields: scalarFields(item, '', {}, 0) }));
  const total = rows.length;
  const stats = new Map();
  for (const r of rows) {
    for (const [k, v] of Object.entries(r.fields)) {
      let s = stats.get(k);
      if (!s) stats.set(k, (s = { key: k, values: new Map(), n: 0 }));
      s.n++;
      const key = String(v);
      s.values.set(key, (s.values.get(key) || 0) + 1);
    }
  }

  let keyField = null;
  let bestRatio = 0.5;
  for (const s of stats.values()) {
    if (!KEY_FIELD.test(s.key.split('.').pop()) || s.n < total * 0.8) continue;
    const ratio = s.values.size / s.n;
    if (ratio > bestRatio || (ratio === bestRatio && keyField && s.key.length < keyField.length)) {
      bestRatio = ratio;
      keyField = s.key;
    }
  }
  const distinct = keyField ? stats.get(keyField).values.size : total;

  const eventIds = [...new Set(rows.map((r) => r.ei))];
  let groupBy = null;
  let bestScore = 0.99;
  for (const s of stats.values()) {
    if (s.key === keyField || s.n < total * 0.8) continue;
    if (s.values.size < 2 || s.values.size > Math.max(2, Math.min(30, total / 2))) continue;
    let aligned = 0;
    for (const ei of eventIds) {
      const vals = new Set(rows.filter((r) => r.ei === ei).map((r) => String(r.fields[s.key])));
      if (vals.size === 1) aligned++;
    }
    const score = (GROUP_HINT.test(s.key) ? 1 : 0) + aligned / eventIds.length;
    if (score > bestScore) { bestScore = score; groupBy = s.key; }
  }

  let groups = [];
  if (groupBy) {
    const byValue = new Map();
    for (const r of rows) {
      const v = String(r.fields[groupBy]);
      let g = byValue.get(v);
      if (!g) byValue.set(v, (g = { value: v, count: 0, events: new Set(), firstT: null, lastT: null }));
      g.count++;
      g.events.add(r.ei);
      const t = events[r.ei] ? events[r.ei].t : null;
      if (t != null) {
        if (g.firstT == null || t < g.firstT) g.firstT = t;
        if (g.lastT == null || t > g.lastT) g.lastT = t;
      }
    }
    groups = [...byValue.values()]
      .map((g) => ({ ...g, events: g.events.size }))
      .sort((a, b) => (a.firstT ?? Infinity) - (b.firstT ?? Infinity));
  }

  const seen = new Set();
  const merged = [];
  for (const r of rows) {
    if (keyField) {
      const k = String(r.fields[keyField]);
      if (seen.has(k)) continue;
      seen.add(k);
    }
    merged.push(r.item);
  }

  return {
    path: rec.path || '(root)',
    total,
    events: rec.events.size,
    keyField,
    unique: distinct,
    duplicates: total - distinct,
    groupBy,
    groups,
    merged,
  };
}

function streamTiming(events) {
  const times = events.map((e) => e.t).filter((t) => t != null);
  if (!times.length) return null;
  let maxGap = 0;
  let maxGapAfter = null;
  for (let i = 1; i < times.length; i++) {
    const gap = times[i] - times[i - 1];
    if (gap > maxGap) { maxGap = gap; maxGapAfter = i - 1; }
  }
  return { first: times[0], last: times[times.length - 1], maxGap, maxGapAfter };
}

if (typeof module !== 'undefined') {
  module.exports = {
    STREAM_CONTENT_TYPE, MAX_STREAM_EVENTS, isStreamEntry, detectFormat, parseStream, inferShape, eventTime,
  };
}
