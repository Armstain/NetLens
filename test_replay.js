const assert = require('assert');
const { parseHeaderLines, formatHeaderLines } = require('./net-format.js');

// 1. Values keep every colon after the first — URLs and timestamps must survive
assert.deepStrictEqual(
  parseHeaderLines('Referer-Alt: https://app.test:8443/x\nDate-Alt: 12:30:05'),
  { 'Referer-Alt': 'https://app.test:8443/x', 'Date-Alt': '12:30:05' }
);

// 2. Blank lines, comments and junk lines are dropped, not turned into headers
assert.deepStrictEqual(
  parseHeaderLines('A: 1\n\n# a comment\nnot a header\nB: 2'),
  { A: '1', B: '2' }
);

// 3. A line starting with a colon has no name, so it cannot become a header
assert.deepStrictEqual(parseHeaderLines(':nope'), {});

// 4. Surrounding whitespace is trimmed off both name and value
assert.deepStrictEqual(parseHeaderLines('   X-Key   :   v   '), { 'X-Key': 'v' });

// 5. An empty value is legal and must be preserved, not dropped
assert.deepStrictEqual(parseHeaderLines('X-Empty:'), { 'X-Empty': '' });

// 6. CRLF is what a pasted header block usually carries
assert.deepStrictEqual(parseHeaderLines('A: 1\r\nB: 2'), { A: '1', B: '2' });

// 7. Round trip: what the editor shows must parse back to what it was given
const headers = {
  'Content-Type': 'application/json',
  Authorization: 'Bearer abc.def-ghi',
  'X-Trace': 'a:b:c',
};
assert.deepStrictEqual(parseHeaderLines(formatHeaderLines(headers)), headers);

// 8. Missing or malformed input never throws
assert.deepStrictEqual(parseHeaderLines(null), {});
assert.deepStrictEqual(parseHeaderLines(undefined), {});
assert.deepStrictEqual(parseHeaderLines(''), {});
assert.strictEqual(formatHeaderLines(null), '');
assert.strictEqual(formatHeaderLines({}), '');

console.log('replay tests passed');
