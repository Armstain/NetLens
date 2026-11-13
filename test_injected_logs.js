const assert = require('assert');
const fs = require('fs');
const vm = require('vm');

// injected.js is a page script with no exports, so run it against a stub
// window and watch what it posts. The stub postMessage applies both hops a
// batch really takes: structured clone (page -> content script) and JSON
// (content script -> panel). Either one throwing loses the batch.
function load() {
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
  sandbox.window = sandbox;
  vm.runInNewContext(fs.readFileSync(`${__dirname}/injected.js`, 'utf8'), sandbox);
  const flush = () => { while (timers.length) timers.shift()(); };
  const entries = () => batches.flatMap((b) => b.batch);
  return { console: sandbox.console, flush, entries };
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

console.log('injected log tests passed');
