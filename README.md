# Auto_Browser: Custom Chromium Browser & Network Recorder

A modern, high-performance desktop Chromium browser with a built-in, real-time **Network Recorder**, **Chrome DevTools Protocol (CDP)** engine, and an **Inspection Dashboard**.

---

## Architecture Overview

```
Auto_Browser/
├── main.js                  # Main process: WebContentsView layout, CDP debugger hooks, IPC channels
├── preload.js               # Context bridge: secure IPC API for the inspector UI
├── recorder.js              # Recording engine: streams requests.jsonl, responses.jsonl & stores bodies
├── settings.json            # Configurable settings (redactions, max body size, auto-record)
├── ui/
│   ├── index.html           # Dual-pane browser & developer tools shell
│   ├── styles.css           # Modern dark-mode glassmorphic theme
│   └── app.js               # Reactive inspector, waterfall timeline, session drawer
└── recordings/              # Saved recording sessions
    └── session_YYYY-MM-DD_HH-mm-ss/
        ├── session_meta.json
        ├── requests.jsonl
        ├── responses.jsonl
        └── bodies/
            ├── <requestId>_req.txt
            └── <requestId>_res.<json|html|png|bin>
```

---

## Key Features

### 1. Embedded Modern Chromium Engine
* Built directly on **Electron 41.7+** (powered by **Chromium 134+**).
* Full interactive browser navigation with Back, Forward, Reload, and Home controls.
* Address bar with search fallback and HTTPS SSL verification badge.
* Native Chromium DevTools toggle.

### 2. Deep Network Capture via Chrome DevTools Protocol (CDP)
Directly hooks into Chromium's low-level network subsystem using `Network.enable`:
* **`Network.requestWillBeSent`**: URL, HTTP method, headers, POST payload, initiator, resource type.
* **`Network.responseReceived`**: HTTP status code, response headers, remote IP/port, MIME type, detailed timing.
* **`Network.loadingFinished`**: Data transfer size, duration calculation.
* **`Network.getResponseBody`**: Automatically extracts response bodies (text, JSON, HTML, images, and binary).

### 3. Local Storage Architecture
* **Streaming `.jsonl` Files**: Writes records to `requests.jsonl` and `responses.jsonl` line-by-line so captures are never lost if the browser is closed unexpectedly.
* **Body Storage**: Saves request payloads and response bodies into a dedicated `bodies/` directory within the session folder.
* **Metadata**: Writes `session_meta.json` with aggregate metrics (total requests, failed requests, transfer size, duration).

### 4. Interactive Inspection Dashboard
* **Metrics Counters**: Total requests, failed count (4xx/5xx), and total transfer size.
* **Filter Toolbar**: Instant search by URL, domain, status, or method. Filter by type: `All`, `Fetch/XHR`, `Doc`, `JS`, `CSS`, `Img`, `Media`, `WS`, `Errors`.
* **Detail Inspector Panel**:
  * **Headers**: General, Response Headers, Request Headers with redaction indicators.
  * **Auth & Tokens**: Dedicated inspector tab for captured Bearer JWTs, session cookies, API keys, and auth response payloads with one-click copy and live decoded JWT claims viewer.
  * **Payload**: Decoded Query Parameters and Request Body viewer.
  * **Response**: Pretty-printed JSON, HTML/CSS/JS viewer, image preview.
  * **Timing**: Breakdown of DNS lookup, Initial connection, SSL handshake, TTFB, and download.
  * **Cookies**: Request and Response cookie tables.
  * **Raw JSONL**: Exact JSON written to disk.

### 5. Authentication Token Capture & Configurable Redaction
* **Full Token Recording (Default)**: Captures `Authorization` headers, Bearer tokens, cookies, API keys, and authentication response payloads in full unredacted format.
* **Automatic Token Export**: Discovered tokens are automatically cataloged into `tokens.json` and `analyse/tokens_captured.csv` for each session.
* **Optional Redaction Toggle**: Redaction can be toggled on/off in the Settings modal if masking sensitive credentials with `[REDACTED]` is desired.
* Adjustable body size thresholds to prevent high-memory usage on heavy media files.

### 6. HAR Export & Session History
* **HAR 1.2 Export**: Export any session directly into standard HTTP Archive (.har) format for use in Postman, Wireshark, Charles, or WebPageTest.
* **Session Manager**: Browse and reload past recorded sessions into the inspector at any time.

---

## How to Run

From this directory (`c:\SHAHID IMAM\CODE\projects\2\Auto_Browser`):

```bash
npm start
```

Or run via npx:
```bash
npx electron .
```

---

## Layout Controls
* **Split Horizontal**: Browser on top, Network Inspector below.
* **Split Vertical**: Browser on left, Network Inspector on right.
* **Browser Only**: Maximizes browser browsing view.
* **Inspector Only**: Maximizes network inspection table and payload viewer.
* **Draggable Divider**: Drag the divider bar between panels to adjust split sizing.
