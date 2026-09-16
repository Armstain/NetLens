const assert = require('assert');
const { sortCssProps, compactSides, collapseShorthands, cssRuleText } = require('./css-format.js');

// 1. Four equal sides collapse to one value
assert.deepStrictEqual(
  collapseShorthands([
    ['margin-top', '8px'], ['margin-right', '8px'], ['margin-bottom', '8px'], ['margin-left', '8px'],
  ]),
  [['margin', '8px']]
);

// 2. Partial sets must NOT collapse — the missing sides are at their default
assert.deepStrictEqual(
  collapseShorthands([['margin-left', 'auto'], ['margin-right', 'auto']]),
  [['margin-left', 'auto'], ['margin-right', 'auto']]
);

// 3. compactSides picks the shortest legal form
assert.strictEqual(compactSides(['1px', '2px', '1px', '2px']), '1px 2px');
assert.strictEqual(compactSides(['1px', '2px', '3px', '2px']), '1px 2px 3px');
assert.strictEqual(compactSides(['1px', '2px', '3px', '4px']), '1px 2px 3px 4px');

// 4. Border merges across width/style/colour, and a spacey rgb() colour does
//    not defeat the merge
const border = collapseShorthands([
  ['border-top-width', '1px'], ['border-right-width', '1px'], ['border-bottom-width', '1px'], ['border-left-width', '1px'],
  ['border-top-style', 'solid'], ['border-right-style', 'solid'], ['border-bottom-style', 'solid'], ['border-left-style', 'solid'],
  ['border-top-color', 'rgb(0, 0, 0)'], ['border-right-color', 'rgb(0, 0, 0)'], ['border-bottom-color', 'rgb(0, 0, 0)'], ['border-left-color', 'rgb(0, 0, 0)'],
]);
assert.deepStrictEqual(border, [['border', '1px solid rgb(0, 0, 0)']]);

// 5. Uneven sides stay as border-width/style/color, never as `border`
const uneven = collapseShorthands([
  ['border-top-width', '1px'], ['border-right-width', '2px'], ['border-bottom-width', '1px'], ['border-left-width', '2px'],
  ['border-top-style', 'solid'], ['border-right-style', 'solid'], ['border-bottom-style', 'solid'], ['border-left-style', 'solid'],
  ['border-top-color', 'red'], ['border-right-color', 'red'], ['border-bottom-color', 'red'], ['border-left-color', 'red'],
]);
assert.ok(uneven.some(([p, v]) => p === 'border-width' && v === '1px 2px'));
assert.ok(!uneven.some(([p]) => p === 'border'));

// 6. Paired properties
assert.deepStrictEqual(collapseShorthands([['overflow-x', 'hidden'], ['overflow-y', 'hidden']]), [['overflow', 'hidden']]);
assert.deepStrictEqual(collapseShorthands([['row-gap', '4px'], ['column-gap', '8px']]), [['gap', '4px 8px']]);

// 7. Grouping puts layout before typography before paint
const sorted = sortCssProps([['color', 'red'], ['box-shadow', 'none'], ['display', 'flex']]).map(([p]) => p);
assert.deepStrictEqual(sorted, ['display', 'color', 'box-shadow']);

// 8. Rule text is pasteable
assert.strictEqual(cssRuleText('div.card', [['display', 'flex']]), 'div.card {\n  display: flex;\n}');
assert.strictEqual(cssRuleText('div', []), 'div {}');

console.log('All CSS formatting assertions passed!');

// ---- selector parsing, used by the :hover/:focus state scan ----
const { splitSelectorList, scanStates } = require('./css-format.js');

// 9. Commas inside :is()/:not()/attribute values are not list separators
assert.deepStrictEqual(splitSelectorList('.a, .b'), ['.a', '.b']);
assert.deepStrictEqual(splitSelectorList(':is(.a, .b) .c'), [':is(.a, .b) .c']);
assert.deepStrictEqual(splitSelectorList('[title="a,b"], .c'), ['[title="a,b"]', '.c']);

// 10. States are found, and the base selector drops them
assert.deepStrictEqual(scanStates('.btn:hover', false), [':hover']);
assert.strictEqual(scanStates('.btn:hover', true), '.btn');
assert.deepStrictEqual(scanStates('a:focus-visible', false), [':focus-visible']);
assert.strictEqual(scanStates('a:focus-visible', true), 'a');

// 11. :focus-visible must not be read as :focus plus junk
assert.deepStrictEqual(scanStates('a:focus', false), [':focus']);
assert.ok(!scanStates('a:focus-visible', false).includes(':focus'));

// 12. A state inside :not() is a condition, not the rule's own state —
//     stripping it would leave the invalid `:not()` and lose the rule
assert.deepStrictEqual(scanStates('.btn:not(:disabled):hover', false), [':hover']);
assert.strictEqual(scanStates('.btn:not(:disabled):hover', true), '.btn:not(:disabled)');

// 13. Pseudo-elements are left alone
assert.strictEqual(scanStates('.btn:hover::after', true), '.btn::after');

// 14. Selectors with no state at all report none
assert.deepStrictEqual(scanStates('.btn', false), []);


// ---- colour conversion for the page palette ----
const { rgbToHex } = require('./css-format.js');

// 15. Both the legacy comma form and the modern space form
assert.strictEqual(rgbToHex('rgb(255, 255, 255)'), '#ffffff');
assert.strictEqual(rgbToHex('rgb(255 255 255)'), '#ffffff');
assert.strictEqual(rgbToHex('rgb(0, 0, 0)'), '#000000');

// 16. Alpha becomes a fourth pair, and a fully opaque alpha is dropped
assert.strictEqual(rgbToHex('rgba(0, 0, 0, 1)'), '#000000');
assert.strictEqual(rgbToHex('rgba(255, 0, 0, 0.5)'), '#ff000080');

// 17. Anything that is not rgb() is left for the caller to show verbatim
assert.strictEqual(rgbToHex('oklch(0.7 0.1 200)'), null);
assert.strictEqual(rgbToHex('#abc'), null);

console.log('All selector parsing and colour assertions passed!');
