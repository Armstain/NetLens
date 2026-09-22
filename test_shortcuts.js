const assert = require('assert');
const {
  DEFAULT_SHORTCUTS,
  SHORTCUT_OPTIONS,
  normalizeShortcuts,
  matchesShortcut,
} = require('./net-format.js');

// 1. Normalization
assert.deepStrictEqual(normalizeShortcuts(null), DEFAULT_SHORTCUTS);
assert.deepStrictEqual(normalizeShortcuts({}), DEFAULT_SHORTCUTS);
assert.deepStrictEqual(
  normalizeShortcuts({ reveal: 'Alt+R', inspect: 'none' }),
  { reveal: 'Alt+R', inspect: 'none' }
);
// Invalid strings fallback to default
assert.deepStrictEqual(
  normalizeShortcuts({ reveal: 'InvalidShortcut', inspect: 123 }),
  DEFAULT_SHORTCUTS
);

// 2. Shortcut matching
const mockEvent = (overrides) => ({
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  metaKey: false,
  key: '',
  code: '',
  ...overrides,
});

// Alt+Shift+R matching
assert.strictEqual(
  matchesShortcut(mockEvent({ altKey: true, shiftKey: true, key: 'R', code: 'KeyR' }), 'Alt+Shift+R'),
  true
);
// Keydown with lowercase key or different layout code
assert.strictEqual(
  matchesShortcut(mockEvent({ altKey: true, shiftKey: true, key: 'r', code: 'KeyR' }), 'Alt+Shift+R'),
  true
);
// Missing modifier should fail
assert.strictEqual(
  matchesShortcut(mockEvent({ altKey: true, shiftKey: false, key: 'R', code: 'KeyR' }), 'Alt+Shift+R'),
  false
);
// Extra modifier should fail
assert.strictEqual(
  matchesShortcut(mockEvent({ ctrlKey: true, altKey: true, shiftKey: true, key: 'R', code: 'KeyR' }), 'Alt+Shift+R'),
  false
);
// Disabled 'none' should never match
assert.strictEqual(
  matchesShortcut(mockEvent({ altKey: true, shiftKey: true, key: 'R' }), 'none'),
  false
);
// Ctrl+Shift+C
assert.strictEqual(
  matchesShortcut(mockEvent({ ctrlKey: true, shiftKey: true, key: 'c', code: 'KeyC' }), 'Ctrl+Shift+C'),
  true
);

console.log('All shortcut tests passed!');
