const assert = require('assert');
const { entryBytes, sessionsToPrune, entriesToTrim } = require('./store.js');
const { dayLabel } = require('./net-format.js');

// ----------------------------------------------------------------- sizing

// 1. Both bodies count toward an entry's cost, plus a flat metadata allowance
assert.strictEqual(entryBytes({ requestBody: 'ab', responseBody: 'cde' }), 517);
assert.strictEqual(entryBytes({}), 512);
assert.strictEqual(entryBytes(null), 0);

// 2. Non-string bodies (placeholders, nulls) cost nothing beyond the allowance
assert.strictEqual(entryBytes({ requestBody: null, responseBody: undefined }), 512);

// ----------------------------------------------------------------- pruning

const mk = (id, startedAt, bytes) => ({ id, startedAt, bytes });

// 3. Under both caps, nothing is pruned
assert.deepStrictEqual(sessionsToPrune([mk(1, 100, 10), mk(2, 200, 10)], 5, 1000), []);

// 4. Over the session cap, the oldest go first
assert.deepStrictEqual(
  sessionsToPrune([mk(1, 100, 1), mk(2, 200, 1), mk(3, 300, 1), mk(4, 400, 1)], 2, 1e9),
  [1, 2]
);

// 5. Over the byte cap, sessions are dropped until it fits
assert.deepStrictEqual(
  sessionsToPrune([mk(1, 100, 600), mk(2, 200, 600), mk(3, 300, 600)], 99, 1000),
  [1, 2]
);

// 6. Input order does not matter — pruning is by age, not array position
assert.deepStrictEqual(
  sessionsToPrune([mk(3, 300, 1), mk(1, 100, 1), mk(2, 200, 1)], 1, 1e9),
  [1, 2]
);

// 7. The newest session is the live one being written to and is never dropped,
//    even when it alone blows the byte budget
assert.deepStrictEqual(sessionsToPrune([mk(1, 100, 99999)], 99, 10), []);
assert.deepStrictEqual(sessionsToPrune([mk(1, 100, 5), mk(2, 200, 99999)], 99, 10), [1]);

// 8. Missing byte counts are treated as zero rather than NaN-poisoning the sum
assert.deepStrictEqual(sessionsToPrune([mk(1, 100), mk(2, 200)], 1, 1e9), [1]);

// 9. Empty input never throws
assert.deepStrictEqual(sessionsToPrune([], 5, 100), []);
assert.deepStrictEqual(sessionsToPrune(null, 5, 100), []);

// ---------------------------------------------------------------- dayLabel

const now = new Date(2026, 8, 17, 13, 30).getTime(); // 17 Sep 2026, 13:30 local
const at = (...args) => new Date(...args).getTime();

// 10. Anything after local midnight today is Today, including 00:01
assert.strictEqual(dayLabel(now, now), 'Today');
assert.strictEqual(dayLabel(at(2026, 8, 17, 0, 1), now), 'Today');

// 11. Late last night is Yesterday, not Today — the boundary is midnight, not
//     a rolling 24 hours
assert.strictEqual(dayLabel(at(2026, 8, 16, 23, 59), now), 'Yesterday');

// 12. Within the past week, the weekday name; older than that, a date
assert.strictEqual(dayLabel(at(2026, 8, 14, 9, 0), now), new Date(2026, 8, 14).toLocaleDateString([], { weekday: 'long' }));
assert.strictEqual(dayLabel(at(2026, 7, 1, 9, 0), now), new Date(2026, 7, 1).toLocaleDateString([], { month: 'short', day: 'numeric' }));

// ----------------------------------------------------- trimming one session

// 13. A session inside the budget loses nothing, including exactly at the cap
assert.strictEqual(entriesToTrim([40, 40], 100), 0);
assert.strictEqual(entriesToTrim([50, 50], 100), 0);

// 14. Over the cap, the oldest go until it is at 80% — not merely under 100%,
//     or the next write would trigger another trim straight away
assert.strictEqual(entriesToTrim([30, 30, 30, 30], 100), 2);
assert.strictEqual(entriesToTrim([10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10], 100), 3);

// 15. The newest entry survives even when it alone is over the budget
assert.strictEqual(entriesToTrim([10, 500], 100), 1);
assert.strictEqual(entriesToTrim([500], 100), 0);

// 16. Empty input never throws
assert.strictEqual(entriesToTrim([], 100), 0);
assert.strictEqual(entriesToTrim(null, 100), 0);

console.log('store tests passed');
