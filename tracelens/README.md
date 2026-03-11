# TraceLens

A read-only network debugging tool for support engineers and developers. Runs 100% in the browser as a Chrome DevTools extension — no backend, no server, no account system.

## Installation

1. Open Chrome and navigate to `chrome://extensions`
2. Enable **Developer mode** (toggle in the top-right corner)
3. Click **Load unpacked**
4. Select the `tracelens/` folder
5. Open any website → open DevTools (F12) → click the **TraceLens** tab

## Usage

Open the TraceLens panel **before** navigating to a page. Requests will populate in real time as the page loads and as you interact with it.

By default, TraceLens filters out static assets (images, fonts, CSS, JS) and only shows API calls (JSON, XML, CSV responses and POST/PUT/DELETE/PATCH methods).

### Summary Strip

Click the summary chips at the top to filter:

- **Total** — Show all captured requests
- **Slow** — Only requests exceeding the slow threshold (default 800ms)
- **Errors** — Only 4xx/5xx responses
- **Auth** — Only requests with Authorization headers

### Filter Bar

- **Search** — Filter by URL, status code, method, or GraphQL operation name
- **Method buttons** — Filter by GET, POST, or GQL
- **Bookmark icon** — Show only bookmarked entries

### Drawer Tabs

Click any request to open the detail drawer with six tabs:

| Tab | Description |
|---|---|
| **Overview** | Full URL, method, status, duration, size, headers, response body (formatted JSON), and rule-based diagnosis |
| **Timing** | Waterfall visualization of DNS, TCP, SSL, Server Wait, Download phases with slowest stage highlighted |
| **Token** | JWT decode with live countdown, validity status, decoded claims (sub, email, role, algorithm, issued, expires) |
| **Replay** | cURL command, fetch() snippet, and Postman collection — all with copy buttons. Export as `.tracelens` or `.har` |
| **Diff** | Compare fast vs slow requests to the same endpoint with response body diff highlighting changed fields |
| **Report** | Jira-ready incident report with environment, endpoint, auth status, trace ID, and diagnosis |

### Burst Grouping

Requests that fire within 800ms of each other are grouped into "bursts" — representing a single user action. Burst headers are sticky when scrolling.

### Cascade Detection

When 3+ consecutive requests exceed the slow threshold, a cascade alert banner appears, indicating possible downstream service degradation.

## Keyboard Shortcuts

| Key | Action |
|---|---|
| `J` | Navigate to next request |
| `K` | Navigate to previous request |
| `Space` | Open / close drawer |
| `Esc` | Close drawer or settings panel |
| `B` | Stamp a bookmark at current position |
| `R` | Copy cURL command for selected request |
| `C` | Copy incident report for selected request |
| `?` | Toggle keyboard shortcuts overlay |

## Settings

Click the gear icon to open the settings panel:

- **Slow threshold (ms)** — Duration above which requests are flagged as slow (default: 800)
- **API calls only** — Filter out static assets automatically
- **GraphQL naming** — Show GraphQL operation names instead of paths
- **Cascade detection** — Enable cascade alert banners
- **Token countdown** — Show live JWT expiry countdown badges

Settings persist across sessions via `chrome.storage.local`.

## Export Formats

### `.tracelens` Snapshot

A self-contained JSON file with everything needed to reconstruct the drawer view for a given request: the full request/response data, timing information, burst context, and diagnosis.

To share: export the snapshot and send the `.tracelens` file to a colleague. They can inspect it as raw JSON.

### `.har` File

Standard HTTP Archive format (HAR 1.2) containing all captured requests. Compatible with Chrome DevTools, Charles Proxy, and other HAR viewers.

## Architecture

- **manifest.json** — Manifest V3, declares DevTools page and storage permission
- **devtools.html / devtools.js** — Creates the TraceLens panel in DevTools
- **background.js** — Minimal service worker for MV3 compliance
- **panel.html / panel.css / panel.js** — All UI and logic in vanilla JS/HTML/CSS
- **No npm, no build step, no bundler** — Pure browser code
- **No remote API calls** — Everything stays in the browser

## Generating Icons

If you need to regenerate the placeholder icons:

```bash
npm install canvas
node generate-icons.js
```

Or simply keep the pre-generated PNGs in the `icons/` folder.
