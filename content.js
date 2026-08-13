
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
      let local = {}, session = {};
      try { local = readStore(window.localStorage); } catch {}
      try { session = readStore(window.sessionStorage); } catch {}
      sendResponse({ local, session });
      return;
    }
  });
})();
