# Changelog

Internal version scheme: `vYYXX` where `YY` = year mod 100 and `XX` is a
sequential two-digit counter within that year. The browser-facing
`manifest_version` follows semver-style `<YY>.<XX>.<patch>`.

## v2605 — 2026-05-09

Deepened the projects-directory module: a single `ProjectsDir` state
machine replaces the scattered grant flow, with ports & adapters that
make the renderer-crash invariants verifiable in tests.

### Added

- **`src/sidepanel/projectsDir/`** — a deepened module owning the
  full lifecycle from "user has not yet picked a folder" to "module
  exposes a usable, listed, write-permitted directory". Public surface:
  `state()` (a discriminated `ProjectsDirState` —
  `unpicked | granted | stale | wrong-folder | bootstrap-failed | cancelled`),
  `grant()`, `forget()`, `refreshList()`, `ready()`. The
  validate-before-escalate rule (chrome-issues.md §1) is structural:
  there is no public way to call escalation without first passing
  through name validation. The non-empty data: URL bootstrap
  (chrome-issues.md §2) is enforced by a defensive check inside the
  Downloads adapter. Every failure mode becomes a state variant — the
  state machine never throws.
- **Three ports, three production adapters**:
  - `ChromeFsaPort` (`chromeFsa.ts`) — wraps `showDirectoryPicker`,
    `queryPermission`, `requestPermission`, directory iteration; maps
    `AbortError` → `{ kind: 'cancelled' }` and `NotFoundError` →
    `StaleHandleError`. Hands out opaque `DirToken` strings to keep
    the state machine free of FSA imports.
  - `DownloadsPort` (`downloads.ts`) — wraps `chrome.downloads.download`;
    rejects empty `data:` URLs defensively.
  - `HandleStorePort` (`handleStore.ts`) — wraps `idb-keyval` with a
    side-door `adoptHandle()` so a rehydrated handle can be interned
    into the chromeFsa adapter's token table.
- **In-memory fake adapters** at `projectsDir/adapters/fake/` —
  declarative controls (`enqueuePick`, `setNextRequestResult`,
  `putDir`, `invalidate`, `mintToken`, `callCounts`, `preseedHandle`)
  let tests configure scenarios without jsdom or any FSA polyfill.
- **Vitest** as a devDep, plus `npm run test`. Seven boundary tests
  in `projectsDir/projectsDir.test.ts` cover the full grant flow,
  cancel, wrong-folder (asserting `requestPermission` is NEVER called
  on a non-validated handle — the renderer-crash invariant becomes
  a verifiable test, not a code-review hope), bootstrap-failed,
  stale-handle rehydration, mid-session permission revocation, and
  AbortError after a partial flow.

### Changed

- **MainTab grant prompt** drives entirely off `projectsDir.state()`
  with `Switch/Match`. The local `error` signal, the `isAbort`
  predicate, the dual `onGrant` / `onReGrant` handlers, and their
  try/catches are gone — every failure mode is now a state variant
  with its own banner.
- **Store slimmed down**. Removed `dirHandle`, `dirPermission`, `list`
  from the `project` slice, and the imperative procedures
  `hydrateProjectsDir`, `grantProjectsDir`, `reGrantProjectsDir`,
  `forgetProjectsDir`, `refreshProjectList`, `verifyHandleExists`,
  `resetToUnpicked`. Replaced with derived accessors (`rootHandle()`,
  `projectList()`, `isGranted()`) and the singleton `projectsDir`.
  `setStage` / `setPathwayName` now refresh the list through
  `projectsDir.refreshList()` rather than mutating a parallel store
  copy.
- **`services/projectsDir.ts` split** into single-purpose homes:
  `services/sheetUrl.ts` for `parseSheetUrl` /
  `getActiveTabSheetUrl` / `findProjectByExactSheet`, and
  `services/projectOps.ts` for `createProject` / `deleteProject` (which
  take the granted root handle as input). `ExtractTab`, `SummateTab`,
  and `CanonizeTab` switched from `project.dirHandle` /
  `project.list` to the new derived accessors.

User-visible behavior is byte-identical to v2604; the refactor is
structural.

## v2604 — 2026-05-08

Chrome Web Store submission prep and folder-grant UX fixes.

### Added

- **`npm run package`** — runs `npm run build:cws` (sets
  `AICURATOR_CWS=1` and writes to a separate `dist-cws/` via vite's
  `--outDir`), then zips that directory into
  `aicurator-<manifest-version>.zip` at the repo root. The version
  is read from the built manifest, not `package.json`, so the zip
  name always matches the shipped manifest. **`dist/` is left
  untouched**, so the unpacked dev extension stays loadable while
  you produce a CWS build.
- **`AICURATOR_CWS=1` build flag** — strips the pinned `key` field
  from the built manifest and selects `AICURATOR_OAUTH_CLIENT_ID_CWS`
  instead of the dev OAuth client. CWS rejects manifests carrying a
  `key` (it assigns the extension ID itself). Local `npm run build`
  keeps the key so the dev extension ID stays pinned at
  `ficloojffnfibdhflbinbnonaemknfai` and uses
  `AICURATOR_OAUTH_CLIENT_ID`.
- **`PRIVACY.md`** — privacy policy covering local-only storage,
  third-party API endpoints contacted, the optional native PDF host,
  and per-permission rationale, sized for the CWS submission form.

