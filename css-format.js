// Turns a computed-style diff (array of [property, value]) into a CSS rule a
// designer can paste. Pure string work, no DOM — see sidepanel.js for the
// rendering layer and content.js for where the diff comes from.

const CSS_GROUPS = [
  ['display', 'position', 'top', 'right', 'bottom', 'left', 'inset', 'z-index', 'float', 'clear', 'visibility'],
  ['flex', 'grid', 'gap', 'row-gap', 'column-gap', 'justify', 'align', 'place', 'order'],
  ['width', 'height', 'min-', 'max-', 'margin', 'padding', 'box-sizing', 'overflow', 'aspect-ratio'],
  ['color', 'font', 'line-height', 'letter-spacing', 'word-spacing', 'text-', 'white-space', 'vertical-align', 'list-style'],
  ['background', 'border', 'box-shadow', 'outline', 'opacity', 'filter', 'backdrop-filter', 'mix-blend-mode', 'clip-path', 'mask'],
  ['transition', 'animation', 'transform', 'will-change', 'cursor', 'pointer-events', 'user-select'],
];

// Index-aligned with CSS_GROUPS, kept next to it so the two can never drift —
// the last label (index CSS_GROUPS.length) is cssGroupIndex()'s fallthrough
// for a property that matched no group.
const CSS_GROUP_LABELS = ['Position', 'Flex & Grid', 'Box Model', 'Typography', 'Appearance', 'Motion & Interaction', 'Other'];

function cssGroupIndex(prop) {
  for (let i = 0; i < CSS_GROUPS.length; i++) {
    if (CSS_GROUPS[i].some((p) => prop === p || prop.startsWith(p))) return i;
  }
  return CSS_GROUPS.length;
}

function cssGroupLabel(prop) {
  return CSS_GROUP_LABELS[cssGroupIndex(prop)];
}

function sortCssProps(pairs) {
  return (pairs || []).slice().sort((a, b) => {
    const ga = cssGroupIndex(a[0]);
    const gb = cssGroupIndex(b[0]);
    return ga !== gb ? ga - gb : a[0].localeCompare(b[0]);
  });
}

const FOUR_SIDED = [
  ['margin', ['margin-top', 'margin-right', 'margin-bottom', 'margin-left']],
  ['padding', ['padding-top', 'padding-right', 'padding-bottom', 'padding-left']],
  ['inset', ['top', 'right', 'bottom', 'left']],
  ['border-width', ['border-top-width', 'border-right-width', 'border-bottom-width', 'border-left-width']],
  ['border-style', ['border-top-style', 'border-right-style', 'border-bottom-style', 'border-left-style']],
  ['border-color', ['border-top-color', 'border-right-color', 'border-bottom-color', 'border-left-color']],
  ['border-radius', ['border-top-left-radius', 'border-top-right-radius', 'border-bottom-right-radius', 'border-bottom-left-radius']],
];

const PAIRED = [
  ['overflow', ['overflow-x', 'overflow-y']],
  ['gap', ['row-gap', 'column-gap']],
];

function compactSides([t, r, b, l]) {
  if (t === r && r === b && b === l) return t;
  if (t === b && r === l) return `${t} ${r}`;
  if (r === l) return `${t} ${r} ${b}`;
  return `${t} ${r} ${b} ${l}`;
}

