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

### Resolve PDF-tagger / Chrome inline-PDF-viewer conflict

The merged pmid-tagger only fires when Chrome routes a PDF through the
**downloads pipeline**. Chrome's setting *"Download PDF files instead
of automatically opening them in Chrome"* must be **ON** for that, but
turning it on means local `.pdf` files clicked from the address bar or
file manager also get downloaded again instead of viewed inline. Users
who routinely review local PDFs in Chrome have to toggle the setting
(or accept losing the inline viewer).

Possible resolutions:
- Build an in-extension PDF viewer panel that reads PDFs from the
  project's `PDF/` subdir via FS Access and renders them in an iframe
  with `pdfjs-dist`. Removes the user's reason to need inline-Chrome
  viewing.
- Document the setting requirement prominently in the README and
  surface a banner in Main if `chrome.downloads` is disabled.
- Investigate whether `chrome.declarativeNetRequest` or a content
  script on `<embed>`/`<object>` PDF pages can reliably catch
  publisher-PDF inline viewing — probably no, the Chrome PDF viewer
  origin is `chrome-extension://mhjfbmdgcfjbbpaeojofohoefgiehjai`
  and our content scripts can't run there.

Currently the workaround is "keep the setting ON during AICurator
sessions, toggle off otherwise". Track until the in-extension viewer
ships.

### pdfjs-dist fallback for PDF → text (when libpoppler host absent)

The current libpoppler-glib native host (see `scripts/install-native-host.sh`)
covers the case where the curator has poppler dev libs installed. For
curators who don't, Summate falls back to "send PDFs as document blocks
to the provider" — same as the original behavior.

A future improvement is an in-browser fallback via `pdfjs-dist`:

- Tier 1 (½ day): `getTextContent()` + naive Y-then-X concat. Fine on
  single-column manuscripts; breaks on 2-column reviews.
- Tier 2 (3–5 days): add column detection (histogram x-positions →
  vertical gutters → sort within columns). ~70–80% of pdftotext
  quality on standard journal layouts.

Tier 2 is the right target if the fallback turns out to matter. Tier 3
(matching pdftotext) is impractical clean-room; the bridge path already
covers that quality for users who install poppler.

Bundle cost: ~1 MB extra. Activation logic: only kick in when
`probeMode()` returns `'pdf-blocks'` and the curator has opted into
text mode in Settings.

### Pipeline PDF reads across Summate rows

`src/sidepanel/runners/summate.ts` reads the cited PDFs for each row
synchronously, then awaits the LLM call, then advances. While the
60–120s LLM call for row N is in flight, row N+1's PDFs sit untouched
on disk. A depth-1 pipeline would halve perceived disk-read latency
across multi-row runs.

Sketch:
- Maintain a `next` future that pre-loads row N+1's PDFs as soon as
  row N's LLM call is issued.
- Await `next` at the top of the next iteration; the read is mostly
  done.
- Bound depth at 1 to keep memory steady (PDFs are 5–30MB each).

Skipped during the /simplify pass because state-machine complexity is
non-trivial for a usability-only win.

### Drop the 5-second poll fallback in SummateTab

`src/sidepanel/tabs/SummateTab.tsx` currently runs both a
`chrome.downloads.onChanged` listener (instant chip flips) AND a 5-second
`setInterval` re-scan of `<project>/PDF/`. The interval was meant to
catch files dropped in via the OS file manager (no `downloads` event
fires for those).

The interval ticks unconditionally and `setPdfMap(new Map(...))` causes
every chip to re-evaluate even when nothing changed. Two cleaner paths:

1. Drop the interval entirely. Most curators get PDFs via the integrated
   tagger (which fires `onChanged`); the rare OS-file-manager drop is
   handled by the explicit Re-scan button.
2. Keep the interval but add an echo guard: compare the new map's keys
   against the previous and only call `setPdfMap` when they differ.

Skipped during the /simplify pass — the current behavior is correct,
just slightly wasteful.
