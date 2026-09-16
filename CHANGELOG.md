# Changelog

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
