const assert = require('assert');
const { tryParsePartialJson } = require('./decoders.js');

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
