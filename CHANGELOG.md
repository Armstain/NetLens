# Changelog

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
