# Changelog

Internal version scheme: `vYYXX` where `YY` = year mod 100 and `XX` is a
sequential two-digit counter within that year. The browser-facing
`manifest_version` follows semver-style `<YY>.<XX>.<patch>`.

## v2602 — 2026-05-03

Post-v2601 follow-ups: Summate PDF→text preprocessing, redesigned tab gating, span-input ergonomics, wider source-column read.

### Added

- **Native libpoppler text-extraction host** (optional). Small C
  binary at `scripts/native-host/aicurator-pdftotext.c` linked
  against `libpoppler-glib` + `json-glib`. Compiled and registered by
  `scripts/install-native-host.sh` (writes manifest into Chrome
  and Chromium `NativeMessagingHosts/` dirs under `~/.config/`). The
  sidepanel pings it once per session via
  `chrome.runtime.connectNative`; if available, Summate extracts each
  cited PDF to text once via `poppler_document_new_from_bytes` +
  `poppler_page_get_text`, caches the result as `<basename>.txt` next
  to the PDF (re-extracts when the PDF mtime is newer), and splices
  the text into the user prompt instead of sending the raw PDF as a
  document block. Mixed-mode per row: PDFs with no cache and no
  active host fall back to document-block mode; successful
  extractions in the same row are still sent as inline text. The
  Summate tab's PDF directory line surfaces the active mode
  (`Mode: libpoppler text` vs `Mode: native PDF blocks`). Host is
  GPL-2.0 (links libpoppler); the rest of the extension stays
  Apache-2.0; the two are separated by stdio IPC. Wire format is
  4-byte-LE-prefixed JSON; PDF bytes are sent in 512 KB base64 chunks.
- `nativeMessaging` permission added to the manifest.
- `services/pdfText.ts` (probeMode + getOrExtractText), and
  `loadCitedSources` helper in `runners/summate.ts`.

### Changed

- **All process tabs always available.** Tab availability is no
  longer derived from project stage; Start is gated per-tab via
  contextual badges (`no project selected`, `enter pathway name`,
  `add at least one PDF`, `configure provider in Settings`,
  `no PDFs for selected rows`, `invalid span`, `running…`).
- **Active-project footer** under the tab strip shows the selected
  project plus a `Switch to: <name>` button when the active sheet's
  project differs from the current selection. Footer reactively
  refreshes when `project.list` changes (e.g. after FS Access
  permission re-grant repopulates the list).
- **Row-span input** accepts both `3-7` and bare `3` (= 3-3).
- **Summate reads up to 30 source columns** (H..AK) instead of 5.
  Centralised in `services/sheetRows.ts` as `MAX_SOURCES = 30` plus
  an A1-letter helper; `parsePmidsFromRow` and the chip-grid
  loader pick up the wider range automatically. Extract still only
  writes Source1..Source5 — curators can hand-extend rows with
  additional PMIDs to the right and Summate will read them.

### Fixed

- TDZ traps in Summate/Canonize: `createMemo` evaluates eagerly, so
  memos must be declared after their dependencies. Reordered the
  `parsedSpan → spanIsValid → chipRows → summatableRowCount → badge
  → canStart/canMock` chain in SummateTab and the analogous chain
  in CanonizeTab.


## v2601 — 2026-05-02

First end-to-end functional release. Manifest version `26.1.0`.

### Added

- **Chrome MV3 side panel** at `src/sidepanel/index.html`, four-tab
  layout (Main, Extract, Summate, Canonize) with vertical tab strip,
  arrow-key navigation, ARIA roles.
- **Reactive store** (`solid-js/store`) with split-storage adapters:
  API key in `chrome.storage.local`; provider, model name, selected
  project in `chrome.storage.sync`. 250 ms debounced writes per field
  with a "saving / saved / error" indicator.
- **Single-instance lock** via `BroadcastChannel('aicurator-instance')` —
  duplicate panel renders a splash with a "Try again" button.
- **Projects directory** at `<Downloads>/aicurator/`, granted via FS
  Access API (mode:'read' at pick + readwrite upgrade after name
  validation; bootstrap-via-downloads pre-creates the folder).
