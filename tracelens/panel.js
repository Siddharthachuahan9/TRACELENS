/* ============================================================
   TraceLens v2.1.0 — panel.js
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
let recentPaths = new Map();
let maskAuthInExport = true;
let newEntryIds = new Set();

// AI settings
let AI_PROVIDER = ''; // 'anthropic' | 'openai' | ''
let AI_KEY = '';
let AI_MODEL = 'claude-haiku-4-5-20251001';
let AI_DISCLOSED = false; // user has seen the privacy notice
let aiLastResponse = ''; // for copy-response

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
let prevSummaryCounts = {}; // for chip pulse animation

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

  // Only handle Bearer tokens — ignore Basic, Digest, etc.
  if (!/^bearer\s+/i.test(authHeader.value)) return null;

  const token = authHeader.value.replace(/^bearer\s+/i, '');
  const b64url = s => s.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(s.length / 4) * 4, '=');
  const parts = token.split('.');

  // Not a JWT — opaque Bearer token (API key, session token, etc.)
  if (parts.length !== 3) {
    return { raw: token, ok: null, isJwt: false, alg: '—', sub: '—', email: '—', role: '—', iat: '—', iatRaw: null, exp: '—', expRaw: null, minsLeft: null };
  }

  try {
    const payload = JSON.parse(atob(b64url(parts[1])));
    const now = Date.now() / 1000;
    const minsLeft = payload.exp ? Math.max(0, (payload.exp - now) / 60) : null;
    return {
      raw: token,
      isJwt: true,
      alg: (() => { try { return JSON.parse(atob(b64url(parts[0]))).alg || '—'; } catch(e) { return '—'; } })(),
      sub: payload.sub || payload.preferred_username || payload.username || payload.user_id || payload.userId || '—',
      email: payload.email || payload.upn || '—',
      role: payload.role || payload.roles?.[0] || payload.scope || payload.scp || payload.authorities?.[0] || '—',
      iat: payload.iat ? new Date(payload.iat * 1000).toLocaleTimeString() : '—',
      iatRaw: payload.iat || null,
      exp: payload.exp ? new Date(payload.exp * 1000).toLocaleTimeString() : '—',
      expRaw: payload.exp || null,
      ok: payload.exp ? now < payload.exp : true,
      minsLeft,
    };
  } catch (e) {
    // Has 3 parts but payload couldn't be decoded — malformed JWT
    return { raw: token, ok: null, isJwt: true, alg: '—', sub: '—', email: '—', role: '—', iat: '—', iatRaw: null, exp: '—', expRaw: null, minsLeft: null };
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
  const key = `${entry.method}:${entry.path}`;
  const prev = recentPaths.get(key);
  const isRetry = prev !== undefined && Math.abs(prev - entry.timestamp) < 5000;
  recentPaths.set(key, entry.timestamp);
  return isRetry;
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
  const clamp = v => Math.max(0, v ?? 0);
  const wait = clamp(timings?.wait);
  const dns = clamp(timings?.dns);
  const ssl = clamp(timings?.ssl);
  const dl = clamp(timings?.receive);

  if (entry._isRetry)
    return 'Retry detected — same endpoint fired again within 5s. Look at the original request for the root cause.';

  if (status === 401 && !hasAuth)
    return '401 with no Authorization header sent. The client never attached credentials — check session/cookie state.';

  if (status === 401 && auth && auth.ok === false)
    return `401 with an expired JWT. Token expired at ${auth.exp}. Refresh the token and replay.`;

  if (status === 401 && auth && auth.ok === true)
    return '401 with a structurally valid JWT that the server rejected. Possible causes: wrong issuer, wrong audience, signature mismatch, or token not yet active (nbf claim).';

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

  if (status === 400)
    return '400 Bad Request — the server rejected the request syntax. Check required fields, data types, or malformed JSON in the request body.';

  if (status === 404)
    return `404 Not Found — ${new URL(entry.url).pathname} does not exist on this server. Check the URL, API version, and whether the resource was deleted.`;

  if (status === 408)
    return '408 Request Timeout — the server closed the connection before receiving a complete request. Network instability or large payload.';

  if (status === 409)
    return '409 Conflict — the request conflicts with current resource state. Likely a duplicate, stale write, or optimistic lock violation.';

  if (status === 413)
    return `413 Payload Too Large — request body (${formatSize(entry.size)}) exceeds server limit. Compress, paginate, or chunk the upload.`;

  if (status >= 500 && status < 600 && dur <= 5000)
    return `${status} Server Error in ${Math.round(dur)}ms — the server threw an exception. Check server logs; this is not a client-side bug.`;

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
      creator: { name: 'TraceLens', version: '2.1.0' },
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
    version: '2.1.0',
    exportedAt: new Date().toISOString(),
    entry: entry,
    diagnosis: diagnose(entry),
    burst: bursts.find(b => b.requests.some(r => r.id === entry.id)),
  };
  downloadJSON(snapshot, `tracelens-${entry.method}-${entry.status}-${Date.now()}.tracelens`);
}

function exportSession() {
  const data = {
    version: '2.1.0',
    exportedAt: new Date().toISOString(),
    pageUrl: currentPageUrl,
    entries: allEntries,
    bursts: bursts,
  };
  downloadJSON(data, `tracelens-session-${Date.now()}.tracelens`);
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
    const val = h.name.toLowerCase() === 'authorization' ? maskAuth(h.value) : h.value;
    cmd += ` \\\n  -H '${shellEscape(h.name)}: ${shellEscape(val)}'`;
  });
  if (entry.reqBody) {
    cmd += ` \\\n  -d '${shellEscape(entry.reqBody)}'`;
  }
  return cmd;
}

function toFetch(entry) {
  const opts = { method: entry.method, headers: {} };
  entry.reqHeaders?.forEach(h => {
    opts.headers[h.name] = h.name.toLowerCase() === 'authorization' ? maskAuth(h.value) : h.value;
  });
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

function maskAuth(val) {
  if (!maskAuthInExport) return val;
  return val.replace(/^(Bearer\s+)(\S{6})\S+(\S{4})$/i, '$1$2••••••••$3');
}

function toPython(entry) {
  const headers = {};
  entry.reqHeaders?.forEach(h => {
    headers[h.name] = h.name.toLowerCase() === 'authorization' ? maskAuth(h.value) : h.value;
  });
  let code = `import requests\n\n`;
  code += `headers = ${JSON.stringify(headers, null, 4)}\n\n`;
  if (entry.reqBody) {
    try {
      const parsed = JSON.parse(entry.reqBody);
      code += `payload = ${JSON.stringify(parsed, null, 4)}\n\n`;
      code += `response = requests.${entry.method.toLowerCase()}(\n    ${JSON.stringify(entry.url)},\n    json=payload,\n    headers=headers\n)\n`;
    } catch {
      code += `payload = ${JSON.stringify(entry.reqBody)}\n\n`;
      code += `response = requests.${entry.method.toLowerCase()}(\n    ${JSON.stringify(entry.url)},\n    data=payload,\n    headers=headers\n)\n`;
    }
  } else {
    code += `response = requests.${entry.method.toLowerCase()}(\n    ${JSON.stringify(entry.url)},\n    headers=headers\n)\n`;
  }
  code += `\nprint(response.status_code)\nprint(response.json())`;
  return code;
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
Exported via TraceLens v2.1.0`;
}

// --------------- Settings Persistence ---------------
function loadSettings() {
  if (typeof chrome !== 'undefined' && chrome.storage?.local) {
    chrome.storage.local.get(['thresh', 'apiOnly', 'gqlNames', 'cascade', 'tokenCountdown', 'theme', 'baselineEnabled', 'baselinePct', 'performanceBaseline', 'annotations', 'aiProvider', 'aiKey', 'aiModel', 'aiDisclosed'], (s) => {
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
      AI_PROVIDER = s.aiProvider || '';
      AI_KEY = s.aiKey || '';
      AI_MODEL = s.aiModel || 'claude-haiku-4-5-20251001';
      AI_DISCLOSED = !!s.aiDisclosed;
      applyTheme();
      applySettingsToUI();
    });
  }
}

// --------------- Theme Toggle ---------------
const THEMES = ['dark', 'light', 'midnight', 'terminal'];

function applyTheme() {
  document.body.classList.remove('theme-light', 'theme-midnight', 'theme-terminal');
  if (THEME !== 'dark') document.body.classList.add('theme-' + THEME);

  const icon = document.getElementById('theme-icon');
  if (icon) {
    if (THEME === 'light') {
      icon.innerHTML = '<path d="M8 12a4 4 0 110-8 4 4 0 010 8zM8 0a1 1 0 011 1v1a1 1 0 01-2 0V1a1 1 0 011-1z" fill="currentColor"/>';
    } else if (THEME === 'midnight') {
      icon.innerHTML = '<path d="M13 8.5A5.5 5.5 0 117.5 3c-.8 1-1.2 2.2-1.2 3.5a5.5 5.5 0 005.5 5.5c.5 0 .9-.1 1.2-.2z" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/>';
    } else if (THEME === 'terminal') {
      icon.innerHTML = '<rect x="2" y="3" width="12" height="9" rx="1.5" stroke="currentColor" stroke-width="1.2"/><path d="M4.5 7l2 2-2 2M8 11h3.5" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/>';
    } else {
      icon.innerHTML = '<circle cx="8" cy="8" r="3.5" stroke="currentColor" stroke-width="1.2"/><path d="M8 1.5v2M8 12.5v2M1.5 8h2M12.5 8h2M3.4 3.4l1.4 1.4M11.2 11.2l1.4 1.4M3.4 12.6l1.4-1.4M11.2 4.8l1.4-1.4" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/>';
    }
  }

  document.querySelectorAll('.theme-swatch').forEach(s => {
    s.classList.toggle('active', s.dataset.theme === THEME);
  });
}

function toggleTheme() {
  const idx = THEMES.indexOf(THEME);
  THEME = THEMES[(idx + 1) % THEMES.length];
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
  newEntryIds.add(entry.id);
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

// --------------- AI Privacy Sanitizer ---------------

const SENSITIVE_HEADER_PATTERNS = [
  /^authorization$/i, /^cookie$/i, /^set-cookie$/i,
  /^x-api-key$/i, /^x-auth-token$/i, /^x-access-token$/i,
  /^x-csrf-token$/i, /^x-session-token$/i, /^x-auth$/i,
  /^api-key$/i, /^private-token$/i, /^x-private-token$/i,
  /^x-secret$/i, /^proxy-authorization$/i,
];

const SENSITIVE_BODY_KEYS = new Set([
  'password', 'passwd', 'pwd', 'secret', 'token', 'key', 'api_key', 'apikey',
  'private_key', 'privatekey', 'access_token', 'accesstoken', 'refresh_token',
  'refreshtoken', 'auth', 'credential', 'credentials', 'ssn', 'credit_card',
  'creditcard', 'card_number', 'cardnumber', 'cvv', 'cvc', 'pin', 'passphrase',
  'client_secret', 'clientsecret', 'webhook_secret',
]);

function isSensitiveHeader(name) {
  return SENSITIVE_HEADER_PATTERNS.some(p => p.test(name));
}

function sanitizeBodyObj(obj, depth = 0) {
  if (depth > 5 || obj === null || typeof obj !== 'object') return obj;
  if (Array.isArray(obj)) return obj.slice(0, 5).map(v => sanitizeBodyObj(v, depth + 1));
  const result = {};
  for (const [k, v] of Object.entries(obj)) {
    if (SENSITIVE_BODY_KEYS.has(k.toLowerCase())) {
      result[k] = '[REDACTED]';
    } else {
      result[k] = sanitizeBodyObj(v, depth + 1);
    }
  }
  return result;
}

function sanitizeQueryParams(url) {
  try {
    const u = new URL(url);
    u.searchParams.forEach((val, key) => {
      // Redact values that look like tokens (>20 chars, opaque alphanumeric)
      if (val.length > 20 && /^[A-Za-z0-9+/=_\-.~]+$/.test(val)) {
        u.searchParams.set(key, '[REDACTED]');
      }
    });
    return u.toString();
  } catch { return url; }
}

function sanitizeForAI(entry) {
  const stripped = [];

  // Safe headers only
  const safeReqHeaders = {};
  (entry.reqHeaders || []).forEach(h => {
    if (isSensitiveHeader(h.name)) {
      stripped.push(h.name.toLowerCase());
    } else {
      safeReqHeaders[h.name] = h.value;
    }
  });
  const safeResHeaders = {};
  (entry.resHeaders || []).forEach(h => {
    if (isSensitiveHeader(h.name)) {
      stripped.push(h.name.toLowerCase());
    } else {
      safeResHeaders[h.name] = h.value;
    }
  });

  // Sanitize URL query params
  const safeUrl = sanitizeQueryParams(entry.url);

  // Request body: parse and sanitize JSON, else size hint only
  let safeReqBody = null;
  if (entry.reqBody) {
    try {
      const parsed = JSON.parse(entry.reqBody);
      safeReqBody = sanitizeBodyObj(parsed);
    } catch {
      if (typeof entry.reqBody === 'string' && entry.reqBody.length < 200) {
        safeReqBody = entry.reqBody; // short non-JSON (form data etc.)
      } else {
        safeReqBody = `[${entry.reqBody.length} bytes — non-JSON]`;
      }
    }
  }

  // Response body: only include if it's an error or small JSON
  let safeResBody = null;
  if (entry.resBody && (entry.status >= 400 || entry.resBody.length < 800)) {
    try {
      const parsed = JSON.parse(entry.resBody);
      safeResBody = sanitizeBodyObj(parsed);
    } catch {
      safeResBody = entry.resBody.slice(0, 400);
    }
  } else if (entry.resBody) {
    safeResBody = `[${entry.resBody.length} bytes — not included]`;
  }

  // JWT claims (safe to include — not raw token)
  let jwtClaims = null;
  if (entry._auth?.isJwt && entry._auth?.claims) {
    const { exp, iat, sub, scope, scp, preferred_username, upn, authorities, iss, aud } = entry._auth.claims;
    jwtClaims = { exp, iat, sub, scope: scope || scp, preferred_username: preferred_username || upn, authorities, iss, aud };
    // Remove undefined keys
    Object.keys(jwtClaims).forEach(k => jwtClaims[k] === undefined && delete jwtClaims[k]);
  }

  const timings = entry.timings ? {
    dns: Math.max(0, entry.timings.dns ?? -1),
    connect: Math.max(0, entry.timings.connect ?? -1),
    ssl: Math.max(0, entry.timings.ssl ?? -1),
    wait: Math.max(0, entry.timings.wait ?? 0),
    receive: Math.max(0, entry.timings.receive ?? 0),
  } : null;

  return {
    url: safeUrl,
    path: entry.path,
    method: entry.method,
    status: entry.status,
    duration_ms: Math.round(entry.dur || 0),
    timings_ms: timings,
    mime_type: entry.mimeType,
    request_headers: safeReqHeaders,
    response_headers: safeResHeaders,
    request_body: safeReqBody,
    response_body: safeResBody,
    jwt_claims: jwtClaims,
    is_graphql: !!entry._isGraphQL,
    is_retry: !!entry._isRetry,
    traceLens_diagnosis: diagnose(entry),
    _stripped: [...new Set(stripped)],
  };
}

// --------------- AI API Call ---------------

async function callAI(payload, userPrompt) {
  if (!AI_KEY || !AI_PROVIDER) throw new Error('No API key configured.');

  const systemPrompt = `You are an expert HTTP debugging assistant embedded in TraceLens, a Chrome DevTools extension used by developers and support engineers during live debugging sessions.

You receive sanitized request snapshots. Sensitive fields — auth tokens, cookies, passwords, raw JWT strings — were stripped server-side before this payload reached you. Never ask for them; work only with what is provided.

Rules:
- Reference actual values from the data: quote status codes, timing milliseconds, URL paths, response error messages, JWT claims by name. Generic answers are useless here.
- The traceLens_diagnosis field is a first-pass rule-based guess. Build on it, challenge it, or confirm it — never just repeat it.
- Every response must end with something the developer can do right now.
- The reader is a competent engineer. Skip obvious definitions. No padding.
- Plain text only. Numbered lists where order matters, dashes where it does not. No markdown headers, no bold, no code fences unless showing a command.
- Responses under 180 words unless the task explicitly requires more (e.g. a full incident report).`;

  const contextBlock = `Request snapshot (sensitive fields pre-stripped):\n${JSON.stringify(payload, null, 2)}`;

  const fullPrompt = `${contextBlock}\n\n${userPrompt}`;

  if (AI_PROVIDER === 'anthropic') {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': AI_KEY,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: AI_MODEL,
        max_tokens: 512,
        system: systemPrompt,
        messages: [{ role: 'user', content: fullPrompt }],
      }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err?.error?.message || `Anthropic API error ${res.status}`);
    }
    const data = await res.json();
    return data.content?.[0]?.text || '';
  }

  if (AI_PROVIDER === 'openai') {
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${AI_KEY}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: AI_MODEL,
        max_tokens: 512,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: fullPrompt },
        ],
      }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err?.error?.message || `OpenAI API error ${res.status}`);
    }
    const data = await res.json();
    return data.choices?.[0]?.message?.content || '';
  }

  throw new Error('Unknown provider.');
}

// --------------- AI Tab Renderer ---------------

function renderAITab(entry) {
  if (!AI_PROVIDER || !AI_KEY) {
    return `<div class="ai-no-key">
      AI Assistant is not configured.<br>
      <a id="ai-open-settings">Open Settings</a> to add your API key.
    </div>`;
  }

  const payload = sanitizeForAI(entry);
  const strippedPills = payload._stripped.map(s =>
    `<span class="stripped-pill">✗ ${escapeHtml(s)}</span>`
  ).join('');

  const payloadDisplay = JSON.stringify(payload, (k, v) => k === '_stripped' ? undefined : v, 2);

  return `<div class="ai-tab-wrap">
    <div class="ai-payload-preview">
      <div class="ai-payload-header" id="ai-payload-toggle">
        <span class="ai-payload-title">What will be sent</span>
        <div class="ai-payload-stripped">${strippedPills || '<span style="font-size:10px;color:var(--c6)">No sensitive fields found</span>'}</div>
      </div>
      <div class="ai-payload-body" id="ai-payload-body">${escapeHtml(payloadDisplay)}</div>
    </div>

    <div class="ai-prompt-row">
      <button class="ai-prompt-btn" data-prompt="Diagnose this request. Answer three things: (1) What exactly caused this status code — is the fault client-side or server-side? Reference the specific status, response body error message, and JWT claims if relevant. (2) What was the server likely doing when this failed? (3) Does the timing data support or contradict the error story — note any phase that stands out. Be specific, quote actual values, 4-6 sentences.">Root cause</button>
      <button class="ai-prompt-btn" data-prompt="Give a numbered fix list for this exact request. Each fix must name the specific header to add or change, field to fix, endpoint to call, or code pattern to change. If multiple root causes are possible, label each fix path with the cause it addresses. No generic advice — if you would say 'check your auth', instead say exactly what to check and what value to set based on this data.">How to fix</button>
      <button class="ai-prompt-btn" data-prompt="The timing_ms object shows individual phases. Identify which single phase dominates the total duration_ms. Explain the specific technical reason that phase is slow given this URL, method, and server response. Quote the actual millisecond values. End with one concrete action to reduce that phase.">What's slow</button>
      <button class="ai-prompt-btn" data-prompt="Write a Jira incident report. Use exactly these section labels on their own lines, nothing else:\nSUMMARY: one sentence\nSEVERITY: P1/P2/P3 with one-line justification\nIMPACT: what breaks for end users\nROOT CAUSE: 2-3 technical sentences\nSTEPS TO REPRODUCE: numbered, specific to this request\nEVIDENCE: quote the key values verbatim — status, duration_ms, error message from response body\nRECOMMENDED FIX: what engineering must do, specifically">Draft report</button>
      <button class="ai-prompt-btn" data-prompt="Scan this request for security issues. Check: (1) missing security headers in the response (HSTS, X-Content-Type-Options, X-Frame-Options, CSP); (2) sensitive data leaking in the URL path or response body; (3) if JWT claims are present — check for missing exp, overly broad scope, or suspicious iss/aud values; (4) any status code that indicates a misconfigured server (403 vs 401 confusion, 500 on auth paths, etc.). List only actual findings, not things to check.">Security scan</button>
      <button class="ai-prompt-btn" data-prompt="Explain what happened with this request in plain language for a non-technical stakeholder — a product manager or customer. No jargon, no status codes, no technical terms. One short paragraph: what the user was trying to do, what went wrong, and what fixing it will change for them.">Explain simply</button>
    </div>

    <div class="ai-custom-row">
      <input type="text" class="ai-custom-input" id="ai-custom-prompt" placeholder="Ask anything about this request…">
      <button class="ai-ask-btn" id="ai-ask-btn">Ask →</button>
    </div>

    <div class="ai-response-wrap" id="ai-response-wrap">
      <div class="ai-response-placeholder">Choose a prompt above or type a custom question.</div>
    </div>
  </div>`;
}

function attachAITabHandlers(entry) {
  const payload = sanitizeForAI(entry);

  // Payload preview toggle
  document.getElementById('ai-payload-toggle')?.addEventListener('click', () => {
    document.getElementById('ai-payload-body')?.classList.toggle('open');
  });

  // Open settings link
  document.getElementById('ai-open-settings')?.addEventListener('click', () => {
    toggleSettings();
  });

  // Quick prompt buttons
  document.querySelectorAll('.ai-prompt-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      runAIQuery(payload, btn.dataset.prompt);
    });
  });

  // Custom prompt
  const customInput = document.getElementById('ai-custom-prompt');
  const askBtn = document.getElementById('ai-ask-btn');
  const runCustom = () => {
    const q = customInput?.value.trim();
    if (q) runAIQuery(payload, q);
  };
  askBtn?.addEventListener('click', runCustom);
  customInput?.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') runCustom();
  });
}

function runAIQuery(payload, prompt) {
  const wrap = document.getElementById('ai-response-wrap');
  if (!wrap) return;

  // Show disclosure first time
  if (!AI_DISCLOSED) {
    showAIDisclosure(() => runAIQuery(payload, prompt));
    return;
  }

  wrap.innerHTML = `<div class="ai-thinking">
    <div class="ai-thinking-dot"></div>
    <div class="ai-thinking-dot"></div>
    <div class="ai-thinking-dot"></div>
    <span>Thinking…</span>
  </div>`;

  const askBtn = document.getElementById('ai-ask-btn');
  if (askBtn) askBtn.disabled = true;

  callAI(payload, prompt)
    .then(text => {
      aiLastResponse = text;
      const modelLabel = AI_MODEL.includes('haiku') ? 'Claude Haiku'
        : AI_MODEL.includes('sonnet') ? 'Claude Sonnet'
        : AI_MODEL.includes('gpt-4o-mini') ? 'GPT-4o mini'
        : AI_MODEL.includes('gpt-4o') ? 'GPT-4o'
        : AI_MODEL;

      wrap.innerHTML = `
        <div class="ai-response-inner">${escapeHtml(text)}</div>
        <div class="ai-response-meta">
          <span class="ai-model-tag">${escapeHtml(modelLabel)}</span>
          <button class="ai-copy-resp" id="ai-copy-resp-btn">Copy</button>
        </div>`;

      document.getElementById('ai-copy-resp-btn')?.addEventListener('click', (ev) => {
        navigator.clipboard.writeText(aiLastResponse).then(() => {
          ev.target.textContent = '✓ Copied';
          setTimeout(() => { ev.target.textContent = 'Copy'; }, 1500);
        });
      });
    })
    .catch(err => {
      wrap.innerHTML = `<div class="ai-error">Error: ${escapeHtml(err.message)}</div>`;
    })
    .finally(() => {
      if (askBtn) askBtn.disabled = false;
    });
}

let _pendingAICallback = null;
function showAIDisclosure(callback) {
  _pendingAICallback = callback;
  document.getElementById('ai-disclosure')?.classList.add('visible');
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
      if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) return;

      const importEntry = (entry) => {
        if (!entry || typeof entry !== 'object') return;
        if (!entry.url || typeof entry.url !== 'string') return;
        if (!entry.method || typeof entry.method !== 'string') return;
        entry.id = entry.id || generateId();
        entry._auth = extractAuth(entry);
        entry._isRetry = false;
        entry._displayName = getDisplayName(entry);
        entry._methodLabel = getMethodLabel(entry);
        entry._isGraphQL = isGraphQL(entry);
        entry._imported = true;
        allEntries.push(entry);
        newEntryIds.add(entry.id);
        addToBurst(entry);
      };

      if (Array.isArray(snapshot.entries)) {
        snapshot.entries.forEach(importEntry);
      } else if (snapshot.entry && typeof snapshot.entry === 'object' && !Array.isArray(snapshot.entry)) {
        importEntry(snapshot.entry);
      } else {
        return;
      }

      updateSummary();
      renderTimeline();
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
    const q = searchQuery;
    if (q.startsWith('/') && q.endsWith('/') && q.length > 1) {
      try {
        const re = new RegExp(q.slice(1, -1), 'i');
        entries = entries.filter(e => re.test(e.url) || re.test(e._displayName));
      } catch (e) { /* invalid regex — skip */ }
    } else if (/^[2-5]xx$/i.test(q)) {
      const base = parseInt(q[0], 10) * 100;
      entries = entries.filter(e => e.status >= base && e.status < base + 100);
    } else {
      const ql = q.toLowerCase();
      entries = entries.filter(e =>
        e.url.toLowerCase().includes(ql) ||
        e._displayName.toLowerCase().includes(ql) ||
        String(e.status).includes(ql) ||
        e.method.toLowerCase().includes(ql) ||
        e._methodLabel.toLowerCase().includes(ql)
      );
    }
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

  // Pulse chip values that increased
  const nowCounts = { total, slow, errors, authCount };
  $summary.querySelectorAll('.chip-val').forEach(el => {
    const chip = el.closest('.summary-chip');
    if (!chip) return;
    const key = chip.dataset.filter === '' ? 'total'
              : chip.dataset.filter === 'slow' ? 'slow'
              : chip.dataset.filter === 'errors' ? 'errors'
              : 'authCount';
    if ((prevSummaryCounts[key] ?? -1) < nowCounts[key]) {
      el.classList.remove('pulsing');
      void el.offsetWidth;
      el.classList.add('pulsing');
      el.addEventListener('animationend', () => el.classList.remove('pulsing'), { once: true });
    }
  });
  prevSummaryCounts = nowCounts;

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

  // Animate newly added rows
  if (newEntryIds.size) {
    $timeline.querySelectorAll('.req-row').forEach(row => {
      if (newEntryIds.has(row.dataset.id)) row.classList.add('row-new');
    });
    newEntryIds.clear();
  }

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
  const wsTabs = ['overview', 'connection', 'replay', 'report'];
  const aiTab = AI_PROVIDER && AI_KEY ? ['ai'] : [];
  const tabs = [...(e._isWebSocket ? wsTabs : baseTabs), ...aiTab];

  let html = `<div class="drawer-tabs">
    ${tabs.map(t => `<button class="drawer-tab ${activeTab === t ? 'active' : ''}" data-tab="${t}">${t === 'ai' ? '✦ AI' : t.charAt(0).toUpperCase() + t.slice(1)}</button>`).join('')}
    <button class="drawer-close" id="drawer-close-btn">&times;</button>
  </div>
  <div class="drawer-body">`;

  if (activeTab === 'overview') html += renderOverviewTab(e);
  else if (activeTab === 'timing') html += renderTimingTab(e);
  else if (activeTab === 'token') html += renderTokenTab(e);
  else if (activeTab === 'replay') html += renderReplayTab(e);
  else if (activeTab === 'diff') html += renderDiffTab(e);
  else if (activeTab === 'report') html += renderReportTab(e);
  else if (activeTab === 'connection') html += renderFramesTab(e);
  else if (activeTab === 'ai') html += renderAITab(e);

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

  // AI tab handlers
  if (activeTab === 'ai') attachAITabHandlers(e);

  // Reveal token toggle
  $drawerContent.querySelector('#reveal-token-btn')?.addEventListener('click', (ev) => {
    const tokenEl = document.getElementById('raw-token');
    if (!tokenEl) return;
    const revealed = tokenEl.dataset.revealed === 'true';
    if (revealed) {
      tokenEl.textContent = tokenEl.dataset.full.substring(0, 12) + '••••••••••••••••••••••••••••••••' + tokenEl.dataset.full.slice(-8);
      tokenEl.dataset.revealed = 'false';
      ev.target.textContent = 'Reveal';
    } else {
      tokenEl.textContent = tokenEl.dataset.full;
      tokenEl.dataset.revealed = 'true';
      ev.target.textContent = 'Hide';
    }
  });

  // Copy button handlers
  $drawerContent.querySelectorAll('[data-copy]').forEach(btn => {
    btn.addEventListener('click', () => {
      const target = btn.dataset.copy;
      const el = document.getElementById(target);
      if (el) {
        const text = el.dataset.full || el.textContent;
        navigator.clipboard.writeText(text).then(() => {
          const orig = btn.textContent;
          btn.textContent = '✓ Copied';
          btn.classList.add('copy-success');
          setTimeout(() => {
            btn.textContent = orig;
            btn.classList.remove('copy-success');
          }, 1500);
        });
      }
    });
  });

  // Mask auth toggle
  $drawerContent.querySelector('#mask-auth-toggle')?.addEventListener('change', (ev) => {
    maskAuthInExport = ev.target.checked;
    renderDrawer();
  });

  // Export button handlers
  $drawerContent.querySelector('#export-tracelens')?.addEventListener('click', () => exportTraceLens(e));
  $drawerContent.querySelector('#export-har')?.addEventListener('click', () => exportHAR(allEntries));
  $drawerContent.querySelector('#copy-report')?.addEventListener('click', (ev) => {
    navigator.clipboard.writeText(generateReport(e)).then(() => {
      const btn = ev.currentTarget;
      btn.textContent = '✓ Copied';
      btn.classList.add('copy-success');
      setTimeout(() => {
        btn.textContent = 'Copy Incident Report';
        btn.classList.remove('copy-success');
      }, 1500);
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

  let reqBodyDisplay = '';
  if (e.reqBody) {
    try {
      const parsed = JSON.parse(e.reqBody);
      reqBodyDisplay = `<pre class="json-body">${syntaxHighlight(JSON.stringify(parsed, null, 2))}</pre>`;
    } catch {
      reqBodyDisplay = `<pre class="raw-body">${escapeHtml(e.reqBody.substring(0, 5000))}</pre>`;
    }
  }

  const cookieHeader = e.reqHeaders?.find(h => h.name.toLowerCase() === 'cookie');
  const cookies = cookieHeader ? cookieHeader.value.split(';').map(c => {
    const [name, ...rest] = c.trim().split('=');
    return { name: name.trim(), value: rest.join('=').trim() };
  }).filter(c => c.name) : [];

  let gqlVarsDisplay = '';
  if (e._isGraphQL && e.reqBody) {
    try {
      const body = JSON.parse(e.reqBody);
      if (body.variables && Object.keys(body.variables).length > 0) {
        gqlVarsDisplay = `
        <div class="ov-section">
          <div class="ov-heading">GraphQL Variables</div>
          <div class="body-viewer">
            <pre class="json-body">${syntaxHighlight(JSON.stringify(body.variables, null, 2))}</pre>
          </div>
        </div>`;
      }
    } catch {}
  }

  const sameEndpoint = allEntries.filter(x => x.method === e.method && x.path === e.path).slice(-20);
  let sparklineHtml = '';
  if (sameEndpoint.length > 1) {
    const max = Math.max(...sameEndpoint.map(x => x.dur), 1);
    const points = sameEndpoint.map((x, i) => {
      const px = (i / (sameEndpoint.length - 1)) * 180;
      const py = 28 - (x.dur / max) * 24;
      return `${px.toFixed(1)},${py.toFixed(1)}`;
    }).join(' ');
    const current = sameEndpoint[sameEndpoint.length - 1];
    const prev = sameEndpoint[sameEndpoint.length - 2];
    const trend = current.dur > prev.dur * 1.2 ? '↑ slower' : current.dur < prev.dur * 0.8 ? '↓ faster' : '→ stable';
    const trendColor = current.dur > prev.dur * 1.2 ? 'var(--red)' : current.dur < prev.dur * 0.8 ? 'var(--green)' : 'var(--c8)';
    sparklineHtml = `
    <div class="ov-section">
      <div class="ov-heading">Response Time Trend <span style="font-weight:400;color:var(--c7);font-size:10px">${sameEndpoint.length} requests</span></div>
      <div class="sparkline-wrap">
        <svg width="180" height="32" class="sparkline-svg">
          <polyline points="${points}" fill="none" stroke="var(--amber)" stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round"/>
          <circle cx="${((sameEndpoint.length-1)/(sameEndpoint.length-1))*180}" cy="${(28 - (current.dur/max)*24).toFixed(1)}" r="3" fill="var(--amber)"/>
        </svg>
        <span class="sparkline-trend" style="color:${trendColor}">${trend}</span>
      </div>
    </div>`;
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
    ${gqlVarsDisplay}
    <div class="ov-section">
      <div class="ov-heading">Context</div>
      <div class="ov-grid">
        <div class="ov-cell"><span class="ov-label">Page</span><span class="ov-val">${escapeHtml(e.pageUrl || currentPageUrl || '—')}</span></div>
        <div class="ov-cell"><span class="ov-label">Action</span><span class="ov-val">${burst ? new Date(burst.startTime).toLocaleTimeString() + ' (' + burst.requests.length + ' reqs)' : '—'}</span></div>
        <div class="ov-cell"><span class="ov-label">Captured</span><span class="ov-val">${new Date(e.timestamp).toLocaleTimeString()}</span></div>
      </div>
    </div>
    ${sparklineHtml}
    <div class="ov-section">
      <div class="ov-heading">Request Headers</div>
      <table class="headers-table"><tbody>
        ${(e.reqHeaders || []).map(h => `<tr><td class="h-name">${escapeHtml(h.name)}</td><td class="h-val">${escapeHtml(h.value)}</td></tr>`).join('')}
      </tbody></table>
    </div>
    ${cookies.length > 0 ? `
    <div class="ov-section">
      <div class="ov-heading">Cookies (${cookies.length})</div>
      <table class="headers-table">
        ${cookies.map(c => `<tr><td class="h-name">${escapeHtml(c.name)}</td><td class="h-val">${escapeHtml(c.value.length > 80 ? c.value.substring(0, 80) + '…' : c.value)}</td></tr>`).join('')}
      </table>
    </div>` : ''}
    <div class="ov-section">
      <div class="ov-heading">Response Headers</div>
      <table class="headers-table"><tbody>
        ${(e.resHeaders || []).map(h => `<tr><td class="h-name">${escapeHtml(h.name)}</td><td class="h-val">${escapeHtml(h.value)}</td></tr>`).join('')}
      </tbody></table>
    </div>
    ${reqBodyDisplay ? `
    <div class="ov-section">
      <div class="ov-heading">Request Body</div>
      <div class="body-viewer">${reqBodyDisplay}</div>
    </div>` : ''}
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
  const clamp = v => Math.max(0, v ?? 0);
  const stages = [
    { name: 'DNS', val: clamp(t.dns), raw: t.dns, color: 'var(--blue)' },
    { name: 'TCP', val: clamp(t.connect), raw: t.connect, color: 'var(--c8)' },
    { name: 'SSL', val: clamp(t.ssl), raw: t.ssl, color: 'var(--amber)' },
    { name: 'Server Wait', val: clamp(t.wait), raw: t.wait, color: 'var(--red)' },
    { name: 'Download', val: clamp(t.receive), raw: t.receive, color: 'var(--green)' },
    { name: 'Total', val: total, raw: total, color: 'var(--cW)' },
  ];
  const maxVal = Math.max(1, ...stages.map(s => s.val));
  const slowest = stages.slice(0, 5).reduce((a, b) => a.val > b.val ? a : b);

  return `
    <div class="timing-waterfall">
      ${stages.map(s => {
        const pct = (s.val / maxVal) * 100;
        const isSlowest = s.name === slowest.name && s.name !== 'Total';
        const skipped = s.raw == null || s.raw < 0;
        const label = skipped ? '—' : formatDur(s.val);
        const skipHints = { DNS: 'cached', TCP: 'reused connection', SSL: 'reused connection' };
        const hint = skipped && skipHints[s.name] ? `<span class="timing-skip-hint">${skipHints[s.name]}</span>` : '';
        return `<div class="timing-row ${isSlowest ? 'slowest' : ''}">
          <span class="timing-name">${s.name}</span>
          <div class="timing-bar-wrap">
            <div class="timing-bar" style="width:${pct}%;background:${s.color}"></div>
          </div>
          <span class="timing-val">${label}${hint}</span>
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
      <span class="token-status-badge ${auth.ok === true ? 'valid' : auth.ok === false ? 'expired' : 'unknown'}">${auth.ok === true ? 'VALID' : auth.ok === false ? 'EXPIRED' : auth.isJwt ? 'UNREADABLE' : 'BEARER TOKEN'}</span>
    </div>
    ${auth.expRaw ? `<div class="token-countdown-wrap">
      <div class="token-countdown-bar" id="token-countdown-bar"></div>
      <span class="token-countdown-text" id="token-countdown-text"></span>
    </div>` : ''}
    <div class="ov-section">
      <div class="ov-heading">Raw Token</div>
      <div class="token-raw-wrap">
        <code class="token-raw" id="raw-token" data-full="${escapeHtml(auth.raw || '')}" data-revealed="false">${escapeHtml(auth.raw ? auth.raw.substring(0, 12) + '••••••••••••••••••••••••••••••••' + auth.raw.slice(-8) : '')}</code>
        <button class="copy-btn" id="reveal-token-btn">Reveal</button>
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
    ${auth.ok === false ? '<div class="token-warning">⚠ This token has expired. The server will reject requests using this token.</div>' : ''}
    ${auth.ok === null && !auth.isJwt ? '<div class="token-warning" style="background:rgba(107,114,128,0.1);border-color:rgba(107,114,128,0.3);color:var(--c9)">This is an opaque Bearer token — not a JWT. Claims cannot be decoded.</div>' : ''}
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
    const total = auth.iatRaw ? auth.expRaw - auth.iatRaw : (auth.minsLeft != null ? auth.minsLeft * 60 + (now - auth.expRaw + remaining) : 3600);
    const pct = total > 0 ? Math.min(100, (remaining / total) * 100) : 0;

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
    <div class="replay-mask-row">
      <label class="replay-mask-label">
        <input type="checkbox" id="mask-auth-toggle" ${maskAuthInExport ? 'checked' : ''}>
        Mask auth token in exports
      </label>
    </div>
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
      <div class="ov-heading">Python (requests)</div>
      <div class="code-block-wrap">
        <pre class="code-block" id="python-code">${escapeHtml(toPython(e))}</pre>
        <button class="copy-btn" data-copy="python-code">Copy</button>
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
    if (typeof v1 === 'object' && typeof v2 === 'object' && v1 !== null && v2 !== null && !Array.isArray(v1) && !Array.isArray(v2)) {
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

// --------------- WebSocket Connection Tab ---------------
function renderFramesTab(e) {
  const getHeader = (headers, name) => headers?.find(h => h.name.toLowerCase() === name)?.value || '—';

  const protocol    = getHeader(e.resHeaders, 'sec-websocket-protocol');
  const extensions  = getHeader(e.resHeaders, 'sec-websocket-extensions');
  const wsKey       = getHeader(e.reqHeaders, 'sec-websocket-key');
  const wsAccept    = getHeader(e.resHeaders, 'sec-websocket-accept');
  const wsVersion   = getHeader(e.reqHeaders, 'sec-websocket-version');
  const origin      = getHeader(e.reqHeaders, 'origin');

  return `
    <div class="ov-section">
      <div class="ov-heading">Handshake</div>
      <div class="ov-grid">
        <div class="ov-cell"><span class="ov-label">Status</span><span class="ov-val" style="color:var(--green)">101 Switching Protocols</span></div>
        <div class="ov-cell"><span class="ov-label">Upgrade time</span><span class="ov-val">${formatDur(e.dur)}</span></div>
        <div class="ov-cell"><span class="ov-label">Origin</span><span class="ov-val">${escapeHtml(origin)}</span></div>
        <div class="ov-cell"><span class="ov-label">WS Version</span><span class="ov-val">${escapeHtml(wsVersion)}</span></div>
      </div>
    </div>
    <div class="ov-section">
      <div class="ov-heading">Negotiated</div>
      <div class="ov-grid">
        <div class="ov-cell"><span class="ov-label">Subprotocol</span><span class="ov-val">${escapeHtml(protocol)}</span></div>
        <div class="ov-cell"><span class="ov-label">Extensions</span><span class="ov-val">${escapeHtml(extensions)}</span></div>
        <div class="ov-cell"><span class="ov-label">Key</span><span class="ov-val" style="font-family:var(--font-mono);font-size:11px">${escapeHtml(wsKey)}</span></div>
        <div class="ov-cell"><span class="ov-label">Accept</span><span class="ov-val" style="font-family:var(--font-mono);font-size:11px">${escapeHtml(wsAccept)}</span></div>
      </div>
    </div>
    <div class="ov-section">
      <div class="ov-heading">Frame Payloads</div>
      <div class="diag-text" style="color:var(--c7);font-size:12px;line-height:1.6">
        TraceLens does not capture WebSocket frame payloads. Doing so requires either injecting code into your page or attaching a debugger — both grant access to all page data and break the privacy model.<br><br>
        TraceLens has no <code style="font-family:var(--font-mono)">scripting</code> or <code style="font-family:var(--font-mono)">debugger</code> permission. Only the handshake (above) is observable from the DevTools network API without touching page context.
      </div>
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

  const aiProvider = document.getElementById('setting-ai-provider');
  const aiKeyRow = document.getElementById('ai-key-row');
  const aiModelRow = document.getElementById('ai-model-row');
  const aiNote = document.getElementById('ai-note');
  const aiKeyInput = document.getElementById('setting-ai-key');
  const aiModelInput = document.getElementById('setting-ai-model');

  if (aiProvider) aiProvider.value = AI_PROVIDER;
  if (aiKeyInput) aiKeyInput.value = AI_KEY;
  if (aiModelInput) {
    // Sync model options to provider
    syncAIModelOptions(AI_PROVIDER);
    aiModelInput.value = AI_MODEL;
  }
  const showAI = !!AI_PROVIDER;
  if (aiKeyRow) aiKeyRow.style.display = showAI ? 'flex' : 'none';
  if (aiModelRow) aiModelRow.style.display = showAI ? 'flex' : 'none';
  if (aiNote) aiNote.style.display = showAI ? 'block' : 'none';
}

function syncAIModelOptions(provider) {
  const sel = document.getElementById('setting-ai-model');
  if (!sel) return;
  sel.innerHTML = provider === 'openai'
    ? `<option value="gpt-4o-mini">GPT-4o mini (fast)</option>
       <option value="gpt-4o">GPT-4o (smart)</option>`
    : `<option value="claude-haiku-4-5-20251001">Claude Haiku (fast)</option>
       <option value="claude-sonnet-4-6">Claude Sonnet (smart)</option>`;
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
  document.querySelectorAll('.theme-swatch').forEach(s => {
    s.addEventListener('click', () => {
      THEME = s.dataset.theme;
      applyTheme();
      saveSetting('theme', THEME);
    });
  });

  // AI settings
  document.getElementById('setting-ai-provider')?.addEventListener('change', (ev) => {
    AI_PROVIDER = ev.target.value;
    saveSetting('aiProvider', AI_PROVIDER);
    const show = !!AI_PROVIDER;
    document.getElementById('ai-key-row').style.display = show ? 'flex' : 'none';
    document.getElementById('ai-model-row').style.display = show ? 'flex' : 'none';
    document.getElementById('ai-note').style.display = show ? 'block' : 'none';
    syncAIModelOptions(AI_PROVIDER);
    // Reset to default model for provider
    AI_MODEL = AI_PROVIDER === 'openai' ? 'gpt-4o-mini' : 'claude-haiku-4-5-20251001';
    const sel = document.getElementById('setting-ai-model');
    if (sel) sel.value = AI_MODEL;
    saveSetting('aiModel', AI_MODEL);
  });

  document.getElementById('setting-ai-key')?.addEventListener('change', (ev) => {
    AI_KEY = ev.target.value.trim();
    saveSetting('aiKey', AI_KEY);
  });

  document.getElementById('setting-ai-model')?.addEventListener('change', (ev) => {
    AI_MODEL = ev.target.value;
    saveSetting('aiModel', AI_MODEL);
  });

  document.getElementById('ai-key-show')?.addEventListener('click', () => {
    const input = document.getElementById('setting-ai-key');
    if (!input) return;
    input.type = input.type === 'password' ? 'text' : 'password';
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
  bookmarks.clear();
  recentPaths = new Map();
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
      btn.classList.remove('popping');
      void btn.offsetWidth; // force reflow so animation re-triggers
      btn.classList.add('popping');
      btn.addEventListener('animationend', () => btn.classList.remove('popping'), { once: true });
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
  document.getElementById('export-session-btn')?.addEventListener('click', exportSession);
  document.getElementById('settings-btn')?.addEventListener('click', toggleSettings);
  document.getElementById('shortcuts-btn')?.addEventListener('click', toggleShortcuts);
  document.getElementById('shortcuts-close-btn')?.addEventListener('click', () => {
    $shortcutsOverlay?.classList.remove('visible');
  });
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

  // AI disclosure modal
  document.getElementById('ai-disclosure-cancel')?.addEventListener('click', () => {
    document.getElementById('ai-disclosure')?.classList.remove('visible');
    _pendingAICallback = null;
  });
  document.getElementById('ai-disclosure-confirm')?.addEventListener('click', () => {
    document.getElementById('ai-disclosure')?.classList.remove('visible');
    AI_DISCLOSED = true;
    saveSetting('aiDisclosed', true);
    if (_pendingAICallback) {
      _pendingAICallback();
      _pendingAICallback = null;
    }
  });

  // Periodically update heatmap
  setInterval(updateHeatmap, 2000);
}

document.addEventListener('DOMContentLoaded', init);
