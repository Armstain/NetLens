
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

  function addSessionDecodedIfAny(containerEl, url) {
    const existing = containerEl.querySelector('.session-decoded');
    if (existing) existing.remove();

    try {
      const u = new URL(url);
      const decodedParams = [];
      for (const [key, val] of u.searchParams.entries()) {
        const decoded = tryDecodeStructure(val);
        if (decoded) {
          decodedParams.push({ key, method: decoded.method, value: decoded.value });
        }
      }
      
      const segments = u.pathname.split('/').filter(Boolean);
      const decodedSegments = [];
      for (let i = 0; i < segments.length; i++) {
        const decoded = tryDecodeStructure(segments[i]);
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
          
          const table = document.createElement('table');
          table.className = 'kv decoded-table';
          for (const item of decodedParams) {
            const tr = document.createElement('tr');
            const tdKey = document.createElement('td');
            tdKey.className = 'decoded-key-cell';
            tdKey.textContent = item.key;
            
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
          inner.appendChild(table);
        }

        if (decodedSegments.length > 0) {
          const title = document.createElement('div');
          title.className = 'decoded-section-title';
          title.textContent = 'URL Path Segments';
          inner.appendChild(title);
          
          const table = document.createElement('table');
          table.className = 'kv decoded-table';
          for (const item of decodedSegments) {
            const tr = document.createElement('tr');
            const tdKey = document.createElement('td');
            tdKey.className = 'decoded-key-cell';
            tdKey.textContent = item.key;
            
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
          inner.appendChild(table);
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

  function decodeText(encodedText, shift) {
    if (shift < 1 || shift > 25) return "";
    let decoded = "";
    const effectiveShift = 26 - shift;
    for (let i = 0; i < encodedText.length; i++) {
      let charCode = encodedText.charCodeAt(i);
      if (charCode >= 65 && charCode <= 90) {
        decoded += String.fromCharCode(((charCode - 65 + effectiveShift) % 26) + 65);
      } else if (charCode >= 97 && charCode <= 122) {
        decoded += String.fromCharCode(((charCode - 97 + effectiveShift) % 26) + 97);
      } else {
        decoded += encodedText.charAt(i);
      }
    }
    return decoded;
  }

  function tryDecode(val) {
    if (typeof val !== 'string' || !val.trim()) return null;
    val = val.trim();

    // 1. Try Caesar-shift + LZString
    try {
      const decodedText = decodeText(val, 9);
      const decompressed = LZString.decompressFromEncodedURIComponent(decodedText);
      if (decompressed) {
        const parsed = JSON.parse(decompressed);
        if (parsed && typeof parsed === 'object') {
          return { method: 'Caesar(9)+LZ', value: parsed };
        }
      }
    } catch {}

    // 2. Try plain LZString
    try {
      const decompressed = LZString.decompressFromEncodedURIComponent(val);
      if (decompressed) {
        const parsed = JSON.parse(decompressed);
        if (parsed && typeof parsed === 'object') {
          return { method: 'LZString', value: parsed };
        }
      }
    } catch {}

    return null;
  }

  // ponytail: attempts to auto-repair truncated JSON strings (e.g. capped at 200KB) by closing strings and container brackets.
  function tryParsePartialJson(str) {
    if (typeof str !== 'string') return null;
    let raw = str.trim();
    if (!raw.startsWith('{') && !raw.startsWith('[')) return null;

    let s = raw;
    for (let attempt = 0; attempt < 50; attempt++) {
      let inString = false;
      let escaped = false;
      const stack = [];

      for (let i = 0; i < s.length; i++) {
        const c = s[i];
        if (inString) {
          if (escaped) {
            escaped = false;
          } else if (c === '\\') {
            escaped = true;
          } else if (c === '"') {
            inString = false;
          }
        } else {
          if (c === '"') {
            inString = true;
          } else if (c === '{' || c === '[') {
            stack.push(c);
          } else if (c === '}') {
            if (stack.length && stack[stack.length - 1] === '{') stack.pop();
          } else if (c === ']') {
            if (stack.length && stack[stack.length - 1] === '[') stack.pop();
          }
        }
      }

      let candidate = s;
      if (inString) candidate += '"';

      let suffix = '';
      for (let i = stack.length - 1; i >= 0; i--) {
        suffix += stack[i] === '{' ? '}' : ']';
      }

      try {
        const result = JSON.parse(candidate + suffix);
        if (result && typeof result === 'object') return result;
      } catch {}

      const lastBoundary = Math.max(s.lastIndexOf(','), s.lastIndexOf('{'), s.lastIndexOf('['));
      if (lastBoundary > 0 && lastBoundary < s.length - 1) {
        s = s.slice(0, lastBoundary + (s[lastBoundary] === ',' ? 0 : 1));
      } else if (s.length > 1) {
        s = s.slice(0, -1);
      } else {
        break;
      }
    }

    return null;
  }

  function tryDecodeStructure(val) {
    if (typeof val !== 'string') return null;
    
    const direct = tryDecode(val);
    if (direct) return direct;

    try {
      let parsed = null;
      try {
        parsed = JSON.parse(val);
      } catch {
        parsed = tryParsePartialJson(val);
      }
      if (parsed && typeof parsed === 'object') {
        let hasDecoded = false;
        const decodedStruct = JSON.parse(JSON.stringify(parsed));
        
        const recurse = (obj) => {
          if (Array.isArray(obj)) {
            for (let i = 0; i < obj.length; i++) {
              if (typeof obj[i] === 'string') {
                const dec = tryDecode(obj[i]);
                if (dec) {
                  obj[i] = { __decoded: true, method: dec.method, value: dec.value };
                  hasDecoded = true;
                }
              } else if (obj[i] && typeof obj[i] === 'object') {
                recurse(obj[i]);
              }
            }
          } else if (obj && typeof obj === 'object') {
            for (const [k, v] of Object.entries(obj)) {
              if (typeof v === 'string') {
                const dec = tryDecode(v);
                if (dec) {
                  obj[k] = { __decoded: true, method: dec.method, value: dec.value };
                  hasDecoded = true;
                }
              } else if (v && typeof v === 'object') {
                recurse(v);
              }
            }
          }
        };
        
        recurse(decodedStruct);
        if (hasDecoded) {
          return { method: 'JSON Structure', value: decodedStruct };
        }
      }
    } catch {}

    return null;
  }

  function hasDecodableData(d) {
    try {
      const u = new URL(d.url);
      for (const [, val] of u.searchParams) {
        if (tryDecodeStructure(val)) return true;
      }
      for (const val of u.pathname.split('/').filter(Boolean)) {
        if (tryDecodeStructure(val)) return true;
      }
    } catch {}
    if (d.requestBody && tryDecodeStructure(d.requestBody)) return true;
    if (d.responseBody && tryDecodeStructure(d.responseBody)) return true;
    for (const val of Object.values(d.requestHeaders || {})) {
      if (tryDecodeStructure(val)) return true;
    }
    for (const val of Object.values(d.responseHeaders || {})) {
      if (tryDecodeStructure(val)) return true;
    }
    return false;
  }

  function renderDecoded(container, d) {
    container.textContent = '';
    const decodedSections = [];

    try {
      const u = new URL(d.url);
      
      const params = Array.from(u.searchParams.entries());
      const decodedParams = [];
      for (const [key, val] of params) {
        const decoded = tryDecodeStructure(val);
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
        const decoded = tryDecodeStructure(segments[i]);
        if (decoded) {
          decodedSegments.push({ key: `Path Segment [${i}]`, method: decoded.method, value: decoded.value });
        }
      }
      if (decodedSegments.length > 0) {
        decodedSections.push({ title: 'URL Path Segments', items: decodedSegments });
      }
    } catch {}

    if (d.requestBody) {
      const decoded = tryDecodeStructure(d.requestBody);
      if (decoded) {
        decodedSections.push({
          title: 'Request Body',
          items: [{ key: 'Body', method: decoded.method, value: decoded.value }]
        });
      }
    }

    if (d.responseBody) {
      const decoded = tryDecodeStructure(d.responseBody);
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
        const decoded = tryDecodeStructure(v);
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
      return;
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
    if (sessions.length === 0) return true;
    const currentSession = sessions[sessions.length - 1];
    const container = currentSession.containerEl;
    if (!container) return true;
    
    const containerBottom = container.offsetTop + container.offsetHeight;
    const viewportBottom = listEl.scrollTop + listEl.clientHeight;
    return (containerBottom - viewportBottom) < 40;
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
      container.appendChild(tree);
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
      if (open) {
        if (!built) {
          built = true;
          buildDetail(detail, d);
        }
        const q = filterEl.value.trim().toLowerCase();
        if (q) highlightMatches(detail, q, true);
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

    if (hasDecodableData(d)) {
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
    const searchBodies = bodySearchEl.checked;
    const apiOnly = apiOnlyEl.checked;
    for (const { data, el } of entries) {
      const matchesText =
        !q || el.dataset.hay.includes(q) || (searchBodies && bodyHay(data).includes(q));
      const matches =
        matchesText && (!errOnly || el.dataset.err === '1') && (!apiOnly || el.dataset.api === '1');
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
  bodySearchEl.addEventListener('change', applyFilter);
  apiOnlyEl.addEventListener('change', applyFilter);

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
