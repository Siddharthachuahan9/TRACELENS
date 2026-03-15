<p align="center">
  <img src="tracelens/icons/icon128.png" alt="TraceLens" width="80" />
</p>

<h1 align="center">TraceLens</h1>

<p align="center">
  <strong>See what your APIs are really doing.</strong><br />
  A read-only network debugging tool for developers and support engineers.<br />
  Runs entirely in the browser — no servers, no accounts, no data leaves your machine.
</p>

<p align="center">
  <a href="https://tracelens.site">tracelens.site</a> ·
  <a href="#installation">Install</a> ·
  <a href="#features">Features</a> ·
  <a href="#how-it-works">How It Works</a> ·
  <a href="#keyboard-shortcuts">Shortcuts</a> ·
  <a href="#architecture">Architecture</a> ·
  <a href="#contributing">Contributing</a>
</p>

---

## Screenshot

<!-- Replace with actual screenshot of TraceLens in action -->

<img width="552" height="822" alt="Screenshot 2026-03-12 at 1 01 39 AM" src="https://github.com/user-attachments/assets/8867d498-0c62-4ade-ab3b-35d3ee51fd6a" />

*TraceLens running inside Chrome DevTools — timeline view with burst grouping, health gauge, and activity heatmap.*

---

## What Is TraceLens?

TraceLens is a Chrome DevTools extension that gives developers and support engineers instant visibility into API behavior. It captures network requests in real time, groups them by user action, diagnoses performance issues, decodes JWTs, detects cascading failures, and generates shareable incident reports — all without leaving the browser.

**Zero infrastructure. Zero dependencies. Zero data exfiltration.**

---

## Features

### Core Inspection
- **Real-time request capture** — Intercepts API calls as they happen via `chrome.devtools.network`
- **Smart filtering** — Automatically filters out static assets (images, fonts, CSS, JS) to focus on API traffic
- **GraphQL awareness** — Detects GraphQL requests, extracts operation names, and labels mutations/subscriptions
- **JSON syntax highlighting** — Response bodies are parsed and color-coded for readability
- **Request/response headers** — Full header inspection for both directions

### Performance Analysis
- **Timing waterfall** — Visual breakdown of DNS, TCP, SSL, Server Wait, and Download phases
- **Slow request detection** — Configurable threshold (default 800ms) flags slow endpoints
- **Activity heatmap** — 60-second rolling heatmap showing request density over time
- **Health gauge** — Real-time health score based on error rate and slow request ratio
- **Cascade detection** — Alerts when 3+ consecutive requests exceed the slow threshold

### Token & Auth
- **JWT decoding** — Automatically extracts and decodes Bearer tokens from Authorization headers
- **Live countdown** — Real-time countdown bar showing token time-to-expiry
- **Claim inspection** — Subject, email, role, algorithm, issued-at, and expiry fields
- **Expiry warnings** — Visual badge on each request showing token validity status

### Diagnostics Engine
- **Rule-based diagnosis** — Analyzes status codes, timing phases, and auth state to produce human-readable explanations
- **Retry detection** — Identifies duplicate requests to the same endpoint within 5 seconds
- **Pattern matching** — Recognizes slow DB queries (server wait dominance), DNS issues, SSL overhead, large payloads, rate limiting, and more

### Export & Sharing
- **cURL command** — One-click copy of the request as a cURL command
- **fetch() snippet** — JavaScript fetch() code ready to paste into a console
- **Postman collection** — Export as a Postman-compatible JSON collection
- **HAR export** — Standard HTTP Archive (HAR 1.2) file with all captured requests
- **`.tracelens` snapshot** — Self-contained JSON with request data, burst context, and diagnosis
- **Incident report** — Jira-ready plaintext report with environment, endpoint, auth status, trace ID, and diagnosis

### Comparison
- **Request diff** — Compare fast vs slow requests to the same endpoint side by side
- **Response body diff** — Highlights added, removed, and changed fields between responses

### Workflow
- **Burst grouping** — Requests within 800ms of each other are grouped as a single user action
- **Bookmarks** — Stamp labeled bookmarks into the timeline to mark important moments
- **Keyboard-first navigation** — Full keyboard shortcut support (vim-style J/K navigation)
- **Persistent settings** — All preferences saved to `chrome.storage.local`

---

## Screenshot Gallery


### Timing Waterfall
<!-- Replace with actual screenshot -->
<img width="539" height="295" alt="Screenshot 2026-03-12 at 1 02 27 AM" src="https://github.com/user-attachments/assets/9f4555a6-2a60-4627-b740-66c79e49dc9f" />

*Visual breakdown of request phases with the slowest stage highlighted.*

