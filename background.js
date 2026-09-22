chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: true })
  .catch(() => {});

// A page's cross-origin stylesheets are unreadable from the content script
// (touching .cssRules throws SecurityError), so fetch them here where
// host_permissions applies, and let the content script re-parse the text.
// A toast's "Locate" click reaches here relayed through content.js's message,
// so it may not carry a live user gesture by the time it does — best effort,
// not guaranteed by Chrome to succeed.
chrome.runtime.onMessage.addListener((msg, sender) => {
  if (!msg || msg.type !== 'netlens:openPanel' || !sender.tab) return;
  chrome.sidePanel.open({ tabId: sender.tab.id }).catch(() => {});
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.type !== 'netlens:fetchCss' || !msg.url) return;
  fetch(msg.url, { credentials: 'omit' })
    .then((res) => (res.ok ? res.text() : Promise.reject(new Error(`HTTP ${res.status}`))))
    .then((text) => sendResponse({ text }))
    .catch((err) => sendResponse({ error: String(err && err.message || err) }));
  return true;
});

chrome.commands.onCommand.addListener((command, tab) => {
  const tabId = tab && tab.id;
  if (!tabId) return;
  const type = command === 'pick-reveal' ? 'netlens:reveal:start' : (command === 'pick-inspect' ? 'netlens:inspect:start' : null);
  if (!type) return;

  chrome.tabs.sendMessage(tabId, { type }, () => {
    if (chrome.runtime.lastError) {
      chrome.scripting.executeScript({
        target: { tabId },
        files: ['css-format.js', 'net-format.js', 'decoders.js', 'provenance.js', 'content.js']
      }, () => {
        if (!chrome.runtime.lastError) chrome.tabs.sendMessage(tabId, { type }).catch(() => {});
      });
    }
  });
});

