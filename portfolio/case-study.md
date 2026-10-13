# NetLens — Chrome / Firefox extension for inspecting a page's API calls

## Problem

Debugging what a web page sends to its backend normally means opening DevTools. That has three costs:

- **You have to open it first.** Anything fired during page load is gone if DevTools wasn't already open, so you reload and hope the bug reproduces.
- **It's heavy and noisy.** The debugger banner, dozens of panels, and every asset type mixed in with the API calls you care about.
- **Context is lost.** Encoded payloads (Base64, JWT, LZString, custom ciphers) have to be decoded by hand in another tool. Nothing tells you which request produced a given value on screen. Once the tab closes, the history is gone.

## My part

Sole author of the project: designed, built and shipped it end to end (50 commits, 17 Sep – 8 Oct 2026, about 12.6k lines of JS/HTML/CSS, 11 test files).

- **Capture layer.** Patched `fetch` / `XMLHttpRequest` in the page's main world at `document_start`, so load-time calls are captured. Added WebSocket and EventSource capture. Kept a bounded ring buffer per tab, so opening the panel late still shows everything.
- **Performance.** Response bodies are read from `response.clone()` after the page already has its response. Messages are batched. Buffers are capped by bytes as well as entry count. Socket frames are rate-limited. The goal was that a debugging tool shouldn't be the thing slowing the page.
- **Side panel UI.** Status-coloured request rows, filtering by URL/header/body with plain text or `/regex/`, copy as `curl` / `fetch`, and saved sessions in IndexedDB.
- **Auto-decode.** Query params, headers and bodies are scanned and decoded (Base64, Base64URL, Hex, JWT, Unicode, URL, LZString), plus user-defined decoder chains and custom JS decoders that run in an isolated Web Worker.
- **Replay and diff.** Edit a captured request and resend it from the page, so it carries the real session, then diff the response against the original.
- **Reveal API Source.** Click any element on the page and trace which API response (or server-rendered payload) produced that value, down to the JSON path. Parses Next.js RSC payloads, `__NEXT_DATA__`, `__NUXT_DATA__` and JSON-LD.
- **CSS Inspect and page palette.** Shows only the CSS the page actually authored, with fonts, colours and an eyedropper.
- **Page toasts.** Optional on-page notifications for failed or slow calls, rendered in a shadow root.
- **AI access (MCP).** A local, token-authenticated MCP server so AI agents in Claude Code, Cursor or Claude Desktop can read captures directly. Loopback-only, off by default, with credential headers redacted.
- **Cross-browser.** Manifest V3 for Chrome, plus a Firefox sidebar and Gecko settings.

## Outcome

- Shipped 6.4 → 6.9 plus an unreleased MCP release, with a maintained changelog.
- Load-time API calls are visible after the fact: open the panel after the page loads and the calls are already there. DevTools can't do this.
- Debugging flow goes from "open DevTools, reload, find the call, decode it by hand" to "click the element, see the exact request and field behind it".
- Works in Chrome and Firefox without the debugger banner.
- Ships with unit tests for the decoders, provenance matching, replay, store, sockets and MCP.
- _Add your own numbers here if you have them: installs, store rating, time saved, teams using it._

## Screenshots (demo app is fictional)

| File | Shows |
| --- | --- |
| 01-desktop-list | Every call, including load-time ones, with colour-coded status |
| 02-desktop-failure | A 500 on checkout opened to the error body and trace id |
| 03-desktop-decoded | JWT in a response auto-decoded into header and payload |
| 04-desktop-reveal | Clicking a price on the page traces it to `data[0].price` |
| 05-desktop-inspect | CSS Inspect on a page element |
| 06-desktop-replay | Editing and resending a failed request |
| 07-desktop-filter | `/regex/` filtering |
