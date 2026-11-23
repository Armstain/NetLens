const test = require('node:test');
const assert = require('assert');
global.LZString = require('./lz-string.js');
const {
  b64Decode, b64UrlDecode, hexDecodeStr, jwtDecode, unicodeEscapeDecode, urlDecodeStr,
  DECODER_STEP_MAP, runChainDecoder, tryDecode, tryDecodeStructure, hasDecodableData,
  urlMatches, parseStep, chainLabel,
} = require('./decoders.js');

const pick = (r) => r && { method: r.method, value: r.value };

const obj = { user: 'alice', id: 42 };
const json = JSON.stringify(obj);
const b64 = Buffer.from(json).toString('base64');
const b64url = Buffer.from(json).toString('base64url');
const hex = Buffer.from(json).toString('hex');

test('base64 decodes and rejects junk', () => {
  assert.strictEqual(b64Decode(b64), json);
  assert.strictEqual(b64Decode('abc'), null);
  assert.strictEqual(b64Decode('abcdefg'), null);
  assert.deepStrictEqual(DECODER_STEP_MAP.base64.fn(b64), obj);
});

test('base64url decodes without padding', () => {
  assert.strictEqual(b64UrlDecode(b64url), json);
  assert.deepStrictEqual(DECODER_STEP_MAP.base64url.fn(b64url), obj);
});

test('url-safe base64 is still labelled Base64URL', () => {
  const urlSafe = Buffer.from('{"k":"??>>"}').toString('base64url');
  assert.match(urlSafe, /[-_]/);
  assert.deepStrictEqual(pick(tryDecode(urlSafe)), { method: 'Base64URL', value: { k: '??>>' } });
});

test('utf-8 text survives base64, base64url, hex and jwt', () => {
  const intl = { name: 'José 東京 🚀' };
  const s = JSON.stringify(intl);
  assert.deepStrictEqual(DECODER_STEP_MAP.base64.fn(Buffer.from(s).toString('base64')), intl);
  assert.deepStrictEqual(DECODER_STEP_MAP.base64url.fn(Buffer.from(s).toString('base64url')), intl);
  assert.deepStrictEqual(DECODER_STEP_MAP.hex.fn(Buffer.from(s).toString('hex')), intl);
  const part = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  assert.deepStrictEqual(jwtDecode(`${part({ alg: 'none' })}.${part(intl)}.x`).payload, intl);
});

test('binary that is not utf-8 is rejected', () => {
  assert.strictEqual(b64Decode(Buffer.from([0xff, 0xfe, 0x80, 0x81, 0xc0, 0xc1]).toString('base64')), null);
});

test('hex decodes and rejects odd length', () => {
  assert.strictEqual(hexDecodeStr(hex), json);
  assert.strictEqual(hexDecodeStr(hex + 'a'), null);
  assert.deepStrictEqual(DECODER_STEP_MAP.hex.fn(hex), obj);
});

test('jwt splits header, payload and signature', () => {
  const part = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const token = `${part({ alg: 'HS256' })}.${part(obj)}.sig123`;
  assert.deepStrictEqual(jwtDecode(token), { header: { alg: 'HS256' }, payload: obj, signature: 'sig123' });
  assert.strictEqual(jwtDecode('a.b'), null);
});

test('url and unicode escapes', () => {
  assert.strictEqual(urlDecodeStr(encodeURIComponent(json)), json);
  assert.strictEqual(urlDecodeStr('plain'), null);
  assert.strictEqual(urlDecodeStr('%E0%A4%A'), null);
  assert.strictEqual(unicodeEscapeDecode('\\u0068\\u0069'), 'hi');
  assert.strictEqual(unicodeEscapeDecode('no escapes'), null);
});

test('json step only accepts objects and arrays', () => {
  assert.deepStrictEqual(DECODER_STEP_MAP.json.fn(json), obj);
  assert.strictEqual(DECODER_STEP_MAP.json.fn('"str"'), null);
  assert.strictEqual(DECODER_STEP_MAP.json.fn('{bad'), null);
});

test('chain runs steps in the given order', () => {
  const padded = Buffer.from('{"a":1}').toString('base64');
  assert.ok(padded.endsWith('='));
  assert.deepStrictEqual(runChainDecoder(['urlDecode', 'base64'], encodeURIComponent(padded)), { a: 1 });
  assert.deepStrictEqual(runChainDecoder(['base64', 'json'], b64), obj);
  assert.deepStrictEqual(runChainDecoder(['base64', 'base64'], Buffer.from(b64).toString('base64')), obj);
  const urlInB64 = Buffer.from(encodeURIComponent(json)).toString('base64');
  assert.deepStrictEqual(runChainDecoder(['base64', 'urlDecode'], urlInB64), obj);
});

test('caesar step takes a shift and chains into lzstring', () => {
  assert.deepStrictEqual(runChainDecoder(['caesar:9', 'lzstring'], 'W4RpqrKlLVJ0RLVxP0ZJ8CfS4pUxO8p'), { a: 1, b: ['x', 'y'] });
  assert.strictEqual(DECODER_STEP_MAP.caesar.auto, false);
  assert.strictEqual(parseStep('caesar').arg, 9);
  assert.strictEqual(parseStep('caesar:0'), null);
  assert.strictEqual(parseStep('caesar:26'), null);
  assert.strictEqual(chainLabel(['caesar:3', 'base64']), 'Caesar shift (3) → Base64');
});

