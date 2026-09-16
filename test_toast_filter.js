const assert = require('assert');
const {
  DEFAULT_TOAST_SETTINGS, TOAST_PRESETS, TOAST_METHODS, TOAST_METHOD_GROUPS,
  normalizeToastSettings, buildUrlTest, toastMatch,
} = require('./net-format.js');

const on = (preset, over) => normalizeToastSettings({ enabled: true, ...TOAST_PRESETS[preset], ...over });

const okJson = { kind: 'fetch', method: 'GET', url: 'https://x.test/api/users', status: 200, duration: 120, contentType: 'application/json' };
const slowJson = { ...okJson, duration: 1500 };
const notFound = { ...okJson, status: 404 };
// A fetch rejection: injected.js sets status 0 and omits contentType entirely.
const netFail = { kind: 'fetch', method: 'GET', url: 'https://x.test/api/users', status: 0, statusText: 'Failed to fetch', failed: true, duration: 30 };
const postJson = { ...okJson, method: 'POST', url: 'https://x.test/api/orders', status: 201 };
const gqlQuery = { kind: 'fetch', method: 'POST', url: 'https://x.test/graphql', status: 200, duration: 90, contentType: 'application/json', requestBody: '{"query":"query Feed($n:Int){feed(n:$n){id}}"}' };
const gqlMutation = { ...gqlQuery, requestBody: '{"query":"mutation AddPost($t:String){addPost(t:$t){id}}"}' };
const image = { kind: 'fetch', method: 'GET', url: 'https://x.test/logo.png', status: 200, duration: 40, contentType: 'image/png' };
const logEntry = { kind: 'log', level: 'error', message: 'boom' };

// 1. The blind spot: a failure carries no contentType, so an isApi()-only test
//    would silently drop exactly the calls worth interrupting for.
assert.strictEqual(toastMatch(netFail, on('errors')), true);
assert.strictEqual(toastMatch(netFail, on('all')), true);

// 2. Disabled beats every other setting
assert.strictEqual(toastMatch(netFail, normalizeToastSettings({ ...TOAST_PRESETS.all })), false);

// 3. Errors preset stays quiet on healthy traffic; All does not
assert.strictEqual(toastMatch(okJson, on('errors')), false);
assert.strictEqual(toastMatch(notFound, on('errors')), true);
assert.strictEqual(toastMatch(okJson, on('all')), true);

// 4. Slow is an escape hatch independent of status class
assert.strictEqual(toastMatch(slowJson, on('slow')), true);
assert.strictEqual(toastMatch(okJson, on('slow')), false);
assert.strictEqual(toastMatch(slowJson, on('errors')), false);
assert.strictEqual(toastMatch(slowJson, on('errors', { slowMs: 1000 })), true);
// slowMs 0 disables the check rather than matching everything
assert.strictEqual(toastMatch(okJson, on('slow', { slowMs: 0 })), false);

// 5. Method gating
assert.strictEqual(toastMatch(postJson, on('mutations')), true);
assert.strictEqual(toastMatch(okJson, on('mutations')), false);
// An unlisted verb passes unless explicitly unticked
assert.strictEqual(toastMatch({ ...postJson, method: 'PROPFIND' }, on('all')), true);
assert.strictEqual(toastMatch(postJson, on('all', { methods: { POST: false } })), false);

// 6. GraphQL sends reads and writes alike as POST, so the method cannot decide
assert.strictEqual(toastMatch(gqlQuery, on('mutations')), false);
assert.strictEqual(toastMatch(gqlMutation, on('mutations')), true);
// ...but only when the caller asked for that distinction
assert.strictEqual(toastMatch(gqlQuery, on('all')), true);

// 7. URL match: substring, then regex, then a broken regex degrading to substring
assert.strictEqual(toastMatch(okJson, on('all', { urlMatch: '/api/' })), true);
assert.strictEqual(toastMatch(okJson, on('all', { urlMatch: '/admin/' })), false);
assert.strictEqual(toastMatch(okJson, on('all', { urlMatch: '/\\/api\\/u/' })), true);
assert.strictEqual(toastMatch(okJson, on('all', { urlMatch: '/v[0-9]+\\//' })), false);
assert.strictEqual(buildUrlTest('/api(/')('https://x.test/api(/x'), true);
// A bare string is a case-insensitive substring; slash-delimited is a regex and
// so keeps regex casing rules.
assert.strictEqual(buildUrlTest('API')('https://x.test/api/users'), true);
assert.strictEqual(buildUrlTest('/API/')('https://x.test/api/users'), false);
assert.strictEqual(buildUrlTest('/API/i')('https://x.test/api/users'), true);

// 8. Non-API responses and console entries never toast
assert.strictEqual(toastMatch(image, on('all')), false);
assert.strictEqual(toastMatch(logEntry, on('all')), false);

// 9. normalize fills gaps, clamps nonsense, and keeps dedupe opt-out honest
const norm = normalizeToastSettings({ enabled: true, maxStack: 999, dismissMs: 'abc', status: { s2xx: true } });
assert.strictEqual(norm.maxStack, 20);
assert.strictEqual(norm.dismissMs, DEFAULT_TOAST_SETTINGS.dismissMs);
assert.strictEqual(norm.status.s2xx, true);
assert.strictEqual(norm.status.s4xx, true);       // untouched default survives
assert.strictEqual(norm.methods.GET, true);
assert.strictEqual(norm.dedupe, true);
assert.strictEqual(normalizeToastSettings({ dedupe: false }).dedupe, false);
assert.strictEqual(normalizeToastSettings(null).enabled, false);
assert.strictEqual(normalizeToastSettings({ position: 'middle' }).position, 'bottom-right');

// 10. Method groups drive the settings UI, so every verb must belong to exactly
//     one group — otherwise a chip exists that no group chip can ever toggle.
const grouped = [...TOAST_METHOD_GROUPS.reads, ...TOAST_METHOD_GROUPS.writes];
assert.deepStrictEqual([...grouped].sort(), [...TOAST_METHODS].sort());
assert.strictEqual(new Set(grouped).size, grouped.length);
for (const method of TOAST_METHODS) {
  assert.strictEqual(DEFAULT_TOAST_SETTINGS.methods[method], true, `${method} missing from defaults`);
}

// 11. OPTIONS is deliberately absent: a CORS preflight never reaches the
//     patched fetch/XHR, so a chip for it could never match anything.
assert.ok(!TOAST_METHODS.includes('OPTIONS'));
assert.strictEqual(toastMatch({ ...postJson, method: 'OPTIONS' }, on('all')), true); // unlisted verb still passes

console.log('toast filter: all assertions passed');
