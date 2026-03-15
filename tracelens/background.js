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

// Open the side panel when the toolbar icon is clicked
chrome.action.onClicked.addListener((tab) => {
  chrome.sidePanel.open({ tabId: tab.id });
});

// Enable side panel on install and set it to open on action click
chrome.runtime.onInstalled?.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
});
