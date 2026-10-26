# TraceLens

> A read-only API debugger inside Chrome DevTools.

TraceLens is a free, open-source Chrome extension that adds a tab beside Console and Network. It groups every request by the click that caused it, times each phase, decodes tokens and writes the incident report for you.

It is for developers debugging their own API calls, and for support engineers working out why a customer's page is slow or failing.

- Source and install: https://github.com/Siddharthachuahan9/TRACELENS
- Chrome Web Store listing: coming soon
- Licence: MIT
- Blog: https://tracelens.site/blog/ (markdown: https://tracelens.site/blog.md)

## One action, read properly

Requests within 800 ms are one burst: the click that caused them. Each is timed by phase and the slowest one is explained in a sentence.

Sample burst at 14:22:08, "Open orders page": 6 requests, 2 slow, 1 error.

| Method | Request | Auth | Status | Total |
| --- | --- | --- | --- | --- |
| GET | /api/v1/users/me | JWT | 200 | 38 ms |
| POST | /api/v1/orders | JWT | 201 | 112 ms |
| GET | /api/v1/analytics/summary | JWT | 200 | 2,400 ms |
| POST | /api/v1/auth/refresh | JWT expired | 401 | 19 ms |
| GQL | GetUserProfile | JWT | 200 | 88 ms |
| GET | /api/v1/orders/8821/items | JWT | 200 | 1,310 ms |

Timing for the selected request, GET /api/v1/analytics/summary (2,400 ms): DNS cached, connect reused, TLS reused, server wait 2,180 ms, download 220 ms.

Finding: "Server wait dominates at 2,180 ms (91%). Likely a slow DB query or N+1 resolver."

Diagnosis for the 401: "Token expired 00:04:12 ago (exp 1718123400). The refresh call itself returned 401; the session cannot recover without a new login."

Settings that change how a burst is read: slow threshold (default 800 ms), show all / slow / errors, group by domain, this page's own requests, API calls only, GraphQL naming, token badges, cascade detection.

How bursts are grouped, in the source: https://github.com/Siddharthachuahan9/TRACELENS/blob/main/tracelens/panel.js

## Everything in one tab

The incident report TraceLens writes for the sample burst, as plain text ready for Jira:

```
Incident: slow orders page
Window: 14:22:08–14:22:11 (3.2 s)
Requests: 6 · Slow: 2 · Errors: 1
Slowest: GET /api/v1/analytics/summary 2,400 ms (server wait 2,180 ms, 91%)
Phases: DNS cached · connect reused · TLS reused · wait 2,180 · download 220
Error: POST /api/v1/auth/refresh 401 (token expired)
Likely cause: slow DB query or N+1 resolver behind /analytics/summary
Cascade: none; the longest slow run at ≥ 1,000 ms is 1
Baseline: /analytics/summary averages 640 ms; this call is +275% (regression, over your +50%)
```

Features:

- **Timing waterfall.** DNS, connect, TLS, server wait and download per request. Cached phases are labelled.
- **JWT inspector.** Bearer tokens decoded as they pass. Subject, scope, issuer, algorithm, and a live countdown to expiry.
- **Diagnosis.** Status code, timing phases and auth state read together and stated in plain English.
- **Cascade alert.** Three or more consecutive slow requests raise an alert before it becomes an outage.
- **Request diff.** A fast and a slow call to the same endpoint, compared field by field.
- **Replay and export.** Copy as cURL, fetch or Python. Export HAR, a .tracelens snapshot, a Postman collection or a Jira-ready incident report.
- **Performance baseline.** Snapshot endpoint averages and get told when a request regresses past your threshold.
- **AI assistant.** Ask Claude or GPT about any request with your own key. Tokens, cookies and raw JWTs are stripped before anything is sent.

Keyboard: J and K step through requests, Space opens the drawer, Esc closes it. B bookmarks, R copies cURL, C copies the report, T cycles the four themes, D groups by domain, and ? lists the rest.

## Nothing leaves unless you ask

The whole manifest, what it asks for and what it does not.

| Permission | TraceLens | What it is for, or would allow | Declared under |
| --- | --- | --- | --- |
| storage | asked for | saving your settings locally | permissions |
| sidePanel | asked for | showing the panel in Chrome's side panel | permissions |
| api.anthropic.com, api.openai.com | host permissions | the AI assistant only, with your own key, tokens and cookies stripped first; never called unless you ask | host_permissions |
| webRequest | not asked for | reading or blocking traffic | permissions |
| declarativeNetRequest | not asked for | modifying traffic | permissions |
| scripting | not asked for | injecting code into pages | permissions |
| content scripts | none | touching the page at all | content_scripts |

Captured data lives in browser memory; close DevTools and it is gone. No analytics, no telemetry. The only outbound calls are the ones you make to the AI provider you choose, with your own key. Every line is on GitHub, unminified. MIT.

Read the manifest: https://github.com/Siddharthachuahan9/TRACELENS/blob/main/tracelens/manifest.json

## Running in sixty seconds

1. **Clone it.** One folder, no build step. What Chrome loads is what you can read.

   ```
   git clone https://github.com/Siddharthachuahan9/TRACELENS
   ```

2. **Load it unpacked.** Open `chrome://extensions`, switch on Developer mode, press Load unpacked and choose the `tracelens/` folder.

3. **Open DevTools on any page.** Press F12. The TraceLens tab sits beside Console and Network and starts capturing at once.

No build step. No npm. No account.

## Free, open source, read-only

It is free, open source and read-only. Read the code, then install it.

- GitHub: https://github.com/Siddharthachuahan9/TRACELENS
- Issues: https://github.com/Siddharthachuahan9/TRACELENS/issues
- Blog: https://tracelens.site/blog/

TraceLens, a read-only API debugger for Chrome DevTools. MIT License. Made by Sidheart, 2026.
