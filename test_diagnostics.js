const assert = require('assert');
const { isSlow, isLarge, diagnose, SLOW_MS, LARGE_BYTES } = require('./net-format.js');

// ------------------------------------------------------------------ isSlow

// 1. At or above the threshold counts, just under does not
assert.strictEqual(isSlow({ duration: SLOW_MS }), true);
assert.strictEqual(isSlow({ duration: SLOW_MS - 1 }), false);

// 2. Logs have no duration semantics and are never flagged, cap or not
assert.strictEqual(isSlow({ kind: 'log', duration: 99999 }), false);

// 3. Missing duration is not slow, not a crash
assert.strictEqual(isSlow({}), false);

// 4. A custom threshold overrides the default
assert.strictEqual(isSlow({ duration: 500 }, 400), true);

// ----------------------------------------------------------------- isLarge

// 5. At or above the byte threshold counts
assert.strictEqual(isLarge({ responseSize: LARGE_BYTES }), true);
assert.strictEqual(isLarge({ responseSize: LARGE_BYTES - 1 }), false);
assert.strictEqual(isLarge({ kind: 'log', responseSize: 99999999 }), false);
assert.strictEqual(isLarge({}), false);

// ----------------------------------------------------------------- diagnose

// 6. Each capture lands in every bucket it qualifies for, not just one
const entries = [
  { kind: 'fetch', status: 500, duration: 100, responseSize: 100 }, // failed only
  { kind: 'fetch', status: 200, duration: 4000, responseSize: 100 }, // slow only
  { kind: 'fetch', status: 200, duration: 100, responseSize: 2 * 1024 * 1024 }, // large only
  { kind: 'fetch', status: 500, duration: 5000, responseSize: 3 * 1024 * 1024 }, // all three
  { kind: 'fetch', status: 200, duration: 50, responseSize: 10 }, // clean, in none
  { kind: 'log', level: 'error', message: 'boom' }, // console error
  { kind: 'log', level: 'warn', message: 'meh' }, // not an error, excluded
  { kind: 'fetch', failed: true, status: 0, duration: 10 }, // network failure
];
const d = diagnose(entries);
assert.strictEqual(d.failed.length, 3); // 500, 500+slow+large, network failure
assert.strictEqual(d.slow.length, 2);
assert.strictEqual(d.large.length, 2);
assert.strictEqual(d.consoleErrors.length, 1);
assert.strictEqual(d.consoleErrors[0].message, 'boom');

// 7. Empty and missing input never throw
assert.deepStrictEqual(diagnose([]), { failed: [], consoleErrors: [], slow: [], large: [] });
assert.deepStrictEqual(diagnose(null), { failed: [], consoleErrors: [], slow: [], large: [] });

console.log('diagnostics tests passed');
