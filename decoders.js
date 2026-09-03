// Pure decoding engine — no DOM, no chrome.* APIs. Everything here takes
// data in, returns data out, so it can run in the panel UI or under plain
// node (see test_partial_json.js) without a browser.
//
// `customDecoders` is owned by sidepanel.js (loaded from chrome.storage,
// edited by the decoder-manager UI) and passed in by the caller rather than
// held as a module global here, so this file has no mutable state of its own.

function decodeText(encodedText, shift) {
  if (shift < 1 || shift > 25) return "";
  let decoded = "";
  const effectiveShift = 26 - shift;
  for (let i = 0; i < encodedText.length; i++) {
    let charCode = encodedText.charCodeAt(i);
    if (charCode >= 65 && charCode <= 90) {
      decoded += String.fromCharCode(((charCode - 65 + effectiveShift) % 26) + 65);
    } else if (charCode >= 97 && charCode <= 122) {
      decoded += String.fromCharCode(((charCode - 97 + effectiveShift) % 26) + 97);
    } else {
      decoded += encodedText.charAt(i);
    }
  }
  return decoded;
}

function isMostlyPrintable(s) {
  if (!s || !s.length) return false;
  let bad = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (!(c === 9 || c === 10 || c === 13 || (c >= 32 && c <= 126))) bad++;
  }
  return bad / s.length < 0.1;
}

function b64Decode(str) {
  if (!/^[A-Za-z0-9+/]{8,}={0,2}$/.test(str) || str.length % 4 !== 0) return null;
  try {
    const bin = atob(str);
    return isMostlyPrintable(bin) ? bin : null;
  } catch { return null; }
}

function b64UrlDecode(str) {
  if (!/^[A-Za-z0-9_-]{8,}$/.test(str)) return null;
  const b64 = str.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - str.length % 4) % 4);
  try {
    const bin = atob(b64);
    return isMostlyPrintable(bin) ? bin : null;
  } catch { return null; }
}

function hexDecodeStr(str) {
  if (!/^[0-9a-fA-F]{8,}$/.test(str) || str.length % 2 !== 0) return null;
  let out = '';
  for (let i = 0; i < str.length; i += 2) out += String.fromCharCode(parseInt(str.substr(i, 2), 16));
  return isMostlyPrintable(out) ? out : null;
}

function jwtDecode(str) {
  const parts = str.split('.');
  if (parts.length !== 3) return null;
  try {
    const h = b64UrlDecode(parts[0]);
    const p = b64UrlDecode(parts[1]);
    if (h == null || p == null) return null;
    return { header: JSON.parse(h), payload: JSON.parse(p), signature: parts[2] };
  } catch { return null; }
}

