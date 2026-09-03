
(() => {
  const MAX_ROWS = 500;
  const BODY_SEARCH_CAP = 20 * 1024; 
  const FILTER_DEBOUNCE_MS = 80;

  const listEl = document.getElementById('list');
  const emptyEl = document.getElementById('empty');
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
  let sessions = [];
  let paused = false;
  let pulseTimer = null;

  // ponytail: history is kept in sidepanel memory. If the sidepanel is closed, history is lost. Upgrade path: use chrome.storage.session or background service worker.
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
      containerEl
    };
    sessions.push(newSession);

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

  function runCustomFunction(code, input, timeoutMs = 1000) {
    return new Promise((resolve, reject) => {
      const src = `self.onmessage=function(e){try{const fn=new Function('input',e.data.code);const r=fn(e.data.input);self.postMessage({ok:true,result:r});}catch(err){self.postMessage({ok:false,error:String(err&&err.message||err)});}};`;
      let worker;
      try {
        const blob = new Blob([src], { type: 'application/javascript' });
        worker = new Worker(URL.createObjectURL(blob));
      } catch (e) { reject(e); return; }
      const timer = setTimeout(() => {
        worker.terminate();
        reject(new Error('Timed out (possible infinite loop)'));
      }, timeoutMs);
      worker.onmessage = (e) => {
        clearTimeout(timer);
        worker.terminate();
        if (e.data && e.data.ok) resolve(e.data.result);
        else reject(new Error((e.data && e.data.error) || 'Unknown error'));
      };
      worker.onerror = (e) => {
        clearTimeout(timer);
        worker.terminate();
        reject(new Error(e.message || 'Worker error'));
      };
      worker.postMessage({ code, input });
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
  function fmtDuration(ms) {
    if (ms == null) return '';
    return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(2)}s`;
  }

  function fmtSize(bytes) {
    if (!bytes) return '';
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }

  function statusClass(d) {
    if (d.failed || d.status === 0) return 'failed';
    if (d.status >= 500) return 's5xx';
    if (d.status >= 400) return 's4xx';
    if (d.status >= 300) return 's3xx';
    if (d.status >= 200) return 's2xx';
    return '';
  }

  function isError(d) {
    if (d.kind === 'log') return d.level === 'error';
    return d.failed || d.status === 0 || d.status >= 400;
  }

  function isLog(d) {
    return d.kind === 'log';
  }

  function isApi(d) {
    return /json|xml|graphql/i.test(d.contentType || '');
  }

  function pathOf(url) {
    try {
      const u = new URL(url);
      return u.pathname + u.search;
    } catch {
      return url;
    }
  }

  function pulse() {
    if (paused) return;
    pulseEl.classList.add('active');
    clearTimeout(pulseTimer);
    pulseTimer = setTimeout(() => pulseEl.classList.remove('active'), 400);
  }

  function updateCount() {
    countEl.textContent = String(entries.length);
    emptyEl.classList.toggle('visible', entries.length === 0);
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

    const views = {
      Response: () => renderBody(body, d.responseBody, d.truncated),
      Payload: () => renderBody(body, d.requestBody, false),
      Headers: () => renderHeaders(body, d),
    };

    if (hasDecodableData(d, customDecoders)) {
      views.Decoded = () => renderDecoded(body, d);
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

    container.append(tabs, body);
    if (activeBtn) activeBtn.classList.add('active');
    views[activeName]();
    if (q) highlightMatches(body, q, true);
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
    const q = filterEl.value.trim().toLowerCase();
    const errOnly = errorsOnlyEl.checked;
    const apiOnly = apiOnlyEl.checked;
    const showLogs = showLogsEl.checked;
    for (const { data, el } of entries) {
      const matchesText =
        !q || el.dataset.hay.includes(q) || bodyHay(data).includes(q);
      const matches =
        matchesText && (!errOnly || el.dataset.err === '1') && (!apiOnly || el.dataset.api === '1') &&
        (showLogs || data.kind !== 'log');
      el.style.display = matches ? '' : 'none';

      const pathBdo = el.querySelector('.path bdo');
      if (pathBdo) {
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
  }

  let filterDebounce = null;
  function scheduleFilter() {
    clearTimeout(filterDebounce);
    filterDebounce = setTimeout(applyFilter, FILTER_DEBOUNCE_MS);
  }

  filterEl.addEventListener('input', scheduleFilter);
  errorsOnlyEl.addEventListener('change', applyFilter);
  apiOnlyEl.addEventListener('change', applyFilter);
  showLogsEl.addEventListener('change', applyFilter);

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

    applyFilter();
    updateCount();
    pulse();
    if (pinned) {
      const lastEntry = currentSession.entries[currentSession.entries.length - 1];
      if (lastEntry) lastEntry.el.scrollIntoView({ block: 'nearest', behavior: 'instant' });
    }
  }

  function clearAll(alsoBuffer) {
    entries = [];
    sessions = [];
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

  function openSlidePanel(panel) {
    panel.hidden = false;
    requestAnimationFrame(() => panel.classList.add('panel-open'));
  }
  function closeSlidePanel(panel) {
    panel.classList.remove('panel-open');
    const ms = parseFloat(getComputedStyle(panel).transitionDuration) * 1000 || 180;
    setTimeout(() => { panel.hidden = true; }, ms);
  }

  if (storageBtn && storagePanel) {
    const openStoragePanel = () => { openSlidePanel(storagePanel); loadStorage(); };
    const closeStoragePanel = () => closeSlidePanel(storagePanel);

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

  function renderInspectResult(data) {
    if (!inspectBodyEl) return;
    inspectBodyEl.textContent = '';

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

    inspectBodyEl.appendChild(buildInspectSection('Computed style', true,
      buildDecodedTable(Object.entries(data.computed).map(([key, value]) => ({ key, value })))));

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
    inspectBodyEl.appendChild(buildInspectSection('Outer HTML', false, htmlWrap));
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
      inspectPickBtn.textContent = on ? 'Picking… (Esc to cancel)' : 'Pick element';
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
      if (msg.type === 'netlens:inspect:result') {
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

  if (decodersBtn && decoderPanel) {
    buildChainStepCheckboxes();

    const openPanel = () => {
      renderDecoderList();
      openSlidePanel(decoderPanel);
    };
    const closePanel = () => closeSlidePanel(decoderPanel);

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
