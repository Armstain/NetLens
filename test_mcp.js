const assert = require('assert');
const lib = require('./mcp/lib.js');

const req = (over) => ({
  id: 1, kind: 'fetch', method: 'GET', url: 'https://x.com/api/a', status: 200, startedAt: 1000,
  requestHeaders: {}, responseHeaders: {}, ...over,
});

// ---------------------------------------------------------------- redaction

// 1. Credential headers are masked by default, case-insensitively
assert.deepStrictEqual(
  lib.redactHeaders({ Authorization: 'Bearer abc', 'X-Api-Key': 'k', accept: 'json' }),
  { Authorization: '[redacted]', 'X-Api-Key': '[redacted]', accept: 'json' }
);

// 2. ...and shown when asked for
assert.strictEqual(lib.redactHeaders({ cookie: 'a=1' }, true).cookie, 'a=1');

// 3. The curl command never leaks a redacted secret
const curl = lib.buildCurl(req({ method: 'POST', requestHeaders: { authorization: 'Bearer s3cret' }, requestBody: '{"a":1}' }));
assert.ok(!curl.includes('s3cret'));
assert.ok(curl.includes("-X POST") && curl.includes("--data-raw '{\"a\":1}'"));

// ------------------------------------------------------------------ filters

const buffer = [
  req({ id: 1, url: 'https://x.com/api/transfer/search', method: 'POST', requestBody: '{"to":"Dubai Mall"}', responseBody: '{"dropoff":{"address":{"line":"Dubai (center)"}}}' }),
  req({ id: 2, url: 'https://x.com/api/user', status: 500, startedAt: 2000 }),
  req({ id: 3, kind: 'xhr', url: 'https://x.com/api/slow', pending: true, status: undefined, startedAt: 3000 }),
  req({ id: 3, kind: 'xhr', url: 'https://x.com/api/slow', status: 404, startedAt: 3000 }),
  { id: 4, kind: 'log', level: 'error', message: 'boom', startedAt: 4000 },
  { id: 5, kind: 'wsframe', url: 'wss://x.com/s', dir: 'in', data: 'hi', startedAt: 5000 },
];

// 4. A pending placeholder is replaced by its finished entry
assert.strictEqual(lib.dedupe(buffer).filter((d) => d.id === 3).length, 1);
assert.strictEqual(lib.dedupe(buffer).find((d) => d.id === 3).status, 404);

// 5. Default kind is fetch/XHR only
assert.deepStrictEqual(lib.filterEntries(buffer).entries.map((d) => d.id), [1, 2, 3]);

// 6. The query searches bodies, not just URLs — the "is it the backend?" check
assert.deepStrictEqual(lib.filterEntries(buffer, { query: 'Dubai (center)' }).entries.map((d) => d.id), [1]);

// 7. /regex/ queries
assert.deepStrictEqual(lib.filterEntries(buffer, { query: '/transfer\\/sea?rch/i' }).entries.map((d) => d.id), [1]);
assert.throws(() => lib.filterEntries(buffer, { query: '/(/' }), /Invalid regex/);

// 8. Status classes and errors-only
assert.deepStrictEqual(lib.filterEntries(buffer, { status: '4xx' }).entries.map((d) => d.id), [3]);
assert.deepStrictEqual(lib.filterEntries(buffer, { errorsOnly: true }).entries.map((d) => d.id), [2, 3]);
assert.deepStrictEqual(lib.filterEntries(buffer, { kind: 'logs', errorsOnly: true }).entries.map((d) => d.id), [4]);

// 9. limit keeps the most recent matches but reports the full total
const limited = lib.filterEntries(buffer, { limit: 1 });
assert.strictEqual(limited.total, 3);
assert.deepStrictEqual(limited.entries.map((d) => d.id), [3]);

// 10. Method filter is case-insensitive
assert.deepStrictEqual(lib.filterEntries(buffer, { method: 'post' }).entries.map((d) => d.id), [1]);

// ------------------------------------------------------------------- detail

// 11. JSON bodies are pretty-printed and long bodies clipped
const det = lib.detail(req({ responseBody: JSON.stringify({ a: 'x'.repeat(500) }) }), { maxBodyChars: 100 });
assert.ok(det.responseBody.startsWith('{\n  "a"'));
assert.ok(det.responseBody.includes('truncated'));

// --------------------------------------------------------------- handshake

// 12. Proofs depend on token, role and nonce
const p = lib.proof('tok', 'server', 'n1');
assert.strictEqual(p, lib.proof('tok', 'server', 'n1'));
assert.notStrictEqual(p, lib.proof('tok', 'client', 'n1'));
assert.notStrictEqual(p, lib.proof('other', 'server', 'n1'));
assert.ok(lib.safeEqual(p, p) && !lib.safeEqual(p, 'x'));

// 13. Only extension origins may connect — never a website
assert.ok(lib.originAllowed('chrome-extension://abcdefghijklmnop'));
assert.ok(lib.originAllowed('moz-extension://1234-abcd'));
assert.ok(!lib.originAllowed('https://evil.example'));
assert.ok(!lib.originAllowed('null'));
assert.ok(!lib.originAllowed(undefined));

console.log('test_mcp: all passed');