// Collapses only when every longhand of a set is present. A partial set would
// be a silent lie on paste: `margin: 8px` also overwrites the sides that were
// sitting at their default and therefore never showed up in the diff.
function collapseShorthands(pairs) {
  const map = new Map(pairs);
  const replaced = new Map();
  const dropped = new Set();
  const uniform = new Set();

  for (const [short, parts] of FOUR_SIDED) {
    if (!parts.every((p) => map.has(p))) continue;
    const values = parts.map((p) => map.get(p));
    if (values.every((v) => v === values[0])) uniform.add(short);
    replaced.set(parts[0], [short, compactSides(values)]);
    for (const p of parts.slice(1)) dropped.add(p);
  }
  for (const [short, parts] of PAIRED) {
    if (!parts.every((p) => map.has(p))) continue;
    const values = parts.map((p) => map.get(p));
    replaced.set(parts[0], [short, values[0] === values[1] ? values[0] : values.join(' ')]);
    for (const p of parts.slice(1)) dropped.add(p);
  }

  let out = [];
  for (const [prop, value] of pairs) {
    if (dropped.has(prop)) continue;
    out.push(replaced.get(prop) || [prop, value]);
  }

  // `border: 1px solid red` needs all three parts uniform across the sides —
  // checked via the uniform set, not by sniffing for spaces, because a colour
  // like `rgb(0, 0, 0)` has spaces of its own.
  if (['border-width', 'border-style', 'border-color'].every((s) => uniform.has(s))) {
    const at = new Map(out);
    if (at.get('border-style') !== 'none') {
      const merged = `${at.get('border-width')} ${at.get('border-style')} ${at.get('border-color')}`;
      out = out
        .map((entry) => (entry[0] === 'border-width' ? ['border', merged] : entry))
        .filter(([p]) => p !== 'border-style' && p !== 'border-color');
    }
  }
  return out;
}

function cssRuleText(selector, pairs) {
  if (!pairs.length) return `${selector} {}`;
  return `${selector} {\n${pairs.map(([p, v]) => `  ${p}: ${v};`).join('\n')}\n}`;
}

const STATE_PSEUDOS = [
  ':hover', ':focus-visible', ':focus-within', ':focus', ':active', ':visited',
  ':target', ':disabled', ':enabled', ':checked', ':indeterminate',
  ':placeholder-shown', ':read-only', ':required', ':invalid', ':valid',
].sort((a, b) => b.length - a.length);

// A selector list cannot be split on commas alone: :is(a, b), :not(.x, .y)
// and [title="a,b"] all carry their own.
function splitSelectorList(selectorText) {
  const parts = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < selectorText.length; i++) {
    const ch = selectorText[i];
    if (ch === '(' || ch === '[') depth++;
    else if (ch === ')' || ch === ']') depth--;
    else if (ch === ',' && depth === 0) {
      parts.push(selectorText.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(selectorText.slice(start));
  return parts.map((p) => p.trim()).filter(Boolean);
}

function stateAt(selector, i) {
  const rest = selector.slice(i);
  return STATE_PSEUDOS.find((s) => rest.startsWith(s) && !/[a-z-]/i.test(rest[s.length] || '')) || null;
}

// Depth 0 only: a state inside :not(:disabled) is a condition on the rule,
// not the state the rule is for, and stripping it would leave `:not()`, which
// is invalid and would throw the whole rule away.
function scanStates(selector, strip) {
  const found = new Set();
  let out = '';
  let depth = 0;
  for (let i = 0; i < selector.length; i++) {
    const ch = selector[i];
    if (ch === '(' || ch === '[') depth++;
    else if (ch === ')' || ch === ']') depth--;
    if (ch === ':' && depth === 0 && selector[i + 1] !== ':') {
      const state = stateAt(selector, i);
      if (state) {
        found.add(state);
        i += state.length - 1;
        continue;
      }
    }
    out += ch;
  }
  return strip ? out.trim() : [...found];
}

// Computed styles always report colours as rgb()/rgba(), but a palette is only
// useful to a designer as hex. Handles both the legacy comma form and the
// modern space form, since which one a browser emits is not worth depending on.
function rgbToHex(value) {
  if (!/^rgba?\(/i.test(value)) return null;
  const nums = value.match(/[\d.]+/g);
  if (!nums || nums.length < 3) return null;
  const hex = (n) => Math.max(0, Math.min(255, Math.round(Number(n)))).toString(16).padStart(2, '0');
  const base = '#' + hex(nums[0]) + hex(nums[1]) + hex(nums[2]);
  const alpha = nums[3] === undefined ? 1 : Number(nums[3]);
  return alpha >= 1 ? base : base + hex(alpha * 255);
}

if (typeof module !== 'undefined') {
  module.exports = { cssGroupIndex, cssGroupLabel, sortCssProps, compactSides, collapseShorthands, cssRuleText, splitSelectorList, scanStates, rgbToHex };
}
