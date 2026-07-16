
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

    // Call through immediately — the page gets the untouched promise.
    const promise = origFetch.apply(this, arguments);

    promise.then(
      (res) => {
        // Everything below happens after the page already has its response.
        queueMicrotask(() => {
          try {
            const responseHeaders = {};
            res.headers.forEach((v, k) => { responseHeaders[k] = v; });
            const ct = res.headers.get('content-type') || '';
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
            if (READABLE_CT.test(ct)) {
              res.clone().text().then(
                (text) => {
                  const t = truncate(text);
                  enqueue({ ...base, responseBody: t.body, truncated: t.truncated, responseSize: t.size });
                },
                () => enqueue({ ...base, responseBody: null, responseSize: 0 })
              );
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
