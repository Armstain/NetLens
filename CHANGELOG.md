# Changelog

## 6.6

- Streamlined filter bar: replaced cramped checkboxes with a clean segmented control (`All` | `API` | `Console`), giving the search input ample room to breathe.
- Full console log interception: captures `console.log`, `console.info`, `console.debug`, `console.warn`, and `console.error` with color-coded tags (`LOG`, `INFO`, `DBG`, `WARN`, `ERR`).
- Contextual log level filter: a clean dropdown appears when viewing the `Console` scope to quickly filter by `Errors`, `Warn`, `Info`, `Log`, or `Debug`.
- Configurable log capture: added a setting in Settings to enable/disable capturing verbose console logs (`log`, `info`, `debug`) alongside errors and warnings.
- Fixed Reveal API Source shortcut when side panel is closed: selecting an element via keyboard shortcut now seamlessly persists the target context and automatically opens the Reveal panel with matched data sources.
- Performance optimization: made HTML snapshotting lazy, completely eliminating main-thread DOM serialization on `DOMContentLoaded` across all page loads.

## 6.5

- Added "Reveal API Source" (crosshair icon): click any element on the page to trace exactly which API request or SSR hydration payload populated it. Computes path provenance (e.g. `data.products[0].price`), highlights matching values, and displays confidence rankings.
- Added SSR / Hydration State Extraction & Provenance: automatically traces Next.js (`__NEXT_DATA__`, RSC flight chunks), Nuxt (`__NUXT_DATA__`), Remix (`__remixContext`), and Schema.org JSON-LD structured data when no client-side fetch is responsible for the rendered markup. SSR candidates feature distinct hydration badges, a "Copy SSR Payload" action, and interactive highlighted JSON trees.
- Added customizable keyboard shortcuts: trigger element selection directly from the webpage (`Alt+Shift+R` for Reveal, `Alt+Shift+C` for CSS Inspect) or the side panel. Configurable via dropdown selectors in Settings or through Chrome's global shortcuts page (`chrome://extensions/shortcuts`).
- In-page element pickers now toggle on/off cleanly with their respective shortcut and automatically open the side panel if it was closed when an element is locked.
- Element Inspector now automatically reveals its slide-in panel upon selection even when navigating other sidepanel tabs.

## 6.4

- Added request replay: edit a captured request's method, URL, headers and body, then resend it from the page's own context so it carries real cookies and origin. Results include a Diff tab showing exactly what changed, using a line diff that trims the shared prefix/suffix first, so a multi-megabyte body with one changed field still diffs instantly instead of bailing out.
- Added a saved sessions panel: captures now persist to IndexedDB as they arrive, so history survives closing the panel, navigating away, and closing the tab — previously it lived only in memory and was lost with the panel.
- Added WebSocket and EventSource capture, both entirely invisible before now. Frames render nested under one row per connection with a live sent/received count, rate-limited to 60/sec so a chatty feed can't make the panel the performance problem it exists to find.
- Added a Diagnostics panel (off by default, enable in Settings → Toolbar): failed requests, console errors, requests over 3s, and responses over 1MB — each a hard, measurable fact, with no guessing at what caused what. Click a finding to jump straight to its row.
- The on-page toast now renders response bodies as a collapsible JSON tree instead of flat text, and repairs bodies truncated at the 200KB capture cap so a clipped response still renders structured. Added a "Locate in panel" button that scrolls to and opens the matching row in the side panel.
- View storage is now opt-in like Diagnostics (Settings → Toolbar), and custom decoders moved from a toolbar icon into Settings — the toolbar was getting crowded.
- Fixed the Diagnostics toggle silently doing nothing: an author `display` rule on `.icon-btn` was beating the browser's `[hidden]` stylesheet rule.
- Fixed captures going missing after reloading the tab you're already watching. The panel only ever re-synced from the content script's buffer on tab switch, never on a same-tab reload, so a dropped message had nothing to fall back on until the panel itself was closed and reopened.
- Fixed a live socket's frames silently going nowhere: its connection row could get evicted by ordinary request-count pruning on a busy page, or reused across a reload before its per-load frame counter reset.
- Performance: capture no longer pays to clone full request/response bodies for a side panel that isn't open — sending backs off after a failed attempt and resumes the moment the panel is listening again. IndexedDB writes batch on a timer instead of opening a transaction on every 100ms flush.

## 6.3

