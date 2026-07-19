
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
  const bodySearchEl = document.getElementById('bodySearch');
  const apiOnlyEl = document.getElementById('apiOnly');
  const pauseBtn = document.getElementById('pauseBtn');
  const clearBtn = document.getElementById('clearBtn');

  let currentTabId = null;
  let entries = [];           
  let paused = false;
  let pulseTimer = null;

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
    return d.failed || d.status === 0 || d.status >= 400;
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
    return listEl.scrollHeight - listEl.scrollTop - listEl.clientHeight < 40;
  }

  // --------------------------------------------------------- JSON tree UI
  function jsonNode(key, value) {
    const isObj = value !== null && typeof value === 'object';
    if (isObj) {
      const isArr = Array.isArray(value);
      const keys = isArr ? value : Object.keys(value);
      const det = document.createElement('details');
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
      for (const [k, v] of children) det.appendChild(jsonNode(String(k), v));
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
    try {
      const parsed = JSON.parse(text);
      const tree = document.createElement('div');
      tree.className = 'jtree';
      const root = jsonNode(null, parsed);
      if (root.tagName === 'DETAILS') root.open = true;
      tree.appendChild(root);
      container.appendChild(tree);
    } catch {
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
        setTimeout(() => { btn.textContent = label; }, 1200);
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
    if (typeof d.requestBody === 'string') hay += d.requestBody;
    if (typeof d.responseBody === 'string') hay += '\n' + d.responseBody;
    d.__bodyHay = hay.slice(0, BODY_SEARCH_CAP).toLowerCase();
    return d.__bodyHay;
  }

  // ------------------------------------------------------------ row build
  function buildRow(d) {
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
    row.appendChild(detail);

    let built = false;
    const toggle = () => {
      const open = row.classList.toggle('open');
      head.setAttribute('aria-expanded', String(open));
      if (open && !built) {
        built = true;
        buildDetail(detail, d);
      }
    };
    head.addEventListener('click', toggle);
    head.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); }
    });

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

    let activeBtn = null;
    for (const name of Object.keys(views)) {
      const btn = document.createElement('button');
      btn.className = 'tab';
      btn.textContent = name;
      btn.addEventListener('click', () => {
        if (activeBtn) activeBtn.classList.remove('active');
        activeBtn = btn;
        btn.classList.add('active');
        views[name]();
      });
      tabs.appendChild(btn);
      if (!activeBtn) { activeBtn = btn; }
    }

    container.append(tabs, body);
    activeBtn.classList.add('active');
    views.Response(); 
  }

  // ------------------------------------------------------------ filtering
  function applyFilter() {
    const q = filterEl.value.trim().toLowerCase();
    const errOnly = errorsOnlyEl.checked;
    const searchBodies = bodySearchEl.checked;
    const apiOnly = apiOnlyEl.checked;
    for (const { data, el } of entries) {
      const matchesText =
        !q || el.dataset.hay.includes(q) || (searchBodies && bodyHay(data).includes(q));
      const matches =
        matchesText && (!errOnly || el.dataset.err === '1') && (!apiOnly || el.dataset.api === '1');
      el.style.display = matches ? '' : 'none';
    }
  }

  let filterDebounce = null;
  function scheduleFilter() {
    clearTimeout(filterDebounce);
    filterDebounce = setTimeout(applyFilter, FILTER_DEBOUNCE_MS);
  }

  filterEl.addEventListener('input', scheduleFilter);
  errorsOnlyEl.addEventListener('change', applyFilter);
  bodySearchEl.addEventListener('change', applyFilter);
  apiOnlyEl.addEventListener('change', applyFilter);

  // ------------------------------------------------------------- ingest
  function addEntries(batch) {
    if (!batch || !batch.length) return;
    const pinned = isPinnedToBottom();
    const frag = document.createDocumentFragment();
    for (const d of batch) {
      const el = buildRow(d);
      entries.push({ data: d, el });
      frag.appendChild(el);
    }
    listEl.appendChild(frag);

    while (entries.length > MAX_ROWS) {
      const removed = entries.shift();
      removed.el.remove();
    }

    applyFilter();
    updateCount();
    pulse();
    if (pinned) listEl.scrollTop = listEl.scrollHeight;
  }

  function clearAll(alsoBuffer) {
    entries = [];
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
    requestDump(tabId);
  }

  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (tabs && tabs[0]) trackTab(tabs[0].id);
  });

  chrome.tabs.onActivated.addListener(({ tabId }) => trackTab(tabId));

  chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
    if (tabId !== currentTabId) return;
    if (changeInfo.status === 'loading') clearAll(false); // fresh page, fresh list
  });

  // ---------------------------------------------------------- live batches
  chrome.runtime.onMessage.addListener((msg, sender) => {
    if (!msg || msg.type !== 'netlens:batch') return;
    if (!sender.tab || sender.tab.id !== currentTabId) return;
    if (paused) return;
    addEntries(msg.batch);
  });

  // -------------------------------------------------------------- controls
  pauseBtn.addEventListener('click', () => {
    paused = !paused;
    pauseBtn.classList.toggle('active', paused);
    pauseBtn.textContent = paused ? '▶' : '⏸';
    pauseBtn.title = paused ? 'Resume capture' : 'Pause capture';
    pulseEl.classList.toggle('paused', paused);
  });

  clearBtn.addEventListener('click', () => clearAll(true));

  updateCount();
})();
