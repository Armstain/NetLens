
(() => {
  if (window.__netlens_content_installed) return;
  window.__netlens_content_installed = true;

  const RING_SIZE = 200;
  // The ring holds full bodies, so 200 entries of capped 200KB responses would
  // pin 40MB in the page's process. Whichever limit bites first wins.
  const RING_BYTES = 8 * 1024 * 1024;

  // With the side panel closed there is no receiver, but sendMessage still
  // structured-clones the whole batch — bodies included — before it finds that
  // out. On a busy page that is megabytes of pointless serialisation every
  // flush, so stop sending once it fails and retry on a timer. Nothing is lost
  // by backing off: the panel pulls this ring buffer with netlens:dump the
  // moment it opens.
  const PANEL_RETRY_MS = 2000;
  let panelLikely = true;
  let panelRetryAt = 0;
  let buffer = [];

  // ----------------------------------------------------------- api toast
  // Rendered here (not the side panel) so it fires even with the panel
  // closed — this listener already sees every batch regardless. Which entries
  // qualify is decided by toastMatch() in net-format.js, shared with the panel.
  const TOAST_BODY_LINES = 40;
  const TOAST_BODY_CHARS = 4000;
  const TOAST_PEEK_CHARS = 120;

  let toastSettings = typeof normalizeToastSettings === 'function'
    ? normalizeToastSettings(null)
    : { enabled: false, position: 'bottom-right' };
  let shortcutSettings = typeof normalizeShortcuts === 'function'
    ? normalizeShortcuts(null)
    : { reveal: 'Alt+Shift+R', inspect: 'Alt+Shift+C' };
  function syncLogConfig(captureAllLogs) {
    try { window.postMessage({ __netlens_config: true, captureAllLogs }, '*'); } catch {}
  }

  try {
    chrome.storage.local.get(['netlensToastSettings', 'netlensShortcuts', 'netlensCaptureAllLogs'], (res) => {
      if (res && res.netlensToastSettings) {
        toastSettings = normalizeToastSettings(res.netlensToastSettings);
        applyToastPosition();
      }
      if (res && res.netlensShortcuts) {
        shortcutSettings = normalizeShortcuts(res.netlensShortcuts);
      }
      if (res && res.netlensCaptureAllLogs !== undefined) {
        syncLogConfig(Boolean(res.netlensCaptureAllLogs));
      }
    });
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local') return;
      if (changes.netlensToastSettings) {
        toastSettings = normalizeToastSettings(changes.netlensToastSettings.newValue);
        if (!toastSettings.enabled) clearToasts();
        else applyToastPosition();
      }
      if (changes.netlensShortcuts) {
        shortcutSettings = normalizeShortcuts(changes.netlensShortcuts.newValue);
      }
      if (changes.netlensCaptureAllLogs) {
        syncLogConfig(Boolean(changes.netlensCaptureAllLogs.newValue));
      }
    });
  } catch {}

  const TOAST_CSS = `
    :host { all: initial; }
    .stack {
      position: fixed; z-index: 2147483647;
      display: flex; gap: 6px;
      pointer-events: none;
      font: 12px/1.45 ui-monospace, SFMono-Regular, Menlo, monospace;
    }
    /* The stack is anchored to its corner and grows inward, so settled toasts
       stay put and only the newest one appears at the growing edge. */
    .stack.bottom-right, .stack.bottom-left { bottom: 16px; flex-direction: column-reverse; }
    .stack.top-right, .stack.top-left { top: 16px; flex-direction: column; }
    .stack.bottom-right, .stack.top-right { right: 16px; align-items: flex-end; }
    .stack.bottom-left, .stack.top-left { left: 16px; align-items: flex-start; }
    .toast {
      pointer-events: auto; cursor: pointer; box-sizing: border-box;
      max-width: 420px; padding: 6px 10px;
      background: #161b22; color: #e6edf3;
      border: 1px solid #30363d; border-left-width: 3px; border-radius: 6px;
      box-shadow: 0 2px 8px rgba(0, 0, 0, 0.4);
      opacity: 0; transform: translateY(4px);
      transition: opacity .15s, transform .15s;
    }
    .toast.in { opacity: 1; transform: translateY(0); }
    .toast:hover { border-color: #484f58; }
    .toast.s2xx, .toast.s3xx { border-left-color: #238636; }
    .toast.s4xx, .toast.s5xx, .toast.failed { border-left-color: #da3633; }
    .toast.slow { border-left-color: #d29922; }
    .line { display: flex; gap: 8px; align-items: baseline; white-space: nowrap; }
    .peek {
      color: #8b949e; margin-top: 2px;
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    }
    .toast.open .peek { display: none; }
    .path { flex: 1; overflow: hidden; text-overflow: ellipsis; }
    .method { color: #79c0ff; }
    .status { color: #8b949e; }
    .toast.s4xx .status, .toast.s5xx .status, .toast.failed .status { color: #ff7b72; }
    .meta { color: #8b949e; }
    .toast.slow .dur { color: #d29922; }
    .count { color: #d29922; }
    .count:empty { display: none; }
    .more { pointer-events: none; color: #8b949e; padding: 2px 10px; }
    .card { display: none; margin-top: 6px; max-width: 420px; }
    .toast.open { cursor: default; max-width: 520px; }
    .toast.open .card { display: block; }
    .toast.open .path { white-space: normal; overflow-wrap: anywhere; }
    .url { color: #8b949e; font-size: 11px; overflow-wrap: anywhere; margin-bottom: 6px; }
    pre {
      margin: 0; max-height: 320px; overflow: auto; padding: 6px 8px;
      background: #0d1117; border: 1px solid #30363d; border-radius: 4px;
      white-space: pre-wrap; overflow-wrap: anywhere;
    }
    .note { color: #8b949e; margin-top: 4px; font-size: 11px; }
    .jtree {
      max-height: 320px; overflow: auto; padding: 6px 8px;
      background: #0d1117; border: 1px solid #30363d; border-radius: 4px;
    }
    .jtree details { margin-left: 14px; }
    .jtree summary { cursor: pointer; list-style: none; }
    .jtree summary::-webkit-details-marker { display: none; }
    .jtree .leaf { margin-left: 14px; overflow-wrap: anywhere; }
    .jtree .j-key { color: #79c0ff; }
    .jtree .j-str { color: #a5d6ff; }
    .jtree .j-num { color: #d2a8ff; }
    .jtree .j-bool { color: #ffa657; }
    .jtree .j-null { color: #8b949e; }
    .jtree .j-hint { color: #8b949e; }
    .jtree .j-more { color: #8b949e; margin-left: 14px; font-style: italic; }
    .btns { display: flex; gap: 6px; margin-top: 6px; }
    button {
      font: inherit; color: #e6edf3; background: #21262d;
      border: 1px solid #30363d; border-radius: 4px; padding: 2px 8px; cursor: pointer;
    }
    button:hover { background: #30363d; }
    @media (prefers-reduced-motion: reduce) {
      .toast { transition: none; transform: none; }
      .toast.in { transform: none; }
    }
  `;

  let toastRoot = null;
  let toastStack = null;
  let moreEl = null;
  let suppressed = 0;
  // Keyed by method + path + status class, so a 200 that turns into a 500 opens
  // a fresh toast instead of quietly incrementing the old one.
  const liveToasts = new Map();

  // ponytail: an `html { transform }` re-parents position:fixed and lands the
  // stack in the wrong corner (cosmetic, still readable). Upgrade path: the
  // probe calibration in positionOverlay() below.
  function ensureToastRoot() {
    if (toastStack && toastStack.isConnected) return toastStack;
    const host = document.createElement('div');
    toastRoot = host.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = TOAST_CSS;
    toastStack = document.createElement('div');
    toastStack.className = `stack ${toastSettings.position}`;
    toastStack.setAttribute('aria-live', 'polite');
    toastRoot.append(style, toastStack);
    document.documentElement.appendChild(host);
    return toastStack;
  }

  function applyToastPosition() {
    if (toastStack) toastStack.className = `stack ${toastSettings.position}`;
  }

  function clearToasts() {
    for (const entry of liveToasts.values()) clearTimeout(entry.timer);
    liveToasts.clear();
    suppressed = 0;
    moreEl = null;
    if (toastStack) toastStack.replaceChildren();
  }

  function armDismiss(entry) {
    clearTimeout(entry.timer);
    if (entry.el.classList.contains('open')) return;
    const ms = isError(entry.data) ? toastSettings.errorDismissMs : toastSettings.dismissMs;
    entry.timer = setTimeout(() => dismiss(entry), ms);
  }

  function dismiss(entry) {
    clearTimeout(entry.timer);
    liveToasts.delete(entry.key);
    entry.el.classList.remove('in');
    setTimeout(() => {
      entry.el.remove();
      if (!liveToasts.size) {
        suppressed = 0;
        if (moreEl) { moreEl.remove(); moreEl = null; }
      }
    }, 200);
  }

  // A truncated capture is cut off mid-object, so a plain JSON.parse fails
  // and the toast fell back to raw, unindented text — tryParsePartialJson
  // (decoders.js) closes off whatever braces/brackets are still open so the
  // same tree renderer works on a clipped body as a whole one.
  function bodyPreview(d) {
    const raw = d.responseBody;
    if (typeof raw !== 'string' || !raw) return { text: '(no body captured)', note: '', tree: null };
    const notes = [];
    if (d.truncated) notes.push(`captured body truncated, ${fmtSize(d.responseSize)} total`);

    let parsed = null;
    try { parsed = JSON.parse(raw); } catch { parsed = tryParsePartialJson(raw); }
    if (parsed !== null && typeof parsed === 'object') {
      return { text: raw, note: notes.join(' · '), tree: parsed };
    }

    let text = raw;
    const lines = text.split('\n');
    if (lines.length > TOAST_BODY_LINES) {
      text = lines.slice(0, TOAST_BODY_LINES).join('\n');
      notes.push(`${lines.length - TOAST_BODY_LINES} more lines`);
    }
    if (text.length > TOAST_BODY_CHARS) text = text.slice(0, TOAST_BODY_CHARS);
    return { text, note: notes.join(' · '), tree: null };
  }

  // A much smaller cousin of the side panel's jsonNode: capped depth and
  // sibling count, because this renders inside a fixed-position toast that
  // has to stay light regardless of how big the real response is — the full
  // structure is one Locate click away in the panel.
  const TOAST_TREE_DEPTH = 4;
  const TOAST_TREE_ITEMS = 40;

  function toastJsonNode(key, value, depth) {
    const isObj = value !== null && typeof value === 'object';
    if (isObj) {
      const isArr = Array.isArray(value);
      const keys = isArr ? value : Object.keys(value);
      if (depth >= TOAST_TREE_DEPTH) {
        const leaf = document.createElement('div');
        leaf.className = 'leaf j-more';
        leaf.textContent = isArr ? `Array(${value.length})` : `Object {${keys.length}}`;
        return leaf;
      }
      const det = document.createElement('details');
      if (depth === 0) det.open = true;
      const sum = document.createElement('summary');
      if (key !== null) {
        const k = document.createElement('span');
        k.className = 'j-key';
        k.textContent = JSON.stringify(key) + ': ';
        sum.appendChild(k);
      }
      const hint = document.createElement('span');
      hint.className = 'j-hint';
      hint.textContent = isArr ? `Array(${value.length})` : `Object {${keys.length}}`;
      sum.appendChild(hint);
      det.appendChild(sum);

      const children = isArr ? value.map((v, i) => [i, v]) : Object.entries(value);
      for (const [k, v] of children.slice(0, TOAST_TREE_ITEMS)) {
        det.appendChild(toastJsonNode(String(k), v, depth + 1));
      }
      if (children.length > TOAST_TREE_ITEMS) {
        const more = document.createElement('div');
        more.className = 'j-more';
        more.textContent = `… ${children.length - TOAST_TREE_ITEMS} more — open in panel`;
        det.appendChild(more);
      }
      return det;
    }

    const div = document.createElement('div');
    div.className = 'leaf';
    if (key !== null) {
      const k = document.createElement('span');
      k.className = 'j-key';
      k.textContent = JSON.stringify(key) + ': ';
      div.appendChild(k);
    }
    const v = document.createElement('span');
    if (typeof value === 'string') { v.className = 'j-str'; v.textContent = JSON.stringify(value); }
    else if (typeof value === 'number') { v.className = 'j-num'; v.textContent = String(value); }
    else if (typeof value === 'boolean') { v.className = 'j-bool'; v.textContent = String(value); }
    else { v.className = 'j-null'; v.textContent = 'null'; }
    div.appendChild(v);
    return div;
  }

  // One line, whitespace flattened — the card is where the real body lives.
  function peekOf(d) {
    const raw = typeof d.responseBody === 'string' ? d.responseBody.trim() : '';
    if (!raw) return '';
    const flat = raw.replace(/\s+/g, ' ');
    return flat.length > TOAST_PEEK_CHARS ? `${flat.slice(0, TOAST_PEEK_CHARS)}…` : flat;
  }

  function buildCard(d) {
    const card = document.createElement('div');
    card.className = 'card';

    const url = document.createElement('div');
    url.className = 'url';
    url.textContent = d.url;
    card.appendChild(url);

    const { text, note, tree } = bodyPreview(d);
    if (tree !== null) {
      const treeEl = document.createElement('div');
      treeEl.className = 'jtree';
      treeEl.appendChild(toastJsonNode(null, tree, 0));
      card.appendChild(treeEl);
    } else {
      const pre = document.createElement('pre');
      pre.textContent = text;
      card.appendChild(pre);
    }

    if (note) {
      const noteEl = document.createElement('div');
      noteEl.className = 'note';
      noteEl.textContent = note;
      card.appendChild(noteEl);
    }

    const btns = document.createElement('div');
    btns.className = 'btns';
    const copyBtn = document.createElement('button');
    copyBtn.type = 'button';
    copyBtn.textContent = 'Copy body';
    copyBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      try {
        // Rejects on insecure origins and when the document is not focused.
        await navigator.clipboard.writeText(d.responseBody || '');
        copyBtn.textContent = 'Copied';
      } catch {
        copyBtn.textContent = 'Copy failed';
      }
      setTimeout(() => { copyBtn.textContent = 'Copy body'; }, 1500);
    });
    btns.appendChild(copyBtn);

    const locateBtn = document.createElement('button');
    locateBtn.type = 'button';
    locateBtn.textContent = 'Locate in panel';
    locateBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const original = locateBtn.textContent;
      const request = (attemptsLeft) => {
        try {
          chrome.runtime.sendMessage({ type: 'netlens:locate', id: d.id }, () => {
            // No receiver means the panel isn't open yet — open it and retry
            // a few times while it loads, rather than giving up on one miss
            // or retrying forever if it never opens.
            if (chrome.runtime.lastError && attemptsLeft > 0) {
              try { chrome.runtime.sendMessage({ type: 'netlens:openPanel' }); } catch {}
              setTimeout(() => request(attemptsLeft - 1), 500);
            }
          });
        } catch {}
      };
      request(3);
      locateBtn.textContent = 'Locating…';
      setTimeout(() => { locateBtn.textContent = original; }, 1200);
    });
    btns.appendChild(locateBtn);

    card.appendChild(btns);
    return card;
  }

  function updateMore() {
    if (!suppressed) {
      if (moreEl) { moreEl.remove(); moreEl = null; }
      return;
    }
    if (!moreEl) {
      moreEl = document.createElement('div');
      moreEl.className = 'more';
      ensureToastRoot().prepend(moreEl);
    }
    moreEl.textContent = `+${suppressed} more`;
  }

  let toastSeq = 0;

  function showToast(d) {
    const path = pathOf(d.url);
    // With dedupe off every call gets its own row, so the key must never collide.
    const key = toastSettings.dedupe
      ? `${d.method} ${path} ${statusClass(d)}`
      : `#${++toastSeq}`;
    const existing = liveToasts.get(key);
    if (existing) {
      existing.hits++;
      existing.countEl.textContent = `×${existing.hits}`;
      // Keep the body the user is already reading; otherwise the card should
      // show the latest response, not the one that opened the toast.
      if (!existing.el.classList.contains('open')) {
        existing.data = d;
        const peek = existing.el.querySelector('.peek');
        if (peek) peek.textContent = peekOf(d);
      }
      armDismiss(existing);
      return;
    }

    if (liveToasts.size >= toastSettings.maxStack) {
      suppressed++;
      updateMore();
      return;
    }

    const stack = ensureToastRoot();
    const el = document.createElement('div');
    el.className = `toast ${statusClass(d)}`;
    if (toastSettings.slowMs > 0 && d.duration > toastSettings.slowMs && !isError(d)) el.classList.add('slow');

    const line = document.createElement('div');
    line.className = 'line';
    const method = document.createElement('span');
    method.className = 'method';
    method.textContent = d.method;
    const status = document.createElement('span');
    status.className = 'status';
    status.textContent = d.failed || d.status === 0 ? (d.statusText || 'failed') : String(d.status);
    const pathEl = document.createElement('span');
    pathEl.className = 'path';
    pathEl.textContent = path;
    const countEl = document.createElement('span');
    countEl.className = 'count';
    const meta = document.createElement('span');
    meta.className = 'meta';
    const dur = document.createElement('span');
    dur.className = 'dur';
    dur.textContent = fmtDuration(d.duration);
    const size = fmtSize(d.responseSize);
    meta.append(dur, document.createTextNode(size ? ` ${size}` : ''));
    line.append(method, status, pathEl, countEl, meta);
    el.appendChild(line);

    if (toastSettings.bodyPeek) {
      const peekText = peekOf(d);
      if (peekText) {
        const peek = document.createElement('div');
        peek.className = 'peek';
        peek.textContent = peekText;
        el.appendChild(peek);
      }
    }

    const entry = { key, el, data: d, hits: 1, countEl, timer: null };

    el.addEventListener('click', () => {
      if (el.classList.contains('open')) return;
      el.classList.add('open');
      clearTimeout(entry.timer);
      el.appendChild(buildCard(entry.data));
      const close = document.createElement('button');
      close.type = 'button';
      close.textContent = 'Close';
      close.addEventListener('click', (e) => { e.stopPropagation(); dismiss(entry); });
      el.querySelector('.btns').appendChild(close);
    });

    liveToasts.set(key, entry);
    stack.appendChild(el);
    requestAnimationFrame(() => el.classList.add('in'));
    armDismiss(entry);
  }

  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && liveToasts.size) clearToasts();
  }, true);

  function entryBytes(d) {
    const req = typeof d.requestBody === 'string' ? d.requestBody.length : 0;
    const res = typeof d.responseBody === 'string' ? d.responseBody.length : 0;
    // Socket frames carry their payload on .data, not a body field.
    const frame = typeof d.data === 'string' ? d.data.length : 0;
    return req + res + frame + 512;
  }

  function trimBuffer() {
    if (buffer.length > RING_SIZE) buffer = buffer.slice(-RING_SIZE);
    let total = 0;
    for (const d of buffer) total += entryBytes(d);
    let cut = 0;
    while (cut < buffer.length - 1 && total > RING_BYTES) {
      total -= entryBytes(buffer[cut]);
      cut++;
    }
    if (cut) buffer = buffer.slice(cut);
  }

  function sendBatchToPanel(batch) {
    if (!panelLikely && Date.now() < panelRetryAt) return;
    const backOff = () => {
      panelLikely = false;
      panelRetryAt = Date.now() + PANEL_RETRY_MS;
    };
    try {
      chrome.runtime.sendMessage({ type: 'netlens:batch', batch }, () => {
        if (chrome.runtime.lastError) backOff();
        else panelLikely = true;
      });
    } catch {
      backOff();
    }
  }

  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    const data = event.data;
    if (!data || data.__netlens !== true || !Array.isArray(data.batch)) return;

    buffer.push(...data.batch);
    trimBuffer();

    for (const entry of data.batch) {
      if (toastMatch(entry, toastSettings)) showToast(entry);
    }

    sendBatchToPanel(data.batch);
  });

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg) return;
    // Any message from the panel proves it is listening, so resume sending
    // immediately rather than waiting out the backoff.
    panelLikely = true;
    panelRetryAt = 0;
    if (msg.type === 'netlens:dump') {
      sendResponse({ buffer });
      return;
    }
    if (msg.type === 'netlens:replay') {
      const rid = `r${Date.now()}_${Math.random().toString(36).slice(2)}`;
      let timer = null;
      let done = false;
      const finish = (result) => {
        if (done) return;
        done = true;
        window.removeEventListener('message', onResult);
        if (timer) clearTimeout(timer);
        try { sendResponse(result); } catch {}
      };
      const onResult = (event) => {
        if (event.source !== window) return;
        const d = event.data;
        if (!d || d.__netlens_replay_result !== true || d.rid !== rid) return;
        finish(d.result);
      };
      window.addEventListener('message', onResult);
      // A request that never settles would otherwise hold both this listener
      // and the sendResponse channel open for the life of the page.
      timer = setTimeout(() => finish({ ok: false, error: 'Replay timed out after 30s' }), 30000);
      try {
        window.postMessage({ __netlens_replay: true, rid, req: msg.req || {} }, '*');
      } catch (err) {
        finish({ ok: false, error: String((err && err.message) || err) });
      }
      return true;
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
      startPicker('inspect');
      sendResponse({ ok: true });
      return;
    }
    if (msg.type === 'netlens:inspect:stop') {
      stopPicker();
      sendResponse({ ok: true });
      return;
    }
    if (msg.type === 'netlens:reveal:start') {
      startPicker('reveal');
      sendResponse({ ok: true });
      return;
    }
    if (msg.type === 'netlens:reveal:stop') {
      stopPicker();
      sendResponse({ ok: true });
      return;
    }
    if (msg.type === 'netlens:pagestyles') {
      sendResponse(scanPageStyles());
      return;
    }
    if (msg.type === 'netlens:toast:test') {
      // Bypasses toastMatch()/enabled on purpose — this is how a dev previews
      // the toast's look while it's still off or mid-tune, not live traffic.
      showToast(TEST_TOASTS[testToastIdx]);
      testToastIdx = (testToastIdx + 1) % TEST_TOASTS.length;
      sendResponse({ ok: true });
      return;
    }
  });

  let testToastIdx = 0;
  const TEST_TOASTS = [
    { kind: 'fetch', method: 'GET', url: location.origin + '/api/users?page=1', status: 200, duration: 142, contentType: 'application/json', responseSize: 4312, responseBody: JSON.stringify({ users: [{ id: 1, name: 'Ada' }, { id: 2, name: 'Linus' }], total: 2 }) },
    { kind: 'fetch', method: 'POST', url: location.origin + '/api/orders', status: 201, duration: 88, contentType: 'application/json', responseSize: 96, responseBody: JSON.stringify({ id: 4417, status: 'pending' }) },
    { kind: 'fetch', method: 'GET', url: location.origin + '/api/reports/22', status: 200, duration: 1840, contentType: 'application/json', responseSize: 93184, responseBody: JSON.stringify({ rows: 500 }) },
    { kind: 'fetch', method: 'POST', url: location.origin + '/api/checkout', status: 422, statusText: 'Unprocessable Entity', duration: 210, contentType: 'application/json', responseSize: 58, responseBody: JSON.stringify({ error: 'card_declined' }) },
    { kind: 'fetch', method: 'GET', url: location.origin + '/api/login', status: 0, statusText: 'Failed to fetch', failed: true, duration: 30 },
  ];

  // ------------------------------------------------------------- inspector
  const MAX_HTML = 20 * 1024;
  let overlayEl = null;
  let labelEl = null;
  let pickerActive = false;
  let pickerMode = 'inspect';
  let rafPending = false;
  let lastHovered = null;

  let initialHtmlSnapshot = null;
  function captureInitialHtml() {
    if (initialHtmlSnapshot || !document.documentElement) return;
    try { initialHtmlSnapshot = document.documentElement.innerHTML.slice(0, 500000); } catch {}
  }
  // Must run before the page's scripts render, or every visible string reads
  // as server-rendered and the SSR/network distinction in Reveal is lost.
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', captureInitialHtml, { once: true });
  } else {
    captureInitialHtml();
  }

  function extractElementContext(el) {
    if (!el) return null;
    if (el.nodeType === 3) el = el.parentElement;
    if (!el || el.nodeType !== 1) return null;

    const text = (el.innerText || el.textContent || '').trim();
    const tag = (el.tagName || '').toLowerCase();
    const id = el.id || '';
    const classes = typeof el.className === 'string'
      ? el.className.trim().split(/\s+/).filter(Boolean)
      : [];

    const attributes = {};
    for (const attr of el.attributes || []) {
      const name = attr.name.toLowerCase();
      if (name.startsWith('data-') || ['src', 'href', 'value', 'placeholder', 'aria-label', 'alt', 'title', 'id'].includes(name)) {
        attributes[name] = attr.value;
      }
    }

    let nearbyText = '';
    if (el.previousElementSibling) {
      const prevText = (el.previousElementSibling.textContent || '').trim();
      if (prevText.length > 0 && prevText.length < 50) nearbyText += prevText + ' ';
    }
    const label = el.closest ? (el.closest('label') || (id ? document.querySelector(`label[for="${CSS.escape(id)}"]`) : null)) : null;
    if (label) nearbyText += (label.textContent || '').trim() + ' ';

    if (tag === 'td') {
      const tr = el.parentElement;
      if (tr) {
        const cellIdx = Array.from(tr.children).indexOf(el);
        const table = tr.closest ? tr.closest('table') : null;
        if (table && cellIdx !== -1) {
          const th = table.querySelector(`thead th:nth-child(${cellIdx + 1})`) || table.querySelector(`tr th:nth-child(${cellIdx + 1})`);
          if (th) nearbyText += (th.textContent || '').trim() + ' ';
        }
      }
    }

    function findCardContainer(node) {
      if (!node || node === document.body || node === document.documentElement) return null;
      const matched = node.closest ? node.closest('tr, li, article, [class*="card"], [class*="item"], [class*="product"], [class*="hotel"], [class*="result"], [class*="listing"], [class*="entry"], [class*="tile"], [data-testid], [data-id]') : null;
      if (matched && matched !== document.body && matched !== document.documentElement) return matched;

      let curr = node.parentElement;
      let best = null;
      let depth = 0;
      while (curr && curr !== document.body && curr !== document.documentElement && depth < 7) {
        const hasHeading = curr.querySelector ? curr.querySelector('h1, h2, h3, h4, h5, h6') : null;
        if (hasHeading && curr.contains(node) && curr !== node) {
          best = curr;
        }
        curr = curr.parentElement;
        depth++;
      }
      return (best && best !== document.body && best !== document.documentElement) ? best : null;
    }

    const containerTexts = [];
    const container = findCardContainer(el);
    if (container) {
      const headings = Array.from(container.querySelectorAll('h1, h2, h3, h4, h5, h6'))
        .map(h => (h.innerText || h.textContent || '').trim())
        .filter(s => s.length > 2);
      containerTexts.push(...headings);

      const raw = container.innerText || container.textContent || '';
      const lines = raw.split(/[\n\r]+/).map(s => s.trim()).filter(s => s.length > 1 && s.length < 120);
      containerTexts.push(...lines.slice(0, 25));
    }

    captureInitialHtml();
    const inInitialHtml = Boolean(initialHtmlSnapshot && text.length > 2 && initialHtmlSnapshot.includes(text));

    const isContainerElem = el !== document.body && el !== document.documentElement && el.children && el.children.length >= 2 && (
      (el.matches && el.matches('tr, li, article, [class*="card"], [class*="item"], [class*="product"], [class*="hotel"], [class*="flight"], [class*="result"], [class*="listing"], [class*="tile"], [data-testid], [data-id]')) ||
      (el.querySelectorAll && el.querySelectorAll('h1, h2, h3, h4, h5, h6, img[src], a[href], [class*="price"], [class*="badge"], [class*="tag"], [class*="status"], [class*="title"], [class*="name"], td, th, p, span').length >= 2) ||
      text.length > 50
    );

    const subElements = [];
    if (isContainerElem) {
      const candidates = el.querySelectorAll('h1, h2, h3, h4, h5, h6, img[src], a[href], [class*="price"], [class*="badge"], [class*="tag"], [class*="status"], [class*="title"], [class*="name"], td, th, p, span');
      const seen = new Set();
      for (const child of candidates) {
        if (subElements.length >= 15) break;
        const isImg = child.tagName.toLowerCase() === 'img';
        const src = isImg ? child.getAttribute('src') : null;
        const cText = (child.innerText || child.textContent || '').trim();

        if (isImg && src) {
          if (!seen.has(src)) {
            seen.add(src);
            subElements.push({
              text: '',
              tag: 'img',
              classes: typeof child.className === 'string' ? child.className.trim().split(/\s+/).filter(Boolean) : [],
              attributes: { src },
              nearbyText: '',
              containerTexts: [src],
            });
          }
        } else if (cText && cText.length >= 2 && cText.length < 100 && !seen.has(cText)) {
          if (child.children.length > 2) continue;
          seen.add(cText);
          subElements.push({
            text: cText,
            tag: child.tagName.toLowerCase(),
            classes: typeof child.className === 'string' ? child.className.trim().split(/\s+/).filter(Boolean) : [],
            attributes: {},
            nearbyText: '',
            containerTexts: [cText],
          });
        }
      }
    }

    const isContainer = isContainerElem && subElements.length >= 2;

    return {
      text,
      tag,
      id,
      classes,
      attributes,
      nearbyText: nearbyText.trim(),
      containerTexts,
      inInitialHtml,
      isContainer,
      subElements: isContainer ? subElements : [],
      ssrPayloads: extractSsrPayloads(),
    };
  }

  function extractSsrPayloads() {
    const scripts = document.querySelectorAll('script[type="application/json"], script[type="application/ld+json"]');
    const payloads = [];
    let total = 0;
    for (const s of scripts) {
      if (payloads.length >= 8) break;
      const text = (s.textContent || '').trim();
      if (text.length < 2 || text.length > 750000 || total + text.length > 2000000) continue;
      total += text.length;
      const name = s.id === '__NEXT_DATA__' ? 'Next.js (__NEXT_DATA__)'
        : (s.id ? `#${s.id}` : (s.type.includes('ld') ? 'JSON-LD' : (s.getAttribute('data-name') || 'SSR JSON')));
      payloads.push({ id: s.id || `ssr-${payloads.length}`, name, json: text });
    }
    return payloads;
  }

  function ensureOverlay() {
    if (overlayEl) {
      const isReveal = pickerMode === 'reveal';
      overlayEl.style.background = isReveal ? 'rgba(16, 185, 129, 0.15)' : 'rgba(99, 102, 241, 0.15)';
      overlayEl.style.border = isReveal ? '1px solid #10b981' : '1px solid #818cf8';
      labelEl.style.borderColor = isReveal ? '#059669' : '#30363d';
      return;
    }
    const isReveal = pickerMode === 'reveal';
    overlayEl = document.createElement('div');
    overlayEl.style.cssText = 'position:fixed;pointer-events:none;z-index:2147483647;box-sizing:border-box;transition:none;' +
      (isReveal ? 'background:rgba(16, 185, 129, 0.15);border:1px solid #10b981;' : 'background:rgba(99, 102, 241, 0.15);border:1px solid #818cf8;');
    labelEl = document.createElement('div');
    labelEl.style.cssText = 'position:fixed;pointer-events:none;z-index:2147483647;' +
      'background:#161b22;color:#e6edf3;font:11px ui-monospace,monospace;padding:2px 6px;' +
      'border-radius:4px;border:1px solid ' + (isReveal ? '#059669;' : '#30363d;') + 'white-space:nowrap;';
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
    if (pickerMode === 'reveal') {
      labelEl.textContent = `${el.tagName.toLowerCase()}${id}${cls}  Click to reveal API source`;
    } else {
      labelEl.textContent = `${el.tagName.toLowerCase()}${id}${cls}  ${Math.round(rect.width)}×${Math.round(rect.height)}`;
    }
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
    let t = e.target;
    if (t && t.nodeType === 3) t = t.parentElement;
    if (!t || t.nodeType !== 1) return;
    lastHovered = t;
    if (rafPending) return;
    rafPending = true;
    requestAnimationFrame(() => {
      rafPending = false;
      if (!pickerActive || !lastHovered) return;
      positionOverlay(lastHovered);
      if (pickerMode !== 'reveal') sendHover(lastHovered);
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
    try {
      chrome.runtime.sendMessage({ type: 'netlens:inspect:result', data }, (res) => {
        if (chrome.runtime.lastError || !res || !res.ok) {
          try {
            chrome.storage.local.set({ netlensPendingAction: { type: 'inspect', data, at: Date.now() } }, () => {
              try { chrome.runtime.sendMessage({ type: 'netlens:openPanel' }); } catch {}
            });
          } catch {}
        }
      });
    } catch {}
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
    let target = lastHovered || e.target;
    if (target && target.nodeType === 3) target = target.parentElement;
    if (pickerMode === 'reveal') {
      const context = extractElementContext(target);
      stopPicker();
      if (context) {
        try {
          chrome.runtime.sendMessage({ type: 'netlens:reveal:result', context }, (res) => {
            if (chrome.runtime.lastError || !res || !res.ok) {
              try {
                chrome.storage.local.set({ netlensPendingAction: { type: 'reveal', context, at: Date.now() } }, () => {
                  try { chrome.runtime.sendMessage({ type: 'netlens:openPanel' }); } catch {}
                });
              } catch {}
            }
          });
        } catch {}
      }
      return;
    }
    if (target && target.nodeType === 1) lockOn(target);
  }

  function onKeydown(e) {
    if (e.key !== 'Escape') return;
    const mode = pickerMode;
    stopPicker();
    try {
      chrome.runtime.sendMessage({ type: mode === 'reveal' ? 'netlens:reveal:cancelled' : 'netlens:inspect:cancelled' }, () => { void chrome.runtime.lastError; });
    } catch {}
  }

  // ---------------------------------------------------- page-wide styles
  // Walking the whole tree costs a getComputedStyle per element, so it runs
  // only on an explicit request and stops at a ceiling rather than hanging a
  // 50k-node page.
  // ponytail: flat cap, sample every Nth element if real pages hit the ceiling
  const SCAN_LIMIT = 10000;
  const SCAN_SKIP_TAGS = new Set(['script', 'style', 'link', 'meta', 'title', 'noscript', 'template', 'br']);
  const TRANSPARENT = new Set(['rgba(0, 0, 0, 0)', 'transparent']);
  const SIDES = ['Top', 'Right', 'Bottom', 'Left'];

  function scanPageStyles() {
    const all = document.querySelectorAll('body *');
    const limit = Math.min(all.length, SCAN_LIMIT);
    const fonts = new Map();
    const colors = new Map();

    const bump = (map, key, role) => {
      let hit = map.get(key);
      if (!hit) {
        hit = { count: 0, roles: new Set(), sizes: new Set(), weights: new Set() };
        map.set(key, hit);
      }
      hit.count++;
      if (role) hit.roles.add(role);
      return hit;
    };

    for (let i = 0; i < limit; i++) {
      const el = all[i];
      if (el === defaultsFrame || el === overlayEl || el === labelEl) continue;
      if (SCAN_SKIP_TAGS.has(el.tagName.toLowerCase())) continue;

      const cs = getComputedStyle(el);
      if (cs.display === 'none' || cs.visibility === 'hidden' || cs.opacity === '0') continue;

      // Only elements holding their own text contribute a font or a text
      // colour; every wrapper inherits both and would otherwise dominate the
      // tally without anything on screen to show for it.
      const hasOwnText = Array.from(el.childNodes).some((n) => n.nodeType === 3 && n.nodeValue.trim());
      if (hasOwnText) {
        const font = bump(fonts, cs.fontFamily);
        font.sizes.add(cs.fontSize);
        font.weights.add(cs.fontWeight);
        if (!TRANSPARENT.has(cs.color)) bump(colors, cs.color, 'text');
      }
      if (!TRANSPARENT.has(cs.backgroundColor)) bump(colors, cs.backgroundColor, 'background');
      for (const side of SIDES) {
        if (cs[`border${side}Width`] === '0px') continue;
        const color = cs[`border${side}Color`];
        if (!TRANSPARENT.has(color)) bump(colors, color, 'border');
      }
    }

    const byCount = (a, b) => b.count - a.count;
    const px = (v) => parseFloat(v) || 0;
    return {
      fonts: [...fonts].map(([family, v]) => ({
        family,
        count: v.count,
        sizes: [...v.sizes].sort((a, b) => px(a) - px(b)),
        weights: [...v.weights].sort((a, b) => px(a) - px(b)),
      })).sort(byCount),
      colors: [...colors].map(([value, v]) => ({ value, count: v.count, roles: [...v.roles] })).sort(byCount),
      scanned: limit,
      truncated: all.length > limit,
    };
  }

  function startPicker(mode = 'inspect') {
    if (pickerActive) {
      if (pickerMode === mode) {
        stopPicker();
        return;
      }
      stopPicker();
    }
    pickerActive = true;
    pickerMode = mode;
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

  function isEditableTarget(target) {
    if (!target) return false;
    const tag = (target.tagName || '').toLowerCase();
    return tag === 'input' || tag === 'textarea' || tag === 'select' || Boolean(target.isContentEditable);
  }

  window.addEventListener('keydown', (e) => {
    if (isEditableTarget(e.target)) return;
    if (typeof matchesShortcut === 'function') {
      if (matchesShortcut(e, shortcutSettings.reveal)) {
        e.preventDefault();
        e.stopPropagation();
        startPicker('reveal');
      } else if (matchesShortcut(e, shortcutSettings.inspect)) {
        e.preventDefault();
        e.stopPropagation();
        startPicker('inspect');
      }
    }
  }, true);
})();
