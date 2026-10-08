# NetLens

See your page's API calls  payloads, responses, headers  in a Chrome side panel. No DevTools, no debugger banner, and load-time calls are captured retroactively.

## Install (unpacked)

1. Go to `chrome://extensions`
2. Enable **Developer mode** (top right)
3. Click **Load unpacked** and select this folder
4. Pin the NetLens icon, click it to open the side panel
5. Reload any page — its fetch/XHR calls appear instantly

## What it does

- Patches `fetch` and `XMLHttpRequest` in the page's main world at `document_start`, so nothing fired during page load is missed
- Keeps a 200-entry ring buffer per tab in the content script — open the panel *after* the page loads and the load-time calls are still there (the thing DevTools can't do)
- Batches captures every 100ms; bodies are capped at 200KB by default (1MB or 5MB in Settings) and only JSON-parsed when you expand a row
- Status rail on every row: emerald = 2xx, amber = 3xx, red = 4xx/5xx/failed
- Filter by URL/method/headers/body (always searched, no toggle) — plain text or a `/regex/` pattern — plus errors-only, pause, clear. Filter checkboxes persist across sessions
- Copy any request as a `curl` command or a `fetch()` snippet
- Replay any captured request: edit the URL, headers and body, resend it from the page itself so it carries the real session, and diff the new response against the original
- Captures `WebSocket` and `EventSource` traffic too, grouped one row per connection with frames nested underneath
- Saved sessions persist to IndexedDB, so history survives closing the panel, navigating away and closing the tab

## Inspect CSS

- Click the crosshair in the top bar, then hover anything on the page — the side panel shows its CSS live, and clicking locks the element so you can read and copy it
- Shows only what the page actually authored: every computed property is diffed against a pristine element of the same tag in an isolated frame, so the ~340 properties a browser reports collapse to the handful someone wrote
- Output is a pasteable rule, grouped into collapsible DevTools-style categories (Position, Flex & Grid, Box Model, Typography, Appearance, Motion & Interaction), with four-sided longhands collapsed (`margin`, `padding`, `inset`, `border-radius`, `border`) and inline colour swatches
- `::before` / `::after` get their own section, and `:hover` / `:focus` / `:active` rules are read straight from the page's stylesheets, since a computed style can't show a state that isn't active. Cross-origin stylesheets are fetched by the service worker and re-parsed; any that stay unreadable are reported, not silently skipped
- State rules keep their `@media` / `@supports` / `@container` conditions, and copying wraps the rule in them
- The palette icon scans the whole page for fonts and colours in use, with usage counts, a click-to-copy hex palette, and the sizes and weights each family appears at — or grab any colour on screen with the built-in eyedropper

## Page toast

- Optional on-page toast for matching API calls, so activity is visible with the side panel closed. Configure it from the settings gear: status class, method (grouped as Reads/Writes, or per-verb), a slow-call threshold, a URL substring or `/regex/` match, and a GraphQL mutations-only mode
- Catches network failures too — a dead endpoint, a CORS block, or an offline request all toast even though they carry no response body to inspect
- Rendered in a shadow root, so page CSS can't reach it. Repeated identical calls collapse into one toast with a `×N` counter; click a toast to expand it into a card with the response body and a copy button; Esc clears the stack
- A "send test toast" button previews it with sample data, no live traffic or even the feature being enabled required

## Decode

- Query params, path segments, headers, and bodies are auto-scanned and decoded wherever a known encoding is detected
- Built-in presets: Base64, Base64URL, Hex, JWT, Unicode escapes, URL encoding, LZString, and a legacy Caesar(9)+LZString preset
- Every request also gets a **Manual Decode** box — paste any value and run it through any preset on demand
- Click the ⚙ in the top bar to add your own decoders: a **chain** of built-in steps (check the boxes, e.g. Base64 → JSON) for stacked standard encodings, or a **custom JS function** for a proprietary scheme (e.g. a cipher). Custom function decoders run in an isolated Web Worker with no access to the page, tabs, or extension storage. Saved decoders persist across sessions and show up automatically alongside the built-ins

## AI access (MCP)

Let the AI agent in your editor read NetLens's captures, so it can look up the network request itself instead of asking you to check the Network tab. A request like "check what `/transfer/search` sent and got back" becomes something it can answer.

The `mcp/` folder has a small [MCP](https://modelcontextprotocol.io) server. Your AI client starts it, and the extension connects to it on `127.0.0.1` only:

```
AI client ──stdio──▶ mcp/server.js ◀──ws://127.0.0.1:17373── NetLens extension
```

**Setup**

1. Install the server and print its token:
   ```sh
   cd mcp && npm install
   node server.js --token
   ```
2. Register it with your AI client, using the absolute path to `server.js`:
   - Claude Code: `claude mcp add netlens -- node /path/to/NetLens/mcp/server.js`
   - Cursor, Claude Desktop and others:
     ```json
     { "mcpServers": { "netlens": { "command": "node", "args": ["/path/to/NetLens/mcp/server.js"] } } }
     ```
3. In NetLens, go to **Settings → AI access (MCP)**, turn it on and paste the token. It shows **● connected** once your AI client is running.

**Tools**

| Tool | What it does |
| --- | --- |
| `list_tabs` | Open tabs and their ids |
| `list_requests` | Captured fetch/XHR calls (or sockets, or console logs) in a tab. Searches URL, headers and bodies as text or `/regex/`, and filters by method, status (`404`, `5xx`) or errors only |
| `get_request` | One entry in full: headers, pretty-printed bodies, timing and a `curl` command |
| `replay_request` | Re-sends a request from the page with its real session, with optional changes. **Off unless you tick *Allow replay*** |
| `get_page_styles` | Fonts and colours used on the page |
| `netlens_status` | Whether the extension is connected, and how to connect it if not |

Without a `tab_id`, tools use the active tab of the focused window.

**Security**

- Off by default.
- The server listens only on `127.0.0.1` and refuses any WebSocket that isn't from an extension origin, so websites can't reach it.
- Both sides prove they hold the same token (HMAC challenge/response) before any data moves. The token itself is never sent.
- `Authorization`, `Cookie`, `Set-Cookie` and API-key headers are redacted in tool output unless the agent asks for them with `include_secrets`.
- The token lives in `~/.netlens-mcp/token`. Override it with `NETLENS_MCP_TOKEN`, and the port with `NETLENS_MCP_PORT`, which must match the port set in the extension.
- Only one server can hold the port. If a second AI client starts its own copy, that copy keeps retrying and takes over when the first one exits.

## Performance design

- The `fetch` wrapper records metadata synchronously and calls through immediately — the page receives the untouched promise
- Response bodies are read from `response.clone()` in a microtask *after* the page has its response; `clone()` shares the stream buffer
- Non-text content types (images, binaries) are never read
- With the panel closed there is no receiver, but `sendMessage` still clones the whole batch before finding that out, so sending backs off after a failed attempt and resumes the moment the panel speaks. Nothing is lost: the panel pulls the ring buffer when it opens
- The ring buffer caps on total bytes as well as entry count, so it can't pin tens of megabytes of response bodies in the page's process
- A request burst is flushed early rather than cloned as one giant message
- Socket frames are rate limited to 60/sec and capped at 8KB each — a game or trading feed must not make NetLens the performance problem it exists to find

## Known limits

- Can't capture on `chrome://` pages or the Chrome Web Store
- Misses requests from service workers and other extensions
- `FormData`/`Blob` request bodies are shown as placeholders, not serialized
- Binary socket frames are recorded by size, not decoded — reading a `Blob` back is asynchronous and costs more than the capture is worth at frame rates
- Named `EventSource` events are only captured for types the page itself subscribes to; there is no way to enumerate the rest
- Frame payloads aren't reached by the deep body search, which covers request and response bodies

## License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

