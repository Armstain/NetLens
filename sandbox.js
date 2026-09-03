// Runs inside a manifest "sandbox" page: relaxed CSP allows eval/new Function
// here (MV3 blocks it everywhere else), but this context has zero access to
// chrome.* APIs, the embedding page's DOM, tabs, or extension storage.
//
// The actual eval still happens in a Worker, not directly on this page's
// thread — that's what makes an infinite loop in user code recoverable via
// Worker.terminate() instead of hanging this frame.

const WORKER_SRC =
  "self.onmessage=function(e){" +
  "try{const fn=new Function('input',e.data.code);const r=fn(e.data.input);self.postMessage({ok:true,result:r});}" +
  "catch(err){self.postMessage({ok:false,error:String(err&&err.message||err)});}" +
  "};";

const pending = new Map(); // reqId -> { worker, timer, replyTo }

window.addEventListener('message', (event) => {
  const data = event.data;
  if (!data || data.__netlensSandbox !== true || data.op !== 'run') return;
  const { reqId, code, input, timeoutMs } = data;
  const replyTo = event.source;

  const reply = (payload) => {
    const entry = pending.get(reqId);
    if (entry) { clearTimeout(entry.timer); entry.worker.terminate(); pending.delete(reqId); }
    try { replyTo.postMessage({ __netlensSandbox: true, reqId, ...payload }, event.origin === 'null' ? '*' : event.origin); } catch {}
  };

  let worker;
  try {
    const blob = new Blob([WORKER_SRC], { type: 'application/javascript' });
    worker = new Worker(URL.createObjectURL(blob));
  } catch (e) {
    reply({ ok: false, error: String(e && e.message || e) });
    return;
  }

  const timer = setTimeout(() => {
    reply({ ok: false, error: 'Timed out (possible infinite loop)' });
  }, timeoutMs || 1000);

  pending.set(reqId, { worker, timer, replyTo });

  worker.onmessage = (e) => reply(e.data && e.data.ok ? { ok: true, result: e.data.result } : { ok: false, error: (e.data && e.data.error) || 'Unknown error' });
  worker.onerror = (e) => reply({ ok: false, error: e.message || 'Worker error' });
  worker.postMessage({ code, input });
});
