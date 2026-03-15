/* ============================================================
   TraceLens v2.0 — panel.js
   Core data capture, analysis engine, and UI controller
   ============================================================ */

// --------------- State ---------------
let allEntries = [];
let bursts = [];
let currentPageUrl = '';
let capturing = true;
let selectedEntry = null;
let selectedIdx = -1;
let filteredEntries = [];
let bookmarks = new Map(); // timestamp -> label
let tokenInterval = null;

// Settings
let THRESH = 800;
let API_ONLY = true;
let GQL_NAMES = true;
let CASCADE_ENABLED = true;
let TOKEN_COUNTDOWN = true;
let THEME = 'dark';
let DOMAIN_GROUPING = false;
let BASELINE_ENABLED = false;
let BASELINE_PCT = 50;
let performanceBaseline = {}; // path -> { avg, count }
let annotations = {}; // entryId -> note text
let collapsedDomains = new Set();
let wsEntries = []; // WebSocket frames

const BURST_GAP = 800;

// --------------- Utilities ---------------
function generateId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

function formatSize(bytes) {
  if (bytes == null || bytes < 0) return '—';
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1048576) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / 1048576).toFixed(2) + ' MB';
}

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

function shellEscape(s) {
  return s.replace(/'/g, "'\\''");
}

// --------------- Status Codes ---------------
const STATUS_CODES = {
  200: 'OK — request succeeded',
  201: 'Created — resource was created',
  204: 'No Content — success with no response body',
  301: 'Moved Permanently — resource has a new URL',
  304: 'Not Modified — cached version is still valid',
  400: 'Bad Request — malformed syntax or invalid params',
  401: 'Unauthorized — valid credentials required',
  403: 'Forbidden — credentials valid but access denied',
  404: 'Not Found — resource does not exist',
  409: 'Conflict — request conflicts with current state',
  422: 'Unprocessable — validation failed on request body',
  429: 'Too Many Requests — rate limit exceeded',
  500: 'Internal Server Error — unexpected server failure',
  502: 'Bad Gateway — upstream server returned invalid response',
  503: 'Service Unavailable — server temporarily overloaded',
  504: 'Gateway Timeout — upstream server did not respond in time',
};

// --------------- Filtering ---------------
function isApiCall(entry) {
  const apiMimes = ['application/json', 'text/csv', 'application/xml', 'text/plain'];
  const url = entry.url.toLowerCase();
  if (url.match(/\.(png|jpg|jpeg|gif|svg|ico|woff|woff2|ttf|css|js|map)(\?|$)/)) return false;
  if (url.includes('google-analytics') || url.includes('hotjar') || url.includes('segment')) return false;
  return apiMimes.some(m => entry.mimeType?.includes(m)) ||
    entry.method === 'POST' || entry.method === 'PUT' ||
    entry.method === 'DELETE' || entry.method === 'PATCH';
}

// --------------- GraphQL ---------------
function isGraphQL(entry) {
  return entry.path?.includes('/graphql') ||
    (entry.reqHeaders?.find(h => h.name === 'content-type' && h.value?.includes('application/json')) &&
     entry.reqBody?.includes('operationName'));
}

function getDisplayName(entry) {
  if (GQL_NAMES && isGraphQL(entry)) {
    try {
      const body = JSON.parse(entry.reqBody);
      if (body.operationName) return body.operationName;
      if (body.query) {
        const match = body.query.match(/(query|mutation|subscription)\s+(\w+)/);
        if (match) return match[2];
      }
    } catch (e) { /* not JSON */ }
  }
  return entry.path;
}

function getMethodLabel(entry) {
  if (isGraphQL(entry)) {
    try {
      const body = JSON.parse(entry.reqBody);
      if (body.query?.trimStart().startsWith('mutation')) return 'MUT';
      if (body.query?.trimStart().startsWith('subscription')) return 'SUB';
    } catch (e) { /* ignore */ }
    return 'GQL';
  }
  return entry.method;
}

// --------------- Auth / JWT ---------------
function extractAuth(entry) {
  const authHeader = entry.reqHeaders?.find(h => h.name.toLowerCase() === 'authorization');
  if (!authHeader) return null;
  const token = authHeader.value.replace('Bearer ', '');
  try {
    const payload = JSON.parse(atob(token.split('.')[1]));
    const now = Date.now() / 1000;
    const minsLeft = payload.exp ? Math.max(0, (payload.exp - now) / 60) : null;
    return {
      raw: token,
      alg: (() => { try { return JSON.parse(atob(token.split('.')[0])).alg || '—'; } catch(e) { return '—'; } })(),
      sub: payload.sub || payload.user_id || payload.userId || '—',
      email: payload.email || '—',
      role: payload.role || payload.roles?.[0] || '—',
      iat: payload.iat ? new Date(payload.iat * 1000).toLocaleTimeString() : '—',
      exp: payload.exp ? new Date(payload.exp * 1000).toLocaleTimeString() : '—',
      expRaw: payload.exp || null,
      ok: payload.exp ? now < payload.exp : true,
      minsLeft,
    };
  } catch (e) {
    return { raw: token, ok: true, minsLeft: null, alg: '—', sub: '—', email: '—', role: '—', iat: '—', exp: '—', expRaw: null };
  }
}

// --------------- Burst Grouping ---------------
function addToBurst(entry) {
  const last = bursts[bursts.length - 1];
  if (last && entry.timestamp - last.lastTimestamp < BURST_GAP) {
    last.requests.push(entry);
    last.lastTimestamp = entry.timestamp;
  } else {
    bursts.push({
      id: generateId(),
      startTime: entry.timestamp,
      lastTimestamp: entry.timestamp,
      pageUrl: currentPageUrl,
      requests: [entry],
    });
  }
}

// --------------- Detection ---------------
function detectRetry(entry) {
  return allEntries.filter(e =>
    e.id !== entry.id &&
    e.method === entry.method &&
    e.path === entry.path &&
    Math.abs(e.timestamp - entry.timestamp) < 5000
  ).length > 0;
}

function detectCascade(entries, thresh) {
  let maxRun = 0, runLen = 0;
  entries.forEach(e => {
    if (e.dur >= thresh) { runLen++; maxRun = Math.max(maxRun, runLen); }
    else runLen = 0;
  });
  return maxRun >= 3;
}

// --------------- Diagnosis Engine ---------------
function diagnose(entry) {
  const { dur, status, timings, size } = entry;
  const auth = entry._auth;
  const hasAuth = !!auth;
  const wait = timings?.wait || 0;
  const dns = timings?.dns || 0;
  const ssl = timings?.ssl || 0;
  const dl = timings?.receive || 0;

  if (entry._isRetry)
    return 'Retry detected — same endpoint fired again within 5s. Look at the original request for the root cause.';

  if (status === 401 && !hasAuth)
    return '401 with no Authorization header sent. The client never attached credentials — check session/cookie state.';

  if (status === 401 && auth && !auth.ok)
    return `401 with an expired JWT. Token expired at ${auth.exp}. Refresh the token and replay.`;

  if (status === 403)
    return `403 Forbidden — credentials accepted but this token lacks the required scope or role. Check the token's role claim: "${auth?.role || '—'}".`;

  if (status === 422)
    return '422 Unprocessable — server rejected the request body due to validation errors. Check the response body for which fields failed.';

  if (status === 429)
    return '429 Rate limited. Too many requests sent too fast. Implement exponential backoff and check Retry-After header.';

  if (status === 500 && dur > 5000)
    return `500 after ${Math.round(dur)}ms — upstream service timeout. The server waited for a dependency that never responded. Not a client-side bug.`;

  if (status === 504)
    return '504 Gateway Timeout — a proxy gave up waiting for the origin server. Infrastructure issue, not application code.';

  if (wait > dur * 0.85 && dur > THRESH)
    return `Server wait dominates at ${Math.round(wait)}ms (${Math.round(wait / dur * 100)}% of total). Likely a slow DB query, missing index, or N+1 resolver.`;

  if (dns > 200)
    return `DNS resolution took ${Math.round(dns)}ms — unusually slow. Possible cold DNS cache or network misconfiguration.`;

  if (ssl > 300)
    return `SSL handshake took ${Math.round(ssl)}ms. Possible certificate chain issue or TLS version negotiation overhead.`;

  if (dl > dur * 0.7 && dur > THRESH)
    return `Download phase dominates — payload is large (${formatSize(size)}). Consider pagination, field filtering, or compression.`;

  if (status >= 200 && status < 300 && dur < THRESH)
    return `Clean request — ${Math.round(dur)}ms response, no anomalies detected.`;

  return `${status} response in ${Math.round(dur)}ms. No specific pattern matched — inspect response body for details.`;
}

// --------------- Export ---------------
function exportHAR(entries) {
  const har = {
    log: {
      version: '1.2',
      creator: { name: 'TraceLens', version: '2.0' },
      entries: entries.map(e => ({
        startedDateTime: new Date(e.timestamp).toISOString(),
        time: e.dur,
        request: {
          method: e.method,
          url: e.url,
          headers: e.reqHeaders,
          postData: e.reqBody ? { text: e.reqBody } : undefined,
        },
        response: {
          status: e.status,
          headers: e.resHeaders,
          content: { text: e.resBody, mimeType: e.mimeType },
        },
        timings: {
          dns: e.timings?.dns || 0,
          connect: e.timings?.connect || 0,
          ssl: e.timings?.ssl || 0,
          send: e.timings?.send || 0,
          wait: e.timings?.wait || 0,
          receive: e.timings?.receive || 0,
        }
      }))
    }
  };
  downloadJSON(har, `tracelens-${Date.now()}.har`);
}

function exportTraceLens(entry) {
  const snapshot = {
    version: '2.0',
    exportedAt: new Date().toISOString(),
    entry: entry,
    diagnosis: diagnose(entry),
    burst: bursts.find(b => b.requests.some(r => r.id === entry.id)),
  };
  downloadJSON(snapshot, `tracelens-${entry.method}-${entry.status}-${Date.now()}.tracelens`);
}

function downloadJSON(obj, filename) {
  const blob = new Blob([JSON.stringify(obj, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

// --------------- Replay Generators ---------------
function toCurl(entry) {
  let cmd = `curl -X ${shellEscape(entry.method)} '${shellEscape(entry.url)}'`;
  entry.reqHeaders?.forEach(h => {
    cmd += ` \\\n  -H '${shellEscape(h.name)}: ${shellEscape(h.value)}'`;
  });
  if (entry.reqBody) {
    cmd += ` \\\n  -d '${shellEscape(entry.reqBody)}'`;
  }
  return cmd;
}

function toFetch(entry) {
  const opts = { method: entry.method, headers: {} };
  entry.reqHeaders?.forEach(h => { opts.headers[h.name] = h.value; });
  if (entry.reqBody) opts.body = entry.reqBody;
  return `fetch(${JSON.stringify(entry.url)}, ${JSON.stringify(opts, null, 2)})
  .then(r => r.json())
  .then(console.log)
  .catch(console.error);`;
}

function toPostman(entry) {
  const item = {
    info: { name: 'TraceLens Export', schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json' },
    item: [{
      name: getDisplayName(entry),
      request: {
        method: entry.method,
        header: entry.reqHeaders?.map(h => ({ key: h.name, value: h.value })) || [],
        url: { raw: entry.url },
        body: entry.reqBody ? { mode: 'raw', raw: entry.reqBody } : undefined,
      }
    }]
  };
  return JSON.stringify(item, null, 2);
}

// --------------- Report Generator ---------------
function generateReport(entry) {
  const burst = bursts.find(b => b.requests.some(r => r.id === entry.id));
  const auth = entry._auth;
  const traceId = entry.resHeaders?.find(h => h.name.toLowerCase().match(/x-trace-id|x-request-id|traceparent/))?.value || '—';

  return `INCIDENT REPORT — TraceLens
================================
Environment: ${new URL(entry.url).hostname}
Page: ${burst?.pageUrl || currentPageUrl || '—'}
Action: ${burst ? new Date(burst.startTime).toLocaleTimeString() + ' burst (' + burst.requests.length + ' requests)' : '—'}

Endpoint: ${entry.method} ${entry.url}
Status: ${entry.status} ${STATUS_CODES[entry.status] || ''}
Duration: ${formatDur(entry.dur)}
Size: ${formatSize(entry.size)}
Trace ID: ${traceId}

Auth Status: ${auth ? (auth.ok ? 'Valid' : 'EXPIRED') : 'None'}
${auth ? `  Sub: ${auth.sub}\n  Email: ${auth.email}\n  Role: ${auth.role}` : ''}

Diagnosis: ${diagnose(entry)}

Captured: ${new Date(entry.timestamp).toLocaleString()}
Exported via TraceLens v2.0`;
}

// --------------- Settings Persistence ---------------
function loadSettings() {
  if (typeof chrome !== 'undefined' && chrome.storage?.local) {
    chrome.storage.local.get(['thresh', 'apiOnly', 'gqlNames', 'cascade', 'tokenCountdown', 'theme', 'baselineEnabled', 'baselinePct', 'performanceBaseline', 'annotations'], (s) => {
      THRESH = s.thresh || 800;
      API_ONLY = s.apiOnly !== false;
      GQL_NAMES = s.gqlNames !== false;
      CASCADE_ENABLED = s.cascade !== false;
      TOKEN_COUNTDOWN = s.tokenCountdown !== false;
      THEME = s.theme || 'dark';
      BASELINE_ENABLED = !!s.baselineEnabled;
      BASELINE_PCT = s.baselinePct || 50;
      performanceBaseline = s.performanceBaseline || {};
      annotations = s.annotations || {};
      applyTheme();
      applySettingsToUI();
    });
  }
}

// --------------- Theme Toggle ---------------
function applyTheme() {
  document.body.classList.toggle('theme-light', THEME === 'light');
  const icon = document.getElementById('theme-icon');
  if (icon) {
    icon.innerHTML = THEME === 'light'
      ? '<path d="M8 12a4 4 0 110-8 4 4 0 010 8zM8 0a1 1 0 011 1v1a1 1 0 01-2 0V1a1 1 0 011-1z" fill="currentColor"/>'
      : '<circle cx="8" cy="8" r="3.5" stroke="currentColor" stroke-width="1.2"/><path d="M8 1.5v2M8 12.5v2M1.5 8h2M12.5 8h2M3.4 3.4l1.4 1.4M11.2 11.2l1.4 1.4M3.4 12.6l1.4-1.4M11.2 4.8l1.4-1.4" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/>';
  }
}

function toggleTheme() {
  THEME = THEME === 'dark' ? 'light' : 'dark';
  applyTheme();
  saveSetting('theme', THEME);
}

function saveSetting(key, val) {
  if (typeof chrome !== 'undefined' && chrome.storage?.local) {
    chrome.storage.local.set({ [key]: val });
  }
}

// --------------- Request Processing ---------------
function addRequest(entry) {
  entry._auth = extractAuth(entry);
  entry._isRetry = detectRetry(entry);
  entry._displayName = getDisplayName(entry);
  entry._methodLabel = getMethodLabel(entry);
  entry._isGraphQL = isGraphQL(entry);
  captureWebSocketUpgrade(entry);

  allEntries.push(entry);
  addToBurst(entry);

  // Relay to side panel via background
  if (typeof chrome !== 'undefined' && chrome.runtime) {
    chrome.runtime.sendMessage({
      type: 'tracelens-entry',
      entry: { url: entry.url, method: entry.method, status: entry.status, dur: entry.dur, timestamp: entry.timestamp }
    }).catch(() => {});
  }

  if (capturing) {
    updateSummary();
    updateHeatmap();
    if (CASCADE_ENABLED && detectCascade(allEntries.slice(-10), THRESH)) {
      showCascadeAlert();
    }
    if (BASELINE_ENABLED) {
      checkPerformanceRegression(entry);
    }
    renderTimeline();
  }
}

// --------------- Page URL Tracking ---------------
function updatePageUrl() {
  if (typeof chrome !== 'undefined' && chrome.devtools?.inspectedWindow) {
    chrome.devtools.inspectedWindow.eval('window.location.href', (url) => {
      if (url) currentPageUrl = url;
    });
  }
}

// --------------- Network Capture ---------------
function startCapture() {
  if (typeof chrome !== 'undefined' && chrome.devtools?.network) {
    chrome.devtools.network.onRequestFinished.addListener(onRequestFinished);
    chrome.devtools.network.onNavigated?.addListener(() => { updatePageUrl(); });
  }
  updatePageUrl();
}

function onRequestFinished(request) {
  if (!capturing) return;
  request.getContent((body) => {
    let parsedUrl;
    try { parsedUrl = new URL(request.request.url); } catch (e) { return; }
    const entry = {
      id: generateId(),
      timestamp: Date.now(),
      method: request.request.method,
      url: request.request.url,
      path: parsedUrl.pathname + parsedUrl.search,
      status: request.response.status,
      dur: request.time,
      size: request.response.bodySize,
      mimeType: request.response.content?.mimeType || '',
      reqHeaders: request.request.headers || [],
      resHeaders: request.response.headers || [],
      reqBody: request.request.postData?.text || '',
      resBody: body || '',
      timings: request.timings,
      initiator: request._initiator,
      pageUrl: currentPageUrl,
    };

    if (API_ONLY && !isApiCall(entry)) return;
    addRequest(entry);
  });
}

// --------------- Performance Regression ---------------
function savePerformanceBaseline() {
  const baseline = {};
  allEntries.forEach(e => {
    if (!baseline[e.path]) baseline[e.path] = { total: 0, count: 0 };
    baseline[e.path].total += e.dur;
    baseline[e.path].count++;
  });
  Object.keys(baseline).forEach(k => {
    baseline[k].avg = baseline[k].total / baseline[k].count;
  });
  performanceBaseline = baseline;
  saveSetting('performanceBaseline', baseline);
}

function checkPerformanceRegression(entry) {
  const base = performanceBaseline[entry.path];
  if (!base) return;
  const threshold = base.avg * (1 + BASELINE_PCT / 100);
  if (entry.dur > threshold) {
    showPerfAlert(entry.path, base.avg, entry.dur);
  }
}

function showPerfAlert(path, baseline, actual) {
  const $alert = document.getElementById('perf-alert');
  const $text = document.getElementById('perf-alert-text');
  if (!$alert || !$text) return;
  const pct = Math.round(((actual - baseline) / baseline) * 100);
  $text.textContent = `Regression: ${path} took ${formatDur(actual)} vs baseline ${formatDur(baseline)} (+${pct}%)`;
  $alert.classList.add('visible');
  setTimeout(() => $alert.classList.remove('visible'), 10000);
}

// --------------- Import .tracelens Snapshots ---------------
function importTraceLensSnapshot(file) {
  const reader = new FileReader();
  reader.onload = (ev) => {
    try {
      const snapshot = JSON.parse(ev.target.result);
      if (snapshot.entry) {
        const entry = snapshot.entry;
        entry.id = entry.id || generateId();
        entry._auth = extractAuth(entry);
        entry._isRetry = false;
        entry._displayName = getDisplayName(entry);
        entry._methodLabel = getMethodLabel(entry);
        entry._isGraphQL = isGraphQL(entry);
        entry._imported = true;
        allEntries.push(entry);
        addToBurst(entry);
        updateSummary();
        renderTimeline();
      }
    } catch (e) {
      console.error('Failed to import .tracelens snapshot:', e);
    }
  };
  reader.readAsText(file);
}

// --------------- Annotations ---------------
function saveAnnotation(entryId, text) {
  if (text.trim()) {
    annotations[entryId] = text;
  } else {
    delete annotations[entryId];
  }
  saveSetting('annotations', annotations);
  renderTimeline();
}

// --------------- WebSocket Capture ---------------
function startWebSocketCapture() {
  if (typeof chrome === 'undefined' || !chrome.devtools?.network) return;
  // Chrome DevTools doesn't provide direct WebSocket frame API in network.onRequestFinished,
  // but we can capture WebSocket upgrade requests and mark them
}

function captureWebSocketUpgrade(entry) {
  if (entry.status === 101 || entry.url?.startsWith('ws://') || entry.url?.startsWith('wss://')) {
    entry._isWebSocket = true;
    entry._wsFrames = [];
  }
}

// ============================================================
//  UI RENDERING
// ============================================================

// Cache DOM elements
let $timeline, $summary, $heatmap, $drawer, $drawerContent,
    $searchInput, $cascadeAlert, $settingsPanel, $shortcutsOverlay,
    $captureBtn, $clearBtn, $liveDot, $gauge, $perfAlert;

function cacheDom() {
  $timeline = document.getElementById('timeline');
  $summary = document.getElementById('summary');
  $heatmap = document.getElementById('heatmap');
  $drawer = document.getElementById('drawer');
  $drawerContent = document.getElementById('drawer-content');
  $searchInput = document.getElementById('search-input');
  $cascadeAlert = document.getElementById('cascade-alert');
  $perfAlert = document.getElementById('perf-alert');
  $settingsPanel = document.getElementById('settings-panel');
  $shortcutsOverlay = document.getElementById('shortcuts-overlay');
  $captureBtn = document.getElementById('capture-btn');
  $clearBtn = document.getElementById('clear-btn');
  $liveDot = document.getElementById('live-dot');
  $gauge = document.getElementById('gauge');
}

// Active filters
let activeFilter = ''; // 'slow', 'errors', 'auth', ''
let activeMethodFilter = ''; // 'GET', 'POST', 'GQL', ''
let searchQuery = '';
let showBookmarksOnly = false;

function getFilteredEntries() {
  let entries = [...allEntries];

  if (activeFilter === 'slow') entries = entries.filter(e => e.dur >= THRESH);
  else if (activeFilter === 'errors') entries = entries.filter(e => e.status >= 400);
  else if (activeFilter === 'auth') entries = entries.filter(e => e._auth);

  if (activeMethodFilter === 'GET') entries = entries.filter(e => e.method === 'GET');
  else if (activeMethodFilter === 'POST') entries = entries.filter(e => e.method === 'POST');
  else if (activeMethodFilter === 'GQL') entries = entries.filter(e => e._isGraphQL);

  if (searchQuery) {
    const q = searchQuery.toLowerCase();
    entries = entries.filter(e =>
      e.url.toLowerCase().includes(q) ||
      e._displayName.toLowerCase().includes(q) ||
      String(e.status).includes(q) ||
      e.method.toLowerCase().includes(q)
    );
  }

  if (showBookmarksOnly) {
    const bkTimestamps = [...bookmarks.keys()];
    entries = entries.filter(e => bkTimestamps.some(t => Math.abs(e.timestamp - t) < 100));
  }

  filteredEntries = entries;
  return entries;
}

// --------------- Summary Strip ---------------
function updateSummary() {
  if (!$summary) return;
  const total = allEntries.length;
  const slow = allEntries.filter(e => e.dur >= THRESH).length;
  const errors = allEntries.filter(e => e.status >= 400).length;
  const authCount = allEntries.filter(e => e._auth).length;

  $summary.innerHTML = `
    <button class="summary-chip ${activeFilter === '' ? 'active' : ''}" data-filter="">
      <span class="chip-val">${total}</span><span class="chip-label">Total</span>
    </button>
    <button class="summary-chip chip-slow ${activeFilter === 'slow' ? 'active' : ''}" data-filter="slow">
      <span class="chip-val">${slow}</span><span class="chip-label">Slow</span>
    </button>
    <button class="summary-chip chip-errors ${activeFilter === 'errors' ? 'active' : ''}" data-filter="errors">
      <span class="chip-val">${errors}</span><span class="chip-label">Errors</span>
    </button>
    <button class="summary-chip chip-auth ${activeFilter === 'auth' ? 'active' : ''}" data-filter="auth">
      <span class="chip-val">${authCount}</span><span class="chip-label">Auth</span>
    </button>
  `;

  $summary.querySelectorAll('.summary-chip').forEach(btn => {
    btn.addEventListener('click', () => {
      activeFilter = activeFilter === btn.dataset.filter ? '' : btn.dataset.filter;
      updateSummary();
      renderTimeline();
    });
  });

  // Update gauge
  if ($gauge) {
    const errorRate = total > 0 ? errors / total : 0;
    const slowRate = total > 0 ? slow / total : 0;
    const health = Math.max(0, 100 - errorRate * 200 - slowRate * 100);
    $gauge.style.setProperty('--health', health + '%');
    $gauge.className = 'gauge ' + (health > 70 ? 'good' : health > 40 ? 'warn' : 'bad');
    $gauge.title = `Health: ${Math.round(health)}%`;
  }
}

// --------------- Activity Heatmap ---------------
function updateHeatmap() {
  if (!$heatmap) return;
  const now = Date.now();
  const window_ms = 60000; // last 60 seconds
  const buckets = 30;
  const bucketSize = window_ms / buckets;
  const counts = new Array(buckets).fill(0);

  allEntries.forEach(e => {
    const age = now - e.timestamp;
    if (age < window_ms) {
      const idx = Math.min(buckets - 1, Math.floor((window_ms - age) / bucketSize));
      counts[idx]++;
    }
  });

  const max = Math.max(1, ...counts);
  $heatmap.innerHTML = counts.map(c => {
    const h = Math.max(2, (c / max) * 20);
    const cls = c === 0 ? '' : c > max * 0.7 ? 'hot' : 'warm';
    return `<div class="heat-bar ${cls}" style="height:${h}px" title="${c} requests"></div>`;
  }).join('');
}

// --------------- Cascade Alert ---------------
function showCascadeAlert() {
  if (!$cascadeAlert) return;
  $cascadeAlert.classList.add('visible');
  setTimeout(() => $cascadeAlert.classList.remove('visible'), 8000);
}

// --------------- Timeline Rendering ---------------
function renderRequestRow(e, maxDur) {
  const statusClass = e.status >= 500 ? 'status-5xx' : e.status >= 400 ? 'status-4xx' : e.status >= 300 ? 'status-3xx' : 'status-2xx';
  const durClass = e.dur >= THRESH ? 'dur-slow' : e.dur >= THRESH * 0.6 ? 'dur-warn' : 'dur-ok';
  const edgeClass = e.status >= 400 ? 'edge-red' : e.dur >= THRESH ? 'edge-yellow' : 'edge-green';
  const barW = Math.min(100, (e.dur / maxDur) * 100);
  const selClass = selectedEntry?.id === e.id ? 'selected' : '';
  const hasNote = annotations[e.id];

  const authBadge = e._auth && TOKEN_COUNTDOWN
    ? `<span class="token-badge ${e._auth.ok ? 'token-ok' : 'token-expired'}">${e._auth.ok ? Math.round(e._auth.minsLeft || 0) + 'm' : 'EXP'}</span>`
    : '';

  const wsBadge = e._isWebSocket ? '<span class="ws-badge">WS</span>' : '';
  const noteDot = hasNote ? '<span class="note-indicator" title="Has note"></span>' : '';
  const importBadge = e._imported ? '<span class="ws-badge" style="background:rgba(232,160,32,0.15);color:var(--amber)">IMP</span>' : '';

  const pageHost = (() => { try { return new URL(e.pageUrl || e.url).hostname; } catch(x) { return ''; } })();

  return `<div class="req-row ${selClass}" data-id="${e.id}">
    <div class="req-edge ${edgeClass}"></div>
    <div class="req-method method-${e._methodLabel.toLowerCase().replace(/[^a-z]/g, '')}">${escapeHtml(e._methodLabel)}</div>
    <div class="req-path">${noteDot}${escapeHtml(e._displayName)}${authBadge}${wsBadge}${importBadge}</div>
    <div class="req-meta">
      <span class="req-status ${statusClass}" title="${STATUS_CODES[e.status] || ''}">${e.status}</span>
      <span class="req-page">${escapeHtml(pageHost)}</span>
    </div>
    <div class="req-dur ${durClass}">
      ${formatDur(e.dur)}
      <div class="dur-bar"><div class="dur-fill ${durClass}" style="width:${barW}%"></div></div>
    </div>
  </div>`;
}

function renderTimeline() {
  if (!$timeline) return;
  const entries = getFilteredEntries();
  const maxDur = Math.max(THRESH, ...entries.map(e => e.dur || 0));

  let html = '';

  if (DOMAIN_GROUPING) {
    // Group by domain
    const domainMap = new Map();
    entries.forEach(e => {
      let domain;
      try { domain = new URL(e.url).hostname; } catch(x) { domain = 'unknown'; }
      if (!domainMap.has(domain)) domainMap.set(domain, []);
      domainMap.get(domain).push(e);
    });

    domainMap.forEach((domainEntries, domain) => {
      const isCollapsed = collapsedDomains.has(domain);
      const slowCount = domainEntries.filter(e => e.dur >= THRESH).length;
      const errCount = domainEntries.filter(e => e.status >= 400).length;
      const avgDur = domainEntries.reduce((s, e) => s + (e.dur || 0), 0) / domainEntries.length;

      html += `<div class="domain-group-header" data-domain="${escapeHtml(domain)}">
        <span class="domain-group-toggle ${isCollapsed ? 'collapsed' : ''}">▼</span>
        <span class="domain-group-name">${escapeHtml(domain)}</span>
        <span class="domain-group-count">${domainEntries.length}</span>
        <div class="domain-group-stats">
          ${slowCount ? `<span class="domain-stat domain-stat-slow">${slowCount} slow</span>` : ''}
          ${errCount ? `<span class="domain-stat domain-stat-err">${errCount} err</span>` : ''}
          <span class="domain-stat domain-stat-avg">avg ${formatDur(avgDur)}</span>
        </div>
      </div>`;

      if (!isCollapsed) {
        domainEntries.forEach(e => {
          bookmarks.forEach((label, ts) => {
            if (Math.abs(e.timestamp - ts) < 100) {
              html += `<div class="bookmark-row"><span class="bookmark-label">${escapeHtml(label)}</span></div>`;
            }
          });
          html += renderRequestRow(e, maxDur);
        });
      }
    });
  } else {
    // Group by burst (original behavior)
    const burstMap = new Map();
    entries.forEach(e => {
      const burst = bursts.find(b => b.requests.some(r => r.id === e.id));
      const bId = burst ? burst.id : 'ungrouped';
      if (!burstMap.has(bId)) burstMap.set(bId, { burst, entries: [] });
      burstMap.get(bId).entries.push(e);
    });

    burstMap.forEach(({ burst, entries: bEntries }) => {
      if (burst) {
        const slowCount = bEntries.filter(e => e.dur >= THRESH).length;
        const errCount = bEntries.filter(e => e.status >= 400).length;
        const time = new Date(burst.startTime).toLocaleTimeString();
        html += `<div class="burst-header">
          <span class="burst-time">${time}</span>
          <span class="burst-label">${bEntries.length} requests</span>
          ${slowCount ? `<span class="burst-chip chip-slow">${slowCount} slow</span>` : ''}
          ${errCount ? `<span class="burst-chip chip-errors">${errCount} err</span>` : ''}
        </div>`;
      }

      bEntries.forEach(e => {
        bookmarks.forEach((label, ts) => {
          if (Math.abs(e.timestamp - ts) < 100) {
            html += `<div class="bookmark-row"><span class="bookmark-label">${escapeHtml(label)}</span></div>`;
          }
        });
        html += renderRequestRow(e, maxDur);
      });
    });
  }

  if (entries.length === 0) {
    html = `<div class="empty-state">
      <div class="empty-icon">◈</div>
      <div class="empty-title">No requests captured yet</div>
      <div class="empty-sub">Navigate to a page with the TraceLens panel open to start capturing network traffic.</div>
    </div>`;
  }

  $timeline.innerHTML = html;

  // Attach click handlers
  $timeline.querySelectorAll('.req-row').forEach(row => {
    row.addEventListener('click', () => {
      const id = row.dataset.id;
      const entry = allEntries.find(e => e.id === id);
      if (entry) openDrawer(entry);
    });
  });

  // Domain group collapse toggle
  $timeline.querySelectorAll('.domain-group-header').forEach(header => {
    header.addEventListener('click', () => {
      const domain = header.dataset.domain;
      if (collapsedDomains.has(domain)) collapsedDomains.delete(domain);
      else collapsedDomains.add(domain);
      renderTimeline();
    });
  });
}

// --------------- Drawer ---------------
let activeTab = 'overview';

function openDrawer(entry) {
  selectedEntry = entry;
  selectedIdx = filteredEntries.indexOf(entry);
  $drawer.classList.add('open');
  renderDrawer();
  renderTimeline(); // update selection highlight
}

function closeDrawer() {
  selectedEntry = null;
  selectedIdx = -1;
  $drawer.classList.remove('open');
  renderTimeline();
  if (tokenInterval) { clearInterval(tokenInterval); tokenInterval = null; }
}

function renderDrawer() {
  if (!selectedEntry || !$drawerContent) return;
  const e = selectedEntry;
  const baseTabs = ['overview', 'timing', 'token', 'replay', 'diff', 'report'];
  const tabs = e._isWebSocket ? ['overview', 'frames', 'replay', 'report'] : baseTabs;

  let html = `<div class="drawer-tabs">
    ${tabs.map(t => `<button class="drawer-tab ${activeTab === t ? 'active' : ''}" data-tab="${t}">${t.charAt(0).toUpperCase() + t.slice(1)}</button>`).join('')}
    <button class="drawer-close" id="drawer-close-btn">&times;</button>
  </div>
  <div class="drawer-body">`;

  if (activeTab === 'overview') html += renderOverviewTab(e);
  else if (activeTab === 'timing') html += renderTimingTab(e);
  else if (activeTab === 'token') html += renderTokenTab(e);
  else if (activeTab === 'replay') html += renderReplayTab(e);
  else if (activeTab === 'diff') html += renderDiffTab(e);
  else if (activeTab === 'report') html += renderReportTab(e);
  else if (activeTab === 'frames') html += renderFramesTab(e);

  html += '</div>';
  $drawerContent.innerHTML = html;

  // Tab click handlers
  $drawerContent.querySelectorAll('.drawer-tab').forEach(btn => {
    btn.addEventListener('click', () => {
      activeTab = btn.dataset.tab;
      renderDrawer();
    });
  });

  $drawerContent.querySelector('#drawer-close-btn')?.addEventListener('click', closeDrawer);

  // Copy button handlers
  $drawerContent.querySelectorAll('[data-copy]').forEach(btn => {
    btn.addEventListener('click', () => {
      const target = btn.dataset.copy;
      const el = document.getElementById(target);
      if (el) {
        navigator.clipboard.writeText(el.textContent).then(() => {
          btn.textContent = 'Copied!';
          setTimeout(() => { btn.textContent = 'Copy'; }, 1500);
        });
      }
    });
  });

  // Export button handlers
  $drawerContent.querySelector('#export-tracelens')?.addEventListener('click', () => exportTraceLens(e));
  $drawerContent.querySelector('#export-har')?.addEventListener('click', () => exportHAR(allEntries));
  $drawerContent.querySelector('#copy-report')?.addEventListener('click', () => {
    navigator.clipboard.writeText(generateReport(e)).then(() => {
      const btn = $drawerContent.querySelector('#copy-report');
      if (btn) { btn.textContent = 'Copied!'; setTimeout(() => { btn.textContent = 'Copy Incident Report'; }, 1500); }
    });
  });

  // Note textarea handler
  const noteInput = $drawerContent.querySelector('#note-input');
  if (noteInput) {
    let noteTimer;
    noteInput.addEventListener('input', () => {
      clearTimeout(noteTimer);
      noteTimer = setTimeout(() => saveAnnotation(e.id, noteInput.value), 500);
    });
  }

  // Start token countdown if on token tab
  if (activeTab === 'token' && e._auth?.expRaw) {
    startTokenCountdown(e._auth);
  }
}

function renderOverviewTab(e) {
  const burst = bursts.find(b => b.requests.some(r => r.id === e.id));
  const diag = diagnose(e);

  let bodyDisplay;
  if (!e.resBody) {
    bodyDisplay = '<span class="muted">— empty —</span>';
  } else if (e.mimeType?.includes('octet-stream') || e.mimeType?.includes('image/')) {
    bodyDisplay = '<span class="muted">— binary content —</span>';
  } else {
    try {
      const parsed = JSON.parse(e.resBody);
      bodyDisplay = `<pre class="json-body">${syntaxHighlight(JSON.stringify(parsed, null, 2))}</pre>`;
    } catch (err) {
      bodyDisplay = `<pre class="raw-body">${escapeHtml(e.resBody.substring(0, 5000))}</pre>`;
    }
  }

  return `
    <div class="ov-section">
      <div class="ov-url">${escapeHtml(e.url)}</div>
      <div class="ov-grid">
        <div class="ov-cell"><span class="ov-label">Method</span><span class="ov-val">${escapeHtml(e.method)}</span></div>
        <div class="ov-cell"><span class="ov-label">Status</span><span class="ov-val status-badge ${e.status >= 400 ? 'status-err' : 'status-ok'}" title="${STATUS_CODES[e.status] || ''}">${e.status}</span></div>
        <div class="ov-cell"><span class="ov-label">Duration</span><span class="ov-val">${formatDur(e.dur)}</span></div>
        <div class="ov-cell"><span class="ov-label">Size</span><span class="ov-val">${formatSize(e.size)}</span></div>
        <div class="ov-cell"><span class="ov-label">Content-Type</span><span class="ov-val">${escapeHtml(e.mimeType || '—')}</span></div>
        ${e._isGraphQL ? `<div class="ov-cell"><span class="ov-label">GraphQL Op</span><span class="ov-val">${escapeHtml(e._displayName)}</span></div>` : ''}
      </div>
    </div>
    <div class="ov-section">
      <div class="ov-heading">Context</div>
      <div class="ov-grid">
        <div class="ov-cell"><span class="ov-label">Page</span><span class="ov-val">${escapeHtml(e.pageUrl || currentPageUrl || '—')}</span></div>
        <div class="ov-cell"><span class="ov-label">Action</span><span class="ov-val">${burst ? new Date(burst.startTime).toLocaleTimeString() + ' (' + burst.requests.length + ' reqs)' : '—'}</span></div>
        <div class="ov-cell"><span class="ov-label">Captured</span><span class="ov-val">${new Date(e.timestamp).toLocaleTimeString()}</span></div>
      </div>
    </div>
    <div class="ov-section">
      <div class="ov-heading">Request Headers</div>
      <table class="headers-table"><tbody>
        ${(e.reqHeaders || []).map(h => `<tr><td class="h-name">${escapeHtml(h.name)}</td><td class="h-val">${escapeHtml(h.value)}</td></tr>`).join('')}
      </tbody></table>
    </div>
    <div class="ov-section">
      <div class="ov-heading">Response Headers</div>
      <table class="headers-table"><tbody>
        ${(e.resHeaders || []).map(h => `<tr><td class="h-name">${escapeHtml(h.name)}</td><td class="h-val">${escapeHtml(h.value)}</td></tr>`).join('')}
      </tbody></table>
    </div>
    <div class="ov-section">
      <div class="ov-heading">Response Body</div>
      <div class="body-viewer">${bodyDisplay}</div>
    </div>
    <div class="ov-section diagnosis-block">
      <div class="diag-label">◈ AI Diagnosis</div>
      <div class="diag-text">${escapeHtml(diag)}</div>
    </div>
    <div class="ov-section note-section">
      <div class="ov-heading">Notes</div>
      <textarea class="note-textarea" id="note-input" placeholder="Add a note about this request…">${escapeHtml(annotations[e.id] || '')}</textarea>
    </div>
  `;
}

function renderTimingTab(e) {
  const t = e.timings || {};
  const total = e.dur || 0;
  const stages = [
    { name: 'DNS', val: t.dns || 0, color: 'var(--blue)' },
    { name: 'TCP', val: t.connect || 0, color: 'var(--c8)' },
    { name: 'SSL', val: t.ssl || 0, color: 'var(--amber)' },
    { name: 'Server Wait', val: t.wait || 0, color: 'var(--red)' },
    { name: 'Download', val: t.receive || 0, color: 'var(--green)' },
    { name: 'Total', val: total, color: 'var(--cW)' },
  ];
  const maxVal = Math.max(1, ...stages.map(s => s.val));
  const slowest = stages.slice(0, 5).reduce((a, b) => a.val > b.val ? a : b);

  return `
    <div class="timing-waterfall">
      ${stages.map(s => {
        const pct = (s.val / maxVal) * 100;
        const isSlowest = s.name === slowest.name && s.name !== 'Total';
        return `<div class="timing-row ${isSlowest ? 'slowest' : ''}">
          <span class="timing-name">${s.name}</span>
          <div class="timing-bar-wrap">
            <div class="timing-bar" style="width:${pct}%;background:${s.color}"></div>
          </div>
          <span class="timing-val">${formatDur(s.val)}</span>
        </div>`;
      }).join('')}
    </div>
    <div class="ov-section diagnosis-block">
      <div class="diag-label">◈ AI Diagnosis</div>
      <div class="diag-text">${escapeHtml(diagnose(e))}</div>
    </div>
  `;
}

function renderTokenTab(e) {
  const auth = e._auth;
  if (!auth) return '<div class="empty-state"><div class="empty-title">No Authorization header found</div></div>';

  const truncated = auth.raw?.length > 60 ? auth.raw.substring(0, 60) + '…' : auth.raw;

  return `
    <div class="token-header">
      <span class="token-status-badge ${auth.ok ? 'valid' : 'expired'}">${auth.ok ? 'VALID' : 'EXPIRED'}</span>
    </div>
    ${auth.expRaw ? `<div class="token-countdown-wrap">
      <div class="token-countdown-bar" id="token-countdown-bar"></div>
      <span class="token-countdown-text" id="token-countdown-text"></span>
    </div>` : ''}
    <div class="ov-section">
      <div class="ov-heading">Raw Token</div>
      <div class="token-raw-wrap">
        <code class="token-raw" id="raw-token">${escapeHtml(auth.raw || '')}</code>
        <button class="copy-btn" data-copy="raw-token">Copy</button>
      </div>
    </div>
    <div class="ov-section">
      <div class="ov-heading">Decoded Fields</div>
      <div class="token-grid">
        <div class="ov-cell"><span class="ov-label">Subject</span><span class="ov-val">${escapeHtml(auth.sub)}</span></div>
        <div class="ov-cell"><span class="ov-label">Email</span><span class="ov-val">${escapeHtml(auth.email)}</span></div>
        <div class="ov-cell"><span class="ov-label">Role</span><span class="ov-val">${escapeHtml(auth.role)}</span></div>
        <div class="ov-cell"><span class="ov-label">Algorithm</span><span class="ov-val">${escapeHtml(auth.alg)}</span></div>
        <div class="ov-cell"><span class="ov-label">Issued</span><span class="ov-val">${auth.iat}</span></div>
        <div class="ov-cell"><span class="ov-label">Expires</span><span class="ov-val">${auth.exp}</span></div>
      </div>
    </div>
    ${!auth.ok ? '<div class="token-warning">⚠ This token has expired. The server will reject requests using this token.</div>' : ''}
  `;
}

function startTokenCountdown(auth) {
  if (tokenInterval) clearInterval(tokenInterval);
  if (!auth.expRaw) return;

  function tick() {
    const bar = document.getElementById('token-countdown-bar');
    const text = document.getElementById('token-countdown-text');
    if (!bar || !text) { clearInterval(tokenInterval); return; }

    const now = Date.now() / 1000;
    const remaining = Math.max(0, auth.expRaw - now);
    const total = auth.expRaw - (auth.expRaw - (auth.minsLeft || 0) * 60);
    const pct = total > 0 ? Math.min(100, (remaining / (auth.minsLeft * 60 || 3600)) * 100) : 0;

    bar.style.width = pct + '%';
    bar.className = 'token-countdown-bar ' + (remaining <= 0 ? 'expired' : remaining < 300 ? 'warning' : 'ok');

    if (remaining <= 0) text.textContent = 'EXPIRED';
    else if (remaining < 60) text.textContent = Math.round(remaining) + 's remaining';
    else text.textContent = Math.round(remaining / 60) + 'm ' + Math.round(remaining % 60) + 's remaining';
  }

  tick();
  tokenInterval = setInterval(tick, 1000);
}

function renderReplayTab(e) {
  return `
    <div class="ov-section">
      <div class="ov-heading">cURL</div>
      <div class="code-block-wrap">
        <pre class="code-block" id="curl-code">${escapeHtml(toCurl(e))}</pre>
        <button class="copy-btn" data-copy="curl-code">Copy</button>
      </div>
    </div>
    <div class="ov-section">
      <div class="ov-heading">fetch()</div>
      <div class="code-block-wrap">
        <pre class="code-block" id="fetch-code">${escapeHtml(toFetch(e))}</pre>
        <button class="copy-btn" data-copy="fetch-code">Copy</button>
      </div>
    </div>
    <div class="ov-section">
      <div class="ov-heading">Postman Collection</div>
      <div class="code-block-wrap">
        <pre class="code-block" id="postman-code">${escapeHtml(toPostman(e))}</pre>
        <button class="copy-btn" data-copy="postman-code">Copy</button>
      </div>
    </div>
    <div class="export-buttons">
      <button class="btn btn-amber" id="export-tracelens">Export .tracelens</button>
      <button class="btn btn-outline" id="export-har">Export .har</button>
    </div>
  `;
}

function renderDiffTab(e) {
  const similar = allEntries.filter(x =>
    x.id !== e.id && x.method === e.method && x.path === e.path
  );

  if (similar.length === 0) {
    return '<div class="empty-state"><div class="empty-title">No other requests to the same endpoint found</div><div class="empty-sub">Make the same request again to compare.</div></div>';
  }

  const other = similar[similar.length - 1];
  const faster = e.dur <= other.dur ? e : other;
  const slower = e.dur > other.dur ? e : other;

  let bodyDiff = '';
  try {
    const body1 = JSON.parse(faster.resBody);
    const body2 = JSON.parse(slower.resBody);
    const diff = diffObjects(body1, body2);
    bodyDiff = diff.length > 0
      ? diff.map(d => `<div class="diff-line diff-${d.type}"><span class="diff-key">${escapeHtml(d.path)}</span>: <span class="diff-old">${escapeHtml(String(d.oldVal ?? ''))}</span> → <span class="diff-new">${escapeHtml(String(d.newVal ?? ''))}</span></div>`).join('')
      : '<div class="muted">Response bodies are identical.</div>';
  } catch (err) {
    bodyDiff = '<div class="muted">Cannot diff — response bodies are not valid JSON.</div>';
  }

  return `
    <div class="ov-section">
      <div class="ov-heading">Duration Comparison</div>
      <div class="diff-dur">
        <div class="diff-dur-item">
          <span class="diff-dur-label">Fast</span>
          <span class="diff-dur-val dur-ok">${formatDur(faster.dur)}</span>
          <span class="diff-dur-time">${new Date(faster.timestamp).toLocaleTimeString()}</span>
        </div>
        <div class="diff-dur-item">
          <span class="diff-dur-label">Slow</span>
          <span class="diff-dur-val dur-slow">${formatDur(slower.dur)}</span>
          <span class="diff-dur-time">${new Date(slower.timestamp).toLocaleTimeString()}</span>
        </div>
      </div>
    </div>
    <div class="ov-section">
      <div class="ov-heading">Response Body Diff</div>
      <div class="diff-body">${bodyDiff}</div>
    </div>
  `;
}

function diffObjects(obj1, obj2, path = '') {
  const diffs = [];
  const keys = new Set([...Object.keys(obj1 || {}), ...Object.keys(obj2 || {})]);
  keys.forEach(key => {
    const p = path ? path + '.' + key : key;
    const v1 = obj1?.[key];
    const v2 = obj2?.[key];
    if (typeof v1 === 'object' && typeof v2 === 'object' && v1 !== null && v2 !== null && !Array.isArray(v1)) {
      diffs.push(...diffObjects(v1, v2, p));
    } else if (JSON.stringify(v1) !== JSON.stringify(v2)) {
      diffs.push({ path: p, oldVal: v1, newVal: v2, type: v1 === undefined ? 'added' : v2 === undefined ? 'removed' : 'changed' });
    }
  });
  return diffs;
}

function renderReportTab(e) {
  const report = generateReport(e);
  return `
    <div class="ov-section">
      <div class="ov-heading">Incident Report</div>
      <pre class="code-block report-block" id="report-text">${escapeHtml(report)}</pre>
    </div>
    <div class="export-buttons">
      <button class="btn btn-amber" id="copy-report">Copy Incident Report</button>
      <button class="btn btn-outline" id="export-tracelens">Export .tracelens</button>
    </div>
  `;
}

// --------------- WebSocket Frames Tab ---------------
function renderFramesTab(e) {
  const frames = e._wsFrames || [];
  if (frames.length === 0) {
    return `<div class="empty-state">
      <div class="empty-title">WebSocket Connection</div>
      <div class="empty-sub">Status ${e.status === 101 ? '101 Switching Protocols — upgrade successful' : e.status}. Frame capture requires active monitoring during the connection lifecycle.</div>
    </div>
    <div class="ov-section">
      <div class="ov-heading">Connection Info</div>
      <div class="ov-grid">
        <div class="ov-cell"><span class="ov-label">URL</span><span class="ov-val">${escapeHtml(e.url)}</span></div>
        <div class="ov-cell"><span class="ov-label">Protocol</span><span class="ov-val">${escapeHtml(e.resHeaders?.find(h => h.name.toLowerCase() === 'sec-websocket-protocol')?.value || '—')}</span></div>
        <div class="ov-cell"><span class="ov-label">Extensions</span><span class="ov-val">${escapeHtml(e.resHeaders?.find(h => h.name.toLowerCase() === 'sec-websocket-extensions')?.value || '—')}</span></div>
      </div>
    </div>`;
  }

  return `
    <div class="ov-section">
      <div class="ov-heading">Frames (${frames.length})</div>
      ${frames.map(f => `<div class="ws-frame-row">
        <span class="ws-dir ${f.dir === 'send' ? 'ws-dir-send' : 'ws-dir-recv'}">${f.dir === 'send' ? 'OUT' : 'IN'}</span>
        <span class="ws-data" title="${escapeHtml(f.data)}">${escapeHtml(f.data.substring(0, 200))}</span>
        <span class="ws-time">${new Date(f.time).toLocaleTimeString()}</span>
      </div>`).join('')}
    </div>
  `;
}

// --------------- JSON Syntax Highlighting ---------------
function syntaxHighlight(json) {
  return json.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/("(\\u[a-zA-Z0-9]{4}|\\[^u]|[^\\"])*"(\s*:)?|\b(true|false|null)\b|-?\d+(?:\.\d*)?(?:[eE][+\-]?\d+)?)/g, (match) => {
      let cls = 'json-number';
      if (/^"/.test(match)) {
        cls = /:$/.test(match) ? 'json-key' : 'json-string';
      } else if (/true|false/.test(match)) {
        cls = 'json-boolean';
      } else if (/null/.test(match)) {
        cls = 'json-null';
      }
      return '<span class="' + cls + '">' + match + '</span>';
    });
}

// --------------- Settings Panel ---------------
function toggleSettings() {
  $settingsPanel?.classList.toggle('open');
}

function applySettingsToUI() {
  const threshInput = document.getElementById('setting-thresh');
  const apiToggle = document.getElementById('setting-api');
  const gqlToggle = document.getElementById('setting-gql');
  const cascadeToggle = document.getElementById('setting-cascade');
  const tokenToggle = document.getElementById('setting-token');

  if (threshInput) threshInput.value = THRESH;
  if (apiToggle) apiToggle.checked = API_ONLY;
  if (gqlToggle) gqlToggle.checked = GQL_NAMES;
  if (cascadeToggle) cascadeToggle.checked = CASCADE_ENABLED;
  if (tokenToggle) tokenToggle.checked = TOKEN_COUNTDOWN;

  const baselineToggle = document.getElementById('setting-baseline');
  const baselinePct = document.getElementById('setting-baseline-pct');
  const baselineRow = document.getElementById('baseline-thresh-row');
  if (baselineToggle) baselineToggle.checked = BASELINE_ENABLED;
  if (baselinePct) baselinePct.value = BASELINE_PCT;
  if (baselineRow) baselineRow.style.display = BASELINE_ENABLED ? 'flex' : 'none';
}

function initSettingsListeners() {
  document.getElementById('setting-thresh')?.addEventListener('change', (ev) => {
    THRESH = parseInt(ev.target.value) || 800;
    saveSetting('thresh', THRESH);
    updateSummary();
    renderTimeline();
  });
  document.getElementById('setting-api')?.addEventListener('change', (ev) => {
    API_ONLY = ev.target.checked;
    saveSetting('apiOnly', API_ONLY);
  });
  document.getElementById('setting-gql')?.addEventListener('change', (ev) => {
    GQL_NAMES = ev.target.checked;
    saveSetting('gqlNames', GQL_NAMES);
    renderTimeline();
  });
  document.getElementById('setting-cascade')?.addEventListener('change', (ev) => {
    CASCADE_ENABLED = ev.target.checked;
    saveSetting('cascade', CASCADE_ENABLED);
  });
  document.getElementById('setting-token')?.addEventListener('change', (ev) => {
    TOKEN_COUNTDOWN = ev.target.checked;
    saveSetting('tokenCountdown', TOKEN_COUNTDOWN);
    renderTimeline();
  });
  document.getElementById('setting-baseline')?.addEventListener('change', (ev) => {
    BASELINE_ENABLED = ev.target.checked;
    saveSetting('baselineEnabled', BASELINE_ENABLED);
    const row = document.getElementById('baseline-thresh-row');
    if (row) row.style.display = BASELINE_ENABLED ? 'flex' : 'none';
  });
  document.getElementById('setting-baseline-pct')?.addEventListener('change', (ev) => {
    BASELINE_PCT = parseInt(ev.target.value) || 50;
    saveSetting('baselinePct', BASELINE_PCT);
  });
  document.getElementById('save-baseline-btn')?.addEventListener('click', () => {
    savePerformanceBaseline();
    const btn = document.getElementById('save-baseline-btn');
    if (btn) { btn.textContent = 'Saved!'; setTimeout(() => { btn.textContent = 'Snapshot'; }, 1500); }
  });
}

// --------------- Shortcuts ---------------
function toggleShortcuts() {
  $shortcutsOverlay?.classList.toggle('visible');
}

// --------------- Keyboard Shortcuts ---------------
function initKeyboard() {
  document.addEventListener('keydown', (ev) => {
    // Ignore if typing in an input
    if (ev.target.tagName === 'INPUT' || ev.target.tagName === 'TEXTAREA') return;

    switch (ev.key) {
      case 'j':
      case 'J':
        ev.preventDefault();
        navigateRequest(1);
        break;
      case 'k':
      case 'K':
        ev.preventDefault();
        navigateRequest(-1);
        break;
      case ' ':
        ev.preventDefault();
        if (selectedEntry) closeDrawer();
        else if (filteredEntries.length > 0) openDrawer(filteredEntries[0]);
        break;
      case 'Escape':
        if ($shortcutsOverlay?.classList.contains('visible')) toggleShortcuts();
        else if ($settingsPanel?.classList.contains('open')) toggleSettings();
        else closeDrawer();
        break;
      case 'b':
      case 'B':
        ev.preventDefault();
        stampBookmark();
        break;
      case 'r':
        ev.preventDefault();
        if (selectedEntry) navigator.clipboard.writeText(toCurl(selectedEntry));
        break;
      case 'c':
        ev.preventDefault();
        if (selectedEntry) navigator.clipboard.writeText(generateReport(selectedEntry));
        break;
      case 'd':
        ev.preventDefault();
        DOMAIN_GROUPING = !DOMAIN_GROUPING;
        document.getElementById('domain-group-btn')?.classList.toggle('active', DOMAIN_GROUPING);
        renderTimeline();
        break;
      case 't':
        ev.preventDefault();
        toggleTheme();
        break;
      case '?':
        ev.preventDefault();
        toggleShortcuts();
        break;
    }
  });
}

function navigateRequest(dir) {
  if (filteredEntries.length === 0) return;
  if (selectedIdx === -1) {
    selectedIdx = 0;
  } else {
    selectedIdx = Math.max(0, Math.min(filteredEntries.length - 1, selectedIdx + dir));
  }
  openDrawer(filteredEntries[selectedIdx]);

  // Scroll the selected row into view
  const row = $timeline?.querySelector('.req-row.selected');
  row?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

function stampBookmark() {
  const label = prompt('Bookmark label:') || 'Bookmark';
  bookmarks.set(Date.now(), label);
  renderTimeline();
}

// --------------- Capture Controls ---------------
function toggleCapture() {
  capturing = !capturing;
  $captureBtn.classList.toggle('stopped', !capturing);
  $captureBtn.querySelector('.cap-label').textContent = capturing ? 'Capturing' : 'Stopped';
  $liveDot?.classList.toggle('paused', !capturing);
}

function clearAll() {
  allEntries = [];
  bursts = [];
  wsEntries = [];
  bookmarks.clear();
  selectedEntry = null;
  selectedIdx = -1;
  filteredEntries = [];
  closeDrawer();
  updateSummary();
  updateHeatmap();
  renderTimeline();

  // Notify side panel
  if (typeof chrome !== 'undefined' && chrome.runtime) {
    chrome.runtime.sendMessage({ type: 'tracelens-clear' }).catch(() => {});
  }
}

// --------------- Filter Bar ---------------
function initFilterBar() {
  $searchInput?.addEventListener('input', (ev) => {
    searchQuery = ev.target.value;
    renderTimeline();
  });

  document.querySelectorAll('.method-filter-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const method = btn.dataset.method;
      activeMethodFilter = activeMethodFilter === method ? '' : method;
      document.querySelectorAll('.method-filter-btn').forEach(b => b.classList.toggle('active', b.dataset.method === activeMethodFilter));
      renderTimeline();
    });
  });

  document.getElementById('bookmark-filter-btn')?.addEventListener('click', () => {
    showBookmarksOnly = !showBookmarksOnly;
    document.getElementById('bookmark-filter-btn')?.classList.toggle('active', showBookmarksOnly);
    renderTimeline();
  });
}

// --------------- Init ---------------
function init() {
  cacheDom();
  loadSettings();
  initSettingsListeners();
  initFilterBar();
  initKeyboard();
  startCapture();
  updateSummary();
  renderTimeline();

  $captureBtn?.addEventListener('click', toggleCapture);
  $clearBtn?.addEventListener('click', clearAll);
  document.getElementById('settings-btn')?.addEventListener('click', toggleSettings);
  document.getElementById('shortcuts-btn')?.addEventListener('click', toggleShortcuts);
  document.getElementById('settings-close')?.addEventListener('click', toggleSettings);

  // Theme toggle
  document.getElementById('theme-btn')?.addEventListener('click', toggleTheme);

  // Domain grouping toggle
  document.getElementById('domain-group-btn')?.addEventListener('click', () => {
    DOMAIN_GROUPING = !DOMAIN_GROUPING;
    document.getElementById('domain-group-btn')?.classList.toggle('active', DOMAIN_GROUPING);
    renderTimeline();
  });

  // Import .tracelens
  document.getElementById('import-btn')?.addEventListener('click', () => {
    document.getElementById('import-file')?.click();
  });
  document.getElementById('import-file')?.addEventListener('change', (ev) => {
    const file = ev.target.files?.[0];
    if (file) {
      importTraceLensSnapshot(file);
      ev.target.value = '';
    }
  });

  // Performance alert dismiss
  document.getElementById('perf-alert-dismiss')?.addEventListener('click', () => {
    document.getElementById('perf-alert')?.classList.remove('visible');
  });

  // Periodically update heatmap
  setInterval(updateHeatmap, 2000);
}

document.addEventListener('DOMContentLoaded', init);
