# Changelog

## 5.1

- Fixed decoded URL parameters showing gibberish for plain path segments (e.g. `online-signature`) that only coincidentally matched the base64/base64url charset — the printable-output check let high-byte garbage through; now rejects it.
- Replaced toolbar emoji/glyph icons with proper SVG icons (crosshair, database, sliders, pause/play, trash, close) for consistent rendering across OSes.
- Restyled filter checkboxes (Errors only / API only / Console logs) to match the panel's dark theme instead of raw OS checkboxes; each now has its own accent color and hover/focus states.
- Row expand/collapse, decoder-type toggle, and collapsible section arrows now animate instead of snapping instantly.
- Added missing press/hover/focus feedback across several interactive elements (row headers, tabs, archived rows, form inputs).
