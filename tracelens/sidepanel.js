/* ============================================================
   TraceLens — Side Panel
   Mirrors captured requests from the DevTools panel
   ============================================================ */

const $body = document.getElementById('sp-body');
let entries = [];

function formatDur(ms) {
  if (ms == null) return '—';
  if (ms < 1000) return Math.round(ms) + 'ms';
  return (ms / 1000).toFixed(2) + 's';
}

function escapeHtml(s) {
  const div = document.createElement('div');
  div.textContent = s;
  return div.innerHTML;
}

function getStatusClass(status) {
  if (status >= 500) return 'status-5xx';
  if (status >= 400) return 'status-4xx';
  if (status >= 300) return 'status-3xx';
  return 'status-2xx';
}

function getMethodClass(method) {
  return 'method-' + method.toLowerCase().replace(/[^a-z]/g, '');
}

function render() {
  if (entries.length === 0) {
    $body.innerHTML = '<div class="sp-empty">Open DevTools to start capturing requests. The side panel mirrors captured traffic in real-time.</div>';
    return;
  }

  $body.innerHTML = entries.slice().reverse().map(e => {
    let path;
    try { path = new URL(e.url).pathname; } catch(x) { path = e.url; }
    return `<div class="sp-entry">
      <div>
        <span class="sp-method ${getMethodClass(e.method)}">${escapeHtml(e.method)}</span>
        <span class="sp-path">${escapeHtml(path)}</span>
      </div>
      <div class="sp-meta">
        <span class="sp-status ${getStatusClass(e.status)}">${e.status}</span>
        <span>${formatDur(e.dur)}</span>
        <span>${new Date(e.timestamp).toLocaleTimeString()}</span>
      </div>
    </div>`;
  }).join('');
}

// Listen for messages from the background service worker
if (typeof chrome !== 'undefined' && chrome.runtime) {
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === 'tracelens-entry') {
      entries.push(msg.entry);
      render();
    } else if (msg.type === 'tracelens-clear') {
      entries = [];
      render();
    }
  });
}
