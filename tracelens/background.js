// TraceLens service worker — Manifest V3
// Relays captured entries from DevTools panel to the side panel.

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'tracelens-entry' || msg.type === 'tracelens-clear') {
    // Forward to all other contexts (side panel)
    chrome.runtime.sendMessage(msg).catch(() => {
      // Side panel may not be open — ignore
    });
  }
});

// Enable side panel on install
chrome.runtime.onInstalled?.addListener(() => {
  if (chrome.sidePanel?.setOptions) {
    chrome.sidePanel.setOptions({ enabled: true });
  }
});
