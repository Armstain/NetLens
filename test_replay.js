const assert = require('assert');
const {
  parseHeaderLines, formatHeaderLines, prettyJson, diffLines, collapseDiff,
} = require('./net-format.js');

// ------------------------------------------------------------------ headers

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

// --------------------------------------------------------------- prettyJson

// 9. Objects and arrays pretty-print
assert.strictEqual(prettyJson('{"a":1}'), '{\n  "a": 1\n}');
assert.strictEqual(prettyJson('[1,2]'), '[\n  1,\n  2\n]');

// 10. Non-JSON bodies return null so callers keep the raw text untouched
assert.strictEqual(prettyJson('a=1&b=2'), null);
assert.strictEqual(prettyJson('plain text'), null);
assert.strictEqual(prettyJson('{"a":'), null);
assert.strictEqual(prettyJson('42'), null);
assert.strictEqual(prettyJson(''), null);
assert.strictEqual(prettyJson(null), null);
assert.strictEqual(prettyJson(undefined), null);

// ---------------------------------------------------------------- diffLines

// 11. Identical input produces only context rows
assert.deepStrictEqual(
  diffLines('a\nb', 'a\nb'),
  [{ type: ' ', text: 'a' }, { type: ' ', text: 'b' }]
);

// 12. A changed line reads as one delete plus one add
assert.deepStrictEqual(
  diffLines('a\nb\nc', 'a\nX\nc'),
  [
    { type: ' ', text: 'a' },
    { type: '-', text: 'b' },
    { type: '+', text: 'X' },
    { type: ' ', text: 'c' },
  ]
);

// 13. Pure insertion and pure deletion at the end
assert.deepStrictEqual(diffLines('a', 'a\nb'), [{ type: ' ', text: 'a' }, { type: '+', text: 'b' }]);
assert.deepStrictEqual(diffLines('a\nb', 'a'), [{ type: ' ', text: 'a' }, { type: '-', text: 'b' }]);

// 14. Empty sides still diff rather than throwing
assert.deepStrictEqual(diffLines('', ''), [{ type: ' ', text: '' }]);
assert.deepStrictEqual(diffLines(null, 'x'), [{ type: '-', text: '' }, { type: '+', text: 'x' }]);

// 15. The real case: one field changes inside a JSON response
const before = prettyJson('{"status":"success","reason":"7 bookings found.","data":[1]}');
const after = prettyJson('{"status":"success","reason":"0 bookings found.","data":null}');
const rows = diffLines(before, after);
assert.deepStrictEqual(
  rows.filter((r) => r.type !== ' ').map((r) => r.type + r.text.trim()),
  [
    '-"reason": "7 bookings found.",',
    '-"data": [',
    '-1',
    '-]',
    '+"reason": "0 bookings found.",',
    '+"data": null',
  ]
);

// 16. Over the line cap, diffing bails out instead of locking the panel
const huge = new Array(1300).fill('x').join('\n');
assert.strictEqual(diffLines(huge, huge + '\ny'), null);

// ------------------------------------------------------------- collapseDiff

// 17. Long unchanged runs collapse, and changed lines keep their context
const many = collapseDiff(
  diffLines(
    Array.from({ length: 30 }, (_, i) => `line${i}`).join('\n'),
    Array.from({ length: 30 }, (_, i) => (i === 15 ? 'CHANGED' : `line${i}`)).join('\n')
  )
);
assert.strictEqual(many.filter((r) => r.type === '@').length, 2);
assert.strictEqual(many.filter((r) => r.type === '-').length, 1);
assert.strictEqual(many.filter((r) => r.type === '+').length, 1);
// 3 lines of context on each side of the change
assert.strictEqual(many.filter((r) => r.type === ' ').length, 6);

// 18. Nothing changed means everything collapses into a single marker
const allSame = collapseDiff(diffLines('a\nb\nc', 'a\nb\nc'));
assert.deepStrictEqual(allSame, [{ type: '@', text: '3 unchanged lines', count: 3 }]);

// 19. Singular wording for a one-line run
assert.strictEqual(collapseDiff(diffLines('a', 'a'))[0].text, '1 unchanged line');

// 20. Short diffs are left alone — nothing to collapse
assert.deepStrictEqual(
  collapseDiff(diffLines('a\nb', 'a\nX')),
  [{ type: ' ', text: 'a' }, { type: '-', text: 'b' }, { type: '+', text: 'X' }]
);

assert.deepStrictEqual(collapseDiff(null), []);

console.log('replay tests passed');
