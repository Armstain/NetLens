const assert = require('assert');

// Simulate the filtering logic from sidepanel.js
function filterEntries(entries, opts) {
  const {
    filterText = '',
    scope = 'all', // 'all' | 'api' | 'console'
    logLevel = 'all',
  } = opts;

  const q = filterText.toLowerCase();

  return entries.filter((entry) => {
    const isEntryLog = entry.kind === 'log';
    const isEntryApi = (entry.contentType || '').includes('json');

    // 1. Text search
    let matchesText = true;
    if (q) {
      const hay = (entry.message || entry.url || '').toLowerCase();
      matchesText = hay.includes(q);
    }

    // 2. Scope filter
    let matchesScope = true;
    if (scope === 'api') {
      matchesScope = !isEntryLog && isEntryApi;
    } else if (scope === 'console') {
      matchesScope = isEntryLog;
    }

    // 3. Level filter (when on console)
    let matchesLevel = true;
    if (isEntryLog && scope === 'console' && logLevel !== 'all') {
      matchesLevel = entry.level === logLevel;
    }

    return matchesText && matchesScope && matchesLevel;
  });
}

// Mock dataset
const sampleEntries = [
  { id: 1, kind: 'fetch', method: 'GET', url: 'https://api.example.com/users', status: 200, contentType: 'application/json' },
  { id: 2, kind: 'fetch', method: 'POST', url: 'https://api.example.com/login', status: 401, contentType: 'application/json' },
  { id: 3, kind: 'fetch', method: 'GET', url: 'https://example.com/style.css', status: 200, contentType: 'text/css' },
  { id: 4, kind: 'log', level: 'error', message: 'Uncaught TypeError: Cannot read properties of undefined' },
  { id: 5, kind: 'log', level: 'warn', message: 'Deprecation warning: component will unmount soon' },
  { id: 6, kind: 'log', level: 'info', message: 'User signed in successfully' },
  { id: 7, kind: 'log', level: 'log', message: 'Component rendered in 14ms' },
  { id: 8, kind: 'log', level: 'debug', message: 'Cache hit for key: user_profile' },
];

// 1. Default scope = 'all': shows all entries (network + console)
const rAll = filterEntries(sampleEntries, { scope: 'all' });
assert.strictEqual(rAll.length, 8);

// 2. Scope = 'api': shows only API network calls (no console, no static files)
const rApi = filterEntries(sampleEntries, { scope: 'api' });
assert.strictEqual(rApi.length, 2);
assert.strictEqual(rApi.every(e => e.kind !== 'log' && (e.contentType || '').includes('json')), true);

// 3. Scope = 'console': shows ONLY console logs (all network hidden)
const rConsole = filterEntries(sampleEntries, { scope: 'console' });
assert.strictEqual(rConsole.length, 5);
assert.strictEqual(rConsole.every(e => e.kind === 'log'), true);

// 4. Scope = 'console' + logLevel = 'error' (Console Errors)
const rError = filterEntries(sampleEntries, { scope: 'console', logLevel: 'error' });
assert.strictEqual(rError.length, 1);
assert.strictEqual(rError[0].level, 'error');

// 5. Scope = 'console' + logLevel = 'warn'
const rWarn = filterEntries(sampleEntries, { scope: 'console', logLevel: 'warn' });
assert.strictEqual(rWarn.length, 1);
assert.strictEqual(rWarn[0].level, 'warn');

// 6. Scope = 'console' + logLevel = 'info'
const rInfo = filterEntries(sampleEntries, { scope: 'console', logLevel: 'info' });
assert.strictEqual(rInfo.length, 1);
assert.strictEqual(rInfo[0].level, 'info');

// 7. Scope = 'console' + logLevel = 'log'
const rLog = filterEntries(sampleEntries, { scope: 'console', logLevel: 'log' });
assert.strictEqual(rLog.length, 1);
assert.strictEqual(rLog[0].level, 'log');

// 8. Scope = 'console' + logLevel = 'debug'
const rDebug = filterEntries(sampleEntries, { scope: 'console', logLevel: 'debug' });
assert.strictEqual(rDebug.length, 1);
assert.strictEqual(rDebug[0].level, 'debug');

// 9. Search query within console scope
const rSearchConsole = filterEntries(sampleEntries, { scope: 'console', filterText: 'cache' });
assert.strictEqual(rSearchConsole.length, 1);
assert.strictEqual(rSearchConsole[0].id, 8);

// 10. Search query within API scope
const rSearchApi = filterEntries(sampleEntries, { scope: 'api', filterText: 'login' });
assert.strictEqual(rSearchApi.length, 1);
assert.strictEqual(rSearchApi[0].id, 2);

console.log('All segmented scope and console filter tests passed!');
