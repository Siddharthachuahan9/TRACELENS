# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

TraceLens is a **Chrome DevTools extension** that provides read-only network debugging for developers and support engineers. It runs entirely in the browser with no backend, no bundler, and no npm dependencies—just vanilla JavaScript, HTML, and CSS.

The extension captures network requests via Chrome DevTools API, enriches them with JWT decoding, GraphQL naming, retry detection, and burst grouping, then renders an interactive timeline with real-time diagnostics and export capabilities.

## Architecture

### High-Level Design

```
Chrome DevTools Panel (panel.html + panel.css + panel.js)
├── Network Capture Layer
│   └── chrome.devtools.network.onRequestFinished listener
├── Data Layer
│   ├── allEntries[] — captured request objects with enriched metadata
│   ├── bursts[] — groups of requests within 800ms (user actions)
│   └── State: filtering, selection, settings, annotations, bookmarks
├── Analysis Engine
│   ├── JWT extraction and decoding
│   ├── Retry detection (same endpoint within 5s)
│   ├── Cascade detection (3+ consecutive slow requests)
│   ├── GraphQL awareness (operation name extraction)
│   └── Diagnosis engine (status codes, timing patterns, auth state)
├── Rendering Layer
│   ├── Timeline with burst/domain grouping
│   ├── Drawer with 6 tabs (overview, timing, token, replay, diff, report)
│   ├── Summary chips (total, slow, errors, auth)
│   ├── Activity heatmap (60-second rolling window, 30 buckets)
│   └── Health gauge (based on error rate and slow request ratio)
└── Export & Sharing
    ├── HAR 1.2 (HTTP Archive format)
    ├── .tracelens snapshot (self-contained JSON)
    ├── cURL commands
    ├── Fetch snippets
    ├── Postman collections
    └── Incident reports (Jira-ready plaintext)
```

### Request Flow

1. **Capture** — `onRequestFinished` fires for each completed HTTP request; the extension intercepts via `request.getContent()`
2. **Enrich** — Each request is augmented with:
   - JWT extraction from `Authorization: Bearer` headers
   - Retry detection by matching `(method, path, timestamp)`
   - GraphQL naming from `operationName` or parsed `query` field
   - Display name and method label for rendering
   - WebSocket upgrade detection
3. **Burst Assignment** — Requests within 800ms gap form a "burst" representing a user action
4. **Analysis** — Diagnosis engine evaluates status codes, timing phases (DNS, TCP, SSL, wait, download), and auth state
5. **Render** — Timeline updates in real-time; bursts are sticky headers; filtered entries update on search/filter
6. **Export** — One-click export to HAR, .tracelens, cURL, fetch(), Postman, or incident report

### Core State Management

All state lives in global variables at the top of `panel.js`:

- **allEntries** — all captured requests with metadata (`id`, `timestamp`, `method`, `url`, `path`, `status`, `dur`, `size`, `reqHeaders`, `resHeaders`, `reqBody`, `resBody`, `timings`, `mimeType`, `_auth`, `_isRetry`, `_displayName`, `_methodLabel`, `_isGraphQL`)
- **bursts** — grouped requests with `id`, `startTime`, `lastTimestamp`, `pageUrl`, `requests[]`
- **Settings** — `THRESH` (slow threshold, default 800ms), `API_ONLY`, `GQL_NAMES`, `CASCADE_ENABLED`, `TOKEN_COUNTDOWN`, `THEME`, `DOMAIN_GROUPING`, `BASELINE_ENABLED`, `BASELINE_PCT`
- **Filters** — `activeFilter` ('slow'/'errors'/'auth'/''), `activeMethodFilter` ('GET'/'POST'/'GQL'/''), `searchQuery`, `showBookmarksOnly`
- **UI State** — `selectedEntry`, `selectedIdx`, `activeTab` (drawer tab), `capturing` (record on/off)
- **Persistent Storage** — Settings and annotations saved to `chrome.storage.local`, loaded on init

### Key Algorithms

**Burst Grouping** — Requests are assigned to bursts based on time gap:
```
if (lastTimestamp - currentTimestamp < 800ms) → add to current burst
else → create new burst
```

**Cascade Detection** — Identifies 3+ consecutive slow requests (duration > threshold):
```
count consecutive entries where dur >= THRESH
if max run >= 3 → cascade alert
```

**Diagnosis Engine** — Rule-based pattern matching on `(status, dur, timings, auth)`:
- 401 with no auth header → "client never attached credentials"
- 401 with expired JWT → "token expired at {exp}, refresh and replay"
- 403 → "credentials accepted but lacking scope, check role claim"
- 429 → "rate limited, implement exponential backoff"
- Server wait > 85% of duration → "slow DB query or N+1 resolver"
- DNS > 200ms → "cold DNS cache or network issue"
- SSL > 300ms → "certificate chain or TLS negotiation overhead"
- Download > 70% of duration → "large payload, consider pagination"
- 2xx and < threshold → "clean request, no anomalies"

**Performance Regression** — Compare current request duration against saved baseline average:
```
threshold = baseline[path].avg * (1 + BASELINE_PCT / 100)
if current > threshold → show alert with pct deviation
```