### one click report
<!-- Replace with actual screenshot -->
<img width="541" height="364" alt="Screenshot 2026-03-12 at 1 03 32 AM" src="https://github.com/user-attachments/assets/411807b8-3017-4cf0-a1ea-76f3ad8f67f9" />

*Automated root-cause analysis based on status codes, timing distribution, and auth state.*

---

## How It Works

```
┌─────────────────────────────────────────────────────┐
│                    Chrome Browser                    │
│                                                     │
│   ┌─────────────┐    ┌───────────────────────────┐  │
│   │  Web Page    │    │  DevTools                  │  │
│   │             │    │  ┌───────────────────────┐ │  │
│   │  Network    │───▶│  │  TraceLens Panel      │ │  │
│   │  Traffic    │    │  │                       │ │  │
│   │             │    │  │  Capture → Analyze    │ │  │
│   │             │    │  │  → Render → Export    │ │  │
│   └─────────────┘    │  └───────────────────────┘ │  │
│                      └───────────────────────────────┘  │
│                                                     │
│   Data never leaves the browser.                    │
└─────────────────────────────────────────────────────┘
```

1. **Capture** — `chrome.devtools.network.onRequestFinished` intercepts completed requests
2. **Enrich** — Each request is augmented with JWT data, retry detection, GraphQL naming, and burst assignment
3. **Analyze** — The diagnosis engine evaluates status codes, timing phases, and auth state
4. **Render** — Vanilla JS renders the timeline, drawer tabs, heatmap, and gauge in real time
5. **Export** — One-click export to cURL, fetch(), Postman, HAR, `.tracelens`, or incident report

---

## Installation

### Manual Installation (Chrome)

1. Clone this repository:
   ```bash
   git clone https://github.com/Siddharthachuahan9/TRACELENS.git
   ```

2. Open Chrome and navigate to `chrome://extensions`

3. Enable **Developer mode** (toggle in the top-right corner)

4. Click **Load unpacked**

5. Select the `tracelens/` folder from the cloned repository

6. Open any website → open DevTools (`F12` or `Cmd+Opt+I`) → click the **TraceLens** tab

### Chrome Web Store

> Coming soon. Star the repo to get notified.

### Landing Page

