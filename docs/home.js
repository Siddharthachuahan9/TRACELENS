/* TraceLens homepage: live burst, controls, report, entrances. */
document.documentElement.classList.add('js');
/* TraceLens prototype "quiet instrument": data, pure renderers, and the wiring.
   The renderers are pure string functions so build.mjs can pre-render the no-script state. */
(function () {
  var TL = {};
  var fmt = function (n) { return typeof n === 'number' ? n.toLocaleString('en-US') : n; };
  var esc = function (s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); };

  /* ---------- the sample burst (copy deck) ---------- */
  TL.BURST = [
    { m: 'GET', p: '/api/v1/users/me', host: 'api.example.com', s: 200, t: 38, ph: { dns: 'cached', con: 'reused', tls: 'reused', wait: 31, dl: 7 }, tok: 'ok', api: true },
    { m: 'POST', p: '/api/v1/orders', host: 'api.example.com', s: 201, t: 112, ph: { dns: 'cached', con: 'reused', tls: 'reused', wait: 98, dl: 14 }, tok: 'ok', api: true },
    { m: 'GET', p: '/api/v1/analytics/summary', host: 'api.example.com', s: 200, t: 2400, ph: { dns: 'cached', con: 'reused', tls: 'reused', wait: 2180, dl: 220 }, tok: 'ok', api: true },
    { m: 'POST', p: '/api/v1/auth/refresh', host: 'api.example.com', s: 401, t: 19, ph: { dns: 'cached', con: 'reused', tls: 'reused', wait: 16, dl: 3 }, tok: 'expired', api: true },
    { m: 'GQL', p: 'GetUserProfile', raw: '/graphql', host: 'api.example.com', s: 200, t: 88, ph: { dns: 'cached', con: 'reused', tls: 'reused', wait: 74, dl: 14 }, tok: 'ok', api: true },
    { m: 'GET', p: '/api/v1/orders/8821/items', host: 'api.example.com', s: 200, t: 1310, ph: { dns: 'cached', con: 'reused', tls: 'reused', wait: 1205, dl: 105 }, tok: 'ok', api: true }
  ];
  /* static files the same click loaded; shown only when "API calls only" is off (sample) */
  TL.STATIC = [
    { m: 'GET', p: '/assets/orders.4f2c91.js', host: 'app.example.com', s: 200, t: 64, ph: { dns: 'cached', con: 'reused', tls: 'reused', wait: 21, dl: 43 }, api: false, after: 0 },
    { m: 'GET', p: '/assets/orders.9b1e.css', host: 'app.example.com', s: 200, t: 31, ph: { dns: 'cached', con: 'reused', tls: 'reused', wait: 18, dl: 13 }, api: false, after: 0 },
    { m: 'GET', p: '/img/empty-state.svg', host: 'app.example.com', s: 200, t: 12, ph: { dns: 'cached', con: 'reused', tls: 'reused', wait: 9, dl: 3 }, api: false, after: 5 }
  ];
  TL.DEFAULT = { thr: 800, show: 'all', api: true, gql: true, domain: false, tokens: true, cascade: true, own: false, sel: 2 };

  TL.list = function (st, own) {
    if (st.own && own) return own.slice();
    var out = [];
    TL.BURST.forEach(function (r, i) {
      out.push(Object.assign({ i: i }, r));
      if (!st.api) TL.STATIC.forEach(function (x, k) { if (x.after === i) out.push(Object.assign({ i: 'x' + k }, x)); });
    });
    return out;
  };

  TL.diagnose = function (r, thr) {
    if (r.s === 401 && r.tok === 'expired') return 'Token expired 00:04:12 ago (exp 1718123400). The refresh call itself returned 401; the session cannot recover without a new login.';
    var w = typeof r.ph.wait === 'number' ? r.ph.wait : null, d = typeof r.ph.dl === 'number' ? r.ph.dl : null;
    if (w == null) return (r.t >= thr ? 'Slow at ' + fmt(r.t) + ' ms against your ' + fmt(thr) + ' ms threshold. ' : 'Finished in ' + fmt(r.t) + ' ms. ') + 'This server does not share its timing phases (no Timing-Allow-Origin), so only the total is known.';
    var wp = Math.round(w / r.t * 100), dp = Math.round(d / r.t * 100);
    if (r.t >= thr && wp >= 85) return 'Server wait dominates at ' + fmt(w) + ' ms (' + wp + '%). Likely a slow DB query or N+1 resolver.';
    var setup = ['dns', 'con', 'tls'].reduce(function (n, k) { return n + (typeof r.ph[k] === 'number' ? r.ph[k] : 0); }, 0), sp = Math.round(setup / r.t * 100);
    if (r.t >= thr && sp >= 40) return 'Connection setup (DNS, connect, TLS) takes ' + fmt(setup) + ' ms (' + sp + '%). A cold connection; a preconnect hint would save most of it.';
    if (r.t >= thr && dp >= 70) return 'Download takes ' + dp + '% of ' + fmt(r.t) + ' ms. Large payload, consider pagination.';
    if (r.t >= thr) return 'Slow at ' + fmt(r.t) + ' ms against your ' + fmt(thr) + ' ms threshold; server wait is ' + wp + '% of it.';
    return 'Clean request, no anomalies. ' + fmt(r.t) + ' ms is under your ' + fmt(thr) + ' ms threshold.';
  };

  var mcls = function (m) { return m === 'GET' ? 'method-get' : m === 'POST' ? 'method-post' : 'method-gql'; };
  var scls = function (s) { return typeof s !== 'number' ? 'status-na' : s >= 400 ? 'status-4xx' : 'status-2xx'; };
  var dcls = function (t, thr) { return t >= thr ? 'dur-slow' : t >= thr * 0.6 ? 'dur-warn' : 'dur-ok'; };

  TL.row = function (r, st, max, idx) {
    var slow = r.t >= st.thr, err = typeof r.s === 'number' && r.s >= 400;
    var edge = err ? 'edge-red' : slow ? 'edge-red' : r.t >= st.thr * 0.6 ? 'edge-yellow' : 'edge-green';
    var m = r.m === 'GQL' && !st.gql ? 'POST' : r.m;
    var name = r.m === 'GQL' && !st.gql ? r.raw : r.p;
    var tok = st.tokens && r.tok ? '<span class="token-badge ' + (r.tok === 'expired' ? 'token-expired' : 'token-ok') + '">' + (r.tok === 'expired' ? 'JWT expired' : 'JWT') + '</span>' : '';
    var w = Math.max(0.04, Math.min(1, r.t / max));
    return '<button type="button" class="req-row' + (String(st.sel) === String(r.i) ? ' selected' : '') + '" data-i="' + r.i + '" style="--n:' + idx + '">' +
      '<span class="req-edge ' + edge + '"></span>' +
      '<span class="req-method ' + mcls(m) + '">' + m + '</span>' +
      '<code class="req-path">' + esc(name) + '</code>' + tok +
      '<span class="req-status ' + scls(r.s) + '">' + (r.s || '—') + '</span>' +
      '<span class="req-dur ' + dcls(r.t, st.thr) + '">' + fmt(r.t) + ' ms<span class="dur-bar"><span class="dur-fill ' + dcls(r.t, st.thr) + '" style="transform:scaleX(' + w.toFixed(3) + ')"></span></span></span>' +
      (String(st.sel) === String(r.i) ? '<svg class="pointer" width="16" height="22" viewBox="0 0 16 22" aria-hidden="true"><path d="M1 1v17l4.5-4.2 3 6.7 2.6-1.2-3-6.6H14z" fill="#111" stroke="#fff" stroke-width="1.2" stroke-linejoin="round"/></svg>' : '') +
      '</button>';
  };

  TL.renderList = function (st, own) {
    var rows = TL.list(st, own);
    var max = Math.max.apply(null, rows.map(function (r) { return r.t; }));
    var shown = rows.filter(function (r) { return st.show === 'slow' ? r.t >= st.thr : st.show === 'errors' ? (typeof r.s === 'number' && r.s >= 400) : true; });
    var slow = rows.filter(function (r) { return r.t >= st.thr; }).length, errs = rows.filter(function (r) { return typeof r.s === 'number' && r.s >= 400; }).length;
    var head = function (label, time, list) {
      var s = list.filter(function (r) { return r.t >= st.thr; }).length, e = list.filter(function (r) { return typeof r.s === 'number' && r.s >= 400; }).length;
      return '<div class="burst-header"><span class="burst-time">' + time + '</span><span class="burst-label">' + esc(label) + '</span><span class="burst-chip">' + list.length + ' req</span>' +
        (s ? '<span class="burst-chip chip-slow">' + s + ' slow</span>' : '') + (e ? '<span class="burst-chip chip-errors">' + e + ' error' + (e > 1 ? 's' : '') + '</span>' : '') + '</div>';
    };
    var html = '', n = 0;
    // cascade: longest run of consecutive slow requests, in capture order
    var run = 0, best = 0; rows.forEach(function (r) { run = r.t >= st.thr ? run + 1 : 0; best = Math.max(best, run); });
    var hostOf = rows.length ? rows[0].host : '';
    var alert = st.cascade && best >= 3 ? '<div class="cascade-alert">' + best + ' consecutive slow requests (&ge; ' + fmt(st.thr) + ' ms) on ' + esc(hostOf) + '. Possible downstream degradation.</div>' : '';
    if (st.domain) {
      var hosts = []; shown.forEach(function (r) { if (hosts.indexOf(r.host) < 0) hosts.push(r.host); });
      hosts.forEach(function (h) {
        var list = shown.filter(function (r) { return r.host === h; });
        var avg = Math.round(list.reduce(function (a, r) { return a + r.t; }, 0) / list.length);
        html += '<div class="burst-header domain"><span class="burst-label">' + esc(h) + '</span><span class="burst-chip">' + list.length + ' req</span><span class="burst-chip">avg ' + fmt(avg) + ' ms</span></div>';
        list.forEach(function (r) { html += TL.row(r, st, max, n++); });
      });
    } else {
      html += head(st.own && own ? 'This page, loading' : 'Open orders page', st.own && own ? (own.time || 'now') : '14:22:08', rows);
      shown.forEach(function (r) { html += TL.row(r, st, max, n++); });
    }
    if (!shown.length) html += '<p class="empty-sub">Nothing matches this filter at ' + fmt(st.thr) + ' ms.</p>';
    return { html: alert + html, slow: slow, errs: errs, count: rows.length };
  };

  TL.renderDrawer = function (st, own) {
    var rows = TL.list(st, own);
    var r = rows.filter(function (x) { return String(x.i) === String(st.sel); })[0] || rows[0];
    if (!r) return '';
    var bars = [['DNS', r.ph.dns], ['Connect', r.ph.con], ['TLS', r.ph.tls], ['Server wait', r.ph.wait], ['Download', r.ph.dl]];
    var h = '<div class="drawer-tabs"><span class="drawer-tab">Overview</span><span class="drawer-tab active">Timing</span><span class="drawer-tab">' + (r.tok ? 'Token' : 'Replay') + '</span><span class="drawer-tab">Report</span></div>';
    h += '<div class="drawer-path"><span class="req-method ' + mcls(r.m === 'GQL' && !st.gql ? 'POST' : r.m) + '">' + (r.m === 'GQL' && !st.gql ? 'POST' : r.m) + '</span><code>' + esc(r.m === 'GQL' && !st.gql ? r.raw : r.p) + '</code><span class="drawer-total">' + fmt(r.t) + ' ms</span></div>';
    h += '<div class="wf">';
    var lead = 0;
    bars.forEach(function (b) {
      var v = b[1], num = typeof v === 'number';
      var w = num ? Math.max(0.006, v / r.t) : 0;
      h += '<div class="wf-row"><span class="wf-name">' + b[0] + '</span><span class="wf-track">' + (num ? '<span class="wf-bar' + (b[0] === 'Server wait' && r.t >= st.thr ? ' hot' : '') + '" style="left:' + (lead * 100).toFixed(2) + '%;width:' + (w * 100).toFixed(2) + '%"></span>' : '') + '</span><span class="wf-val">' + (num ? fmt(v) + ' ms' : esc(v || 'hidden')) + '</span></div>';
      if (num) lead += w;
    });
    h += '</div><p class="finding">' + esc(TL.diagnose(r, st.thr)) + '</p>';
    if (r.tok === 'expired' && st.tokens) h += '<p class="claims">sub user_8x4k · iss https://auth.example.com · alg RS256 · scope orders:read orders:write · <b>expired 4 min ago</b></p>';
    return h;
  };

  /* ---------- the incident report (features) ---------- */
  TL.RDEFAULT = { phases: true, claims: false, cause: true, thr: 1000, diff: false, fmt: 'jira', base: 50, ai: 'off' };
  TL.report = function (o) {
    var ts = [38, 112, 2400, 19, 88, 1310];
    var slow = ts.filter(function (t) { return t >= o.thr; }).length;
    var run = 0, best = 0; ts.forEach(function (t) { run = t >= o.thr ? run + 1 : 0; best = Math.max(best, run); });
    var over = Math.round((2400 / 640 - 1) * 100);
    if (o.fmt === 'curl') {
      return "curl 'https://api.example.com/api/v1/analytics/summary' \\\n  -H 'Accept: application/json' \\\n  -H 'Authorization: Bearer eyJhbG••••••Qssw5c' \\\n  --compressed\n\n# 200 in 2,400 ms (server wait 2,180 ms, 91%)\n# Token masked. Reveal it in the Token tab before running.";
    }
    var L = [];
    L.push(['Incident', 'slow orders page']);
    L.push(['Window', '14:22:08–14:22:11 (3.2 s)']);
    L.push(['Requests', '6 · Slow: ' + slow + ' · Errors: 1']);
    L.push(['Slowest', 'GET /api/v1/analytics/summary 2,400 ms' + (o.phases ? ' (server wait 2,180 ms, 91%)' : '')]);
    if (o.phases) L.push(['Phases', 'DNS cached · connect reused · TLS reused · wait 2,180 · download 220']);
    L.push(['Error', 'POST /api/v1/auth/refresh 401 (token expired)']);
    if (o.claims) L.push(['Token', 'sub user_8x4k · iss https://auth.example.com · alg RS256 · scope orders:read orders:write · expired 4 min ago']);
    if (o.cause) L.push(['Likely cause', 'slow DB query or N+1 resolver behind /analytics/summary']);
    L.push(['Cascade', best >= 3 ? best + ' consecutive slow requests (≥ ' + fmt(o.thr) + ' ms)' : 'none; the longest slow run at ≥ ' + fmt(o.thr) + ' ms is ' + best]);
    if (o.diff) L.push(['Diff', 'same endpoint at 14:19:40 took 310 ms; server wait 262 → 2,180 ms (+1,918), body 48.1 → 48.2 KB']);
    L.push(['Baseline', '/analytics/summary averages 640 ms; this call is +' + over + '% ' + (over > o.base ? '(regression, over your +' + o.base + '%)' : '(within your +' + o.base + '% allowance)')]);
    if (o.ai !== 'off') L.push(['AI', 'asked ' + (o.ai === 'claude' ? 'Claude' : 'GPT') + ' with your key; Authorization, cookies and the raw JWT stripped first']);
    if (o.fmt === 'md') return '## Incident: slow orders page\n\n' + L.slice(1).map(function (l) { return '- **' + l[0] + ':** ' + l[1]; }).join('\n');
    return L.map(function (l) { return l[0] + ': ' + l[1]; }).join('\n');
  };

  /* ---------- the margin instrument: this page's own navigation timing and activity ---------- */
  TL.GSAMPLE = { load: 355, ph: { dns: 14, con: 22, tls: 31, wait: 96, dl: 18 }, buckets: [0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,4,3], count: 7, slow: 0 };
  TL.gutterWf = function (g) {
    var rows = [['DNS', g.ph.dns, 'cached'], ['Connect', g.ph.con, 'reused'], ['TLS', g.ph.tls, 'reused'], ['Server wait', g.ph.wait, '0 ms'], ['Download', g.ph.dl, '0 ms']];
    var span = rows.reduce(function (n, r) { return n + (r[1] > 0 ? r[1] : 0); }, 0) || 1, lead = 0, h = '';
    rows.forEach(function (r) {
      var v = r[1] > 0 ? r[1] : 0, w = v / span;
      h += '<div class="wf-row"><span class="wf-name">' + r[0] + '</span><span class="wf-track">' + (v ? '<span class="wf-bar' + (r[0] === 'Server wait' && v >= 800 ? ' hot' : '') + '" style="left:' + (lead * 100).toFixed(1) + '%;width:' + Math.max(2, w * 100).toFixed(1) + '%"></span>' : '') + '</span><span class="wf-val">' + (v ? fmt(Math.round(v)) + ' ms' : r[2]) + '</span></div>';
      lead += w;
    });
    return h;
  };
  TL.gutterHeat = function (b) {
    var max = Math.max(3, Math.max.apply(null, b));
    return b.map(function (n) { return '<span class="hb' + (n >= 3 ? ' hot' : n ? ' warm' : '') + '" style="transform:scaleY(' + (n ? Math.max(0.18, n / max) : 0.08).toFixed(2) + ')"></span>'; }).join('');
  };
  TL.gutterCount = function (c, s) { return c + ' request' + (c === 1 ? '' : 's') + ' so far, ' + s + ' slow'; };

  if (typeof globalThis !== 'undefined') globalThis.TL = TL;
  if (typeof document === 'undefined') return;

  /* ================= the page ================= */
  var reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;

  /* entrances: elements are visible at rest; a class plays the arrival as each one enters */
  var rise = [].slice.call(document.querySelectorAll('[data-rise]'));
  if ('IntersectionObserver' in window && !reduce) {
    var io = new IntersectionObserver(function (es) {
      es.forEach(function (e) { if (e.isIntersecting) { e.target.classList.add('in'); io.unobserve(e.target); } });
    }, { rootMargin: '0px 0px -6% 0px' });
    rise.forEach(function (el) { if (!el.closest('.hero') && !el.closest('.gutter')) io.observe(el); });
  }
  requestAnimationFrame(function () { document.documentElement.classList.add('loaded'); });

  /* ---------- showcase ---------- */
  var st = Object.assign({}, TL.DEFAULT);
  var own = null;
  var listEl = document.getElementById('demo-list'), drawerEl = document.getElementById('demo-drawer');
  var caption = document.getElementById('demo-caption');
  function ownTrace() {
    var nav = performance.getEntriesByType('navigation')[0];
    var res = performance.getEntriesByType('resource');
    var all = (nav ? [nav] : []).concat(res).filter(function (e) { return e.duration > 0; });
    var t0 = all.length ? Math.min.apply(null, all.map(function (e) { return e.startTime; })) : 0;
    var rows = all.map(function (e, k) {
      var u; try { u = new URL(e.name); } catch (x) { u = { hostname: location.hostname, pathname: e.name }; }
      var hasPh = e.requestStart > 0;
      var ph = hasPh ? {
        dns: e.domainLookupEnd - e.domainLookupStart > 0 ? Math.round(e.domainLookupEnd - e.domainLookupStart) : 'cached',
        con: e.connectEnd - e.connectStart > 0 ? Math.round(e.connectEnd - e.connectStart) : 'reused',
        tls: e.secureConnectionStart > 0 ? Math.round(e.connectEnd - e.secureConnectionStart) : 'reused',
        wait: Math.round(Math.max(0, e.responseStart - e.requestStart)),
        dl: Math.round(Math.max(0, e.responseEnd - e.responseStart))
      } : { dns: 'hidden', con: 'hidden', tls: 'hidden', wait: 'hidden', dl: 'hidden' };
      var p = u.pathname.length > 30 ? '…' + u.pathname.slice(-29) : u.pathname;
      if (u.hostname !== location.hostname) p = u.hostname.replace(/^www\./, '') + p;
      var isDoc = e.entryType === 'navigation';
      var dur = isDoc ? e.responseEnd - e.startTime : e.duration;
      return { i: 'o' + k, m: 'GET', p: isDoc ? (u.pathname.split('/').pop() || 'index.html') + ' (this page)' : (p || '/'), host: u.hostname || 'this page', s: e.responseStatus || '', t: Math.max(1, Math.round(dur)), ph: ph, start: e.startTime - t0 };
    }).sort(function (a, b) { return a.start - b.start; }).slice(0, 9);
    var d = new Date(); rows.time = d.toTimeString().slice(0, 8);
    return rows;
  }
  function slowest(rows) { return rows.reduce(function (a, r) { return r.t > a.t ? r : a; }, rows[0]); }
  function drawDemo(animate) {
    if (!listEl) return;
    var out = TL.renderList(st, own);
    listEl.innerHTML = out.html;
    drawerEl.innerHTML = TL.renderDrawer(st, own);
    if (caption) {
      caption.textContent = st.own && own
        ? 'Your browser, just now: ' + own.length + ' requests this page made while it loaded. Slowest: ' + slowest(own).p + ' at ' + fmt(slowest(own).t) + ' ms.'
        : 'Sample burst: one click on “Open orders”, ' + out.count + ' requests, ' + out.slow + ' slow at ' + fmt(st.thr) + ' ms, ' + out.errs + ' error.';
    }
    if (animate && !reduce) listEl.classList.remove('fresh'), void listEl.offsetWidth, listEl.classList.add('fresh');
  }
  /* the hero's own instance: the same burst, rows clickable, not tied to the showcase controls */
  var hst = Object.assign({}, TL.DEFAULT);
  var hList = document.getElementById('hero-list'), hDrawer = document.getElementById('hero-drawer');
  if (hList) hList.addEventListener('click', function (e) {
    var b = e.target.closest('.req-row'); if (!b) return;
    hst.sel = b.getAttribute('data-i');
    hList.innerHTML = TL.renderList(hst, null).html; hDrawer.innerHTML = TL.renderDrawer(hst, null);
    var again = hList.querySelector('.req-row.selected'); if (again) again.focus({ preventScroll: true });
  });

  if (listEl) {
    listEl.addEventListener('click', function (e) {
      var b = e.target.closest('.req-row'); if (!b) return;
      st.sel = b.getAttribute('data-i'); drawDemo(false);
      var again = listEl.querySelector('.req-row.selected'); if (again) again.focus({ preventScroll: true });
    });
    var bind = function (id, ev, fn) { var el = document.getElementById(id); if (el) el.addEventListener(ev, function () { fn(el); drawDemo(true); }); };
    bind('c-thr', 'input', function (el) { st.thr = +el.value; document.getElementById('c-thr-v').textContent = fmt(st.thr) + ' ms'; });
    bind('c-api', 'change', function (el) { st.api = el.checked; });
    bind('c-gql', 'change', function (el) { st.gql = el.checked; });
    bind('c-domain', 'change', function (el) { st.domain = el.checked; });
    bind('c-tok', 'change', function (el) { st.tokens = el.checked; });
    bind('c-cascade', 'change', function (el) { st.cascade = el.checked; });
    bind('c-own', 'change', function (el) {
      st.own = el.checked;
      if (st.own) { own = ownTrace(); if (!own.length) { st.own = false; el.checked = false; return; } st.sel = slowest(own).i; }
      else st.sel = 2;
    });
    [].forEach.call(document.querySelectorAll('input[name="c-show"]'), function (r) {
      r.addEventListener('change', function () { st.show = r.value; drawDemo(true); });
    });
    var more = document.getElementById('c-more');
    if (more) more.addEventListener('click', function () {
      var p = document.getElementById('controls'); var open = p.classList.toggle('all');
      more.textContent = open ? 'Show fewer controls' : 'Show all eight controls'; more.setAttribute('aria-expanded', open);
    });
  }

  /* ---------- margin instrument (desktop gutter) ---------- */
  var gEl = document.getElementById('gutter');
  if (gEl && window.performance && performance.getEntriesByType) {
    var gLoad = document.getElementById('g-load'), gWf = document.getElementById('g-wf'), gHeat = document.getElementById('g-heat'), gCount = document.getElementById('g-count');
    var drawNav = function () {
      var n = performance.getEntriesByType('navigation')[0]; if (!n) return;
      var end = n.loadEventEnd > 0 ? n.loadEventEnd : n.domContentLoadedEventEnd > 0 ? n.domContentLoadedEventEnd : n.responseEnd;
      gLoad.textContent = fmt(Math.max(1, Math.round(end - n.startTime)));
      var has = n.requestStart > 0;
      gWf.innerHTML = TL.gutterWf({ ph: {
        dns: n.domainLookupEnd - n.domainLookupStart, con: n.connectEnd - n.connectStart - (n.secureConnectionStart > 0 ? n.connectEnd - n.secureConnectionStart : 0),
        tls: n.secureConnectionStart > 0 ? n.connectEnd - n.secureConnectionStart : 0,
        wait: has ? n.responseStart - n.requestStart : 0, dl: n.responseEnd - n.responseStart } });
    };
    var drawHeat = function () {
      var now = performance.now(), b = []; for (var i = 0; i < 30; i++) b.push(0);
      var res = performance.getEntriesByType('resource'), all = performance.getEntriesByType('navigation').concat(res), slow = 0;
      all.forEach(function (e) {
        if (e.duration >= 800) slow++;
        var age = now - e.startTime; if (age < 0 || age >= 60000) return;
        b[29 - Math.floor(age / 2000)]++;
      });
      gHeat.innerHTML = TL.gutterHeat(b);
      gCount.textContent = TL.gutterCount(all.length, slow);
    };
    drawNav(); drawHeat();
    if (document.readyState !== 'complete') addEventListener('load', function () { setTimeout(function () { drawNav(); drawHeat(); }, 0); });
    if ('PerformanceObserver' in window) { try { new PerformanceObserver(function () { drawHeat(); }).observe({ type: 'resource', buffered: false }); } catch (x) {} }
    var tick = setInterval(function () { if (!document.hidden) drawHeat(); }, 2000);
    var gLink = document.getElementById('g-open');
    if (gLink) gLink.addEventListener('click', function (e) {
      e.preventDefault();
      var t = document.getElementById('trace'); if (t) t.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'start' });
      var c = document.getElementById('c-own'); if (c && !c.checked) { c.checked = true; c.dispatchEvent(new Event('change')); }
    });
  }

  /* ---------- features: the report the reader configures ---------- */
  var ro = Object.assign({}, TL.RDEFAULT);
  var rep = document.getElementById('report-text');
  function drawReport() {
    if (!rep) return;
    var next = TL.report(ro);
    if (next === rep.textContent) return;
    rep.textContent = next;
    if (!reduce) { rep.classList.remove('swap'); void rep.offsetWidth; rep.classList.add('swap'); }
  }
  var rb = function (id, ev, fn) { var el = document.getElementById(id); if (el) el.addEventListener(ev, function () { fn(el); drawReport(); }); };
  rb('f-phases', 'change', function (el) { ro.phases = el.checked; });
  rb('f-claims', 'change', function (el) { ro.claims = el.checked; });
  rb('f-cause', 'change', function (el) { ro.cause = el.checked; });
  rb('f-thr', 'input', function (el) { ro.thr = +el.value; document.getElementById('f-thr-v').textContent = fmt(ro.thr) + ' ms'; });
  rb('f-diff', 'change', function (el) { ro.diff = el.checked; });
  rb('f-base', 'input', function (el) { ro.base = +el.value; document.getElementById('f-base-v').textContent = '+' + ro.base + '%'; });
  [['f-fmt', 'fmt'], ['f-ai', 'ai']].forEach(function (p) {
    [].forEach.call(document.querySelectorAll('input[name="' + p[0] + '"]'), function (r) {
      r.addEventListener('change', function () { ro[p[1]] = r.value; drawReport(); });
    });
  });
  var copy = document.getElementById('copy-report');
  if (copy) copy.addEventListener('click', function () {
    var done = function () { copy.textContent = 'Copied'; setTimeout(function () { copy.textContent = 'Copy incident report'; }, 1600); };
    if (navigator.clipboard) navigator.clipboard.writeText(rep.textContent).then(done, done); else done();
  });

  /* ---------- how it works: the stage follows the statement nearest the centre ---------- */
  var steps = [].slice.call(document.querySelectorAll('.step'));
  var stage = document.getElementById('stage');
  if (steps.length && stage && 'IntersectionObserver' in window) {
    var so = new IntersectionObserver(function (es) {
      es.forEach(function (e) {
        if (!e.isIntersecting) return;
        var n = e.target.getAttribute('data-step');
        steps.forEach(function (s) { s.classList.toggle('active', s === e.target); });
        stage.setAttribute('data-state', n);
      });
    }, { rootMargin: '-45% 0px -45% 0px' });
    steps.forEach(function (s) { so.observe(s); });
  }
})();

