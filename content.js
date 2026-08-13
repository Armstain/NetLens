
(() => {
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
    overlayEl.style.top = `${rect.top}px`;
    overlayEl.style.left = `${rect.left}px`;
    overlayEl.style.width = `${rect.width}px`;
    overlayEl.style.height = `${rect.height}px`;

    const id = el.id ? `#${el.id}` : '';
    const cls = typeof el.className === 'string' && el.className.trim()
      ? '.' + el.className.trim().split(/\s+/).slice(0, 2).join('.') : '';
    labelEl.textContent = `${el.tagName.toLowerCase()}${id}${cls}  ${Math.round(rect.width)}×${Math.round(rect.height)}`;
    const top = rect.top > 20 ? rect.top - 20 : rect.bottom + 2;
    labelEl.style.top = `${top}px`;
    labelEl.style.left = `${rect.left}px`;
  }

  function buildSelector(el) {
    const parts = [];
    let node = el;
    while (node && node.nodeType === 1 && parts.length < 6) {
      let part = node.tagName.toLowerCase();
      if (node.id) { parts.unshift(`${part}#${node.id}`); break; }
      if (typeof node.className === 'string' && node.className.trim()) {
        part += '.' + node.className.trim().split(/\s+/).filter(Boolean).slice(0, 2).join('.');
      }
      const parent = node.parentElement;
      if (parent) {
        const siblings = Array.from(parent.children).filter((c) => c.tagName === node.tagName);
        if (siblings.length > 1) part += `:nth-of-type(${siblings.indexOf(node) + 1})`;
      }
      parts.unshift(part);
      node = node.parentElement;
    }
    return parts.join(' > ');
  }

  const COMPUTED_KEYS = ['display', 'position', 'color', 'backgroundColor', 'fontSize', 'fontFamily', 'padding', 'margin', 'border', 'boxSizing'];

  function serializeElement(el) {
    const rect = el.getBoundingClientRect();
    const attributes = {};
    for (const a of el.attributes || []) attributes[a.name] = a.value;
    const cs = getComputedStyle(el);
    const computed = {};
    for (const k of COMPUTED_KEYS) computed[k] = cs[k];
    const outerHTML = el.outerHTML || '';
    return {
      tag: el.tagName.toLowerCase(),
      id: el.id || null,
      classes: typeof el.className === 'string' ? el.className.trim().split(/\s+/).filter(Boolean) : [],
      attributes,
      selector: buildSelector(el),
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
    const data = serializeElement(el);
    stopPicker();
    try { chrome.runtime.sendMessage({ type: 'netlens:inspect:result', data }, () => { void chrome.runtime.lastError; }); } catch {}
  }

  function onKeydown(e) {
    if (e.key === 'Escape') stopPicker();
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
