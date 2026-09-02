
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

  const COMPUTED_KEYS = ['display', 'position', 'color', 'backgroundColor', 'fontSize', 'fontFamily', 'padding', 'margin', 'border', 'boxSizing'];

  function serializeElement(el) {
    const rect = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    const computed = {};
    for (const k of COMPUTED_KEYS) computed[k] = cs[k];
    const outerHTML = el.outerHTML || '';
    return {
      tag: el.tagName.toLowerCase(),
      id: el.id || null,
      classes: typeof el.className === 'string' ? el.className.trim().split(/\s+/).filter(Boolean) : [],
      rect: { width: Math.round(rect.width), height: Math.round(rect.height) },
      computed,
      outerHTML: outerHTML.length > MAX_HTML ? outerHTML.slice(0, MAX_HTML) : outerHTML,
      outerHTMLTruncated: outerHTML.length > MAX_HTML,
    };
  }

  function onMouseMove(e) {
    lastHovered = e.target;
    if (rafPending) return;
    rafPending = true;
    requestAnimationFrame(() => {
      rafPending = false;
      if (pickerActive && lastHovered) positionOverlay(lastHovered);
    });
  }

  function onClick(e) {
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();
    const el = lastHovered || e.target;
    stopPicker();
    try {
      const data = serializeElement(el);
      chrome.runtime.sendMessage({ type: 'netlens:inspect:result', data }, () => { void chrome.runtime.lastError; });
    } catch (err) {
      try { chrome.runtime.sendMessage({ type: 'netlens:inspect:error', message: String(err && err.message || err) }, () => { void chrome.runtime.lastError; }); } catch {}
    }
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
    document.removeEventListener('mousemove', onMouseMove, true);
    document.removeEventListener('click', onClick, true);
    document.removeEventListener('keydown', onKeydown, true);
    if (overlayEl) { overlayEl.remove(); overlayEl = null; }
    if (labelEl) { labelEl.remove(); labelEl = null; }
  }
})();
