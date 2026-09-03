
(() => {
  if (window.__netlens_installed) return;
  window.__netlens_installed = true;

  const MAX_BODY = 200 * 1024; // 200KB cap per body
  const FLUSH_MS = 100;

  let queue = [];
  let flushTimer = null;
  let seq = 0;

  const now = () => performance.now();

  function absolutize(url) {
    try { return new URL(url, location.href).href; } catch { return String(url); }
  }

  function truncate(text) {
    if (typeof text !== 'string') return { body: null, truncated: false, size: 0 };
    const size = text.length;
    if (size > MAX_BODY) return { body: text.slice(0, MAX_BODY), truncated: true, size };
    return { body: text, truncated: false, size };
  }

  function serializeRequestBody(body) {
    try {
      if (body == null) return null;
      if (typeof body === 'string') return truncate(body).body;
      if (body instanceof URLSearchParams) return body.toString();
      if (typeof FormData !== 'undefined' && body instanceof FormData) return '[FormData]';
      if (typeof Blob !== 'undefined' && body instanceof Blob) return `[Blob ${body.size} bytes, ${body.type || 'unknown type'}]`;
      if (body instanceof ArrayBuffer) return `[Binary ${body.byteLength} bytes]`;
      if (ArrayBuffer.isView(body)) return `[Binary ${body.byteLength} bytes]`;
      return '[Unserializable request body]';
    } catch {
      return null;
    }
  }

  function enqueue(entry) {
    queue.push(entry);
    if (!flushTimer) flushTimer = setTimeout(flush, FLUSH_MS);
  }

  function flush() {
    flushTimer = null;
    if (!queue.length) return;
    const batch = queue;
    queue = [];
    try { window.postMessage({ __netlens: true, batch }, '*'); } catch {}
  }

  const READABLE_CT = /json|text|xml|javascript|x-www-form-urlencoded/i;

  // Long-lived streams. clone() tees the body, and a branch nobody drains at
  // the producer's rate buffers without bound — on an SSE feed that never
  // ends, forever. Match before READABLE_CT, which "text" and "json" catch.
  const STREAM_CT = /event-stream|x-ndjson|stream\+json/i;

  const isReadableBody = (ct) => READABLE_CT.test(ct) && !STREAM_CT.test(ct);

  // ------------------------------------------------------------------ logs
  const LOG_RATE_LIMIT = 50; // per second
  let logWindowStart = now();
  let logWindowCount = 0;
  let logsDropped = 0;

  function safeStringify(val, depth = 4, seen) {
    if (val instanceof Error) return `${val.message}\n${val.stack || ''}`;
    if (typeof Element !== 'undefined' && val instanceof Element) return `[${val.tagName}]`;
    if (typeof val === 'function') return `[Function ${val.name || 'anonymous'}]`;
    if (typeof val !== 'object' || val === null) return val;
    seen = seen || new WeakSet();
    if (seen.has(val)) return '[Circular]';
    if (depth <= 0) return Array.isArray(val) ? '[Array]' : '[Object]';
    seen.add(val);
    try {
      if (Array.isArray(val)) return val.slice(0, 50).map((v) => safeStringify(v, depth - 1, seen));
      const out = {};
      let n = 0;
      for (const k in val) {
        if (++n > 50) { out['…'] = 'truncated'; break; }
        out[k] = safeStringify(val[k], depth - 1, seen);
      }
      return out;
    } catch {
      try { return String(val); } catch { return '[Unserializable]'; }
    }
  }

  function enqueueLog(level, args, extra) {
    const t = now();
    if (t - logWindowStart > 1000) {
      if (logsDropped > 0) {
        enqueue({ id: ++seq, kind: 'log', level: 'warn', message: `NetLens: ${logsDropped} log(s) dropped (rate limit)`, args: [], startedAt: Date.now() });
      }
      logWindowStart = t;
      logWindowCount = 0;
      logsDropped = 0;
    }
    logWindowCount++;
    if (logWindowCount > LOG_RATE_LIMIT) { logsDropped++; return; }

    let message;
    try {
      message = args.map((a) => {
        if (typeof a === 'string') return a;
        const s = safeStringify(a);
        return typeof s === 'string' ? s : JSON.stringify(s);
      }).join(' ');
    } catch { message = '[unrenderable log]'; }

    enqueue(Object.assign({
      id: ++seq,
      kind: 'log',
      level,
      message: truncate(message).body,
      args: args.map((a) => safeStringify(a)),
      startedAt: Date.now(),
    }, extra));
  }

  const origConsoleError = console.error;
  console.error = function (...args) {
    try { origConsoleError.apply(console, args); } finally {
      try { enqueueLog('error', args); } catch {}
    }
  };

  const origConsoleWarn = console.warn;
  console.warn = function (...args) {
    try { origConsoleWarn.apply(console, args); } finally {
      try { enqueueLog('warn', args); } catch {}
    }
  };

  window.addEventListener('error', (e) => {
    try {
      const err = e.error;
      enqueueLog('error', [err ? (err.message || String(err)) : e.message], {
        stack: err && err.stack ? err.stack : null,
        source: e.filename ? `${e.filename}:${e.lineno}:${e.colno}` : null,
      });
    } catch {}
  });

  window.addEventListener('unhandledrejection', (e) => {
    try {
      const reason = e.reason;
      const msg = reason instanceof Error ? reason.message : String(reason);
      enqueueLog('error', [`Unhandled rejection: ${msg}`], {
        stack: reason && reason.stack ? reason.stack : null,
      });
    } catch {}
  });

  // ---------------------------------------------------------------- fetch
  const origFetch = window.fetch;
  window.fetch = function (input, init) {
    let method = 'GET';
    let url = '';
    let reqHeaders = {};
    let reqBody = null;

    try {
      if (typeof Request !== 'undefined' && input instanceof Request) {
        method = input.method || 'GET';
        url = input.url;
        input.headers.forEach((v, k) => { reqHeaders[k] = v; });
      } else {
        url = String(input);
      }
      if (init) {
        if (init.method) method = init.method;
        if (init.headers) {
          try { new Headers(init.headers).forEach((v, k) => { reqHeaders[k] = v; }); } catch {}
        }
        if ('body' in init) reqBody = serializeRequestBody(init.body);
      }
    } catch {}

    const id = ++seq;
    const start = now();
    const startedAt = Date.now();

    // Call through immediately  the page gets the untouched promise.
    const promise = origFetch.apply(this, arguments);

    promise.then(
      (res) => {
        // clone() MUST happen here, synchronously. Our handler is registered
        // before the page's, so we run first; a queued microtask would run
        // *after* the page's `r => r.json()` has already disturbed the body,
        // and clone() would throw. Only the body read is deferred.
        // Clone solely for bodies we intend to read: an unread clone tees the
        // stream and buffers the whole response with nothing draining it.
        const ct = res.headers.get('content-type') || '';
        let cloned = null;
        if (isReadableBody(ct)) {
          try { cloned = res.clone(); } catch {}
        }

        // Everything below happens after the page already has its response.
        queueMicrotask(() => {
          try {
            const responseHeaders = {};
            res.headers.forEach((v, k) => { responseHeaders[k] = v; });
            const base = {
              id,
              kind: 'fetch',
              method: String(method).toUpperCase(),
              url: absolutize(url),
              status: res.status,
              statusText: res.statusText,
              startedAt,
              duration: now() - start,
              requestHeaders: reqHeaders,
              requestBody: reqBody,
              responseHeaders,
              contentType: ct,
            };
            if (isReadableBody(ct)) {
              // No clone means the body was unreachable — still record the
              // request rather than dropping the entry entirely.
              if (!cloned) {
                enqueue({ ...base, responseBody: '[body unavailable]', responseSize: 0 });
              } else {
                cloned.text().then(
                  (text) => {
                    const t = truncate(text);
                    enqueue({ ...base, responseBody: t.body, truncated: t.truncated, responseSize: t.size });
                  },
                  () => enqueue({ ...base, responseBody: null, responseSize: 0 })
                );
              }
            } else {
              enqueue({ ...base, responseBody: ct ? `[${ct}]` : null, responseSize: 0 });
            }
          } catch {}
        });
      },
      (err) => {
        enqueue({
          id,
          kind: 'fetch',
          method: String(method).toUpperCase(),
          url: absolutize(url),
          status: 0,
          statusText: (err && err.message) || 'Network error',
          startedAt,
          duration: now() - start,
          requestHeaders: reqHeaders,
          requestBody: reqBody,
          responseHeaders: {},
          responseBody: null,
          responseSize: 0,
          failed: true,
        });
       
      }
    );

    return promise;
  };

  // ------------------------------------------------------------------ XHR
  const XHRp = XMLHttpRequest.prototype;
  const origOpen = XHRp.open;
  const origSend = XHRp.send;
  const origSetRequestHeader = XHRp.setRequestHeader;

  XHRp.open = function (method, url) {
    try {
      this.__netlens = {
        method: String(method || 'GET').toUpperCase(),
        url: absolutize(url),
        requestHeaders: {},
      };
    } catch {}
    return origOpen.apply(this, arguments);
  };

  XHRp.setRequestHeader = function (name, value) {
    try { if (this.__netlens) this.__netlens.requestHeaders[name] = value; } catch {}
    return origSetRequestHeader.apply(this, arguments);
  };

  XHRp.send = function (body) {
    const meta = this.__netlens;
    if (meta) {
      const id = ++seq;
      meta.start = now();
      meta.startedAt = Date.now();
      meta.requestBody = serializeRequestBody(body);

      this.addEventListener('loadend', () => {
        try {
          const duration = now() - meta.start;
          const ct = (this.getResponseHeader && this.getResponseHeader('content-type')) || '';

          let responseBody = null;
          let responseSize = 0;
          let truncated = false;

          if (this.responseType === '' || this.responseType === 'text') {
            const t = truncate(this.responseText);
            responseBody = t.body; responseSize = t.size; truncated = t.truncated;
          } else if (this.responseType === 'json') {
            try {
              const t = truncate(JSON.stringify(this.response));
              responseBody = t.body; responseSize = t.size; truncated = t.truncated;
            } catch {}
          } else {
            responseBody = `[${this.responseType} response]`;
          }

          const responseHeaders = {};
          const raw = (this.getAllResponseHeaders && this.getAllResponseHeaders()) || '';
          raw.trim().split(/[\r\n]+/).forEach((line) => {
            const i = line.indexOf(': ');
            if (i > 0) responseHeaders[line.slice(0, i)] = line.slice(i + 2);
          });

          enqueue({
            id,
            kind: 'xhr',
            method: meta.method,
            url: meta.url,
            status: this.status,
            statusText: this.statusText,
            startedAt: meta.startedAt,
            duration,
            requestHeaders: meta.requestHeaders,
            requestBody: meta.requestBody,
            responseHeaders,
            responseBody,
            responseSize,
            truncated,
            contentType: ct,
            failed: this.status === 0,
          });
        } catch {}
      });
    }
    return origSend.apply(this, arguments);
  };
})();