function unicodeEscapeDecode(str) {
  if (!/\\u[0-9a-fA-F]{4}/.test(str)) return null;
  try {
    const out = JSON.parse('"' + str.replace(/"/g, '\\"') + '"');
    return out !== str ? out : null;
  } catch { return null; }
}

function urlDecodeStr(str) {
  if (!/%[0-9a-fA-F]{2}/.test(str)) return null;
  try {
    const out = decodeURIComponent(str);
    return out !== str ? out : null;
  } catch { return null; }
}

function tryJsonValue(v) {
  if (typeof v !== 'string') return v;
  try {
    const p = JSON.parse(v);
    return (p && typeof p === 'object') ? p : v;
  } catch { return v; }
}

// step fns take a raw string, return string|object|null (null = doesn't apply)
const DECODER_STEPS = [
  { id: 'legacy', label: 'Caesar(9)+LZ', auto: true, fn: (v) => {
      const t = decodeText(v, 9);
      const d = LZString.decompressFromEncodedURIComponent(t);
      if (!d) return null;
      const parsed = JSON.parse(d);
      return (parsed && typeof parsed === 'object') ? parsed : null;
    } },
  { id: 'lzstring', label: 'LZString', auto: true, fn: (v) => {
      const d = LZString.decompressFromEncodedURIComponent(v);
      if (!d) return null;
      const parsed = tryJsonValue(d);
      return (typeof parsed === 'string' && !isMostlyPrintable(parsed)) ? null : parsed;
    } },
  { id: 'jwt', label: 'JWT', auto: true, fn: jwtDecode },
  { id: 'unicodeEscape', label: 'Unicode Escape', auto: true, fn: unicodeEscapeDecode },
  { id: 'urlDecode', label: 'URL Decode', auto: true, fn: urlDecodeStr },
  { id: 'base64url', label: 'Base64URL', auto: true, fn: (v) => { const d = b64UrlDecode(v); return d == null ? null : tryJsonValue(d); } },
  { id: 'base64', label: 'Base64', auto: true, fn: (v) => { const d = b64Decode(v); return d == null ? null : tryJsonValue(d); } },
  { id: 'hex', label: 'Hex', auto: true, fn: (v) => { const d = hexDecodeStr(v); return d == null ? null : tryJsonValue(d); } },
  { id: 'json', label: 'JSON', auto: false, fn: (v) => {
      const s = v.trim();
      if (!s.startsWith('{') && !s.startsWith('[')) return null;
      try { const p = JSON.parse(s); return (p && typeof p === 'object') ? p : null; } catch { return null; }
    } },
];
const DECODER_STEP_MAP = Object.fromEntries(DECODER_STEPS.map(s => [s.id, s]));

function runChainDecoder(steps, val) {
  let cur = val;
  for (const stepId of steps) {
    const step = DECODER_STEP_MAP[stepId];
    if (!step) return null;
    let out;
    try { out = step.fn(cur); } catch { return null; }
    if (out == null) return null;
    cur = (typeof out === 'object') ? JSON.stringify(out) : out;
  }
  return tryJsonValue(cur);
}

function tryDecode(val, customDecoders) {
  if (typeof val !== 'string' || !val.trim()) return null;
  val = val.trim();

  for (const cd of customDecoders || []) {
    if (cd.type !== 'chain' || !Array.isArray(cd.steps) || !cd.steps.length) continue;
    try {
      const result = runChainDecoder(cd.steps, val);
      if (result != null && (typeof result === 'object' || (typeof result === 'string' && result !== val && isMostlyPrintable(result)))) {
        return { method: cd.name || 'Custom', value: result };
      }
    } catch {}
  }

  for (const step of DECODER_STEPS) {
    if (!step.auto) continue;
    try {
      const result = step.fn(val);
      if (result != null) return { method: step.label, value: result };
    } catch {}
  }

  return null;
}

// Repairs bodies cut off at the 200KB capture cap.
function tryParsePartialJson(str) {
  if (typeof str !== 'string') return null;
  let raw = str.trim();
  if (!raw.startsWith('{') && !raw.startsWith('[')) return null;

  let s = raw;
  for (let attempt = 0; attempt < 50; attempt++) {
    let inString = false;
    let escaped = false;
    const stack = [];

    for (let i = 0; i < s.length; i++) {
      const c = s[i];
      if (inString) {
        if (escaped) {
          escaped = false;
        } else if (c === '\\') {
          escaped = true;
        } else if (c === '"') {
          inString = false;
        }
      } else {
        if (c === '"') {
          inString = true;
        } else if (c === '{' || c === '[') {
          stack.push(c);
        } else if (c === '}') {
          if (stack.length && stack[stack.length - 1] === '{') stack.pop();
        } else if (c === ']') {
          if (stack.length && stack[stack.length - 1] === '[') stack.pop();
        }
      }
    }

    let candidate = s;
    if (inString) candidate += '"';

    let suffix = '';
    for (let i = stack.length - 1; i >= 0; i--) {
      suffix += stack[i] === '{' ? '}' : ']';
    }

    try {
      const result = JSON.parse(candidate + suffix);
      if (result && typeof result === 'object') return result;
    } catch {}

    const lastBoundary = Math.max(s.lastIndexOf(','), s.lastIndexOf('{'), s.lastIndexOf('['));
    if (lastBoundary > 0 && lastBoundary < s.length - 1) {
      s = s.slice(0, lastBoundary + (s[lastBoundary] === ',' ? 0 : 1));
    } else if (s.length > 1) {
      s = s.slice(0, -1);
    } else {
      break;
    }
  }

  return null;
}

function tryDecodeStructure(val, customDecoders) {
  if (typeof val !== 'string') return null;

  const direct = tryDecode(val, customDecoders);
  if (direct) return direct;

  try {
    let parsed = null;
    try {
      parsed = JSON.parse(val);
    } catch {
      parsed = tryParsePartialJson(val);
    }
    if (parsed && typeof parsed === 'object') {
      let hasDecoded = false;
      const decodedStruct = JSON.parse(JSON.stringify(parsed));

      const recurse = (obj) => {
        if (Array.isArray(obj)) {
          for (let i = 0; i < obj.length; i++) {
            if (typeof obj[i] === 'string') {
              const dec = tryDecode(obj[i], customDecoders);
              if (dec) {
                obj[i] = { __decoded: true, method: dec.method, value: dec.value };
                hasDecoded = true;
              }
            } else if (obj[i] && typeof obj[i] === 'object') {
              recurse(obj[i]);
            }
          }
        } else if (obj && typeof obj === 'object') {
          for (const [k, v] of Object.entries(obj)) {
            if (typeof v === 'string') {
              const dec = tryDecode(v, customDecoders);
              if (dec) {
                obj[k] = { __decoded: true, method: dec.method, value: dec.value };
                hasDecoded = true;
              }
            } else if (v && typeof v === 'object') {
              recurse(v);
            }
          }
        }
      };

      recurse(decodedStruct);
      if (hasDecoded) {
        return { method: 'JSON Structure', value: decodedStruct };
      }
    }
  } catch {}

  return null;
}

function hasDecodableData(d, customDecoders) {
  try {
    const u = new URL(d.url);
    for (const [, val] of u.searchParams) {
      if (tryDecodeStructure(val, customDecoders)) return true;
    }
    for (const val of u.pathname.split('/').filter(Boolean)) {
      if (tryDecodeStructure(val, customDecoders)) return true;
    }
  } catch {}
  if (d.requestBody && tryDecodeStructure(d.requestBody, customDecoders)) return true;
  if (d.responseBody && tryDecodeStructure(d.responseBody, customDecoders)) return true;
  for (const val of Object.values(d.requestHeaders || {})) {
    if (tryDecodeStructure(val, customDecoders)) return true;
  }
  for (const val of Object.values(d.responseHeaders || {})) {
    if (tryDecodeStructure(val, customDecoders)) return true;
  }
  return false;
}

if (typeof module !== 'undefined') {
  module.exports = {
    decodeText, isMostlyPrintable, b64Decode, b64UrlDecode, hexDecodeStr, jwtDecode,
    unicodeEscapeDecode, urlDecodeStr, tryJsonValue, DECODER_STEPS, DECODER_STEP_MAP,
    runChainDecoder, tryDecode, tryParsePartialJson, tryDecodeStructure, hasDecodableData,
  };
}
