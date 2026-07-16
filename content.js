
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
  });
})();
