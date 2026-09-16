chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: true })
  .catch(() => {});

// A page's cross-origin stylesheets are unreadable from the content script
// (touching .cssRules throws SecurityError), so fetch them here where
// host_permissions applies, and let the content script re-parse the text.
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.type !== 'netlens:fetchCss' || !msg.url) return;
  fetch(msg.url, { credentials: 'omit' })
    .then((res) => (res.ok ? res.text() : Promise.reject(new Error(`HTTP ${res.status}`))))
    .then((text) => sendResponse({ text }))
    .catch((err) => sendResponse({ error: String(err && err.message || err) }));
  return true;
});