test('auto decode finds the caesar shift and multi-step chains', () => {
  assert.deepStrictEqual(tryDecode('W4RpqrKlLVJ0RLVxP0ZJ8CfS4pUxO8p'), { method: 'Caesar shift (9) → LZString', value: { a: 1, b: ['x', 'y'] }, confidence: 'json', steps: ['caesar:9', 'lzstring'] });
  const nested = Buffer.from(Buffer.from(json).toString('hex')).toString('base64');
  assert.deepStrictEqual(tryDecode(nested), { method: 'Base64 → Hex', value: obj, confidence: 'json', steps: ['base64', 'hex'] });
  assert.strictEqual(tryDecode('just-a-plain-slug-value'), null);
  assert.strictEqual(tryDecode('"W4RpqrKlLVJ0RLVxP0ZJ8CfS4pUxO8p"').method, 'Caesar shift (9) → LZString');
});

test('chain with an unknown or failing step returns null', () => {
  assert.strictEqual(runChainDecoder(['caesarLz'], b64), null);
  assert.strictEqual(runChainDecoder(['caesar:99'], b64), null);
  assert.strictEqual(runChainDecoder(['base64', 'caesarLz'], b64), null);
  assert.strictEqual(runChainDecoder(['hex'], b64), null);
});

test('rules win over auto-detect and a broken one falls through', () => {
  const custom = [{ id: '1', name: 'Mine', type: 'chain', steps: ['base64'] }];
  assert.deepStrictEqual(tryDecode(b64, custom), { method: 'Mine', value: obj, confidence: 'rule', steps: ['base64'], ruleId: '1' });
  const stale = [{ id: '2', name: 'Old', type: 'chain', steps: ['caesarLz'] }];
  assert.deepStrictEqual(pick(tryDecode(b64, stale)), { method: 'Base64', value: obj });
});

test('rules only apply to matching urls', () => {
  const rules = [{ id: '1', name: 'Plans', type: 'chain', steps: ['base64'], match: 'api.example.com/plans/*' }];
  assert.strictEqual(tryDecode(b64, rules, 'https://api.example.com/plans/42?x=1').confidence, 'rule');
  assert.strictEqual(tryDecode(b64, rules, 'https://other.test/plans/42').confidence, 'json');
  assert.strictEqual(tryDecode(b64, rules).confidence, 'json');
});

test('url patterns: substring without *, glob with *', () => {
  assert.ok(urlMatches('', 'https://a.test/x'));
  assert.ok(urlMatches('example.com', 'https://api.example.com/v1'));
  assert.ok(urlMatches('https://api.example.com/v1/*', 'https://api.example.com/v1/users'));
  assert.ok(urlMatches('*.example.com/*', 'https://api.EXAMPLE.com/v1'));
  assert.ok(!urlMatches('api.example.com/v1/*', 'https://api.example.com/v2/users'));
  assert.ok(!urlMatches('example.com', undefined));
});

test('plain-text results are marked as a guess', () => {
  const r = tryDecode(Buffer.from('hello there friend').toString('base64'));
  assert.strictEqual(r.confidence, 'text');
  assert.strictEqual(r.value, 'hello there friend');
});

test('auto decode trims and picks the right decoder', () => {
  assert.deepStrictEqual(pick(tryDecode(`  ${b64}\n`)), { method: 'Base64', value: obj });
  assert.strictEqual(tryDecode(hex).method, 'Hex');
  assert.strictEqual(tryDecode(encodeURIComponent(json)).method, 'URL Decode');
});

test('ordinary strings are left alone', () => {
  for (const s of ['hello', 'username', 'alice@example.com', '12345678', 'true', 'GET', 'Bearer', 'application/json', 'deadbeef', '2026-11-15T10:00:00Z']) {
    assert.strictEqual(tryDecode(s), null, `false positive on ${JSON.stringify(s)}`);
  }
  assert.strictEqual(tryDecode(''), null);
  assert.strictEqual(tryDecode(42), null);
});

test('structure decodes nested values in place', () => {
  const body = JSON.stringify({ a: b64, list: ['plain', hex], nested: { n: 1 } });
  const res = tryDecodeStructure(body);
  assert.strictEqual(res.method, 'JSON Structure');
  assert.deepStrictEqual(res.value.a, { __decoded: true, method: 'Base64', value: obj, confidence: 'json' });
  assert.strictEqual(res.value.list[0], 'plain');
  assert.strictEqual(res.value.list[1].method, 'Hex');
  assert.deepStrictEqual(res.value.nested, { n: 1 });
  assert.strictEqual(tryDecodeStructure('{"a":"plain"}'), null);
});

test('hasDecodableData looks at url, bodies and headers', () => {
  assert.strictEqual(hasDecodableData({ url: `https://x.test/p?q=${encodeURIComponent(b64)}` }), true);
  assert.strictEqual(hasDecodableData({ url: 'https://x.test/', requestHeaders: { 'x-t': b64 } }), true);
  assert.strictEqual(hasDecodableData({ url: 'https://x.test/a?b=c', responseBody: '{"ok":true}' }), false);
  assert.strictEqual(hasDecodableData({ url: 'not a url' }), false);
  const fnRule = [{ id: 'f', name: 'Fn', type: 'function', code: 'return input', match: 'x.test/a' }];
  assert.strictEqual(hasDecodableData({ url: 'https://x.test/a?b=c' }, fnRule), true);
  assert.strictEqual(hasDecodableData({ url: 'https://y.test/a?b=c' }, fnRule), false);
});
