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
- Batches captures every 100ms; bodies are capped at 200KB and only JSON-parsed when you expand a row
- Status rail on every row: emerald = 2xx, amber = 3xx, red = 4xx/5xx/failed
- Filter by URL/method, errors-only toggle, pause, clear, copy body

## Performance design

- The `fetch` wrapper records metadata synchronously and calls through immediately — the page receives the untouched promise
- Response bodies are read from `response.clone()` in a microtask *after* the page has its response; `clone()` shares the stream buffer
- Non-text content types (images, binaries) are never read
- If the panel is closed, capture costs one array push per request — no messaging

## Known limits

- Can't capture on `chrome://` pages or the Chrome Web Store
- Misses requests from service workers and other extensions
- `FormData`/`Blob` request bodies are shown as placeholders, not serialized

## License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

