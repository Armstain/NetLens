
(() => {
  if (window.__netlens_content_installed) return;
  window.__netlens_content_installed = true;

  const RING_SIZE = 200;
  let buffer = [];

  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    const data = event.data;
    if (!data || data.__netlens !== true || !Array.isArray(data.batch)) return;

    buffer.push(...data.batch);
    if (buffer.length > RING_SIZE) buffer = buffer.slice(-RING_SIZE);

    try {
      chrome.runtime.sendMessage({ type: 'netlens:batch', batch: data.batch }, () => {
        // Swallow "no receiving end" when the panel is closed.
        void chrome.runtime.lastError;
      });
    } catch {}
  });

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg) return;
    if (msg.type === 'netlens:dump') {
      sendResponse({ buffer });
      return;
    }
    if (msg.type === 'netlens:clear') {
      buffer = [];
      sendResponse({ ok: true });
    }
    if (msg.type === 'netlens:storage:get') {
      const readStore = (store) => {
        const out = {};
        try {
          for (let i = 0; i < store.length; i++) {
            const key = store.key(i);
            out[key] = store.getItem(key);
          }
        } catch {}
        return out;
      };
      let session = {};
      try { session = readStore(window.sessionStorage); } catch {}
      sendResponse({ session });
      return;
    }
    if (msg.type === 'netlens:inspect:start') {
      startPicker();
      sendResponse({ ok: true });
      return;
    }
    if (msg.type === 'netlens:inspect:stop') {
      stopPicker();
      sendResponse({ ok: true });
      return;
    }
  });

  // ------------------------------------------------------------- inspector
  const MAX_HTML = 20 * 1024;
  let overlayEl = null;
  let labelEl = null;
  let pickerActive = false;
  let rafPending = false;
  let lastHovered = null;

  function ensureOverlay() {
    if (overlayEl) return;
    overlayEl = document.createElement('div');
    overlayEl.style.cssText = 'position:fixed;pointer-events:none;z-index:2147483647;' +
      'background:rgba(99,102,241,0.15);border:1px solid #818cf8;box-sizing:border-box;transition:none;';
    labelEl = document.createElement('div');
    labelEl.style.cssText = 'position:fixed;pointer-events:none;z-index:2147483647;' +
      'background:#161b22;color:#e6edf3;font:11px ui-monospace,monospace;padding:2px 6px;' +
      'border-radius:4px;border:1px solid #30363d;white-space:nowrap;';
    document.documentElement.appendChild(overlayEl);
    document.documentElement.appendChild(labelEl);
  }

  function positionOverlay(el) {
    const rect = el.getBoundingClientRect();

    // getBoundingClientRect() is always viewport-relative, but our overlay's
    // position:fixed isn't — if any ancestor of it (often html itself, e.g. a
    // "scale to fit" transform some sites apply on resize, which is exactly
    // what a narrower viewport from the side panel opening can trigger) has a
    // transform, filter, or perspective set, that ancestor becomes fixed's
    // containing block instead of the viewport, and BOTH position and size
    // stop meaning what rect says (a scale distorts size, not just offset).
    // Self-calibrate against both: render a known probe box, measure how it
    // actually lands on screen, and invert that mapping. Reduces to exactly
    // the untransformed case when there's no such ancestor (scale 1, origin
    // matches rect as-is).
    const PROBE = 1000;
    overlayEl.style.top = '0px';
    overlayEl.style.left = '0px';
    overlayEl.style.width = `${PROBE}px`;
    overlayEl.style.height = `${PROBE}px`;
    const probe = overlayEl.getBoundingClientRect();
    const scaleX = probe.width / PROBE || 1;
    const scaleY = probe.height / PROBE || 1;

    const toLocalX = (viewportX) => (viewportX - probe.left) / scaleX;
    const toLocalY = (viewportY) => (viewportY - probe.top) / scaleY;

    overlayEl.style.left = `${toLocalX(rect.left)}px`;
    overlayEl.style.top = `${toLocalY(rect.top)}px`;
    overlayEl.style.width = `${rect.width / scaleX}px`;
    overlayEl.style.height = `${rect.height / scaleY}px`;

    const id = el.id ? `#${el.id}` : '';
    const cls = typeof el.className === 'string' && el.className.trim()
      ? '.' + el.className.trim().split(/\s+/).slice(0, 2).join('.') : '';
    labelEl.textContent = `${el.tagName.toLowerCase()}${id}${cls}  ${Math.round(rect.width)}×${Math.round(rect.height)}`;
    const top = rect.top > 20 ? rect.top - 20 : rect.bottom + 2;
    labelEl.style.top = `${toLocalY(top)}px`;
    labelEl.style.left = `${toLocalX(rect.left)}px`;
  }

  // A computed style carries ~340 properties and nearly all of them are browser
  // defaults — noise nobody wants to read, let alone paste. So diff against a
  // pristine element of the same tag living in an about:blank iframe: page CSS
  // cannot reach inside it, so whatever differs is exactly what the page
  // authored. The frame is sized and merely moved off-screen rather than
  // display:none, because an unlaid-out document resolves layout-dependent
  // values (width, line-height) to 0/auto and every one of them would then
  // read as a difference.
  const DEFAULTS = new Map();
  let defaultsFrame = null;
  let defaultsBlocked = false;

  function defaultsDoc() {
    if (defaultsBlocked) return null;
    if (defaultsFrame && defaultsFrame.contentDocument) return defaultsFrame.contentDocument;
    try {
      if (defaultsFrame) defaultsFrame.remove();
      defaultsFrame = document.createElement('iframe');
      defaultsFrame.setAttribute('aria-hidden', 'true');
      defaultsFrame.style.cssText = 'position:absolute;top:0;left:-99999px;width:1024px;height:768px;border:0;visibility:hidden;';
      document.documentElement.appendChild(defaultsFrame);
      const doc = defaultsFrame.contentDocument;
      if (!doc) throw new Error('no contentDocument');
      return doc;
    } catch {
      // A page's CSP frame-src can forbid even about:blank. Then we have no
      // baseline and fall back to reporting every property.
      defaultsBlocked = true;
      if (defaultsFrame) { defaultsFrame.remove(); defaultsFrame = null; }
      return null;
    }
  }

  function defaultsFor(tag, pseudo) {
    const cacheKey = pseudo ? `${tag}|${pseudo}` : tag;
    if (DEFAULTS.has(cacheKey)) return DEFAULTS.get(cacheKey);
    const doc = defaultsDoc();
    if (!doc) return null;
    let map = null;
    try {
      const probe = doc.createElement(tag);
      (doc.body || doc.documentElement).appendChild(probe);
      const cs = doc.defaultView.getComputedStyle(probe, pseudo || null);
      map = new Map();
      for (let i = 0; i < cs.length; i++) map.set(cs[i], cs.getPropertyValue(cs[i]));
      probe.remove();
    } catch {
      map = null;
    }
    DEFAULTS.set(cacheKey, map);
    return map;
  }

  // Vendor-prefixed properties are duplicates of a standard one, except for the
  // handful that never got an unprefixed equivalent that browsers report.
  const KEEP_PREFIXED = new Set([
    '-webkit-line-clamp', '-webkit-box-orient', '-webkit-text-fill-color',
    '-webkit-text-stroke-color', '-webkit-text-stroke-width',
    '-webkit-backdrop-filter', '-webkit-mask-image',
  ]);

  function isNoise(prop) {
    if (prop.startsWith('--')) return false;
    if (prop.startsWith('-')) return !KEEP_PREFIXED.has(prop);
    // Logical properties (inline-size, margin-block-end, …) restate a physical
    // longhand that is already in the list. The logical corner radii are the
    // one family that names neither axis, so they need naming outright.
    if (/^border-(start|end)-(start|end)-radius$/.test(prop)) return true;
    return /(^|-)(inline|block)(-|$)/.test(prop);
  }

  function computedDiff(el, tag, pseudo) {
    const cs = getComputedStyle(el, pseudo || null);
    const base = defaultsFor(tag, pseudo);
    const out = [];
    for (let i = 0; i < cs.length; i++) {
      const prop = cs[i];
      if (isNoise(prop)) continue;
      const value = cs.getPropertyValue(prop);
      if (value === '') continue;
      if (base && base.get(prop) === value) continue;
      out.push([prop, value]);
    }
    return out;
  }

  function pseudoDiff(el, tag, pseudo) {
    const content = getComputedStyle(el, pseudo).content;
    // No generated content means no box was ever created; its "styles" are
    // defaults for a thing that does not exist.
    if (!content || content === 'none' || content === 'normal') return null;
    const styles = computedDiff(el, tag, pseudo);
    return styles.length ? styles : null;
  }

  function selectorFor(el) {
    const tag = el.tagName.toLowerCase();
    if (el.id) return `${tag}#${CSS.escape(el.id)}`;
    const classes = typeof el.className === 'string'
      ? el.className.trim().split(/\s+/).filter(Boolean) : [];
    return classes.length ? tag + classes.map((c) => '.' + CSS.escape(c)).join('') : tag;
  }

  function serializeElement(el, includeHtml) {
    const rect = el.getBoundingClientRect();
    const tag = el.tagName.toLowerCase();
    // Hover streams a payload per element crossed; 20KB of markup each time is
    // the one part heavy enough to matter, so it rides along only on the click.
    const outerHTML = includeHtml ? (el.outerHTML || '') : '';
    const pseudos = {};
    for (const pseudo of ['::before', '::after']) {
      const styles = pseudoDiff(el, tag, pseudo);
      if (styles) pseudos[pseudo] = styles;
    }
    return {
      tag,
      id: el.id || null,
      classes: typeof el.className === 'string' ? el.className.trim().split(/\s+/).filter(Boolean) : [],
      selector: selectorFor(el),
      rect: { width: Math.round(rect.width), height: Math.round(rect.height) },
      styles: computedDiff(el, tag, null),
      pseudos,
      defaultsUnavailable: defaultsBlocked,
      hasHtml: includeHtml,
      outerHTML: outerHTML.length > MAX_HTML ? outerHTML.slice(0, MAX_HTML) : outerHTML,
      outerHTMLTruncated: outerHTML.length > MAX_HTML,
    };
  }

  let lastSentEl = null;

  function sendHover(el) {
    if (el === lastSentEl) return;
    lastSentEl = el;
    try {
      chrome.runtime.sendMessage({ type: 'netlens:inspect:hover', data: serializeElement(el, false) }, () => { void chrome.runtime.lastError; });
    } catch { /* panel closed mid-move */ }
  }

  function onMouseMove(e) {
    lastHovered = e.target;
    if (rafPending) return;
    rafPending = true;
    requestAnimationFrame(() => {
      rafPending = false;
      if (!pickerActive || !lastHovered) return;
      positionOverlay(lastHovered);
      sendHover(lastHovered);
    });
  }

  // --------------------------------------------------------- state rules
  // :hover and friends cannot be read off a computed style — the state is not
  // active while we look. The only source is the stylesheets themselves.
  // Selector parsing (splitSelectorList, scanStates) comes from css-format.js.
  const sheetRuleCache = new Map();

  function declarations(style) {
    const out = [];
    for (let i = 0; i < style.length; i++) {
      const prop = style[i];
      const priority = style.getPropertyPriority(prop);
      out.push([prop, style.getPropertyValue(prop) + (priority ? ' !important' : '')]);
    }
    return out;
  }

  // Every conditional group rule exposes conditionText, so the at-keyword has to
  // come from the rule's own shape or a @container ends up printed as @supports.
  function atRuleFor(rule) {
    if (rule.media && rule.media.mediaText) return `@media ${rule.media.mediaText}`;
    if (rule.containerName !== undefined) return `@container ${rule.containerName ? rule.containerName + ' ' : ''}${rule.conditionText || ''}`.trim();
    if (rule.conditionText) return `@supports ${rule.conditionText}`;
    return '';
  }

  function walkRules(rules, el, conditions, out) {
    for (const rule of rules) {
      if (typeof CSSKeyframesRule !== 'undefined' && rule instanceof CSSKeyframesRule) continue;
      if (rule.styleSheet) {
        try { walkRules(rule.styleSheet.cssRules, el, conditions, out); } catch {}
        continue;
      }
      if (rule.cssRules && rule.cssRules.length) {
        const cond = atRuleFor(rule);
        walkRules(rule.cssRules, el, cond ? conditions.concat(cond) : conditions, out);
        if (!rule.selectorText) continue;
      }
      if (!rule.selectorText || !rule.style) continue;
      for (const sel of splitSelectorList(rule.selectorText)) {
        const states = scanStates(sel, false);
        if (!states.length) continue;
        const base = scanStates(sel, true);
        if (!base) continue;
        try {
          if (!el.matches(base)) continue;
        } catch {
          continue;
        }
        const decls = declarations(rule.style);
        if (decls.length) out.push({ selector: sel, states, conditions: conditions.slice(), declarations: decls });
      }
    }
  }

  function fetchSheetRules(href) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage({ type: 'netlens:fetchCss', url: href }, (res) => {
          void chrome.runtime.lastError;
          if (!res || !res.text) return resolve(null);
          try {
            // A constructed sheet is parsed but never adopted, so this reads
            // the rules without applying anything to the page. Note that
            // @import inside it is dropped by spec.
            const parsed = new CSSStyleSheet();
            parsed.replaceSync(res.text);
            resolve(parsed.cssRules);
          } catch {
            resolve(null);
          }
        });
      } catch {
        resolve(null);
      }
    });
  }

  async function readableRules(sheet) {
    try {
      if (sheet.cssRules) return sheet.cssRules;
    } catch { /* cross-origin: fall through to the fetch path */ }
    if (!sheet.href) return null;
    if (sheetRuleCache.has(sheet.href)) return sheetRuleCache.get(sheet.href);
    const rules = await fetchSheetRules(sheet.href);
    sheetRuleCache.set(sheet.href, rules);
    return rules;
  }

  async function collectStateRules(el) {
    const out = [];
    let blocked = 0;
    for (const sheet of Array.from(document.styleSheets)) {
      const rules = await readableRules(sheet);
      if (!rules) { blocked++; continue; }
      try { walkRules(rules, el, [], out); } catch {}
    }
    return { rules: out, blocked };
  }

  function lockOn(el) {
    let data = null;
    try {
      data = serializeElement(el, true);
    } catch (err) {
      stopPicker();
      try { chrome.runtime.sendMessage({ type: 'netlens:inspect:error', message: String(err && err.message || err) }, () => { void chrome.runtime.lastError; }); } catch {}
      return;
    }
    stopPicker();
    try { chrome.runtime.sendMessage({ type: 'netlens:inspect:result', data }, () => { void chrome.runtime.lastError; }); } catch {}
    // Stylesheet work can await a cross-origin fetch, so it follows the result
    // as a second message rather than holding the panel up.
    collectStateRules(el).then((states) => {
      try { chrome.runtime.sendMessage({ type: 'netlens:inspect:states', ...states }, () => { void chrome.runtime.lastError; }); } catch {}
    }).catch(() => {});
  }

  function onClick(e) {
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();
    lockOn(lastHovered || e.target);
  }

  function onKeydown(e) {
    if (e.key !== 'Escape') return;
    stopPicker();
    try { chrome.runtime.sendMessage({ type: 'netlens:inspect:cancelled' }, () => { void chrome.runtime.lastError; }); } catch {}
  }

  function startPicker() {
    if (pickerActive) return;
    pickerActive = true;
    ensureOverlay();
    document.addEventListener('mousemove', onMouseMove, true);
    document.addEventListener('click', onClick, true);
    document.addEventListener('keydown', onKeydown, true);
  }

  function stopPicker() {
    if (!pickerActive) return;
    pickerActive = false;
    lastSentEl = null;
    document.removeEventListener('mousemove', onMouseMove, true);
    document.removeEventListener('click', onClick, true);
    document.removeEventListener('keydown', onKeydown, true);
    if (overlayEl) { overlayEl.remove(); overlayEl = null; }
    if (labelEl) { labelEl.remove(); labelEl = null; }
    // DEFAULTS survives; only the frame goes, so a later pick reuses the cache.
    if (defaultsFrame) { defaultsFrame.remove(); defaultsFrame = null; }
  }
})();