### Fixed

- **AbortError no longer surfaces as an error** in MainTab. Cancelling
  the directory picker (Esc / Cancel / X) used to render a red
  "Could not grant access: The user aborted a request" banner. Now
  detected via `err.name === 'AbortError'` in `onGrant` / `onReGrant`
  and silently swallowed.
- **Bootstrap failures are now surfaced** to the user. Previously,
  `bootstrapAicuratorDir` failures (download policy blocks, custom
  Downloads location, managed Chrome) were logged to the console and
  the picker still opened — leaving the user staring at a Downloads
  view with no `aicurator/` folder to pick. `grantProjectsDir` now
  rethrows with an actionable message: "create that folder manually
  in your Downloads directory, then click Grant access again."

## v2603 — 2026-05-04

Provider expansion (Google + extended thinking everywhere), Canonize colon-awareness, Summate prompt sharpening, shared row-span across process tabs.

### Added

- **Google (Gemini) provider.** New `src/sidepanel/llm/google.ts`
  hits `https://generativelanguage.googleapis.com/v1beta/models/<model>:generateContent`
  with `x-goog-api-key`. PDFs go in as `inlineData` parts, system
  prompt as `systemInstruction`. Structured-output schemas pass
  through `responseSchema` + `responseMimeType: 'application/json'`
  after a recursive sanitizer strips Gemini-incompatible JSON Schema
  keywords (`additionalProperties`, `$ref`, `$defs`, `oneOf`, `allOf`,
  `not`, `patternProperties`, `unevaluatedProperties`) so the existing
  `EXTRACT_SCHEMA` round-trips unchanged. `'Google'` added to the
  `Provider` union and `PROVIDERS` array (the Settings dropdown is
  data-driven, so no UI change). `host_permissions` extended with
  `https://generativelanguage.googleapis.com/*`.
- **Extended thinking / reasoning at max on all providers**, model-name
  gated so older non-reasoning models aren't broken:
  - Anthropic (`^claude-(opus-4|sonnet-4|haiku-4|3-7-sonnet)`):
    `thinking: { type: 'enabled', budget_tokens: 24000 }`, `max_tokens`
    bumped to ≥32000 to fit the budget plus visible-response headroom.
    Existing response parsing already filters on `type === 'text'` so
    inline `thinking` blocks are correctly ignored.
  - OpenAI (`^(o1|o3|o4|gpt-5)`): `reasoning_effort: 'high'`, with
    `max_tokens` switched to `max_completion_tokens` as required by
    reasoning models. Non-reasoning models continue to receive
    `max_tokens` as before.
  - Google (`^gemini-2\.5`): `generationConfig.thinkingConfig` with
    `thinkingBudget` set to model max — 32768 for Pro, 24576 for
    Flash and Flash-Lite — and `includeThoughts: false`.
  - OpenRouter: always sends `reasoning: { effort: 'high' }` via a
    new `extraBody` hook on `OpenAILikeOptions`. OpenRouter normalises
    that across upstream providers and ignores it on non-reasoning
    models, so no namespace-prefix gating is needed.
- **Shared row-span state** between Summate and Canonize via a new
  module-level signal in `src/sidepanel/store/rowSpan.ts`
  (`rowSpanMode`, `rowSpanText`). Both tabs read/write the same
  signal so whatever the curator picks in Summate carries over as
  the pre-set in Canonize (and vice-versa).

### Changed

- **Canonize splits entities on `:`** so individual proteins inside a
  complex are canonized independently. `ParsedEntity` now exposes
  `components: { stoich, bareName }[]` instead of a single `bareName`;
  each component carries its own per-component leading stoichiometry
  (so `2 ATP:3 Mg [cytosol]` parses into two components `ATP` / `Mg`
  with their own stoich prefixes). `rewriteCell` looks each component
  up independently, rejoins with `:`, and falls back to the original
  raw form when no replacement applied (preserving whitespace). The
  runner's collection loop adds every component's `bareName` to the
  UniProt batch. Free-text rewriting in cols A/B was already
  colon-aware via `\b` word boundaries (colon is a non-word char), so
  no change there.
- **Summate prompt sharpened** for citation style: parenthetical-only
  ("Smith et al. (2024) showed…" prose form banned), explicit
  placement rule (end of sentence for one citation, immediately after
  each fact for multi-fact sentences with worked example), and a new
  Style bullet enforcing HGNC uppercase for human protein symbols
  (`TP53`, `MYC`, `NFKB1`) with carve-outs for non-human orthologs
  (mouse `Trp53`, yeast `Cdc6`) and viral proteins (`LANA`, `E1A`).
  Updated the tense-rule example to demonstrate parenthetical citation.

### Fixed

- **Re-running Summate and Canonize did nothing** when the project
  was already at stage `summated`/`canonized`. The `onStart` handlers
  fired a `window.confirm` "re-run will overwrite" dialog gated on
  stage; in Chrome side panels that dialog renders unreliably (focus
  / blur quirks), and the user's "no states set by the processes"
  guidance from v2602 had already retired stage as a Start gate.
  Stage-based confirm dialogs removed from both `SummateTab.tsx` and
  `CanonizeTab.tsx` — Start always runs. Extract's pre-flight modal
  (which guards a much wider blast radius — full-sheet overwrite)
  is unchanged.


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