- **Magic file** `.aicurator.json` per project: spreadsheet ID, gid,
  sheet URL, pathway name, stage, timestamps, version.
- **LLM provider abstraction** with three concrete providers
  (Anthropic, OpenAI, OpenRouter). All hit endpoints directly via
  browser `fetch`; no SDKs. PDFs sent as base64 document blocks
  (Anthropic) or `{type:"file"}` content blocks (OpenAI / OpenRouter).
  Hand-rolled JSON-schema validator for structured output.
- **Test connection** button in Settings — minimal smoke-test call with
  16-token cap.
- **Extract pipeline**: pathway name + ≤10 PDFs → copy to `PDF/` →
  single LLM call with [extract-skill prompt](src/sidepanel/prompts/extract.system.ts)
  → JS NCBI batch (ESearch+ESummary on DOIs, single-match
  title+author fallback) → JS source ladder (PubMed > PMC > DOI >
  publisher > blank) → 12-column sheet write. Empty-sheet pre-flight
  modal; re-run modal subsumes it. Mock-LLM "Test sheet write" for
  iterating on row layout. Full LLM response dumped to
  `<project>/extract-response.txt` for debugging.
- **Summate pipeline**: per-row processing with PMID-from-Source-cells
  parsing, PDF glob in `<project>/PDF/`, LLM call with cited PDFs +
  [summate-skill prompt](src/sidepanel/prompts/summate.system.ts),
  per-row commit to column B. Chip grid shows download status with
  `chrome.downloads.onChanged` + 5s poll fallback. Re-run modal for
  stage already at summated/canonized. Mock test variant.
- **Canonize pipeline**: no LLM. Parses entities from columns C–F,
  filters small molecules / ions, queries UniProt SPARQL (5 simple
  parallel per-path queries — reviewed-first, TrEMBL fallback) plus a
  UniProt REST search fallback (`gene:` + `protein_name:` qualifiers)
  for withdrawn / synonym symbols. Rewrites columns A–F (entity cells
  via parser scaffolding preservation; A and B via word-boundary regex,
  longer-name-first, ≥3-char minimum).
- **Merged pmid-tagger** (formerly a standalone extension):
  service-worker tab tracking via PubMed/PMC URL detection + content
  script on `pmc.ncbi.nlm.nih.gov/articles/*`; `chrome.downloads.onDeterminingFilename`
  routes PDFs to `aicurator/<active-project>/PDF/PMID-<id>_<basename>.pdf`.
- **Per-process log windows** (`extract`, `summate`, `canonize`):
  500-line FIFO cap, 1 s-debounced persistence to
  `chrome.storage.local`, `aria-live="polite"`, auto-scroll-to-bottom
  with floating "↓ N new" pill when the user has scrolled up.
- **Pinned extension ID** `ficloojffnfibdhflbinbnonaemknfai` via a
  committed `key` field in `manifest.config.ts`. Private half
  (`aicurator.pem`) is gitignored.
- **OAuth client ID** templated at build time from
  `AICURATOR_OAUTH_CLIENT_ID` (loaded from `.env` or shell environment).
- **Documentation**: `plan.md` (the locked grill-me design plan),
  `chrome-issues.md` (six documented Chrome quirks with mitigations),
  `TODO.md` (backlog of feature follow-ups), this `CHANGELOG.md`,
  rewritten `README.md`.

### Out of scope (deferred)

- Multi-instance side panel — second instance sees a splash.
- Resume-after-panel-close mid-run.
- Auto-update — team members `git pull` + manual reload.
- Provider auto-retry on HTTP failure.
- Streaming responses.
- PDF rasterization for non-PDF-native providers.
- PDF auto-fetch from publisher sites.
- Magic-file schema migration code.
- Lint / formatter / test framework.
- Direct Google, Ollama, Azure, x.ai providers (Grok reachable via
  OpenRouter as `x-ai/grok-4`).

### Known issues

See `chrome-issues.md` and `TODO.md`.