- Reworked the on-page toast into a full settings panel (gear icon): status-class and method chips, a slow-call threshold, URL substring/regex match, GraphQL mutations-only mode, dismiss timers, max stack size, corner position, dedupe toggle, response-body preview, presets, and a test-toast button to preview it without live traffic.
- Method chips are grouped as Reads (GET, HEAD) and Writes (POST, PUT, PATCH, DELETE), with per-verb chips available behind a disclosure. Dropped the OPTIONS chip — a CORS preflight never reaches the patched `fetch`/`XHR`, so it could never have matched anything.
- Fixed the toast silently missing network failures: a failed `fetch` carries no `contentType`, so the old content-type check alone would never catch a dead endpoint, a CORS block, or an offline request.
- Toast is rendered in a shadow root, immune to page CSS. Repeated identical calls collapse into one toast with a `×N` counter; the stack caps at a configurable size; clicking a toast expands it into a card with the pretty-printed response body and a copy button; Esc clears the stack.
- Element inspector's CSS output is now grouped into collapsible categories (Position, Flex & Grid, Box Model, Typography, Appearance, Motion & Interaction, Other), matching how DevTools organizes computed styles.
- Added a screen-wide colour eyedropper to the Page Styles panel (native `EyeDropper` API); the full colour list is now collapsed by default in favor of it.
- Fixed the five drawer panels (inspect/palette/storage/decoders/settings) stacking on top of each other instead of one replacing another.
- "Errors only" / "API only" / "Console logs" filter checkboxes now persist across sessions instead of resetting every time the panel opens.
- Fixed the request-count badge showing the unfiltered total even when a filter hid every row, which looked identical to the capture having died. It now shows "N / total" when anything is hidden, with a distinct "no requests match this filter" empty state.
- The request filter box now accepts a `/regex/` pattern in addition to plain substring text.

## 6.2

- Element inspector now reports the CSS the page actually authored, instead of ten fixed properties: every computed property is diffed against a pristine element of the same tag in an isolated frame, so browser defaults drop out.
- Inspector output is a real CSS rule you can paste — grouped by concern, with four-sided longhands collapsed to shorthands (`margin`, `padding`, `inset`, `border-radius`, `border`) and inline colour swatches.
- Inspector now updates live as you hover, rather than only on click; clicking locks the element so you can read it.
- Added `::before` / `::after` styles, in their own collapsed section, skipped when no box is generated.
- Added `:hover` / `:focus` / `:active` and other state rules, read from the page's stylesheets since a computed style cannot show a state that isn't active. Cross-origin stylesheets are fetched by the service worker and re-parsed, and any that stay unreadable are reported rather than silently omitted.
- State rules carry their `@media` / `@supports` / `@container` conditions, and copy output wraps the rule in them.
- Added an optional "Toast API calls" toggle: JSON/XML/GraphQL responses show a short-lived toast on the page itself, so calls are visible with the side panel closed.
- Added a Page Styles panel: scans the page for every font stack and colour in use, with usage counts, a click-to-copy hex palette, and per-family sizes and weights.
- Extracted CSS formatting and selector parsing into `css-format.js`, shared by the panel and the content script, with assertions in `test_css_format.js`.

## 6.1

- Added a search box to the full-screen view, for searching within the currently open tab's content.

## 6.0

- Added a full-screen view button (expand icon) next to the Response/Payload/Headers/Decoded tabs — opens the current tab's content across the entire side panel for reading large bodies.
- "Console logs" filter is now off by default instead of on.
- Fixed duplicate/mismatched rows appearing when a page reused the same `XMLHttpRequest` instance for multiple requests.
- Fixed custom function decoders always failing under Manifest V3's Content Security Policy.
- Extracted the decoder engine into its own `decoders.js` module (no user-facing change).
- Fixed fetch response bodies being silently dropped, and SSE streams leaking memory over long-lived connections.
- Fixed the element-picker overlay drifting out of place under CSS-transformed ancestor elements.

## 5.1

- Fixed decoded URL parameters showing gibberish for plain path segments (e.g. `online-signature`) that only coincidentally matched the base64/base64url charset — the printable-output check let high-byte garbage through; now rejects it.
- Replaced toolbar emoji/glyph icons with proper SVG icons (crosshair, database, sliders, pause/play, trash, close) for consistent rendering across OSes.
- Restyled filter checkboxes (Errors only / API only / Console logs) to match the panel's dark theme instead of raw OS checkboxes; each now has its own accent color and hover/focus states.
- Row expand/collapse, decoder-type toggle, and collapsible section arrows now animate instead of snapping instantly.
- Added missing press/hover/focus feedback across several interactive elements (row headers, tabs, archived rows, form inputs).
