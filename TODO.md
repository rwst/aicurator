# TODO

Backlog of features and refinements not blocking the v2601 cut.

## UX

### Copy log to clipboard

Add a clipboard icon in `LogWindow`'s `.log-head`, on the same row as the
three traffic-light dots (left of them or replacing the rightmost dot).

- Click handler: build a plain-text dump of the **currently rendered**
  log lines — i.e. `props.lines()` at click time — formatted as
  `HH:MM:SS  [level]  msg` per line, joined by `\n`.
- `await navigator.clipboard.writeText(text)`.
- Visual feedback: briefly swap the icon for a checkmark for ~1.5 seconds,
  or flash the button background with the accent color.
- ARIA: `aria-label="Copy log to clipboard"`. On success, set
  `aria-live` confirmation text in a visually-hidden span.
- Edge case: if `props.lines().length === 0`, disable the button.
- Edge case: clipboard write can fail in extension contexts without
  focus; on failure, log to console and skip the visual confirmation.

Files touched:
- `src/sidepanel/components/LogWindow.tsx`
- `src/sidepanel/styles/app.css` (button styling inside the dark log-head)
