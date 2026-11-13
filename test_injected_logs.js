const assert = require('assert');
const fs = require('fs');
const vm = require('vm');

// injected.js is a page script with no exports, so run it against a stub
// window and watch what it posts. The stub postMessage applies both hops a
// batch really takes: structured clone (page -> content script) and JSON
// (content script -> panel). Either one throwing loses the batch.
function load(extra) {
  const batches = [];
  const timers = [];
  const quiet = () => {};
  const XHR = function () {};
  XHR.prototype = { open: quiet, send: quiet, setRequestHeader: quiet };
  const sandbox = {
    console: { error: quiet, warn: quiet, info: quiet, log: quiet, debug: quiet },
    localStorage: { getItem: () => null, setItem: quiet },
    performance: { now: () => 0 },
    location: { href: 'https://x.test/' },
    XMLHttpRequest: XHR,
    URL,
    setTimeout: (fn) => { timers.push(fn); return timers.length; },
    clearTimeout: quiet,
    addEventListener: quiet,
    postMessage: (msg) => { batches.push(JSON.parse(JSON.stringify(structuredClone(msg)))); },
  };
  Object.assign(sandbox, extra);
  sandbox.window = sandbox;
  vm.runInNewContext(fs.readFileSync(`${__dirname}/injected.js`, 'utf8'), sandbox);
  const flush = () => { while (timers.length) timers.shift()(); };
  const entries = () => batches.flatMap((b) => b.batch);
  return { console: sandbox.console, window: sandbox, flush, entries };
}

// 1. A bigint used to reach the ring buffer raw, and runtime messaging then
//    refused to serialise the whole buffer for the rest of the page's life.
{
  const page = load();
  page.console.log('before');
  page.console.log(10n);
  page.console.log('count', { total: 2n ** 70n });
  page.flush();
  const logs = page.entries();
  assert.strictEqual(logs.length, 3);
  assert.strictEqual(logs[1].message, '10n');
  assert.deepStrictEqual(logs[1].args, ['10n']);
  assert.strictEqual(logs[2].message, 'count {"total":"1180591620717411303424n"}');
}

// 2. A symbol made postMessage throw after the queue was already emptied, so
//    it took every other capture in the same flush window with it.
{
  const page = load();
  page.console.log('before');
  page.console.log(Symbol('x'), [Symbol.iterator]);
  page.console.log('after');
  page.flush();
  const logs = page.entries();
  assert.deepStrictEqual(logs.map((l) => l.message), ['before', 'Symbol(x) ["Symbol(Symbol.iterator)"]', 'after']);
  assert.deepStrictEqual(logs[1].args, ['Symbol(x)', ['Symbol(Symbol.iterator)']]);
}

// 3. Ordinary values are untouched by the conversion
{
  const page = load();
  page.console.log('n', 1, true, null, { a: [1, 'b'] });
  page.flush();
  const [log] = page.entries();
  assert.strictEqual(log.message, 'n 1 true null {"a":[1,"b"]}');
  assert.deepStrictEqual(log.args, ['n', 1, true, null, { a: [1, 'b'] }]);
}

// 4. Date, RegExp, Map and Set have no enumerable keys and used to log as {}
{
  const page = load();
  page.console.log(new Date(0), /a+/gi, new Map([['k', { v: 1 }]]), new Set([1, 'two']));
  page.flush();
  const [log] = page.entries();
  assert.deepStrictEqual(log.args, [
    '1970-01-01T00:00:00.000Z',
    '/a+/gi',
    { 'Map(1)': [['k', { v: 1 }]] },
    { 'Set(2)': [1, 'two'] },
  ]);
  assert.strictEqual(log.message, '1970-01-01T00:00:00.000Z /a+/gi {"Map(1)":[["k",{"v":1}]]} {"Set(2)":[1,"two"]}');
}

// 5. Logging an object must not run its getters, and each plain value is
//    read once, not once for the message and again for the args
{
  const page = load();
  let getterRuns = 0;
  let reads = 0;
  const obj = { get lazy() { getterRuns++; return 1; }, plain: 2 };
  const counted = new Proxy({ a: 1 }, { get(t, k) { if (k === 'a') reads++; return t[k]; } });
  page.console.log(obj, counted);
  page.flush();
  const [log] = page.entries();
  assert.strictEqual(getterRuns, 0);
  assert.strictEqual(reads, 1);
  assert.deepStrictEqual(log.args, [{ lazy: '[Getter]', plain: 2 }, { a: 1 }]);
}

// 6. A huge object graph is cut off by a total budget, not walked to the end
{
  const page = load();
  const wide = (depth) => (depth === 0 ? 1 : Object.fromEntries(Array.from({ length: 50 }, (_, i) => [`k${i}`, wide(depth - 1)])));
  let visited = 0;
  const count = (v) => { visited++; if (v && typeof v === 'object') Object.values(v).forEach(count); };
  page.console.log(wide(3));
  page.flush();
  const [log] = page.entries();
  count(log.args[0]);
  assert.ok(visited < 5000, `walked ${visited} nodes`);
  assert.ok(log.message.includes('truncated'));
}

// 7. A fetch the page aborted itself is marked aborted; a real network
//    failure is not
(async () => {
  const abortErr = Object.assign(new Error('The user aborted a request.'), { name: 'AbortError' });
  const netErr = new TypeError('Failed to fetch');
  const page = load({ fetch: (url) => Promise.reject(String(url).includes('abort') ? abortErr : netErr) });
  await page.window.fetch('/api/abort').catch(() => {});
  await page.window.fetch('/api/down').catch(() => {});
  await new Promise((r) => setImmediate(r));
  page.flush();
  const done = page.entries().filter((d) => d.kind === 'fetch' && !d.pending);
  assert.deepStrictEqual(done.map((d) => [d.url, d.failed, d.aborted]), [
    ['https://x.test/api/abort', true, true],
    ['https://x.test/api/down', true, false],
  ]);
  console.log('injected log tests passed');
})().catch((err) => { console.error(err); process.exit(1); });
