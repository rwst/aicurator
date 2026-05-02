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

### PDF → text preprocessing for Summate

**Motivation.** Summate currently sends each row's cited PDFs to the
provider verbatim as base64 document blocks. Two costs follow:

- **Tokens.** A single 12-page primary-research PDF can run 30–60k
  input tokens through Anthropic's document parser. Per row this is
  fine; across a 50-row Summate run it dominates the bill.
- **OpenRouter PDF parsing fee.** When the curator picks a model that
  doesn't natively accept PDFs (e.g. open-weights via OpenRouter),
  OpenRouter's server-side parser charges a small per-page fee on top
  of the tokens.

**Proposal.** Pre-extract plain text from each PDF once, on first sight
in `<project>/PDF/`, and send the text instead. Two implementation
paths:

- **(a) Native messaging + `pdftotext`** — register a Native Messaging
  Host that runs `pdftotext -layout <in> -` (poppler-utils). Pros: best
  text quality on real review PDFs (preserves columns, equations
  mostly readable). Cons: each user installs the host manifest and
  has poppler installed; cross-platform packaging.
- **(b) In-browser via `pdfjs-dist`** — bundle pdf.js, extract text
  pages on demand. Pros: zero user-side install, single deliverable.
  Cons: text quality somewhat worse than poppler on multi-column
  reviews; ~1 MB additional bundle weight.

User preference (2026-05-02): **pdftotext if installed**. So the
likely shape is path (a), with a graceful fallback. Order of operations:

1. Service worker tries to ping the native host on first PDF read.
2. If host responds, cache the text alongside the PDF as
   `<basename>.txt` and use that for all subsequent Summate calls
   touching that PMID. Re-extract if the PDF mtime changes.
3. If host is missing, fall back to sending the PDF as today.
4. Surface the active mode in the Summate tab UI ("Mode: pdftotext"
   vs "Mode: native PDF blocks") so the curator knows which cost
   profile applies.

Files to touch:
- `src/background/native-host/manifest.json` (host registration shape)
- A small `pdfToText` service in `src/sidepanel/services/`
- `src/sidepanel/runners/summate.ts` to consult the cache before
  building each row's request

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