Visit **[tracelens.site](https://tracelens.site)** for the project landing page, hosted on Cloudflare Workers.

---

## Usage

Open the TraceLens panel **before** navigating to a page. Requests populate in real time as the page loads and as you interact with it.

### Summary Chips

Click the summary chips to filter the timeline:

| Chip | Shows |
|------|-------|
| **Total** | All captured requests |
| **Slow** | Requests exceeding the slow threshold |
| **Errors** | 4xx and 5xx responses |
| **Auth** | Requests with Authorization headers |

### Filter Bar

- **Search** — Filter by URL, status code, method, or GraphQL operation name
- **Method buttons** — Filter by GET, POST, or GQL
- **Bookmark icon** — Show only bookmarked entries

### Drawer Tabs

Click any request to open the detail drawer:

| Tab | Description |
|-----|-------------|
| **Overview** | URL, method, status, duration, size, headers, formatted response body, and rule-based diagnosis |
| **Timing** | Waterfall visualization of DNS → TCP → SSL → Server Wait → Download |
| **Token** | JWT decode with live countdown, validity status, and decoded claims |
| **Replay** | cURL, fetch(), and Postman collection with copy buttons. Export as `.tracelens` or `.har` |
| **Diff** | Compare fast vs slow requests to the same endpoint with response body diff |
| **Report** | Jira-ready incident report with all relevant context |

---

## Keyboard Shortcuts

| Key | Action |
|-----|--------|
| `J` | Next request |
| `K` | Previous request |
| `Space` | Open / close drawer |
| `Esc` | Close drawer or settings panel |
| `B` | Stamp a bookmark |
| `R` | Copy cURL command |
| `C` | Copy incident report |
| `?` | Toggle shortcuts overlay |

---

## Settings

Click the gear icon to configure:

| Setting | Default | Description |
|---------|---------|-------------|
| Slow threshold | 800ms | Duration above which requests are flagged |
| API calls only | On | Filter out static assets automatically |
| GraphQL naming | On | Show operation names instead of paths |
| Cascade detection | On | Alert on 3+ consecutive slow requests |
| Token countdown | On | Show live JWT expiry badges |

Settings persist across sessions via `chrome.storage.local`.

---

## Architecture

```
tracelens/
├── manifest.json        # Manifest V3 — declares DevTools page + storage permission
├── devtools.html         # Entry point — loads devtools.js
├── devtools.js           # Creates the TraceLens panel in Chrome DevTools
├── background.js         # Minimal service worker (MV3 compliance, no logic)
├── panel.html            # Main UI structure — header, timeline, drawer, settings
├── panel.css             # Complete design system — dark theme, amber accent
├── panel.js              # All logic — capture, analysis, rendering, export (1200 lines)
├── generate-icons.js     # Node script to generate placeholder PNG icons
└── icons/
    ├── icon16.png        # Toolbar icon
    ├── icon48.png        # Extensions page icon
    └── icon128.png       # Chrome Web Store icon
```

### Technology Stack

| Layer | Technology |
|-------|-----------|
| Extension API | Chrome Manifest V3 |
| Language | Vanilla JavaScript (ES2020+) |
| Styling | CSS Custom Properties, no preprocessor |
| Fonts | Barlow / Barlow Condensed / Fira Code (Google Fonts) |
| Build | None — no npm, no bundler, no transpiler |
| Storage | `chrome.storage.local` for settings persistence |

### Key Design Decisions

- **No build step** — Load the folder directly as an unpacked extension
- **No external dependencies** — Zero npm packages, zero CDN scripts
- **No remote API calls** — All data stays in the browser, all analysis runs locally
- **Single-file logic** — `panel.js` contains all capture, analysis, and rendering code
- **CSS-first design** — Design system uses CSS custom properties with semantic naming

---

## Security Model

TraceLens is designed to be **strictly read-only**:

| Property | Status |
|----------|--------|
| Network traffic modification | Not possible — no `webRequest` or `declarativeNetRequest` permission |
| Page content injection | Not possible — no content scripts, no `scripting` permission |
| External data transmission | Not possible — no `fetch()` or `XMLHttpRequest` to external servers |
| Permissions required | `storage` only — for saving settings |
| Data persistence | Settings only — captured requests are held in memory and cleared on close |

The only Chrome API used beyond `storage` is `chrome.devtools.network.onRequestFinished` (read-only network observation) and `chrome.devtools.inspectedWindow.eval('window.location.href')` (hardcoded read-only string to get the current page URL).

**All captured data stays in browser memory and is never written to disk or sent anywhere.**

### Security Hardening

The following security improvements have been applied:

| Area | Improvement |
|------|-------------|
| **JWT tokens** | Raw tokens are masked by default (`abc••••••xyz`) with an explicit Reveal/Hide toggle — prevents accidental token exposure in screenshots |
| **Content Security Policy** | `manifest.json` enforces `script-src 'self'` — blocks any inline script execution in extension pages |
| **Inline event handlers** | All `onclick` attributes removed from HTML — replaced with `addEventListener` in JS, CSP-compliant |
| **Import validation** | Imported `.tracelens` snapshot files are type-checked before any data is merged into app state |

---

## Use Cases

### For Frontend Developers
- Debug slow API calls during development
- Inspect JWT tokens without switching to jwt.io
- Compare request performance before and after changes
- Copy cURL commands to replay requests in terminal

### For Support Engineers
- Generate incident reports with one click
- Capture and share `.tracelens` snapshots with backend teams
- Identify whether issues are client-side, server-side, or network-related
- Check token expiry without asking the user for credentials

### For QA Engineers
- Verify API response payloads match expected schemas
- Detect retry storms and cascading failures
- Monitor request timing across test scenarios
- Export HAR files for bug reports

### For Tech Leads
- Review API health at a glance with the health gauge
- Spot performance regressions in the timing waterfall
- Understand burst patterns during user interactions

---

## Roadmap

- [ ] Chrome Web Store publication
- [ ] Side panel support (view requests without opening DevTools)
- [x] WebSocket frame inspection
- [x] Request grouping by domain
- [x] Performance regression alerts (compare against baseline)
- [x] Import `.tracelens` snapshots for offline viewing
- [x] Dark/light theme toggle
- [x] Request annotation and notes
- [ ] Team sharing via URL-encoded snapshots

---

## Contributing

Contributions are welcome. TraceLens is intentionally simple — vanilla JS, no build step, no framework.

### Getting Started

1. Fork and clone the repository
2. Load the `tracelens/` folder as an unpacked Chrome extension
3. Make changes to `panel.js`, `panel.css`, or `panel.html`
4. Reload the extension on `chrome://extensions` to see changes

### Guidelines

- Keep it vanilla — no frameworks, no bundlers, no transpilers
- Keep it read-only — never add capabilities that modify network traffic or page state
- Keep it private — never add code that sends data to external servers
- Keep it simple — prefer clear, readable code over clever abstractions
- Test with real-world APIs — the best test is using TraceLens on production traffic

### Reporting Issues

Found a bug? Have a feature request? [Open an issue](https://github.com/Siddharthachuahan9/TRACELENS/issues).

---

## License

MIT License. See [LICENSE](LICENSE) for details.

---

<p align="center">
  <strong>TraceLens</strong> — See what your APIs are really doing.<br />
  <sub>Built for developers who debug with DevTools open.</sub>
</p>
