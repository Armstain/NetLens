
(() => {
  if (window.__netlens_installed) return;
  window.__netlens_installed = true;

  const MAX_BODY = 200 * 1024; // 200KB cap per body
  const FLUSH_MS = 100;
  // A page can fire thousands of requests inside one flush window. Sending
  // them as a single postMessage means structured-cloning every body at once,
  // and `push(...batch)` on the receiving side would also risk blowing the
  // argument limit. Flushing early bounds both without dropping captures.
  const MAX_BATCH = 400;

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
    if (queue.length >= MAX_BATCH) {
      if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
      flush();
      return;
    }
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
  // Sliding one-second window shared by anything that can fire faster than
  // it's worth capturing: reset-and-warn on window flip, increment-and-check
  // per call. Console logs and socket frames both need one; this is that
  // logic written once.
  function makeRateLimiter(limit, label) {
    let windowStart = now();
    let count = 0;
    let dropped = 0;
    return function allowed() {
      const t = now();
      if (t - windowStart > 1000) {
        if (dropped > 0) {
          enqueue({ id: ++seq, kind: 'log', level: 'warn', message: `NetLens: ${dropped} ${label} dropped (rate limit)`, args: [], startedAt: Date.now() });
        }
        windowStart = t;
        count = 0;
        dropped = 0;
      }
      count++;
      if (count > limit) { dropped++; return false; }
      return true;
    };
  }

  const logAllowed = makeRateLimiter(50, 'log(s)');

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
    if (!logAllowed()) return;

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
    let reqBodyTruncated = false;
    // Replay is only faithful if these travel with the entry. A request whose
    // credentials/mode are guessed at replay time either loses its cookies or
    // gets blocked by CORS, and either way the replay is not the request.
    let credentials = null;
    let mode = null;
    let redirect = null;

    try {
      if (typeof Request !== 'undefined' && input instanceof Request) {
        method = input.method || 'GET';
        url = input.url;
        input.headers.forEach((v, k) => { reqHeaders[k] = v; });
        credentials = input.credentials || null;
        mode = input.mode || null;
        redirect = input.redirect || null;
      } else {
        url = String(input);
      }
      if (init) {
        if (init.method) method = init.method;
        if (init.headers) {
          try { new Headers(init.headers).forEach((v, k) => { reqHeaders[k] = v; }); } catch {}
        }
        if ('body' in init) {
          reqBody = serializeRequestBody(init.body);
          reqBodyTruncated = typeof init.body === 'string' && init.body.length > MAX_BODY;
        }
        if (init.credentials) credentials = init.credentials;
        if (init.mode) mode = init.mode;
        if (init.redirect) redirect = init.redirect;
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
              requestBodyTruncated: reqBodyTruncated,
              credentials,
              mode,
              redirect,
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
          requestBodyTruncated: reqBodyTruncated,
          credentials,
          mode,
          redirect,
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
      meta.id = ++seq;
      meta.start = now();
      meta.startedAt = Date.now();
      meta.requestBody = serializeRequestBody(body);
      meta.requestBodyTruncated = typeof body === 'string' && body.length > MAX_BODY;
      meta.credentials = this.withCredentials ? 'include' : 'same-origin';

      // Bind loadend exactly once per XHR instance. A reused XHR (open+send
      // called again on the same object — some hand-rolled wrappers and
      // polling code do this) would otherwise stack a new listener on every
      // send(), each closing over that call's now-stale `meta`. All of them
      // fire on the NEXT loadend, so a later request's live response data
      // (this.status, this.responseText, ...) gets enqueued paired with an
      // earlier request's method/url/headers — not just a duplicate row, a
      // wrong one. Reading `this.__netlens` fresh at fire time instead of
      // closing over `meta` keeps a single listener always correctly paired.
      if (!this.__netlensBound) {
        this.__netlensBound = true;
        this.addEventListener('loadend', () => {
          const m = this.__netlens;
          if (!m) return;
          try {
            const duration = now() - m.start;
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
              id: m.id,
              kind: 'xhr',
              method: m.method,
              url: m.url,
              status: this.status,
              statusText: this.statusText,
              startedAt: m.startedAt,
              duration,
              requestHeaders: m.requestHeaders,
              requestBody: m.requestBody,
              requestBodyTruncated: m.requestBodyTruncated,
              credentials: m.credentials,
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
    }
    return origSend.apply(this, arguments);
  };


  // ------------------------------------------------------- websocket / sse
  // Frames are small and numerous where bodies are large and rare, so they get
  // their own, much tighter cap.
  const MAX_FRAME = 8 * 1024;
  let wsSeq = 0;

  // A game or trading feed can push hundreds of frames a second. Capturing all
  // of them would make NetLens the performance problem it exists to find.
  const frameAllowed = makeRateLimiter(60, 'socket frame(s)');

  // Reading a Blob back is asynchronous and would cost more than the capture is
  // worth at frame rates, so binary payloads are recorded by size alone.
  function serializeFrame(data) {
    try {
      if (typeof data === 'string') {
        const size = data.length;
        if (size > MAX_FRAME) return { data: data.slice(0, MAX_FRAME), size, truncated: true, binary: false };
        return { data, size, truncated: false, binary: false };
      }
      if (typeof Blob !== 'undefined' && data instanceof Blob) {
        return { data: `[Blob ${data.size} bytes]`, size: data.size, truncated: false, binary: true };
      }
      if (data instanceof ArrayBuffer) {
        return { data: `[Binary ${data.byteLength} bytes]`, size: data.byteLength, truncated: false, binary: true };
      }
      if (ArrayBuffer.isView(data)) {
        return { data: `[Binary ${data.byteLength} bytes]`, size: data.byteLength, truncated: false, binary: true };
      }
      if (data == null) return { data: '', size: 0, truncated: false, binary: false };
      return { data: String(data), size: 0, truncated: false, binary: false };
    } catch {
      return { data: '[unreadable frame]', size: 0, truncated: false, binary: false };
    }
  }

  function emitFrame(wsId, transport, url, dir, data, eventName) {
    if (!wsId || !frameAllowed()) return;
    const f = serializeFrame(data);
    enqueue({
      id: ++seq,
      kind: 'wsframe',
      wsId,
      transport,
      url,
      dir,
      eventName: eventName || null,
      data: f.data,
      size: f.size,
      truncated: f.truncated,
      binary: f.binary,
      startedAt: Date.now(),
    });
  }

  function emitSocket(wsId, transport, url, event, extra) {
    enqueue(Object.assign({
      id: ++seq,
      kind: 'ws',
      wsId,
      transport,
      url,
      event,
      startedAt: Date.now(),
    }, extra));
  }

  const OrigWebSocket = window.WebSocket;
  if (typeof OrigWebSocket === 'function') {
    // Subclassing rather than proxying keeps `instanceof WebSocket` true and
    // inherits the READY_STATE constants through the prototype chain, both of
    // which real code checks.
    class NetLensWebSocket extends OrigWebSocket {
      constructor(url, protocols) {
        super(url, protocols);
        const wsId = `ws${++wsSeq}`;
        const absolute = absolutize(url);
        this.__netlensId = wsId;
        this.__netlensUrl = absolute;
        const started = now();

        emitSocket(wsId, 'ws', absolute, 'connecting');
        this.addEventListener('open', () => {
          emitSocket(wsId, 'ws', absolute, 'open', { duration: now() - started });
        });
        this.addEventListener('message', (e) => emitFrame(wsId, 'ws', absolute, 'recv', e.data));
        this.addEventListener('close', (e) => {
          emitSocket(wsId, 'ws', absolute, 'close', {
            code: e.code,
            reason: e.reason,
            wasClean: e.wasClean,
            duration: now() - started,
          });
        });
        this.addEventListener('error', () => emitSocket(wsId, 'ws', absolute, 'error'));
      }

      send(data) {
        try { emitFrame(this.__netlensId, 'ws', this.__netlensUrl, 'send', data); } catch {}
        return super.send(data);
      }
    }
    window.WebSocket = NetLensWebSocket;
  }

  const OrigEventSource = window.EventSource;
  if (typeof OrigEventSource === 'function') {
    class NetLensEventSource extends OrigEventSource {
      constructor(url, config) {
        super(url, config);
        const wsId = `sse${++wsSeq}`;
        const absolute = absolutize(url);
        // Set before any addEventListener call below, because the override
        // reads it.
        this.__netlensSeen = new Set();
        this.__netlensId = wsId;
        this.__netlensUrl = absolute;
        const started = now();

        emitSocket(wsId, 'sse', absolute, 'connecting');
        this.addEventListener('open', () => {
          emitSocket(wsId, 'sse', absolute, 'open', { duration: now() - started });
        });
        this.addEventListener('message', (e) => emitFrame(wsId, 'sse', absolute, 'recv', e.data));
        this.addEventListener('error', () => emitSocket(wsId, 'sse', absolute, 'error'));
      }

      // Servers routinely send named events, and those never reach a 'message'
      // listener. There is no way to enumerate them, so shadow each type the
      // page itself subscribes to — once, however many listeners it adds.
      addEventListener(type, listener, options) {
        if (type !== 'message' && type !== 'open' && type !== 'error'
            && this.__netlensSeen && !this.__netlensSeen.has(type)) {
          this.__netlensSeen.add(type);
          super.addEventListener(type, (e) => {
            emitFrame(this.__netlensId, 'sse', this.__netlensUrl, 'recv', e.data, type);
          });
        }
        return super.addEventListener(type, listener, options);
      }

      close() {
        try { emitSocket(this.__netlensId, 'sse', this.__netlensUrl, 'close'); } catch {}
        return super.close();
      }
    }
    window.EventSource = NetLensEventSource;
  }

  // --------------------------------------------------------------- replay
  // The browser owns these header names and either rejects or silently drops
  // an attempt to set them, so a captured Cookie/Host/Origin cannot be sent
  // back verbatim. Cookies still travel on the replay — that is what
  // `credentials` is for, and setting the header by hand would not work.
  const FORBIDDEN_HEADERS = /^(accept-charset|accept-encoding|access-control-request-headers|access-control-request-method|connection|content-length|cookie|cookie2|date|dnt|expect|host|keep-alive|origin|referer|set-cookie|te|trailer|transfer-encoding|upgrade|via|proxy-|sec-)/i;

  function replayHeaders(headers) {
    const out = {};
    for (const k of Object.keys(headers || {})) {
      if (!FORBIDDEN_HEADERS.test(k)) out[k] = headers[k];
    }
    return out;
  }

  async function runReplay(req) {
    const start = now();
    const method = String(req.method || 'GET').toUpperCase();
    const init = { method, headers: replayHeaders(req.headers), cache: 'no-store' };
    if (req.credentials) init.credentials = req.credentials;
    if (req.mode) init.mode = req.mode;
    if (req.redirect) init.redirect = req.redirect;
    // fetch throws outright if a GET or HEAD carries a body.
    if (req.body != null && req.body !== '' && method !== 'GET' && method !== 'HEAD') {
      init.body = req.body;
    }

    // origFetch, not window.fetch: replaying through the patched copy would
    // file the replay as a fresh captured row and bury the original.
    const res = await origFetch(req.url, init);
    const ct = res.headers.get('content-type') || '';
    const responseHeaders = {};
    res.headers.forEach((v, k) => { responseHeaders[k] = v; });

    let responseBody = null;
    let responseSize = 0;
    let truncated = false;
    if (isReadableBody(ct)) {
      const t = truncate(await res.text());
      responseBody = t.body;
      responseSize = t.size;
      truncated = t.truncated;
    } else if (ct) {
      responseBody = `[${ct}]`;
    }

    return {
      ok: true,
      method,
      url: absolutize(req.url),
      status: res.status,
      statusText: res.statusText,
      duration: now() - start,
      requestHeaders: init.headers,
      requestBody: init.body == null ? null : init.body,
      responseHeaders,
      responseBody,
      responseSize,
      truncated,
      contentType: ct,
    };
  }

  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    const d = event.data;
    if (!d || d.__netlens_replay !== true) return;
    // The page can post this shape itself, but a replay grants it nothing it
    // could not already do with its own fetch and its own cookies. The panel
    // only renders results whose rid it issued.
    const rid = d.rid;
    const reply = (result) => {
      try { window.postMessage({ __netlens_replay_result: true, rid, result }, '*'); } catch {}
    };
    try {
      runReplay(d.req || {}).then(reply, (err) => reply({ ok: false, error: (err && err.message) || String(err) }));
    } catch (err) {
      reply({ ok: false, error: (err && err.message) || String(err) });
    }
  });
})();
