const assert = require('assert');
const { isError, isSocket, isSlow, isLarge, diagnose } = require('./net-format.js');
const { entryBytes } = require('./store.js');

const conn = (event, extra) => Object.assign({ kind: 'ws', wsId: 'ws1', transport: 'ws', event }, extra);
const frame = (extra) => Object.assign({ kind: 'wsframe', wsId: 'ws1', transport: 'ws', dir: 'recv' }, extra);

// ---------------------------------------------------------------- isSocket

assert.strictEqual(isSocket(conn('open')), true);
assert.strictEqual(isSocket(frame({})), true);
assert.strictEqual(isSocket({ kind: 'fetch' }), false);
assert.strictEqual(isSocket({ kind: 'log', level: 'error' }), false);

// ----------------------------------------------------------------- isError

// 1. A socket error, and a close that was not clean, are real failures
assert.strictEqual(isError(conn('error')), true);
assert.strictEqual(isError(conn('close', { wasClean: false })), true);

// 2. A clean close and a healthy open are not
assert.strictEqual(isError(conn('close', { wasClean: true })), false);
assert.strictEqual(isError(conn('open')), false);
assert.strictEqual(isError(conn('connecting')), false);

// 3. A frame is payload; it is never an error on its own, whatever it carries
assert.strictEqual(isError(frame({ data: '{"error":"boom"}' })), false);

// 4. Sockets must not disturb the existing HTTP rules
assert.strictEqual(isError({ kind: 'fetch', status: 500 }), true);
assert.strictEqual(isError({ kind: 'fetch', status: 200 }), false);

// ------------------------------------------------------- slow / large

// 5. A socket's duration is how long it stayed connected. A healthy
//    all-day connection must not be reported as a slow request.
assert.strictEqual(isSlow(conn('close', { duration: 8 * 60 * 60 * 1000 })), false);
assert.strictEqual(isSlow(frame({ duration: 99999 })), false);
// the HTTP rule is untouched
assert.strictEqual(isSlow({ kind: 'fetch', duration: 99999 }), true);

// 6. Same for size
assert.strictEqual(isLarge(conn('open', { responseSize: 99 * 1024 * 1024 })), false);
assert.strictEqual(isLarge({ kind: 'fetch', responseSize: 99 * 1024 * 1024 }), true);

// ---------------------------------------------------------------- diagnose

// 7. A dropped connection surfaces; its frames and a clean close do not
const report = diagnose([
  conn('open'),
  frame({ data: 'hello' }),
  frame({ data: 'world' }),
  conn('error'),
  { kind: 'fetch', status: 200, duration: 10, responseSize: 10 },
]);
assert.strictEqual(report.failed.length, 1);
assert.strictEqual(report.failed[0].event, 'error');
assert.strictEqual(report.slow.length, 0);
assert.strictEqual(report.large.length, 0);
assert.strictEqual(report.consoleErrors.length, 0);

// -------------------------------------------------------------- accounting

// 8. A frame's payload counts toward the storage budget — it lives on .data,
//    not on a body field, and was invisible to the byte cap before
assert.strictEqual(entryBytes(frame({ data: 'x'.repeat(100) })), 612);
assert.strictEqual(entryBytes(conn('open')), 512);

console.log('socket tests passed');
