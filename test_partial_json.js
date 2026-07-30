const assert = require('assert');

// Copy of tryParsePartialJson for node self-check
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

// 1. Truncated mid-string
const res1 = tryParsePartialJson('{"status":"success","data":[{"flight_key":"F1WC00145-');
assert.strictEqual(res1.status, 'success');
assert.strictEqual(res1.data[0].flight_key, 'F1WC00145-');

// 2. Truncated mid-colon
const res2 = tryParsePartialJson('{"status":"success","tracking_id":');
assert.strictEqual(res2.status, 'success');

// 3. Truncated mid-key
const res3 = tryParsePartialJson('{"status":"success","search_dur');
assert.strictEqual(res3.status, 'success');

console.log('All partial JSON repair assertions passed!');
