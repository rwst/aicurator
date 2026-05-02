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
