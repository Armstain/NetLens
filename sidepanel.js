
(() => {
  const MAX_ROWS = 500;
  const BODY_SEARCH_CAP = 20 * 1024; 
  const FILTER_DEBOUNCE_MS = 80;

  const listEl = document.getElementById('list');
  const emptyEl = document.getElementById('empty');
  const filterEmptyEl = document.getElementById('filterEmpty');
  const countEl = document.getElementById('count');
  const pulseEl = document.getElementById('pulse');
  const filterEl = document.getElementById('filter');
  const errorsOnlyEl = document.getElementById('errorsOnly');
  const apiOnlyEl = document.getElementById('apiOnly');
  const showLogsEl = document.getElementById('showLogs');
  const pauseBtn = document.getElementById('pauseBtn');
  const clearBtn = document.getElementById('clearBtn');

  let currentTabId = null;
  let currentTabUrl = '';
  let entries = [];
  const restoredIds = new Set();           
  let sessions = [];
  let paused = false;
  let pulseTimer = null;

  // Drawer panels register here so opening one closes the rest instead of
  // stacking. Fullscreen isn't part of this group — it's a full overlay.
  const slidePanels = [];

  function buildSeparatorContent(el, url, timestamp, isCurrent = true) {
    el.textContent = '';
    
    const label = document.createElement('span');
    label.className = 'session-label';
    label.textContent = isCurrent ? 'Current Page' : 'Previous Page';
    
    const urlSpan = document.createElement('span');
    urlSpan.className = 'session-url';
    urlSpan.textContent = pathOf(url);
    urlSpan.title = url;
    
    const timeSpan = document.createElement('span');
    timeSpan.className = 'session-time';
    const d = new Date(timestamp);
    timeSpan.textContent = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    
    el.append(label, urlSpan, timeSpan);
  }

  function renderValueNode(value) {
    if (typeof value === 'object' && value !== null) {
      const tree = document.createElement('div');
      tree.className = 'jtree';
      const root = jsonNode(null, value, true);
      if (root.tagName === 'DETAILS') root.open = true;
      tree.appendChild(root);
      return tree;
    }
    const pre = document.createElement('pre');
    pre.className = 'raw';
    pre.textContent = String(value);
    return pre;
  }

  function buildDecodedTable(items) {
    const table = document.createElement('table');
    table.className = 'kv decoded-table';
    for (const item of items) {
      const tr = document.createElement('tr');
      const tdKey = document.createElement('td');
      tdKey.className = 'decoded-key-cell';
      tdKey.textContent = item.key;
      const tdVal = document.createElement('td');
      tdVal.className = 'decoded-val-cell';
      tdVal.appendChild(renderValueNode(item.value));
      tr.append(tdKey, tdVal);
      table.appendChild(tr);
    }
    return table;
  }

  function addSessionDecodedIfAny(containerEl, url) {
    const existing = containerEl.querySelector('.session-decoded');
    if (existing) existing.remove();

    try {
      const u = new URL(url);
      const decodedParams = [];
      for (const [key, val] of u.searchParams.entries()) {
        const decoded = tryDecodeStructure(val, customDecoders);
        if (decoded) {
          decodedParams.push({ key, method: decoded.method, value: decoded.value });
        }
      }
      
      const segments = u.pathname.split('/').filter(Boolean);
      const decodedSegments = [];
      for (let i = 0; i < segments.length; i++) {
        const decoded = tryDecodeStructure(segments[i], customDecoders);
        if (decoded) {
          decodedSegments.push({ key: `Path Segment [${i}]`, method: decoded.method, value: decoded.value });
        }
      }

      if (decodedParams.length > 0 || decodedSegments.length > 0) {
        const decDiv = document.createElement('div');
        decDiv.className = 'session-decoded';
        
        const details = document.createElement('details');
        const summary = document.createElement('summary');
        summary.textContent = '🔍 View Decoded URL Parameters';
        details.appendChild(summary);

        const inner = document.createElement('div');
        inner.className = 'session-decoded-inner';
        
        if (decodedParams.length > 0) {
          const title = document.createElement('div');
          title.className = 'decoded-section-title';
          title.textContent = 'Query Parameters';
          inner.appendChild(title);
          inner.appendChild(buildDecodedTable(decodedParams));
        }

        if (decodedSegments.length > 0) {
          const title = document.createElement('div');
          title.className = 'decoded-section-title';
          title.textContent = 'URL Path Segments';
          inner.appendChild(title);
          inner.appendChild(buildDecodedTable(decodedSegments));
        }

        details.appendChild(inner);
        decDiv.appendChild(details);
        containerEl.appendChild(decDiv);
      }
    } catch {}
  }

  function startNewSession(url) {
    if (!url) url = currentTabUrl || 'Unknown URL';

    if (sessions.length > 0) {
      const current = sessions[sessions.length - 1];
      if (current.entries.length === 0) {
        current.url = url;
        current.timestamp = Date.now();
        if (current.separatorEl) {
          buildSeparatorContent(current.separatorEl, url, current.timestamp, true);
        }
        if (current.dbId != null) dbUpdateSession(current.dbId, url, current.timestamp).catch(() => {});
        addSessionDecodedIfAny(current.containerEl, url);
        return;
      }
    }

    if (sessions.length > 0) {
      const current = sessions[sessions.length - 1];
      for (const entry of current.entries) {
        entry.el.classList.add('archived');
      }
      if (current.separatorEl) {
        buildSeparatorContent(current.separatorEl, current.url, current.timestamp, false);
      }
      const openRows = listEl.querySelectorAll('.row.open');
      openRows.forEach(r => r.classList.remove('open'));
    }

    const containerEl = document.createElement('div');
    containerEl.className = 'session-container';

    const separatorEl = document.createElement('div');
    separatorEl.className = 'session-separator';
    const timestamp = Date.now();
    buildSeparatorContent(separatorEl, url, timestamp, true);

    containerEl.appendChild(separatorEl);
    addSessionDecodedIfAny(containerEl, url);
    listEl.prepend(containerEl);

    const newSession = {
      url,
      timestamp,
      entries: [],
      separatorEl,
      containerEl,
      dbId: null,
      // Entries can arrive before IndexedDB hands back the session id, so they
      // queue here rather than being dropped.
      pending: []
    };
    sessions.push(newSession);

    dbStartSession(url, timestamp).then((id) => {
      newSession.dbId = id;
      if (newSession.pending.length) dbAddEntries(id, newSession.pending.splice(0)).catch(() => {});
      return dbPrune();
    }).catch(() => {});

    while (sessions.length > 2) {
      const oldSession = sessions.shift();
      if (oldSession.containerEl) oldSession.containerEl.remove();
      for (const entry of oldSession.entries) {
        entry.el.remove();
        const idx = entries.indexOf(entry);
        if (idx !== -1) {
          entries.splice(idx, 1);
        }
      }
    }

    updateCount();
  }

  // ------------------------------------------------------- decoder registry
  // Pure decode logic (decodeText, DECODER_STEPS, tryDecode, tryDecodeStructure,
  // hasDecodableData, ...) lives in decoders.js, loaded before this file.
  // customDecoders stays here — it's UI-owned state (chrome.storage-backed,
  // edited by the decoder-manager panel) — and is passed into those pure
  // functions as an explicit argument at each call site.
  let customDecoders = [];
  try {
    chrome.storage.local.get(['netlensCustomDecoders'], (res) => {
      if (res && Array.isArray(res.netlensCustomDecoders)) customDecoders = res.netlensCustomDecoders;
      renderDecoderList();
    });
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === 'local' && changes.netlensCustomDecoders) {
        customDecoders = changes.netlensCustomDecoders.newValue || [];
      }
    });
  } catch {}

  function saveCustomDecoders() {
    chrome.storage.local.set({ netlensCustomDecoders: customDecoders });
  }

  // --------------------------------------------------------- toast settings
  // Read by content.js on every page, so the toast fires with the panel closed.
  // The rules live in net-format.js and are shared with that content script.
  let toastSettings = normalizeToastSettings(null);

  const setEls = {
    enabled: document.getElementById('setEnabled'),
    slowMs: document.getElementById('setSlowMs'),
    urlMatch: document.getElementById('setUrlMatch'),
    gqlMutationsOnly: document.getElementById('setGqlMutationsOnly'),
    dismissMs: document.getElementById('setDismissMs'),
    errorDismissMs: document.getElementById('setErrorDismissMs'),
    maxStack: document.getElementById('setMaxStack'),
    position: document.getElementById('setPosition'),
    dedupe: document.getElementById('setDedupe'),
    bodyPeek: document.getElementById('setBodyPeek'),
  };
  const settingsBody = document.querySelector('.settings-body');
  const statusChipsEl = document.getElementById('setStatus');
  const methodChipsEl = document.getElementById('setMethods');
  const methodGroupChipsEl = document.getElementById('setMethodGroups');

  const STATUS_CHIP_LABELS = { s2xx: '2xx', s3xx: '3xx', s4xx: '4xx', s5xx: '5xx', failed: 'failed' };

  function buildChips(container, keys, label, extraClass) {
    container.replaceChildren();
    for (const key of keys) {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'set-chip';
      chip.dataset.key = key;
      chip.textContent = label(key);
      if (extraClass) chip.classList.add(extraClass(key));
      container.appendChild(chip);
    }
  }

  const METHOD_GROUP_LABELS = {
    reads: `Reads (${TOAST_METHOD_GROUPS.reads.join(', ')})`,
    writes: `Writes (${TOAST_METHOD_GROUPS.writes.join(', ')})`,
  };

  buildChips(statusChipsEl, TOAST_STATUS_CLASSES, (k) => STATUS_CHIP_LABELS[k], (k) =>
    k === 's4xx' || k === 's5xx' || k === 'failed' ? 'chip-err' : 'chip-ok');
  buildChips(methodChipsEl, TOAST_METHODS, (k) => k);
  buildChips(methodGroupChipsEl, Object.keys(TOAST_METHOD_GROUPS), (k) => METHOD_GROUP_LABELS[k]);

  const methodOn = (key) => toastSettings.methods[key] !== false;

  // Built from TOAST_POSITIONS rather than hardcoded in the HTML, so the
  // dropdown can never offer a value normalizeToastSettings() wouldn't accept.
  for (const pos of TOAST_POSITIONS) {
    const option = document.createElement('option');
    option.value = pos;
    option.textContent = pos;
    setEls.position.appendChild(option);
  }

  function renderSettings() {
    const s = toastSettings;
    setEls.enabled.checked = s.enabled;
    setEls.slowMs.value = s.slowMs;
    setEls.urlMatch.value = s.urlMatch;
    setEls.gqlMutationsOnly.checked = s.gqlMutationsOnly;
    setEls.dismissMs.value = s.dismissMs;
    setEls.errorDismissMs.value = s.errorDismissMs;
    setEls.maxStack.value = s.maxStack;
    setEls.position.value = s.position;
    setEls.dedupe.checked = s.dedupe;
    setEls.bodyPeek.checked = s.bodyPeek;
    for (const chip of statusChipsEl.children) chip.classList.toggle('on', !!s.status[chip.dataset.key]);
    for (const chip of methodChipsEl.children) chip.classList.toggle('on', methodOn(chip.dataset.key));
    // A group chip is 'partial' when the per-method list underneath disagrees
    // with itself — otherwise expanding it would contradict what it shows.
    for (const chip of methodGroupChipsEl.children) {
      const members = TOAST_METHOD_GROUPS[chip.dataset.key];
      const onCount = members.filter(methodOn).length;
      chip.classList.toggle('on', onCount > 0);
      chip.classList.toggle('partial', onCount > 0 && onCount < members.length);
    }
    settingsBody.classList.toggle('off', !s.enabled);
  }

  function saveSettings(patch) {
    toastSettings = normalizeToastSettings({ ...toastSettings, ...patch });
    renderSettings();
    try {
      chrome.storage.local.set({ netlensToastSettings: toastSettings });
    } catch {}
  }

  try {
    chrome.storage.local.get(['netlensToastSettings'], (res) => {
      toastSettings = normalizeToastSettings(res && res.netlensToastSettings);
      renderSettings();
    });
  } catch {}
  renderSettings();

  setEls.enabled.addEventListener('change', () => saveSettings({ enabled: setEls.enabled.checked }));
  setEls.gqlMutationsOnly.addEventListener('change', () => saveSettings({ gqlMutationsOnly: setEls.gqlMutationsOnly.checked }));
  setEls.dedupe.addEventListener('change', () => saveSettings({ dedupe: setEls.dedupe.checked }));
  setEls.bodyPeek.addEventListener('change', () => saveSettings({ bodyPeek: setEls.bodyPeek.checked }));
  setEls.position.addEventListener('change', () => saveSettings({ position: setEls.position.value }));
  setEls.urlMatch.addEventListener('input', () => saveSettings({ urlMatch: setEls.urlMatch.value }));
  for (const key of ['slowMs', 'dismissMs', 'errorDismissMs', 'maxStack']) {
    // 'change' not 'input': normalize clamps, and clamping mid-keystroke would
    // fight the typist (typing "1" toward "1500" would snap to the minimum).
    setEls[key].addEventListener('change', () => saveSettings({ [key]: setEls[key].value }));
  }

  statusChipsEl.addEventListener('click', (e) => {
    const chip = e.target.closest('.set-chip');
    if (!chip) return;
    saveSettings({ status: { ...toastSettings.status, [chip.dataset.key]: !chip.classList.contains('on') } });
  });
  methodChipsEl.addEventListener('click', (e) => {
    const chip = e.target.closest('.set-chip');
    if (!chip) return;
    saveSettings({ methods: { ...toastSettings.methods, [chip.dataset.key]: !chip.classList.contains('on') } });
  });
  methodGroupChipsEl.addEventListener('click', (e) => {
    const chip = e.target.closest('.set-chip');
    if (!chip) return;
    // Partial counts as off, so one click on a half-lit group turns all of it
    // on rather than making you clear the odd one out first.
    const members = TOAST_METHOD_GROUPS[chip.dataset.key];
    const turnOn = !members.every(methodOn);
    const methods = { ...toastSettings.methods };
    for (const method of members) methods[method] = turnOn;
    saveSettings({ methods });
  });

  // Presets write into the same fields the chips edit, so there is one source
  // of truth and a preset is just a starting point you can then tweak.
  document.querySelector('.set-presets').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-preset]');
    if (!btn) return;
    saveSettings({ ...TOAST_PRESETS[btn.dataset.preset], enabled: true });
  });

  document.getElementById('setReset').addEventListener('click', () => {
    toastSettings = normalizeToastSettings(null);
    saveSettings({});
  });

  document.getElementById('setTestToast').addEventListener('click', () => {
    if (currentTabId == null) return;
    chrome.tabs.sendMessage(currentTabId, { type: 'netlens:toast:test' }, () => { void chrome.runtime.lastError; });
  });

  // MV3 extension pages default to a CSP with no 'unsafe-eval', which a
  // Worker created here would inherit — new Function() would throw. The
  // sanctioned exception is a manifest "sandbox" page (sandbox.html), which
  // gets a relaxed CSP but zero access to chrome.* APIs, tabs, or storage.
  // The eval itself still runs in a Worker inside that page so a runaway
  // loop is recoverable via Worker.terminate() rather than hanging a frame.
  let sandboxFrame = null;
  let sandboxReadyPromise = null;
  const sandboxPending = new Map(); // reqId -> { resolve, reject }
  let sandboxReqSeq = 0;

  function ensureSandbox() {
    if (sandboxReadyPromise) return sandboxReadyPromise;
    sandboxReadyPromise = new Promise((resolve) => {
      sandboxFrame = document.createElement('iframe');
      sandboxFrame.hidden = true;
      sandboxFrame.src = chrome.runtime.getURL('sandbox.html');
      sandboxFrame.addEventListener('load', () => resolve(), { once: true });
      document.body.appendChild(sandboxFrame);
    });
    return sandboxReadyPromise;
  }

  window.addEventListener('message', (event) => {
    const data = event.data;
    if (!sandboxFrame || event.source !== sandboxFrame.contentWindow) return;
    if (!data || data.__netlensSandbox !== true) return;
    const entry = sandboxPending.get(data.reqId);
    if (!entry) return;
    sandboxPending.delete(data.reqId);
    if (data.ok) entry.resolve(data.result);
    else entry.reject(new Error(data.error || 'Unknown error'));
  });

  async function runCustomFunction(code, input, timeoutMs = 1000) {
    await ensureSandbox();
    const reqId = ++sandboxReqSeq;
    return new Promise((resolve, reject) => {
      sandboxPending.set(reqId, { resolve, reject });
      // targetOrigin '*': sandbox.html has an opaque ("null") origin by spec,
      // so it can't be addressed by an origin string. Only our own iframe —
      // one we created, pointed at our own extension's sandbox.html — ever
      // receives this, so it isn't an exposure.
      sandboxFrame.contentWindow.postMessage(
        { __netlensSandbox: true, op: 'run', reqId, code, input, timeoutMs }, '*'
      );
    });
  }

  function renderDecoded(container, d) {
    container.textContent = '';
    const decodedSections = [];

    try {
      const u = new URL(d.url);
      
      const params = Array.from(u.searchParams.entries());
      const decodedParams = [];
      for (const [key, val] of params) {
        const decoded = tryDecodeStructure(val, customDecoders);
        if (decoded) {
          decodedParams.push({ key, method: decoded.method, value: decoded.value });
        }
      }
      if (decodedParams.length > 0) {
        decodedSections.push({ title: 'Query Parameters', items: decodedParams });
      }

      const segments = u.pathname.split('/').filter(Boolean);
      const decodedSegments = [];
      for (let i = 0; i < segments.length; i++) {
        const decoded = tryDecodeStructure(segments[i], customDecoders);
        if (decoded) {
          decodedSegments.push({ key: `Path Segment [${i}]`, method: decoded.method, value: decoded.value });
        }
      }
      if (decodedSegments.length > 0) {
        decodedSections.push({ title: 'URL Path Segments', items: decodedSegments });
      }
    } catch {}

    if (d.requestBody) {
      const decoded = tryDecodeStructure(d.requestBody, customDecoders);
      if (decoded) {
        decodedSections.push({
          title: 'Request Body',
          items: [{ key: 'Body', method: decoded.method, value: decoded.value }]
        });
      }
    }

    if (d.responseBody) {
      const decoded = tryDecodeStructure(d.responseBody, customDecoders);
      if (decoded) {
        decodedSections.push({
          title: 'Response Body',
          items: [{ key: 'Body', method: decoded.method, value: decoded.value }]
        });
      }
    }

    const decodedHeaders = [];
    const checkHeaders = (headers, type) => {
      for (const [k, v] of Object.entries(headers || {})) {
        const decoded = tryDecodeStructure(v, customDecoders);
        if (decoded) {
          decodedHeaders.push({ key: `${type}: ${k}`, method: decoded.method, value: decoded.value });
        }
      }
    };
    checkHeaders(d.requestHeaders, 'Request');
    checkHeaders(d.responseHeaders, 'Response');
    if (decodedHeaders.length > 0) {
      decodedSections.push({ title: 'Headers', items: decodedHeaders });
    }

    if (decodedSections.length === 0) {
      const note = document.createElement('div');
      note.className = 'note';
      note.textContent = 'No encoded data detected.';
      container.appendChild(note);
    }

    for (const sec of decodedSections) {
      const secTitle = document.createElement('div');
      secTitle.className = 'decoded-section-title';
      secTitle.textContent = sec.title;

      if (sec.items.length === 1 && sec.items[0].key === 'Body') {
        const item = sec.items[0];
        if (item.method && item.method !== 'JSON Structure') {
          const methodSpan = document.createElement('span');
          methodSpan.className = 'decoded-method-label';
          methodSpan.style.marginTop = '0';
          methodSpan.style.marginLeft = '8px';
          methodSpan.textContent = item.method;
          secTitle.appendChild(methodSpan);
        }
        container.appendChild(secTitle);

        if (typeof item.value === 'object' && item.value !== null) {
          const tree = document.createElement('div');
          tree.className = 'jtree';
          const root = jsonNode(null, item.value, true);
          if (root.tagName === 'DETAILS') root.open = true;
          tree.appendChild(root);
          container.appendChild(tree);
        } else {
          const pre = document.createElement('pre');
          pre.className = 'raw';
          pre.textContent = String(item.value);
          container.appendChild(pre);
        }
        continue;
      }

      container.appendChild(secTitle);

      const table = document.createElement('table');
      table.className = 'kv decoded-table';

      for (const item of sec.items) {
        const tr = document.createElement('tr');
        
        const tdKey = document.createElement('td');
        tdKey.className = 'decoded-key-cell';
        const keySpan = document.createElement('span');
        keySpan.textContent = item.key;
        tdKey.appendChild(keySpan);

        if (item.method && item.method !== 'JSON Structure') {
          const methodSpan = document.createElement('span');
          methodSpan.className = 'decoded-method-label';
          methodSpan.textContent = item.method;
          tdKey.append(document.createElement('br'), methodSpan);
        }

        const tdVal = document.createElement('td');
        tdVal.className = 'decoded-val-cell';
        
        if (typeof item.value === 'object' && item.value !== null) {
          const tree = document.createElement('div');
          tree.className = 'jtree';
          const root = jsonNode(null, item.value, true);
          if (root.tagName === 'DETAILS') root.open = true;
          tree.appendChild(root);
          tdVal.appendChild(tree);
        } else {
          const pre = document.createElement('pre');
          pre.className = 'raw';
          pre.textContent = String(item.value);
          tdVal.appendChild(pre);
        }
        
        tr.append(tdKey, tdVal);
        table.appendChild(tr);
      }
      container.appendChild(table);
    }

    appendManualDecodePanel(container);
  }

  function appendManualDecodePanel(container) {
    const details = document.createElement('details');
    details.className = 'manual-decode';
    const summary = document.createElement('summary');
    summary.textContent = 'Manual Decode';
    details.appendChild(summary);

    const inner = document.createElement('div');
    inner.className = 'manual-decode-inner';

    const textarea = document.createElement('textarea');
    textarea.className = 'manual-input';
    textarea.placeholder = 'Paste a value to decode…';

    const controls = document.createElement('div');
    controls.className = 'manual-controls';

    const select = document.createElement('select');
    select.className = 'manual-select';
    for (const step of DECODER_STEPS) {
      const opt = document.createElement('option');
      opt.value = `builtin:${step.id}`;
      opt.textContent = step.label;
      select.appendChild(opt);
    }
    for (const cd of customDecoders) {
      const opt = document.createElement('option');
      opt.value = `custom:${cd.id}`;
      opt.textContent = `${cd.name} (custom)`;
      select.appendChild(opt);
    }

    const runBtn = document.createElement('button');
    runBtn.type = 'button';
    runBtn.className = 'mini-btn';
    runBtn.textContent = 'Decode';

    const output = document.createElement('div');
    output.className = 'manual-output';

    runBtn.addEventListener('click', async () => {
      const val = textarea.value;
      if (!val) return;
      output.textContent = '';
      const [kind, id] = select.value.split(':');
      runBtn.disabled = true;
      try {
        let result;
        if (kind === 'builtin') {
          result = DECODER_STEP_MAP[id].fn(val);
          if (result == null) throw new Error('Decoder produced no output for this input.');
        } else {
          const cd = customDecoders.find(c => c.id === id);
          if (!cd) throw new Error('Decoder not found.');
          if (cd.type === 'function') {
            runBtn.textContent = 'Decoding…';
            result = await runCustomFunction(cd.code, val);
          } else {
            result = runChainDecoder(cd.steps, val);
            if (result == null) throw new Error('Chain produced no output for this input.');
          }
        }
        if (typeof result === 'object' && result !== null) {
          const tree = document.createElement('div');
          tree.className = 'jtree';
          const root = jsonNode(null, result, true);
          if (root.tagName === 'DETAILS') root.open = true;
          tree.appendChild(root);
          output.appendChild(tree);
        } else {
          const pre = document.createElement('pre');
          pre.className = 'raw';
          pre.textContent = String(result);
          output.appendChild(pre);
        }
      } catch (err) {
        const errEl = document.createElement('div');
        errEl.className = 'manual-error';
        errEl.textContent = err.message || String(err);
        output.appendChild(errEl);
      } finally {
        runBtn.disabled = false;
        runBtn.textContent = 'Decode';
      }
    });

    controls.append(select, runBtn);
    inner.append(textarea, controls, output);
    details.appendChild(inner);
    container.appendChild(details);
  }

  // ------------------------------------------------------------- helpers
  // fmtDuration, fmtSize, statusClass, isError, isLog, isApi and pathOf live in
  // net-format.js — the page's toast classifies requests with the same rules.

  function pulse() {
    if (paused) return;
    pulseEl.classList.add('active');
    clearTimeout(pulseTimer);
    pulseTimer = setTimeout(() => pulseEl.classList.remove('active'), 400);
  }

  function updateCount() {
    emptyEl.classList.toggle('visible', entries.length === 0);
    applyFilter(); // owns the count badge and the filtered-empty state
  }

  function isPinnedToBottom() {
    if (sessions.length === 0) return true;
    const currentSession = sessions[sessions.length - 1];
    const container = currentSession.containerEl;
    if (!container) return true;

    // Sessions are prepended, so the current (newest) session sits at the
    // TOP of #list and grows downward within itself as rows arrive. "Pinned"
    // means still tracking that growing edge — not just close to it (the
    // old check), but also not scrolled past it into older, archived
    // sessions below. Without the scrollTop bound, scrolling down into
    // archived history reads as "pinned" too (viewportBottom is huge,
    // containerBottom - viewportBottom is very negative, still < 40) and
    // every incoming batch yanks the view back up mid-read.
    const containerBottom = container.offsetTop + container.offsetHeight;
    const viewportBottom = listEl.scrollTop + listEl.clientHeight;
    const scrolledPastContainer = listEl.scrollTop > containerBottom;
    return !scrolledPastContainer && (containerBottom - viewportBottom) < 40;
  }


  // --------------------------------------------------------- JSON tree UI
  function jsonNode(key, value, forceOpen = false) {
    const isObj = value !== null && typeof value === 'object';
    if (isObj) {
      if (value.__decoded) {
        const det = document.createElement('details');
        if (forceOpen) det.open = true;
        const sum = document.createElement('summary');
        
        if (key !== null) {
          const k = document.createElement('span');
          k.className = 'j-key';
          k.textContent = JSON.stringify(key) + ': ';
          sum.appendChild(k);
        }
        
        const badge = document.createElement('span');
        badge.className = 'decoded-method-label';
        badge.style.marginTop = '0';
        badge.style.marginLeft = '6px';
        badge.textContent = value.method;
        sum.appendChild(badge);
        det.appendChild(sum);
        
        det.appendChild(jsonNode(null, value.value, forceOpen));
        return det;
      }

      const isArr = Array.isArray(value);
      const keys = isArr ? value : Object.keys(value);
      const det = document.createElement('details');
      if (forceOpen) det.open = true;
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
      for (const [k, v] of children) det.appendChild(jsonNode(String(k), v, forceOpen));
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

  function renderBody(container, text, truncated) {
    container.textContent = '';
    if (truncated) {
      const note = document.createElement('div');
      note.className = 'trunc-note';
      note.textContent = '⚠ Body truncated at 200KB';
      container.appendChild(note);
    }
    if (text == null || text === '') {
      const note = document.createElement('div');
      note.className = 'note';
      note.textContent = '(empty)';
      container.appendChild(note);
      return;
    }
    addCopyButton(container, text);
    let parsed = null;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = tryParsePartialJson(text);
    }

    if (parsed !== null && typeof parsed === 'object') {
      const tree = document.createElement('div');
      tree.className = 'jtree';
      const root = jsonNode(null, parsed);
      if (root.tagName === 'DETAILS') root.open = true;
      tree.appendChild(root);

      const rawPre = document.createElement('pre');
      rawPre.className = 'raw';
      rawPre.textContent = text;
      rawPre.hidden = true;

      const toggleBtn = document.createElement('button');
      toggleBtn.className = 'copy-btn raw-toggle-btn';
      toggleBtn.textContent = 'Raw';
      toggleBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        const showingRaw = !rawPre.hidden;
        rawPre.hidden = showingRaw;
        tree.hidden = !showingRaw;
        toggleBtn.textContent = showingRaw ? 'Raw' : 'Pretty';
      });

      container.append(toggleBtn, tree, rawPre);
    } else {
      const pre = document.createElement('pre');
      pre.className = 'raw';
      pre.textContent = text;
      container.appendChild(pre);
    }
  }

  function renderHeaders(container, d) {
    container.textContent = '';
    const table = document.createElement('table');
    table.className = 'kv';

    const addSection = (label, obj) => {
      const keys = Object.keys(obj || {});
      const head = document.createElement('tr');
      const th = document.createElement('td');
      th.textContent = `— ${label} —`;
      th.colSpan = 2;
      th.style.color = 'var(--faint)';
      head.appendChild(th);
      table.appendChild(head);
      if (!keys.length) {
        const tr = document.createElement('tr');
        const td = document.createElement('td');
        td.colSpan = 2;
        td.className = 'note';
        td.textContent = '(none captured)';
        tr.appendChild(td);
        table.appendChild(tr);
        return;
      }
      for (const k of keys) {
        const tr = document.createElement('tr');
        const kd = document.createElement('td');
        kd.textContent = k;
        const vd = document.createElement('td');
        vd.textContent = obj[k];
        tr.append(kd, vd);
        table.appendChild(tr);
      }
    };

    addSection('request', d.requestHeaders);
    addSection('response', d.responseHeaders);
    container.appendChild(table);
  }

  function addCopyButton(container, text, label = 'Copy') {
    const btn = document.createElement('button');
    btn.className = 'copy-btn';
    btn.textContent = label;
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      navigator.clipboard.writeText(text).then(() => {
        btn.textContent = 'Copied';
        btn.classList.add('copied');
        setTimeout(() => { btn.textContent = label; btn.classList.remove('copied'); }, 1200);
      });
    });
    container.appendChild(btn);
  }

  // ------------------------------------------------------- replay snippets
  const BODY_PLACEHOLDER = /^\[(FormData|Blob|Binary|Unserializable)/;

  function usableBody(body) {
    return typeof body === 'string' && body && !BODY_PLACEHOLDER.test(body) ? body : null;
  }

  function shellQuote(s) {
    return `'${String(s).replace(/'/g, "'\\''")}'`;
  }

  function buildCurl(d) {
    const parts = ['curl', shellQuote(d.url)];
    if (d.method && d.method !== 'GET') parts.push('-X', d.method);
    for (const [k, v] of Object.entries(d.requestHeaders || {})) {
      parts.push('-H', shellQuote(`${k}: ${v}`));
    }
    const body = usableBody(d.requestBody);
    if (body) parts.push('--data-raw', shellQuote(body));
    return parts.join(' ');
  }

  function buildFetchSnippet(d) {
    const opts = { method: d.method };
    if (d.requestHeaders && Object.keys(d.requestHeaders).length) opts.headers = d.requestHeaders;
    const body = usableBody(d.requestBody);
    if (body) opts.body = body;
    return `fetch(${JSON.stringify(d.url)}, ${JSON.stringify(opts, null, 2)});`;
  }

  // --------------------------------------------------------------- search
  function bodyHay(d) {
    if (d.__bodyHay !== undefined) return d.__bodyHay;
    let hay = '';
    if (d.kind === 'log') {
      hay = `${d.message || ''}\n${d.stack || ''}`;
    } else {
      if (typeof d.requestBody === 'string') hay += d.requestBody;
      if (typeof d.responseBody === 'string') hay += '\n' + d.responseBody;
    }
    d.__bodyHay = hay.slice(0, BODY_SEARCH_CAP).toLowerCase();
    return d.__bodyHay;
  }

  // ------------------------------------------------------------ row build
  function attachRowToggle(row, head, detail, buildDetailFn) {
    let built = false;
    const toggle = () => {
      const open = row.classList.toggle('open');
      head.setAttribute('aria-expanded', String(open));
      if (open) {
        if (!built) {
          built = true;
          buildDetailFn();
        }
        const q = filterEl.value.trim().toLowerCase();
        if (q) highlightMatches(detail, q, true);
      }
    };
    head.addEventListener('click', toggle);
    head.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); }
    });
  }

  function buildLogRow(d) {
    const row = document.createElement('div');
    row.className = `row log-row log-${d.level}`;
    row.dataset.hay = (d.message || '').toLowerCase();
    row.dataset.err = d.level === 'error' ? '1' : '0';
    row.dataset.api = '0';

    const head = document.createElement('div');
    head.className = 'row-head';
    head.tabIndex = 0;
    head.setAttribute('role', 'button');
    head.setAttribute('aria-expanded', 'false');

    const level = document.createElement('span');
    level.className = `method log-level-${d.level}`;
    level.textContent = d.level === 'error' ? 'ERR' : 'WARN';

    const msg = document.createElement('span');
    msg.className = 'path';
    const bdo = document.createElement('bdo');
    bdo.textContent = d.message || '';
    msg.appendChild(bdo);
    msg.title = d.message || '';

    const time = document.createElement('span');
    time.className = 'dur';
    if (d.startedAt) {
      time.textContent = new Date(d.startedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    }

    head.append(level, msg, time);
    row.appendChild(head);

    const detail = document.createElement('div');
    detail.className = 'row-detail';
    const detailInner = document.createElement('div');
    detailInner.className = 'row-detail-inner';
    detail.appendChild(detailInner);
    row.appendChild(detail);

    attachRowToggle(row, head, detail, () => buildLogDetail(detailInner, d));

    return row;
  }

  function buildLogDetail(container, d) {
    const inner = document.createElement('div');
    inner.className = 'log-detail-inner';

    if (d.stack) {
      const stackPre = document.createElement('pre');
      stackPre.className = 'raw log-stack';
      stackPre.textContent = d.stack;
      inner.appendChild(stackPre);
    }
    if (d.source) {
      const src = document.createElement('div');
      src.className = 'detail-url log-source';
      src.textContent = d.source;
      inner.appendChild(src);
    }
    if (Array.isArray(d.args) && d.args.length) {
      const tree = document.createElement('div');
      tree.className = 'jtree log-args';
      tree.appendChild(jsonNode(null, d.args.length === 1 ? d.args[0] : d.args, true));
      inner.appendChild(tree);
    }
    container.appendChild(inner);
  }

  function buildRow(d) {
    if (isLog(d)) return buildLogRow(d);
    const row = document.createElement('div');
    row.className = `row ${statusClass(d)}`;
    row.dataset.hay = `${d.method} ${d.url}`.toLowerCase();
    row.dataset.err = isError(d) ? '1' : '0';
    row.dataset.api = isApi(d) ? '1' : '0';

    const head = document.createElement('div');
    head.className = 'row-head';
    head.tabIndex = 0;
    head.setAttribute('role', 'button');
    head.setAttribute('aria-expanded', 'false');

    const method = document.createElement('span');
    method.className = `method m-${d.method.toLowerCase()}`;
    method.textContent = d.method;

    const path = document.createElement('span');
    path.className = 'path';
    const bdo = document.createElement('bdo');
    bdo.textContent = pathOf(d.url);
    path.appendChild(bdo);
    path.title = d.url;

    const status = document.createElement('span');
    status.className = 'status';
    status.textContent = d.failed || d.status === 0 ? 'ERR' : String(d.status);
    if (d.statusText) status.title = d.statusText;

    const dur = document.createElement('span');
    dur.className = 'dur';
    dur.textContent = fmtDuration(d.duration);
    if (d.responseSize) dur.title = fmtSize(d.responseSize);

    head.append(method, path, status, dur);
    row.appendChild(head);

    const detail = document.createElement('div');
    detail.className = 'row-detail';
    const detailInner = document.createElement('div');
    detailInner.className = 'row-detail-inner';
    detail.appendChild(detailInner);
    row.appendChild(detail);

    attachRowToggle(row, head, detail, () => buildDetail(detailInner, d));

    return row;
  }

  function buildDetail(container, d) {
    const urlLine = document.createElement('div');
    urlLine.className = 'detail-url';
    urlLine.textContent = `${d.kind.toUpperCase()} · ${d.url}` + (d.statusText ? ` · ${d.statusText}` : '');
    container.appendChild(urlLine);

    const actions = document.createElement('div');
    actions.className = 'detail-actions';
    addCopyButton(actions, buildFetchSnippet(d), 'Copy fetch');
    addCopyButton(actions, buildCurl(d), 'Copy cURL');
    container.appendChild(actions);

    const tabs = document.createElement('div');
    tabs.className = 'tabs';
    const body = document.createElement('div');
    body.className = 'tab-body';

    function renderView(name, target) {
      if (name === 'Response') renderBody(target, d.responseBody, d.truncated);
      else if (name === 'Payload') renderBody(target, d.requestBody, false);
      else if (name === 'Headers') renderHeaders(target, d);
      else if (name === 'Decoded') renderDecoded(target, d);
    }

    const views = { Response: () => renderView('Response', body), Payload: () => renderView('Payload', body), Headers: () => renderView('Headers', body) };
    if (hasDecodableData(d, customDecoders)) {
      views.Decoded = () => renderView('Decoded', body);
    }

    const q = filterEl.value.trim().toLowerCase();
    let defaultTab = 'Response';
    if (q) {
      if (typeof d.responseBody === 'string' && d.responseBody.toLowerCase().includes(q)) {
        defaultTab = 'Response';
      } else if (views.Decoded && bodyHay(d).includes(q)) {
        defaultTab = 'Decoded';
      } else if (typeof d.requestBody === 'string' && d.requestBody.toLowerCase().includes(q)) {
        defaultTab = 'Payload';
      }
    }

    let activeBtn = null;
    let activeName = defaultTab;
    for (const name of Object.keys(views)) {
      const btn = document.createElement('button');
      btn.className = 'tab';
      btn.textContent = name;
      btn.addEventListener('click', () => {
        if (activeBtn) activeBtn.classList.remove('active');
        activeBtn = btn;
        activeName = name;
        btn.classList.add('active');
        views[name]();
        const currentQ = filterEl.value.trim().toLowerCase();
        if (currentQ) highlightMatches(body, currentQ, true);
      });
      tabs.appendChild(btn);
      if (name === defaultTab) { activeBtn = btn; }
    }

    if (!activeBtn && tabs.firstChild) {
      activeBtn = tabs.firstChild;
      activeName = Object.keys(views)[0];
    }

    const fsBtn = document.createElement('button');
    fsBtn.className = 'icon-btn fullscreen-btn';
    fsBtn.type = 'button';
    fsBtn.title = 'View full screen';
    fsBtn.setAttribute('aria-label', 'View full screen');
    fsBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><polyline points="15 3 21 3 21 9"/><polyline points="9 21 3 21 3 15"/><line x1="21" y1="3" x2="14" y2="10"/><line x1="3" y1="21" x2="10" y2="14"/></svg>';
    fsBtn.addEventListener('click', () => {
      fullscreenTitleEl.textContent = activeName;
      renderView(activeName, fullscreenBodyEl);
      const currentQ = filterEl.value.trim().toLowerCase();
      fullscreenSearchEl.value = currentQ;
      if (currentQ) highlightMatches(fullscreenBodyEl, currentQ, true);
      openSlidePanel(fullscreenPanel);
      fullscreenSearchEl.focus();
    });
    tabs.appendChild(fsBtn);

    container.append(tabs, body);
    if (activeBtn) activeBtn.classList.add('active');
    views[activeName]();
    if (q) highlightMatches(body, q, true);

    buildReplay(container, d);
  }

  // --------------------------------------------------------------- replay
  const REPLAY_UNREACHABLE = 'Could not reach the page — reload the tab and try again.';

  function replayNote(text, cls) {
    const el = document.createElement('div');
    el.className = cls || 'replay-note';
    el.textContent = text;
    return el;
  }

  function statusPill(status, failed) {
    const wrap = document.createElement('span');
    wrap.className = statusClass({ status, failed });
    const pill = document.createElement('span');
    pill.className = 'status';
    pill.textContent = failed || status === 0 ? 'ERR' : String(status);
    wrap.appendChild(pill);
    return wrap;
  }

  function renderDiff(container, beforeText, afterText) {
    // Diff the pretty-printed form so a single changed field shows as one
    // changed line rather than one enormous one.
    const before = prettyJson(beforeText) || (beforeText == null ? '' : String(beforeText));
    const after = prettyJson(afterText) || (afterText == null ? '' : String(afterText));
    if (before === after) {
      container.appendChild(replayNote('Identical to the original response.', 'note'));
      return;
    }
    const rows = diffLines(before, after);
    if (!rows) {
      container.appendChild(replayNote('Too large to diff.', 'note'));
      return;
    }
    const pre = document.createElement('pre');
    pre.className = 'raw diff';
    for (const r of collapseDiff(rows)) {
      const span = document.createElement('span');
      if (r.type === '@') {
        span.className = 'diff-skip';
        span.textContent = `⋯ ${r.text}\n`;
      } else {
        span.className = r.type === '+' ? 'diff-add' : r.type === '-' ? 'diff-del' : 'diff-same';
        span.textContent = `${r.type} ${r.text}\n`;
      }
      pre.appendChild(span);
    }
    container.appendChild(pre);
  }

  function renderReplayResult(container, res, d, sentHeaders) {
    container.textContent = '';
    if (!res || !res.ok) {
      container.appendChild(replayNote(`⚠ ${(res && res.error) || 'Replay failed'}`, 'replay-error'));
      return;
    }

    const mk = (cls, text) => {
      const s = document.createElement('span');
      s.className = cls;
      s.textContent = text;
      return s;
    };

    const compare = document.createElement('div');
    compare.className = 'replay-compare';
    compare.append(
      statusPill(d.status, d.failed),
      mk('replay-arrow', '→'),
      statusPill(res.status, false),
      mk('replay-sep', '·'),
      mk('replay-metric', `${fmtDuration(d.duration)} → ${fmtDuration(res.duration)}`),
      mk('replay-sep', '·'),
      mk('replay-metric', `${fmtSize(d.responseSize || 0)} → ${fmtSize(res.responseSize || 0)}`)
    );
    container.appendChild(compare);

    // The executor reports the headers it actually sent, so anything missing
    // was stripped as browser-owned. Saying which beats leaving the user to
    // wonder why their Cookie header had no effect.
    const dropped = Object.keys(sentHeaders || {}).filter((k) => !(k in (res.requestHeaders || {})));
    if (dropped.length) {
      container.appendChild(replayNote(`⚠ Browser-owned headers dropped: ${dropped.join(', ')}`));
    }

    const tabs = document.createElement('div');
    tabs.className = 'tabs';
    const out = document.createElement('div');
    out.className = 'tab-body';
    const views = {
      Diff: () => { out.textContent = ''; renderDiff(out, d.responseBody, res.responseBody); },
      Response: () => renderBody(out, res.responseBody, res.truncated),
      Headers: () => renderHeaders(out, res),
    };
    let active = null;
    for (const name of Object.keys(views)) {
      const btn = document.createElement('button');
      btn.className = 'tab';
      btn.type = 'button';
      btn.textContent = name;
      btn.addEventListener('click', () => {
        if (active) active.classList.remove('active');
        active = btn;
        btn.classList.add('active');
        views[name]();
      });
      tabs.appendChild(btn);
    }
    container.append(tabs, out);
    tabs.firstChild.click();
  }

  function buildReplay(container, d) {
    const wrap = document.createElement('details');
    wrap.className = 'replay';
    const sum = document.createElement('summary');
    sum.textContent = 'Replay';
    wrap.appendChild(sum);

    const inner = document.createElement('div');
    inner.className = 'replay-inner';
    wrap.appendChild(inner);

    const line = document.createElement('div');
    line.className = 'replay-line';
    // A picker, not a text field: switching GET to POST is a real thing to
    // want, typing a method by hand only ever produces typos that fetch will
    // dutifully put on the wire.
    const methodEl = document.createElement('select');
    methodEl.className = 'replay-method';
    methodEl.setAttribute('aria-label', 'Method');
    const captured = String(d.method || 'GET').toUpperCase();
    const methodOptions = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'];
    if (!methodOptions.includes(captured)) methodOptions.unshift(captured);
    for (const m of methodOptions) {
      const opt = document.createElement('option');
      opt.value = m;
      opt.textContent = m;
      methodEl.appendChild(opt);
    }
    const urlEl = document.createElement('input');
    urlEl.className = 'replay-url';
    urlEl.spellcheck = false;
    urlEl.setAttribute('aria-label', 'URL');
    line.append(methodEl, urlEl);

    const headersEl = document.createElement('textarea');
    headersEl.className = 'replay-field';
    headersEl.rows = 5;
    headersEl.spellcheck = false;
    headersEl.setAttribute('aria-label', 'Request headers');

    const bodyEl = document.createElement('textarea');
    bodyEl.className = 'replay-field';
    bodyEl.rows = 9;
    bodyEl.spellcheck = false;
    bodyEl.setAttribute('aria-label', 'Request body');

    const warn = document.createElement('div');
    warn.className = 'replay-warn';
    warn.hidden = true;

    const out = document.createElement('div');
    out.className = 'replay-result';

    const originalBody = usableBody(d.requestBody) || '';

    const validate = () => {
      const t = bodyEl.value.trim();
      // Only JSON-looking bodies are checked; form-encoded and plain text are
      // valid as typed and must not be flagged.
      const looksJson = t && (t[0] === '{' || t[0] === '[');
      let bad = false;
      if (looksJson && t.length < 200000) {
        try { JSON.parse(t); } catch { bad = true; }
      }
      warn.hidden = !bad;
      warn.textContent = bad ? '⚠ Not valid JSON — it will be sent exactly as typed.' : '';
    };

    const reset = () => {
      methodEl.value = captured;
      urlEl.value = d.url || '';
      headersEl.value = formatHeaderLines(d.requestHeaders);
      bodyEl.value = prettyJson(originalBody) || originalBody;
      validate();
    };

    const tabs = document.createElement('div');
    tabs.className = 'tabs replay-tabs';
    const panes = { Headers: headersEl, Body: bodyEl };
    let activeTab = null;
    for (const name of Object.keys(panes)) {
      const btn = document.createElement('button');
      btn.className = 'tab';
      btn.type = 'button';
      btn.textContent = name;
      btn.addEventListener('click', () => {
        if (activeTab) activeTab.classList.remove('active');
        activeTab = btn;
        btn.classList.add('active');
        for (const k of Object.keys(panes)) panes[k].hidden = k !== name;
      });
      tabs.appendChild(btn);
    }

    const currentRequest = () => ({
      method: methodEl.value || 'GET',
      url: urlEl.value.trim(),
      requestHeaders: parseHeaderLines(headersEl.value),
      requestBody: bodyEl.value,
    });

    const actions = document.createElement('div');
    actions.className = 'replay-actions';

    const sendBtn = document.createElement('button');
    sendBtn.className = 'replay-send';
    sendBtn.type = 'button';
    sendBtn.textContent = 'Send';

    const send = () => {
      if (currentTabId == null || sendBtn.disabled) return;
      const req = currentRequest();
      const payload = {
        method: req.method,
        url: req.url,
        headers: req.requestHeaders,
        body: bodyEl.value,
        credentials: d.credentials || undefined,
        mode: d.mode || undefined,
        redirect: d.redirect || undefined,
      };
      sendBtn.disabled = true;
      sendBtn.textContent = 'Sending…';
      out.textContent = '';
      chrome.tabs.sendMessage(currentTabId, { type: 'netlens:replay', req: payload }, (res) => {
        sendBtn.disabled = false;
        sendBtn.textContent = 'Send';
        if (chrome.runtime.lastError || !res) {
          renderReplayResult(out, { ok: false, error: REPLAY_UNREACHABLE }, d, payload.headers);
          return;
        }
        renderReplayResult(out, res, d, payload.headers);
      });
    };
    sendBtn.addEventListener('click', send);

    const fmtBtn = document.createElement('button');
    fmtBtn.className = 'copy-btn';
    fmtBtn.type = 'button';
    fmtBtn.textContent = 'Format';
    fmtBtn.addEventListener('click', () => {
      const pretty = prettyJson(bodyEl.value);
      if (pretty) bodyEl.value = pretty;
      validate();
    });

    const resetBtn = document.createElement('button');
    resetBtn.className = 'copy-btn';
    resetBtn.type = 'button';
    resetBtn.textContent = 'Reset';
    resetBtn.addEventListener('click', reset);

    const curlBtn = document.createElement('button');
    curlBtn.className = 'copy-btn';
    curlBtn.type = 'button';
    curlBtn.textContent = 'Copy cURL';
    curlBtn.addEventListener('click', () => {
      navigator.clipboard.writeText(buildCurl(currentRequest())).then(() => {
        curlBtn.textContent = 'Copied';
        curlBtn.classList.add('copied');
        setTimeout(() => { curlBtn.textContent = 'Copy cURL'; curlBtn.classList.remove('copied'); }, 1200);
      });
    });

    const hint = document.createElement('span');
    hint.className = 'replay-hint';
    hint.textContent = '⌘/Ctrl+Enter';

    actions.append(sendBtn, fmtBtn, resetBtn, curlBtn, hint);

    bodyEl.addEventListener('input', validate);
    wrap.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
        e.preventDefault();
        send();
      }
    });

    inner.append(line, tabs, headersEl, bodyEl, warn);
    // A body we never fully captured must not be resent as if it were the
    // real one, so say what is missing instead of silently differing.
    if (d.requestBody && !originalBody) {
      inner.appendChild(replayNote(`⚠ Original body was ${d.requestBody} — not replayable, type a replacement.`));
    }
    if (d.requestBodyTruncated) {
      inner.appendChild(replayNote('⚠ Captured body hit the 200KB cap and is clipped — sending it will not match the original.'));
    }
    inner.append(actions, out);
    container.appendChild(wrap);

    reset();
    (bodyEl.value ? tabs.children[1] : tabs.children[0]).click();
  }

  // -------------------------------------------------------- text highlighting
  function clearHighlights(containerEl) {
    if (!containerEl) return;
    const marks = containerEl.querySelectorAll('mark.hl');
    for (const mark of marks) {
      const parent = mark.parentNode;
      if (parent) {
        parent.replaceChild(document.createTextNode(mark.textContent), mark);
        parent.normalize();
      }
    }
  }

  function highlightMatches(containerEl, queryStr, scrollIntoView = false) {
    if (!containerEl) return;
    clearHighlights(containerEl);
    if (!queryStr) return;
    const q = queryStr.toLowerCase();

    const walker = document.createTreeWalker(containerEl, NodeFilter.SHOW_TEXT, null, false);
    const textNodes = [];
    let node;
    while ((node = walker.nextNode())) {
      if (node.nodeValue && node.nodeValue.toLowerCase().includes(q)) {
        const parent = node.parentElement;
        if (parent && !parent.closest('.copy-btn, .tab, mark')) {
          textNodes.push(node);
        }
      }
    }

    const createdMarks = [];

    for (const textNode of textNodes) {
      const text = textNode.nodeValue;
      const lower = text.toLowerCase();
      const frag = document.createDocumentFragment();
      let lastIdx = 0;
      let idx = lower.indexOf(q);

      while (idx !== -1) {
        if (idx > lastIdx) {
          frag.appendChild(document.createTextNode(text.slice(lastIdx, idx)));
        }
        const mark = document.createElement('mark');
        mark.className = 'hl';
        mark.textContent = text.slice(idx, idx + q.length);
        frag.appendChild(mark);
        createdMarks.push(mark);
        lastIdx = idx + q.length;
        idx = lower.indexOf(q, lastIdx);
      }
      if (lastIdx < text.length) {
        frag.appendChild(document.createTextNode(text.slice(lastIdx)));
      }
      if (textNode.parentNode) {
        textNode.parentNode.replaceChild(frag, textNode);
      }
    }

    for (const mark of createdMarks) {
      let p = mark.parentElement;
      while (p && p !== containerEl) {
        if (p.tagName === 'DETAILS') {
          p.open = true;
        }
        p = p.parentElement;
      }
    }

    if (scrollIntoView && createdMarks.length > 0) {
      try {
        createdMarks[0].scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      } catch {}
    }
  }

  // ------------------------------------------------------------ filtering
  function applyFilter() {
    const qRaw = filterEl.value.trim();
    const q = qRaw.toLowerCase();
    const test = qRaw ? buildUrlTest(qRaw) : null;
    const errOnly = errorsOnlyEl.checked;
    const apiOnly = apiOnlyEl.checked;
    const showLogs = showLogsEl.checked;
    let visibleCount = 0;
    for (const { data, el } of entries) {
      const matchesText =
        !test || test(el.dataset.hay) || test(bodyHay(data));
      const matches =
        matchesText && (!errOnly || el.dataset.err === '1') && (!apiOnly || el.dataset.api === '1') &&
        (showLogs || data.kind !== 'log');
      el.style.display = matches ? '' : 'none';
      if (matches) visibleCount++;

      const pathBdo = el.querySelector('.path bdo');
      if (pathBdo) {
        // Highlighting is literal-substring only; a /regex/ query still
        // filters correctly above, it just won't paint match spans.
        highlightMatches(pathBdo, matches ? q : '');
      }

      if (el.classList.contains('open')) {
        const detail = el.querySelector('.row-detail');
        if (detail) {
          if (matches && q) {
            highlightMatches(detail, q, true);
          } else {
            clearHighlights(detail);
          }
        }
      }
    }
    for (const session of sessions) {
      if (session.containerEl) {
        const hasVisible = session.entries.some(entry => entry.el.style.display !== 'none');
        session.containerEl.style.display = hasVisible ? '' : 'none';
      }
    }

    // The badge otherwise keeps reading the unfiltered total, so filtering
    // 200 rows down to zero looked identical to the capture having died.
    countEl.textContent = visibleCount === entries.length ? String(entries.length) : `${visibleCount} / ${entries.length}`;
    filterEmptyEl.classList.toggle('visible', entries.length > 0 && visibleCount === 0);
  }

  let filterDebounce = null;
  function scheduleFilter() {
    clearTimeout(filterDebounce);
    filterDebounce = setTimeout(applyFilter, FILTER_DEBOUNCE_MS);
  }

  filterEl.addEventListener('input', scheduleFilter);

  // The query itself stays session-only — reusing yesterday's URL substring
  // on a different site would just hide everything.
  function saveFilterFlags() {
    chrome.storage.local.set({
      netlensFilterFlags: { errorsOnly: errorsOnlyEl.checked, apiOnly: apiOnlyEl.checked, showLogs: showLogsEl.checked },
    });
  }
  try {
    chrome.storage.local.get(['netlensFilterFlags'], (res) => {
      const flags = res && res.netlensFilterFlags;
      if (!flags) return;
      errorsOnlyEl.checked = !!flags.errorsOnly;
      apiOnlyEl.checked = !!flags.apiOnly;
      showLogsEl.checked = !!flags.showLogs;
      applyFilter();
    });
  } catch {}

  errorsOnlyEl.addEventListener('change', () => { applyFilter(); saveFilterFlags(); });
  apiOnlyEl.addEventListener('change', () => { applyFilter(); saveFilterFlags(); });
  showLogsEl.addEventListener('change', () => { applyFilter(); saveFilterFlags(); });

  // ------------------------------------------------------------- ingest
  function addEntries(batch) {
    if (!batch || !batch.length) return;
    const pinned = isPinnedToBottom();
    const frag = document.createDocumentFragment();

    if (sessions.length === 0) {
      startNewSession(currentTabUrl);
    }
    const currentSession = sessions[sessions.length - 1];

    for (const d of batch) {
      const el = buildRow(d);
      const entry = { data: d, el };
      entries.push(entry);
      currentSession.entries.push(entry);
      frag.appendChild(el);
    }
    currentSession.containerEl.appendChild(frag);

    if (currentSession.pending) {
      currentSession.pending.push(...batch);
      scheduleDbFlush();
    }

    while (entries.length > MAX_ROWS) {
      const removed = entries.shift();
      removed.el.remove();
      for (const s of sessions) {
        const idx = s.entries.indexOf(removed);
        if (idx !== -1) {
          s.entries.splice(idx, 1);
          break;
        }
      }
    }

    updateCount();
    pulse();
    scheduleDiagUpdate();
    if (pinned) {
      const lastEntry = currentSession.entries[currentSession.entries.length - 1];
      if (lastEntry) lastEntry.el.scrollIntoView({ block: 'nearest', behavior: 'instant' });
    }
  }

  // One IndexedDB transaction per 100ms flush means constant disk writes of
  // full response bodies on a busy page. Batching them costs at most one
  // second of unsaved captures, and the page-hide flush covers the common way
  // of losing them.
  const DB_FLUSH_MS = 1000;
  let dbFlushTimer = null;

  function flushDbWrites() {
    if (dbFlushTimer) { clearTimeout(dbFlushTimer); dbFlushTimer = null; }
    for (const s of sessions) {
      if (s.dbId == null || !s.pending || !s.pending.length) continue;
      dbAddEntries(s.dbId, s.pending.splice(0)).catch(() => {});
    }
  }

  function scheduleDbFlush() {
    if (dbFlushTimer) return;
    dbFlushTimer = setTimeout(flushDbWrites, DB_FLUSH_MS);
  }

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) flushDbWrites();
  });
  window.addEventListener('pagehide', flushDbWrites);

  function clearAll(alsoBuffer) {
    entries = [];
    sessions = [];
    restoredIds.clear();
    if (diagBadge) diagBadge.hidden = true;
    listEl.textContent = '';
    updateCount();
    if (alsoBuffer && currentTabId != null) {
      chrome.tabs.sendMessage(currentTabId, { type: 'netlens:clear' }, () => {
        void chrome.runtime.lastError;
      });
    }
  }

  function requestDump(tabId) {
    chrome.tabs.sendMessage(tabId, { type: 'netlens:dump' }, (res) => {
      if (chrome.runtime.lastError || !res) return; // no content script here (chrome:// etc.)
      clearAll(false);
      addEntries(res.buffer);
    });
  }

  // -------------------------------------------------------- tab tracking
  function trackTab(tabId) {
    if (tabId == null || tabId === currentTabId) return;
    currentTabId = tabId;
    clearAll(false);
    chrome.tabs.get(tabId, (tab) => {
      if (chrome.runtime.lastError || !tab) return;
      currentTabUrl = tab.url;
      requestDump(tabId);
      const panel = document.getElementById('storagePanel');
      if (panel && !panel.hidden) loadStorage();
    });
  }

  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (tabs && tabs[0]) {
      currentTabUrl = tabs[0].url;
      trackTab(tabs[0].id);
    }
  });

  chrome.tabs.onActivated.addListener(({ tabId }) => trackTab(tabId));

  chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    if (tabId !== currentTabId) return;
    if (changeInfo.status === 'loading') {
      currentTabUrl = tab.url;
      startNewSession(tab.url);
    }
  });

  // ---------------------------------------------------------- live batches
  chrome.runtime.onMessage.addListener((msg, sender) => {
    if (!msg || msg.type !== 'netlens:batch') return;
    if (!sender.tab || sender.tab.id !== currentTabId) return;
    if (paused) return;
    addEntries(msg.batch);
  });

  // -------------------------------------------------------------- controls
  const PAUSE_ICON = '<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" stroke="none" aria-hidden="true" focusable="false"><rect x="6" y="4" width="4" height="16" rx="1"/><rect x="14" y="4" width="4" height="16" rx="1"/></svg>';
  const PLAY_ICON = '<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" stroke="none" aria-hidden="true" focusable="false"><path d="M7 4l13 8-13 8V4z"/></svg>';
  pauseBtn.addEventListener('click', () => {
    paused = !paused;
    pauseBtn.classList.toggle('active', paused);
    pauseBtn.innerHTML = paused ? PLAY_ICON : PAUSE_ICON;
    pauseBtn.title = paused ? 'Resume capture' : 'Pause capture';
    pulseEl.classList.toggle('paused', paused);
  });

  clearBtn.addEventListener('click', () => clearAll(true));

  // -------------------------------------------------------- storage viewer
  const storageBtn = document.getElementById('storageBtn');
  const storagePanel = document.getElementById('storagePanel');
  const storagePanelClose = document.getElementById('storagePanelClose');
  const storageRefreshBtn = document.getElementById('storageRefreshBtn');
  const storageSectionsEl = document.getElementById('storageSections');
  const storageOriginEl = document.getElementById('storageOrigin');

  function buildStorageSection(title, items) {
    const details = document.createElement('details');
    details.className = 'storage-section';
    details.open = items.length > 0;
    const summary = document.createElement('summary');
    summary.textContent = `${title} (${items.length})`;
    details.appendChild(summary);

    if (!items.length) {
      const note = document.createElement('div');
      note.className = 'note storage-empty';
      note.textContent = 'No entries.';
      details.appendChild(note);
      return details;
    }

    const table = document.createElement('table');
    table.className = 'kv decoded-table';
    for (const item of items) {
      const tr = document.createElement('tr');
      const tdKey = document.createElement('td');
      tdKey.className = 'decoded-key-cell';
      tdKey.textContent = item.key;
      if (item.hint) tdKey.title = item.hint;

      const tdVal = document.createElement('td');
      tdVal.className = 'decoded-val-cell';
      const pre = document.createElement('pre');
      pre.className = 'raw';
      pre.textContent = item.value == null ? '' : String(item.value);
      tdVal.appendChild(pre);

      const decoded = tryDecodeStructure(item.value, customDecoders);
      if (decoded) {
        const badge = document.createElement('div');
        badge.className = 'decoded-method-label';
        badge.textContent = `↳ ${decoded.method}`;
        tdVal.appendChild(badge);
        tdVal.appendChild(renderValueNode(decoded.value));
      }

      tr.append(tdKey, tdVal);
      table.appendChild(tr);
    }
    details.appendChild(table);
    return details;
  }

  function loadStorage() {
    if (!storageSectionsEl) return;
    storageSectionsEl.textContent = '';
    const loading = document.createElement('div');
    loading.className = 'note storage-empty';
    loading.textContent = 'Loading…';
    storageSectionsEl.appendChild(loading);

    if (storageOriginEl) {
      try { storageOriginEl.textContent = currentTabUrl ? new URL(currentTabUrl).origin : ''; }
      catch { storageOriginEl.textContent = currentTabUrl || ''; }
    }

    if (currentTabId == null) {
      storageSectionsEl.textContent = '';
      const note = document.createElement('div');
      note.className = 'note storage-empty';
      note.textContent = 'No active tab.';
      storageSectionsEl.appendChild(note);
      return;
    }

    const finish = (sessionItems, cookieItems) => {
      storageSectionsEl.textContent = '';
      storageSectionsEl.appendChild(buildStorageSection('Session Storage', sessionItems));
      storageSectionsEl.appendChild(buildStorageSection('Cookies', cookieItems));
    };

    chrome.tabs.sendMessage(currentTabId, { type: 'netlens:storage:get' }, (res) => {
      void chrome.runtime.lastError;
      const sessionItems = Object.entries(res?.session || {}).map(([key, value]) => ({ key, value }));

      try {
        chrome.cookies.getAll({ url: currentTabUrl }, (cookies) => {
          const cookieItems = (cookies || []).map((c) => ({
            key: c.name,
            value: c.value,
            hint: `${c.domain}${c.path}${c.httpOnly ? ' · HttpOnly' : ''}${c.secure ? ' · Secure' : ''}`,
          }));
          finish(sessionItems, cookieItems);
        });
      } catch { finish(sessionItems, []); }
    });
  }

  // ------------------------------------------------------------ page styles
  const paletteBtn = document.getElementById('paletteBtn');
  const palettePanel = document.getElementById('palettePanel');
  const palettePanelClose = document.getElementById('palettePanelClose');
  const paletteRefreshBtn = document.getElementById('paletteRefreshBtn');
  const paletteEyedropperBtn = document.getElementById('paletteEyedropperBtn');
  const paletteEyedropperResult = document.getElementById('paletteEyedropperResult');
  const paletteBodyEl = document.getElementById('paletteBody');

  function paletteNote(text) {
    paletteBodyEl.textContent = '';
    const note = document.createElement('div');
    note.className = 'note storage-empty';
    note.textContent = text;
    paletteBodyEl.appendChild(note);
  }

  function buildColorGrid(colors) {
    const grid = document.createElement('div');
    grid.className = 'swatch-grid';
    for (const { value, count, roles } of colors) {
      const chip = document.createElement('button');
      chip.className = 'swatch-chip';
      chip.type = 'button';
      const hex = rgbToHex(value);
      chip.title = `${value} · ${count} use${count === 1 ? '' : 's'} · ${roles.join(', ')}`;
      const box = document.createElement('span');
      box.className = 'swatch-box';
      box.style.background = value;
      const label = document.createElement('span');
      label.className = 'swatch-label';
      label.textContent = hex || value;
      chip.append(box, label);
      chip.addEventListener('click', () => {
        navigator.clipboard.writeText(hex || value).then(() => {
          chip.classList.add('copied');
          setTimeout(() => chip.classList.remove('copied'), 900);
        }).catch(() => {});
      });
      grid.appendChild(chip);
    }
    return grid;
  }

  function buildFontList(fonts) {
    const list = document.createElement('div');
    list.className = 'font-list';
    for (const { family, count, sizes, weights } of fonts) {
      const row = document.createElement('div');
      row.className = 'font-row';
      const name = document.createElement('div');
      name.className = 'font-name';
      // Preview the family in its own face, so a stack that never actually
      // loaded is visible as such instead of reading like a success.
      name.style.fontFamily = family;
      name.textContent = family;
      const meta = document.createElement('div');
      meta.className = 'font-meta';
      meta.textContent = `${count} element${count === 1 ? '' : 's'} · ${sizes.join(', ')} · ${weights.join(', ')}`;
      row.append(name, meta);
      list.appendChild(row);
    }
    return list;
  }

  function loadPageStyles() {
    if (currentTabId == null) { paletteNote('No active tab.'); return; }
    paletteNote('Scanning…');
    chrome.tabs.sendMessage(currentTabId, { type: 'netlens:pagestyles' }, (res) => {
      void chrome.runtime.lastError;
      if (!res) { paletteNote('Could not scan this page. Reload it and try again.'); return; }

      paletteBodyEl.textContent = '';
      if (res.truncated) {
        const note = document.createElement('div');
        note.className = 'trunc-note';
        note.textContent = `⚠ Stopped after the first ${res.scanned.toLocaleString()} elements.`;
        paletteBodyEl.appendChild(note);
      }

      const colorWrap = document.createElement('div');
      colorWrap.style.position = 'relative';
      if (res.colors.length) {
        addCopyButton(colorWrap, res.colors.map((c) => rgbToHex(c.value) || c.value).join('\n'), 'Copy all');
        colorWrap.appendChild(buildColorGrid(res.colors));
      }
      // Collapsed by default — the eyedropper above covers the common case,
      // this list is a fallback for when you want every colour in one place.
      paletteBodyEl.appendChild(buildInspectSection(`Colours (${res.colors.length})`, false, colorWrap));

      const fontWrap = document.createElement('div');
      fontWrap.style.position = 'relative';
      if (res.fonts.length) {
        addCopyButton(fontWrap, res.fonts.map((f) => f.family).join('\n'), 'Copy all');
        fontWrap.appendChild(buildFontList(res.fonts));
      }
      paletteBodyEl.appendChild(buildInspectSection(`Fonts (${res.fonts.length})`, true, fontWrap));
    });
  }

  if (paletteBtn && palettePanel) {
    const openPalettePanel = () => { openSlidePanel(palettePanel); loadPageStyles(); };
    const closePalettePanel = () => closeSlidePanel(palettePanel);
    slidePanels.push({ el: palettePanel, close: closePalettePanel });

    paletteBtn.addEventListener('click', () => {
      if (palettePanel.hidden) openPalettePanel(); else closePalettePanel();
    });
    palettePanelClose.addEventListener('click', closePalettePanel);
    paletteRefreshBtn.addEventListener('click', loadPageStyles);
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !palettePanel.hidden) closePalettePanel();
    });
  }

  if (paletteEyedropperBtn) {
    paletteEyedropperBtn.addEventListener('click', async () => {
      if (typeof EyeDropper === 'undefined') {
        paletteEyedropperResult.hidden = false;
        paletteEyedropperResult.textContent = "This browser doesn't support the eyedropper API.";
        return;
      }
      try {
        // Screen-wide, not page-scoped — the side panel window itself is a
        // valid (if unlikely) target, same as it would be in DevTools.
        const { sRGBHex } = await new EyeDropper().open();
        paletteEyedropperResult.hidden = false;
        paletteEyedropperResult.textContent = '';
        const box = document.createElement('span');
        box.className = 'swatch-box';
        box.style.background = sRGBHex;
        const label = document.createElement('span');
        label.textContent = sRGBHex;
        paletteEyedropperResult.append(box, label);
        addCopyButton(paletteEyedropperResult, sRGBHex, 'Copy');
      } catch {
        // User pressed Escape to cancel — not an error worth surfacing.
      }
    });
  }

  function openSlidePanel(panel) {
    for (const p of slidePanels) {
      if (p.el !== panel && !p.el.hidden) p.close();
    }
    panel.hidden = false;
    requestAnimationFrame(() => panel.classList.add('panel-open'));
  }
  function closeSlidePanel(panel) {
    panel.classList.remove('panel-open');
    const ms = parseFloat(getComputedStyle(panel).transitionDuration) * 1000 || 180;
    setTimeout(() => { panel.hidden = true; }, ms);
  }

  const fullscreenPanel = document.getElementById('fullscreenPanel');
  const fullscreenPanelClose = document.getElementById('fullscreenPanelClose');
  const fullscreenTitleEl = document.getElementById('fullscreenTitle');
  const fullscreenBodyEl = document.getElementById('fullscreenBody');
  const fullscreenSearchEl = document.getElementById('fullscreenSearch');
  if (fullscreenPanel && fullscreenPanelClose) {
    const closeFullscreen = () => closeSlidePanel(fullscreenPanel);
    fullscreenPanelClose.addEventListener('click', closeFullscreen);
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !fullscreenPanel.hidden) closeFullscreen();
    });
  }
  if (fullscreenSearchEl) {
    fullscreenSearchEl.addEventListener('input', () => {
      highlightMatches(fullscreenBodyEl, fullscreenSearchEl.value.trim().toLowerCase(), false);
    });
  }

  // ----------------------------------------------------------- diagnostics
  const diagBtn = document.getElementById('diagBtn');
  const diagBadge = document.getElementById('diagBadge');
  const diagPanel = document.getElementById('diagPanel');
  const diagPanelClose = document.getElementById('diagPanelClose');
  const diagBody = document.getElementById('diagBody');

  function jumpToEntry(d) {
    const entry = entries.find((e) => e.data === d);
    if (!entry) return;
    entry.el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    if (!entry.el.classList.contains('open')) {
      const head = entry.el.querySelector('.row-head');
      if (head) head.click();
    }
    entry.el.classList.add('jump-flash');
    setTimeout(() => entry.el.classList.remove('jump-flash'), 900);
  }

  function diagFindingRow(d, extra) {
    const row = document.createElement('button');
    row.className = 'diag-row';
    row.type = 'button';

    const isLogEntry = isLog(d);
    const tag = document.createElement('span');
    tag.className = isLogEntry ? `method log-level-${d.level}` : `method m-${(d.method || '').toLowerCase()}`;
    tag.textContent = isLogEntry ? (d.level === 'error' ? 'ERR' : 'WARN') : d.method;

    const label = document.createElement('span');
    label.className = 'diag-label';
    label.textContent = isLogEntry ? (d.message || '').slice(0, 120) : pathOf(d.url);
    label.title = isLogEntry ? (d.message || '') : d.url;

    const meta = document.createElement('span');
    meta.className = 'diag-meta';
    meta.textContent = extra;

    row.append(tag, label, meta);
    row.addEventListener('click', () => { jumpToEntry(d); });
    return row;
  }

  function diagSection(title, list, extraFn) {
    if (!list.length) return null;
    const details = document.createElement('details');
    details.className = 'storage-section';
    details.open = true;
    const summary = document.createElement('summary');
    summary.textContent = `${title} (${list.length})`;
    details.appendChild(summary);
    for (const d of list) details.appendChild(diagFindingRow(d, extraFn(d)));
    return details;
  }

  // Split from the full render so a busy page updates the toolbar badge on
  // every batch without rebuilding the panel's DOM while it is closed.
  function diagCounts() {
    const report = diagnose(entries.map((e) => e.data));
    const total = report.failed.length + report.consoleErrors.length + report.slow.length + report.large.length;
    if (diagBadge) {
      diagBadge.hidden = total === 0;
      diagBadge.textContent = total > 99 ? '99+' : String(total);
    }
    return report;
  }

  function renderDiagnostics() {
    const report = diagCounts();
    diagBody.textContent = '';

    const sections = [
      diagSection('Failed requests', report.failed, (d) => (d.failed || d.status === 0 ? 'ERR' : String(d.status))),
      diagSection('Console errors', report.consoleErrors, () => ''),
      diagSection('Slow requests (>3s)', report.slow, (d) => fmtDuration(d.duration)),
      diagSection('Large responses (>1MB)', report.large, (d) => fmtSize(d.responseSize)),
    ].filter(Boolean);

    if (!sections.length) {
      const note = document.createElement('div');
      note.className = 'note';
      note.textContent = 'Nothing flagged — no failures, slow requests, large responses or console errors captured.';
      diagBody.appendChild(note);
    } else {
      for (const s of sections) diagBody.appendChild(s);
    }
  }

  // Rescanning every capture on every 100ms batch is wasted work for a panel
  // that is usually closed and a button that is off by default.
  const DIAG_THROTTLE_MS = 750;
  let diagTimer = null;

  function scheduleDiagUpdate() {
    if (!diagBtn || diagBtn.hidden || diagTimer) return;
    diagTimer = setTimeout(() => {
      diagTimer = null;
      if (!diagPanel.hidden) renderDiagnostics();
      else diagCounts();
    }, DIAG_THROTTLE_MS);
  }

  function closeDiagPanel() { closeSlidePanel(diagPanel); }

  const setShowDiagEl = document.getElementById('setShowDiag');

  // Off by default — the toolbar was getting crowded, and most people never
  // open this panel. The toggle lives in Settings, not here, so turning it
  // off doesn't also hide the checkbox that turns it back on.
  function applyDiagVisibility(show) {
    if (!diagBtn) return;
    diagBtn.hidden = !show;
    if (!show) closeDiagPanel();
  }

  if (diagBtn && diagPanel) {
    slidePanels.push({ el: diagPanel, close: closeDiagPanel });
    diagBtn.addEventListener('click', () => {
      if (diagPanel.hidden) { renderDiagnostics(); openSlidePanel(diagPanel); }
      else closeDiagPanel();
    });
    diagPanelClose.addEventListener('click', closeDiagPanel);
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !diagPanel.hidden) closeDiagPanel();
    });
  }

  if (setShowDiagEl) {
    setShowDiagEl.addEventListener('change', () => {
      applyDiagVisibility(setShowDiagEl.checked);
      chrome.storage.local.set({ netlensShowDiag: setShowDiagEl.checked });
    });
    try {
      chrome.storage.local.get(['netlensShowDiag'], (res) => {
        const show = !!(res && res.netlensShowDiag);
        setShowDiagEl.checked = show;
        applyDiagVisibility(show);
      });
    } catch {}
  }

  // --------------------------------------------------------- saved sessions
  const historyBtn = document.getElementById('historyBtn');
  const historyPanel = document.getElementById('historyPanel');
  const historyPanelClose = document.getElementById('historyPanelClose');
  const historyClearBtn = document.getElementById('historyClearBtn');
  const historyBody = document.getElementById('historyBody');

  function historyNote(text) {
    const el = document.createElement('div');
    el.className = 'note';
    el.textContent = text;
    return el;
  }

  async function restoreSession(session) {
    if (restoredIds.has(session.id)) return;
    restoredIds.add(session.id);
    const datas = await dbLoadEntries(session.id);
    const container = document.createElement('div');
    container.className = 'session-container restored';

    const sep = document.createElement('div');
    sep.className = 'session-separator';
    buildSeparatorContent(sep, session.url, session.startedAt, false);
    const label = sep.querySelector('.session-label');
    if (label) label.textContent = 'Saved';
    container.appendChild(sep);

    const frag = document.createDocumentFragment();
    for (const d of datas) {
      const el = buildRow(d);
      el.classList.add('archived');
      // Restored rows join `entries` so the filter and search reach them, but
      // not `sessions` — the live session must stay the one new captures
      // append to.
      entries.push({ data: d, el });
      frag.appendChild(el);
    }
    container.appendChild(frag);
    listEl.prepend(container);
    updateCount();
    applyFilter();
  }

  function renderHistory(list) {
    historyBody.textContent = '';
    if (!list.length) {
      historyBody.appendChild(historyNote('Nothing saved yet — captures appear here as they arrive.'));
      return;
    }
    let lastDay = null;
    for (const s of list) {
      const day = dayLabel(s.startedAt);
      if (day !== lastDay) {
        lastDay = day;
        const head = document.createElement('div');
        head.className = 'history-day';
        head.textContent = day;
        historyBody.appendChild(head);
      }

      const row = document.createElement('div');
      row.className = 'history-row';

      const main = document.createElement('button');
      main.className = 'history-main';
      main.type = 'button';
      main.title = s.url || '';

      const url = document.createElement('span');
      url.className = 'history-url';
      url.textContent = pathOf(s.url) || s.url || 'Unknown URL';

      const meta = document.createElement('span');
      meta.className = 'history-meta';
      const time = new Date(s.startedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      meta.textContent = `${time} · ${s.count} req · ${fmtSize(s.bytes || 0)}`;
      if (s.errors) {
        const err = document.createElement('span');
        err.className = 'history-errors';
        err.textContent = ` · ${s.errors} err`;
        meta.appendChild(err);
      }

      main.append(url, meta);
      main.addEventListener('click', () => {
        restoreSession(s).catch(() => {});
        closeHistoryPanel();
      });

      const del = document.createElement('button');
      del.className = 'icon-btn history-del';
      del.type = 'button';
      del.title = 'Delete this session';
      del.setAttribute('aria-label', 'Delete this session');
      del.textContent = '\u00d7';
      del.addEventListener('click', () => {
        dbDeleteSessions([s.id]).then(loadHistory).catch(() => {});
      });

      row.append(main, del);
      historyBody.appendChild(row);
    }
  }

  function loadHistory() {
    return dbListSessions().then(renderHistory).catch(() => {
      historyBody.textContent = '';
      historyBody.appendChild(historyNote('Could not read saved sessions.'));
    });
  }

  let historyClearArmed = false;
  function disarmHistoryClear() {
    historyClearArmed = false;
    if (historyClearBtn) historyClearBtn.textContent = 'Clear all';
  }

  function closeHistoryPanel() {
    closeSlidePanel(historyPanel);
    disarmHistoryClear();
  }

  if (historyBtn && historyPanel) {
    slidePanels.push({ el: historyPanel, close: closeHistoryPanel });

    historyBtn.addEventListener('click', () => {
      if (historyPanel.hidden) { openSlidePanel(historyPanel); loadHistory(); }
      else closeHistoryPanel();
    });
    historyPanelClose.addEventListener('click', closeHistoryPanel);

    // Deleting every saved capture is not undoable, so it takes two clicks.
    historyClearBtn.addEventListener('click', () => {
      if (!historyClearArmed) {
        historyClearArmed = true;
        historyClearBtn.textContent = 'Delete everything?';
        return;
      }
      disarmHistoryClear();
      dbClearAll().then(loadHistory).catch(() => {});
    });

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !historyPanel.hidden) closeHistoryPanel();
    });
  }

  if (storageBtn && storagePanel) {
    const openStoragePanel = () => { openSlidePanel(storagePanel); loadStorage(); };
    const closeStoragePanel = () => closeSlidePanel(storagePanel);
    slidePanels.push({ el: storagePanel, close: closeStoragePanel });

    storageBtn.addEventListener('click', () => {
      if (storagePanel.hidden) openStoragePanel(); else closeStoragePanel();
    });
    storagePanelClose.addEventListener('click', closeStoragePanel);
    storageRefreshBtn.addEventListener('click', loadStorage);
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !storagePanel.hidden) closeStoragePanel();
    });
  }

  // ------------------------------------------------------- element inspector
  const inspectBtn = document.getElementById('inspectBtn');
  const inspectPanel = document.getElementById('inspectPanel');
  const inspectPanelClose = document.getElementById('inspectPanelClose');
  const inspectPickBtn = document.getElementById('inspectPickBtn');
  const inspectBodyEl = document.getElementById('inspectBody');
  let htmlSectionEl = null;

  function renderInspectResult(data) {
    if (!inspectBodyEl) return;
    inspectBodyEl.textContent = '';
    htmlSectionEl = null;

    const header = document.createElement('div');
    header.className = 'detail-url';
    header.style.padding = '0';
    const tag = `${data.tag}${data.id ? '#' + data.id : ''}${data.classes.length ? '.' + data.classes.join('.') : ''}`;
    header.textContent = `${tag}  ${data.rect.width}×${data.rect.height}`;
    inspectBodyEl.appendChild(header);

    const classesRow = document.createElement('div');
    classesRow.className = 'detail-actions';
    classesRow.style.padding = '0';
    classesRow.style.alignItems = 'center';
    if (data.classes.length) {
      const classesText = document.createElement('code');
      classesText.className = 'raw';
      classesText.style.flex = '1';
      classesText.style.minWidth = '0';
      classesText.style.overflow = 'hidden';
      classesText.style.textOverflow = 'ellipsis';
      classesText.style.whiteSpace = 'nowrap';
      classesText.textContent = data.classes.join(' ');
      classesRow.appendChild(classesText);
      addCopyButton(classesRow, data.classes.join(' '), 'Copy classes');
    } else {
      const note = document.createElement('div');
      note.className = 'note storage-empty';
      note.textContent = 'No classes.';
      classesRow.appendChild(note);
    }
    inspectBodyEl.appendChild(buildInspectSection('Classes', true, classesRow));

    const mainRule = [data.selector, collapseShorthands(sortCssProps(data.styles))];
    const pseudoRules = Object.entries(data.pseudos || {})
      .map(([pseudo, styles]) => [data.selector + pseudo, collapseShorthands(sortCssProps(styles))]);

    const cssWrap = document.createElement('div');
    cssWrap.style.position = 'relative';
    if (data.defaultsUnavailable) {
      const warn = document.createElement('div');
      warn.className = 'trunc-note';
      warn.textContent = '⚠ Page CSP blocked the baseline frame — showing every property, not just authored ones.';
      cssWrap.appendChild(warn);
    }
    // Copy takes the pseudos along even though they are rendered separately —
    // pasting an ::after that styles an icon without its rule is a broken paste.
    const allRules = [mainRule, ...pseudoRules];
    addCopyButton(cssWrap, allRules.map(([sel, pairs]) => cssRuleText(sel, pairs)).join('\n\n'), 'Copy CSS');
    cssWrap.appendChild(buildCssRule(mainRule[0], mainRule[1]));
    inspectBodyEl.appendChild(buildInspectSection('CSS', true, cssWrap));

    if (pseudoRules.length) {
      const pseudoWrap = document.createElement('div');
      pseudoWrap.style.position = 'relative';
      addCopyButton(pseudoWrap, pseudoRules.map(([sel, pairs]) => cssRuleText(sel, pairs)).join('\n\n'), 'Copy CSS');
      for (const [sel, pairs] of pseudoRules) pseudoWrap.appendChild(buildCssRule(sel, pairs));
      const title = `Pseudo-elements (${pseudoRules.map(([sel]) => sel.slice(data.selector.length)).join(', ')})`;
      inspectBodyEl.appendChild(buildInspectSection(title, false, pseudoWrap));
    }

    if (!data.hasHtml) return;

    const htmlWrap = document.createElement('div');
    if (data.outerHTMLTruncated) {
      const trunc = document.createElement('div');
      trunc.className = 'trunc-note';
      trunc.textContent = '⚠ Truncated at 20KB';
      htmlWrap.appendChild(trunc);
    }
    const htmlBox = document.createElement('div');
    htmlBox.style.position = 'relative';
    addCopyButton(htmlBox, data.outerHTML, 'Copy HTML');

    const prettyPre = document.createElement('pre');
    prettyPre.className = 'raw';
    prettyPre.textContent = prettyHtml(data.outerHTML);

    const rawPre = document.createElement('pre');
    rawPre.className = 'raw';
    rawPre.textContent = data.outerHTML;
    rawPre.hidden = true;

    const toggleBtn = document.createElement('button');
    toggleBtn.className = 'copy-btn raw-toggle-btn';
    toggleBtn.textContent = 'Raw';
    toggleBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const showingRaw = !rawPre.hidden;
      rawPre.hidden = showingRaw;
      prettyPre.hidden = !showingRaw;
      toggleBtn.textContent = showingRaw ? 'Raw' : 'Pretty';
    });

    htmlBox.append(toggleBtn, prettyPre, rawPre);
    htmlWrap.appendChild(htmlBox);
    htmlSectionEl = buildInspectSection('Outer HTML', false, htmlWrap);
    inspectBodyEl.appendChild(htmlSectionEl);
  }

  function prettyHtml(html) {
    const VOID_TAGS = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);
    const tokens = html.match(/<[^>]+>|[^<]+/g) || [];
    let depth = 0;
    const lines = [];
    for (const raw of tokens) {
      const token = raw.trim();
      if (!token) continue;
      if (token.startsWith('</')) {
        depth = Math.max(0, depth - 1);
        lines.push('  '.repeat(depth) + token);
      } else if (token.startsWith('<')) {
        lines.push('  '.repeat(depth) + token);
        const tagName = (token.match(/^<([a-zA-Z0-9-]+)/) || [])[1];
        const selfClosing = token.endsWith('/>') || (tagName && VOID_TAGS.has(tagName.toLowerCase()));
        if (!selfClosing) depth++;
      } else {
        lines.push('  '.repeat(depth) + token);
      }
    }
    return lines.join('\n');
  }

  // Formatting helpers (sortCssProps, collapseShorthands, cssRuleText) live in
  // css-format.js so they can be unit-tested outside the browser.

  const COLOR_VALUE = /^(#|rgba?\(|hsla?\(|hwb\(|lab\(|lch\(|oklab\(|oklch\(|color\()/i;

  function buildPropLine(prop, value) {
    const line = document.createElement('span');
    line.className = 'css-prop-line';
    const propEl = document.createElement('span');
    propEl.className = 'css-prop';
    propEl.textContent = prop;
    line.append(propEl, document.createTextNode(': '));
    if (COLOR_VALUE.test(value)) {
      const swatch = document.createElement('span');
      swatch.className = 'css-swatch';
      swatch.style.background = value;
      if (swatch.style.background) line.appendChild(swatch);
    }
    const valEl = document.createElement('span');
    valEl.className = 'css-val';
    valEl.textContent = value;
    line.append(valEl, document.createTextNode(';\n'));
    return line;
  }

  // DevTools-style: properties are grouped into collapsible categories instead
  // of one flat block. Pairs arrive pre-sorted by cssGroupIndex (sortCssProps),
  // so a group-index change is a category boundary — no re-bucketing needed.
  function buildCssRule(selector, pairs) {
    const wrap = document.createElement('div');
    wrap.className = 'css-rule';

    const selLine = document.createElement('div');
    selLine.className = 'css-sel-line';
    const sel = document.createElement('span');
    sel.className = 'css-sel';
    sel.textContent = selector;
    selLine.append(sel, document.createTextNode(' {'));
    wrap.appendChild(selLine);

    let groupIdx = null;
    let summary = null;
    let pre = null;
    let label = '';
    let count = 0;
    for (const pair of pairs) {
      const idx = cssGroupIndex(pair[0]);
      if (idx !== groupIdx) {
        groupIdx = idx;
        label = cssGroupLabel(pair[0]);
        count = 0;
        const bucket = document.createElement('details');
        bucket.className = 'css-group';
        bucket.open = true;
        summary = document.createElement('summary');
        bucket.appendChild(summary);
        pre = document.createElement('pre');
        pre.className = 'raw css-props';
        bucket.appendChild(pre);
        wrap.appendChild(bucket);
      }
      pre.appendChild(buildPropLine(pair[0], pair[1]));
      count++;
      summary.textContent = `${label} (${count})`;
    }

    const close = document.createElement('div');
    close.className = 'css-close';
    close.textContent = '}';
    wrap.appendChild(close);
    return wrap;
  }

  function stateRuleText(rule) {
    let text = cssRuleText(rule.selector, rule.declarations);
    for (let i = rule.conditions.length - 1; i >= 0; i--) {
      const indented = text.split('\n').map((line) => '  ' + line).join('\n');
      text = `${rule.conditions[i]} {\n${indented}\n}`;
    }
    return text;
  }

  function renderStateRules(payload) {
    if (!inspectBodyEl || !inspectBodyEl.firstChild) return;
    const rules = payload.rules || [];
    if (!rules.length && !payload.blocked) return;

    const wrap = document.createElement('div');
    wrap.style.position = 'relative';
    if (payload.blocked) {
      const note = document.createElement('div');
      note.className = 'trunc-note';
      note.textContent = `⚠ ${payload.blocked} stylesheet${payload.blocked === 1 ? '' : 's'} could not be read.`;
      wrap.appendChild(note);
    }
    if (rules.length) {
      addCopyButton(wrap, rules.map(stateRuleText).join('\n\n'), 'Copy CSS');
      for (const rule of rules) {
        if (rule.conditions.length) {
          const cond = document.createElement('div');
          cond.className = 'raw css-cond';
          cond.textContent = rule.conditions.join(' · ');
          wrap.appendChild(cond);
        }
        wrap.appendChild(buildCssRule(rule.selector, rule.declarations));
      }
    } else {
      const empty = document.createElement('div');
      empty.className = 'note storage-empty';
      empty.textContent = 'No state rules found.';
      wrap.appendChild(empty);
    }

    const states = [...new Set(rules.flatMap((r) => r.states))];
    const title = states.length ? `States (${states.join(', ')})` : 'States';
    const section = buildInspectSection(title, false, wrap);
    if (htmlSectionEl && htmlSectionEl.parentNode === inspectBodyEl) inspectBodyEl.insertBefore(section, htmlSectionEl);
    else inspectBodyEl.appendChild(section);
  }

  function buildInspectSection(title, open, contentEl) {
    const details = document.createElement('details');
    details.className = 'storage-section';
    details.open = open;
    const summary = document.createElement('summary');
    summary.textContent = title;
    details.appendChild(summary);
    details.appendChild(contentEl);
    return details;
  }

  if (inspectBtn && inspectPanel) {
    const setPicking = (on) => {
      inspectBtn.classList.toggle('active', on);
      inspectPickBtn.textContent = on ? 'Hover to inspect, click to lock (Esc)' : 'Pick element';
    };

    const showInspectError = (msg) => {
      if (!inspectBodyEl) return;
      inspectBodyEl.textContent = '';
      const note = document.createElement('div');
      note.className = 'manual-error';
      note.textContent = msg;
      inspectBodyEl.appendChild(note);
    };

    const startPicking = () => {
      if (currentTabId == null) return;
      setPicking(true);
      chrome.tabs.sendMessage(currentTabId, { type: 'netlens:inspect:start' }, () => {
        if (!chrome.runtime.lastError) return;
        // Stale content script (e.g. the extension was reloaded after this tab opened): reinject and retry once.
        chrome.scripting.executeScript({ target: { tabId: currentTabId }, files: ['content.js'] }, () => {
          if (chrome.runtime.lastError) {
            setPicking(false);
            showInspectError('Could not reach this page — reload the tab and try again.');
            return;
          }
          chrome.tabs.sendMessage(currentTabId, { type: 'netlens:inspect:start' }, () => {
            if (chrome.runtime.lastError) {
              setPicking(false);
              showInspectError('Could not reach this page — reload the tab and try again.');
            }
          });
        });
      });
    };
    const stopPicking = () => {
      setPicking(false);
      if (currentTabId != null) {
        chrome.tabs.sendMessage(currentTabId, { type: 'netlens:inspect:stop' }, () => { void chrome.runtime.lastError; });
      }
    };

    const openInspectPanel = () => { openSlidePanel(inspectPanel); startPicking(); };
    const closeInspectPanel = () => { stopPicking(); closeSlidePanel(inspectPanel); };
    slidePanels.push({ el: inspectPanel, close: closeInspectPanel });

    inspectBtn.addEventListener('click', () => {
      if (inspectPanel.hidden) openInspectPanel(); else closeInspectPanel();
    });
    inspectPanelClose.addEventListener('click', closeInspectPanel);
    inspectPickBtn.addEventListener('click', startPicking);
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !inspectPanel.hidden) stopPicking();
    });

    chrome.runtime.onMessage.addListener((msg, sender) => {
      if (!msg || !sender.tab || sender.tab.id !== currentTabId) return;
      if (msg.type === 'netlens:inspect:hover') {
        renderInspectResult(msg.data);
      } else if (msg.type === 'netlens:inspect:states') {
        renderStateRules(msg);
      } else if (msg.type === 'netlens:inspect:result') {
        setPicking(false);
        renderInspectResult(msg.data);
      } else if (msg.type === 'netlens:inspect:cancelled') {
        setPicking(false);
      } else if (msg.type === 'netlens:inspect:error') {
        setPicking(false);
        showInspectError(`Inspect failed: ${msg.message}`);
      }
    });
  }

  // ------------------------------------------------ custom decoder manager
  const decodersBtn = document.getElementById('decodersBtn');
  const decoderPanel = document.getElementById('decoderPanel');
  const decoderPanelClose = document.getElementById('decoderPanelClose');
  const decoderListEl = document.getElementById('decoderList');
  const decoderForm = document.getElementById('decoderForm');
  const decoderNameEl = document.getElementById('decoderName');
  const decoderChainGroup = document.getElementById('decoderChainGroup');
  const decoderChainStepsEl = document.getElementById('decoderChainSteps');
  const decoderCodeGroup = document.getElementById('decoderCodeGroup');
  const decoderCodeEl = document.getElementById('decoderCode');

  function buildChainStepCheckboxes() {
    if (!decoderChainStepsEl) return;
    decoderChainStepsEl.textContent = '';
    for (const step of DECODER_STEPS) {
      const label = document.createElement('label');
      label.className = 'decoder-step-check';
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.value = step.id;
      label.append(cb, document.createTextNode(step.label));
      decoderChainStepsEl.appendChild(label);
    }
  }

  function renderDecoderList() {
    if (!decoderListEl) return;
    decoderListEl.textContent = '';
    if (!customDecoders.length) {
      const note = document.createElement('div');
      note.className = 'note';
      note.textContent = 'No custom decoders yet.';
      decoderListEl.appendChild(note);
      return;
    }
    for (const cd of customDecoders) {
      const row = document.createElement('div');
      row.className = 'decoder-row';
      const label = document.createElement('span');
      const stepLabels = cd.type === 'chain' ? cd.steps.map(id => (DECODER_STEP_MAP[id] || { label: id }).label) : [];
      label.textContent = cd.type === 'function' ? `${cd.name} (JS function)` : `${cd.name} (${stepLabels.join(' → ')})`;
      const del = document.createElement('button');
      del.type = 'button';
      del.className = 'mini-btn danger';
      del.textContent = 'Delete';
      del.addEventListener('click', () => {
        customDecoders = customDecoders.filter(x => x.id !== cd.id);
        saveCustomDecoders();
        renderDecoderList();
      });
      row.append(label, del);
      decoderListEl.appendChild(row);
    }
  }

  const settingsBtn = document.getElementById('settingsBtn');
  const settingsPanel = document.getElementById('settingsPanel');
  if (settingsBtn && settingsPanel) {
    const closeSettings = () => closeSlidePanel(settingsPanel);
    slidePanels.push({ el: settingsPanel, close: closeSettings });
    settingsBtn.addEventListener('click', () => {
      if (settingsPanel.hidden) openSlidePanel(settingsPanel); else closeSettings();
    });
    document.getElementById('settingsPanelClose').addEventListener('click', closeSettings);
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !settingsPanel.hidden) closeSettings();
    });
  }

  if (decodersBtn && decoderPanel) {
    buildChainStepCheckboxes();

    const openPanel = () => {
      renderDecoderList();
      openSlidePanel(decoderPanel);
    };
    const closePanel = () => closeSlidePanel(decoderPanel);
    slidePanels.push({ el: decoderPanel, close: closePanel });

    decodersBtn.addEventListener('click', () => {
      if (decoderPanel.hidden) openPanel(); else closePanel();
    });
    decoderPanelClose.addEventListener('click', closePanel);
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !decoderPanel.hidden) closePanel();
    });

    decoderForm.querySelectorAll('input[name="decoderType"]').forEach((radio) => {
      radio.addEventListener('change', () => {
        const isFn = decoderForm.decoderType.value === 'function';
        decoderChainGroup.classList.toggle('is-collapsed', isFn);
        decoderCodeGroup.classList.toggle('is-collapsed', !isFn);
      });
    });

    decoderForm.addEventListener('submit', (e) => {
      e.preventDefault();
      const name = decoderNameEl.value.trim();
      if (!name) return;
      const type = decoderForm.decoderType.value;
      const entry = { id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, name, type };
      if (type === 'function') {
        const code = decoderCodeEl.value.trim();
        if (!code) return;
        entry.code = code;
      } else {
        const steps = Array.from(decoderChainStepsEl.querySelectorAll('input:checked')).map(cb => cb.value);
        if (!steps.length) {
          decoderChainStepsEl.classList.add('input-error');
          return;
        }
        decoderChainStepsEl.classList.remove('input-error');
        entry.steps = steps;
      }
      customDecoders.push(entry);
      saveCustomDecoders();
      renderDecoderList();
      decoderForm.reset();
      decoderChainGroup.classList.remove('is-collapsed');
      decoderCodeGroup.classList.add('is-collapsed');
    });
  }

  updateCount();
})();