### File Structure

```
tracelens/
├── manifest.json              # Manifest V3: declares DevTools page, storage permission, CSP
├── devtools.html              # Entry: registers TraceLens panel
├── devtools.js                # Creates panel: chrome.devtools.panels.create()
├── background.js              # MV3 service worker stub (minimal)
├── panel.html                 # UI structure: header, timeline, drawer, settings, shortcuts
├── panel.css                  # Design system: dark/light themes, CSS custom properties, no preprocessor
├── panel.js                   # Core logic (59KB): capture, analysis, rendering, export, event handlers
├── generate-icons.js          # Node script: generates PNG icons using zlib CRC32 and raw pixel data
├── sidepanel.html & sidepanel.js  # Side panel UI (planned feature, low priority)
└── icons/
    ├── icon16.png             # Toolbar icon
    ├── icon48.png             # Extensions page icon
    └── icon128.png            # Chrome Web Store icon
```

### Design System (CSS)

No CSS preprocessor; all styling uses CSS custom properties (CSS variables) with semantic naming:

- **Color scales** — `--c0` (bg) through `--cA` (text), `--cW` (white)
- **Accent** — `--amber` (#e8a020), `--amber-dim`, `--amber-glow`
- **Status** — `--green`, `--yellow`, `--red`, `--blue`
- **Spacing** — `--sp-xs` (4px) through `--sp-xl` (24px)
- **Fonts** — Barlow (body), Barlow Condensed (headings), Fira Code (monospace)
- **Light theme** — `body.theme-light` inverts color scale and accent

### Rendering Pipeline

1. **getFilteredEntries()** — Apply all active filters (status, method, search, bookmarks) to `allEntries`
2. **renderTimeline()** — Generate HTML for filtered entries grouped by burst or domain:
   - If `DOMAIN_GROUPING` → group by hostname with collapse toggle and stats
   - Else → group by burst with sticky headers showing time and counts
   - Attach click handlers to `.req-row` to open drawer
3. **renderRequestRow()** — Single request HTML: method badge, path, status, duration bar, auth/WS badges
4. **renderDrawer()** — Conditional tab rendering based on `activeTab`:
   - `overview` — full URL, headers, formatted response, diagnosis, metadata
   - `timing` — waterfall visualization with phase breakdown
   - `token` — JWT decode, masked token (Reveal/Hide toggle), countdown, claims
   - `replay` — cURL, fetch(), Postman, export buttons
   - `diff` — compare fast vs slow requests to same endpoint with response diff
   - `report` — Jira-ready plaintext incident report
5. **updateSummary()** — Chip counts and health gauge calculation
6. **updateHeatmap()** — 60-second rolling window with 30 buckets, height mapped to request density

### Event Handling

**Network Capture** — `chrome.devtools.network.onRequestFinished` listener:
- Calls `onRequestFinished(request)` for each completed request
- Extracts headers, timings, response body via `request.getContent()`
- Applies API-only filter, enriches entry, adds to bursts, triggers renders

**User Interaction** — Event delegation on timeline, drawer, and filter bar:
- Click request row → `openDrawer(entry)`, set `selectedEntry`, render drawer, update timeline highlight
- Click filter chip → toggle `activeFilter`, re-render timeline
- Click method filter → toggle `activeMethodFilter`, re-render timeline
- Type in search → update `searchQuery`, re-render timeline
- Click settings icon → `toggleSettings()`, show settings panel
- Click theme icon → `toggleTheme()`, apply CSS class, save to storage

**Keyboard Navigation** (vim-style):
- `J/K` — navigate requests in filtered list, smooth scroll to view
- `Space` — toggle drawer open/close
- `Esc` — close drawer, settings, or shortcuts overlay
- `B` — prompt for bookmark label, add to timeline
- `R` — copy cURL command to clipboard
- `C` — copy incident report to clipboard
- `D` — toggle domain grouping
- `T` — toggle light/dark theme
- `?` — toggle shortcuts overlay

**Settings Persistence** — All changes saved to `chrome.storage.local`:
- Load on init via `loadSettings()`
- Save on change via `saveSetting(key, val)`
- Keys: `thresh`, `apiOnly`, `gqlNames`, `cascade`, `tokenCountdown`, `theme`, `baselineEnabled`, `baselinePct`, `performanceBaseline`, `annotations`

## Development Setup

### No Build Step Required

This extension loads directly as an **unpacked folder** — no npm, no bundler, no transpiler.

1. Clone the repository
2. Open `chrome://extensions`
3. Enable Developer mode
4. Click "Load unpacked"
5. Select the `tracelens/` folder
6. Open any website, press F12 or Cmd+Opt+I to open DevTools
7. Click the **TraceLens** tab

### Making Changes

Simply edit `panel.js`, `panel.css`, or `panel.html`, then reload the extension on `chrome://extensions` (blue reload icon).

No build step, no compilation, no cache busting needed.

### Generating Icons (Optional)

If you need to regenerate placeholder PNG icons:

```bash
npm install canvas
node tracelens/generate-icons.js
```

Or keep the pre-generated PNGs in `icons/` as-is (they work fine).

### Testing in Real Browsers

The best test is using TraceLens on **real-world APIs**. The extension is designed for production use:
- Navigate to a web app with real network traffic
- Open DevTools with TraceLens panel already open
- Interact with the app and watch requests populate in real time
- Test filtering, exporting, and keyboard navigation

## Security & Constraints

### Read-Only by Design

TraceLens cannot:
- Modify network requests (no `webRequest` or `declarativeNetRequest` permission)
- Inject into pages (no content scripts, no `scripting` permission)
- Send data to external servers (no fetch/XMLHttpRequest outside browser)

### Permissions

Only `storage` permission is requested — for persisting settings and annotations to `chrome.storage.local`.

### Hardening

- **JWT tokens** — Raw tokens masked by default (`abc••••••xyz`); Reveal/Hide toggle prevents accidental exposure in screenshots
- **Content Security Policy** — `manifest.json` enforces `script-src 'self'; object-src 'none'` to block inline scripts
- **No inline event handlers** — All onclick attributes replaced with `addEventListener`
- **Import validation** — `.tracelens` snapshot files are type-checked before merging into state

## Deployment

The website (https://tracelens.site) is hosted on **Cloudflare Workers**:

- `wrangler.jsonc` defines the deployment config
- Assets in `docs/` folder (index.html, styles.css, script.js) are served as static content
- Blog posts and SEO content (sitemap.xml, robots.txt, structured data) are in `docs/blog/`

To deploy:

```bash
wrangler publish
```

(Requires Cloudflare account and wrangler CLI setup.)

## Key Design Decisions

1. **Single-file logic** — All capture, analysis, and rendering in `panel.js` for simplicity and discoverability
2. **No external dependencies** — Zero npm packages, zero CDN scripts; reduces attack surface and build complexity
3. **CSS custom properties** — Semantic naming (color scales, spacing) makes theming and design iteration fast
4. **State as globals** — Top-level variables (not encapsulated in objects) for clarity in a vanilla JS codebase
5. **Real-time rendering** — No framework diffing; imperative DOM updates via `innerHTML` for predictability
6. **Chrome DevTools API only** — Read-only `network.onRequestFinished` and `inspectedWindow.eval` for safety
7. **Memory-only storage** — Captured data held in memory, cleared on panel close; only settings persisted to disk

## Common Workflows

### Adding a New Filter

1. Define filter state at top of `panel.js` (e.g., `let activeStatusRange = '2xx'`)
2. Add filter UI to `panel.html` (e.g., checkbox or dropdown)
3. Add event listener in `initFilterBar()` to update filter state
4. Update `getFilteredEntries()` to apply the new condition
5. Test by navigating a page with real traffic and toggling the filter

### Adding a Diagnosis Rule

1. Open `diagnose(entry)` function (line ~189)
2. Add a new `if` condition checking `entry.status`, `entry.dur`, or `entry.timings`
3. Return a human-readable diagnostic message
4. Test by finding a request matching the condition and checking the Overview tab

### Adding an Export Format

1. Create generator function (e.g., `toCSV(entry)`)
2. Add export button to `renderReplayTab()` with `data-copy` or `id` attribute
3. Attach click handler in `renderDrawer()` to call the generator and copy to clipboard
4. Test by exporting and validating the format

### Adding a Drawer Tab

1. Add tab name to `baseTabs` or `tabs` array in `renderDrawer()`
2. Create renderer function (e.g., `renderCustomTab(e)`) returning HTML
3. Add condition in `renderDrawer()` to call the renderer when `activeTab === 'custom'`
4. Attach tab button click handlers (they're already generic)
5. Test by clicking the new tab with a request selected

## Performance Considerations

- **Burst grouping** — O(n) per request insertion; used to avoid rendering every request individually
- **Cascade detection** — O(n) per request on a sliding 10-entry window; fast enough for real-time use
- **Filtering** — O(n) full table scan; cached in `filteredEntries`
- **Timeline rendering** — O(n) HTML generation; `innerHTML` assignment is fast for 100–1000 entries
- **Heatmap** — O(n) per update; runs every 2 seconds and only considers entries from last 60 seconds
- **Settings lookup** — O(1) via `chrome.storage.local.get()`

For large request volumes (>5000 entries), consider pagination or virtualization (not yet implemented).

## Testing Strategy

No automated test suite; the extension is tested via:
1. **Manual integration testing** — Use on real-world web apps with live network traffic
2. **Browser compatibility** — Chrome, Edge, and Chromium-based browsers
3. **User feedback** — GitHub issues and pull requests

To validate changes, load the unpacked extension and reproduce the use case (e.g., capture slow API, export as HAR, check diagnosis message).

## Roadmap

- [ ] Chrome Web Store publication
- [ ] Team sharing via URL-encoded snapshots
- [ ] Side panel support (low priority)
- [x] WebSocket frame inspection
- [x] Request grouping by domain
- [x] Performance regression alerts (compare against baseline)
- [x] Import `.tracelens` snapshots for offline viewing
- [x] Dark/light theme toggle
- [x] Request annotation and notes

See `README.md` for full feature list and use cases.
