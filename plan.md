# AICurator Implementation Plan

Target: Chrome MV3 side-panel extension for the Reactome curation workflow.
Stack: Vite + Solid + TypeScript + `@crxjs/vite-plugin`. Dev-mode only (no
Chrome Web Store).

This plan is the output of a grill-me session that resolved every branch of
the design tree against `design_handoff_aicurator_sidepanel/README.md`,
`orig-plan/phases.txt`, `orig-plan/extract-skill.md`,
`orig-plan/summate-skill.md`, `orig-plan/summation-style.md`, and
`orig-plan/pmid-tagger/`. Every decision below is locked.


## 0. Versioning

Internal scheme: `vYYXX` where `YY` = year mod 100, `XX` = sequential
two-digit counter within that year. First 2026 release is `v2601`.

- `manifest.config.ts` exposes `version: "26.1.0"` (Chrome semver-compatible).
- Panel meta column shows `v2601`.
- Magic file (`.aicurator.json`) carries `"version": "v2601"`. On read, a
  mismatch with the build's known list of accepted versions refuses to load
  the project and logs `[err] project "X" uses unsupported magic-file
  version <v>`. No migration code yet — first migration ships when v2701
  is cut.


## 1. Architecture (consolidated locks)

### 1.1 Surface and lifecycle

- Side panel page at `src/sidepanel/index.html`. All long-running work
  (LLM calls, NCBI batches, sheet writes, SPARQL) runs in this page. If
  the user closes the panel mid-run, the run dies — acceptable for v2601.
  Future TODO: relocate runners to an offscreen document.
- Service worker at `src/background/service-worker.ts` is a thin
  orchestrator: registers `chrome.sidePanel.setPanelBehavior({
  openPanelOnActionClick: true })` once, hosts the merged pmid-tagger
  logic, owns `chrome.downloads.onDeterminingFilename`.
- Single-instance lock via `BroadcastChannel('aicurator-instance')`. On
  panel mount, post `ping` and listen 200ms for `occupied`. Live instance
  answers continuously. Sibling instance renders a full-screen splash
  *"AICurator is already open in another window…"* with a Try Again button.

### 1.2 File-system layout

Projects directory is **fixed** at `<Downloads>/aicurator/`. The
configurable path setting is removed; replaced with a one-time access-grant
button in Settings that calls `showDirectoryPicker({ startIn: "downloads" })`
expecting the user to pick `aicurator/` inside Downloads. The
`FileSystemDirectoryHandle` is persisted in IndexedDB via `idb-keyval`. On
each panel open, `queryPermission({ mode: "readwrite" })` decides whether to
re-prompt. First-run bootstrap auto-creates the dir by writing a zero-byte
`.aicurator-init` file via `chrome.downloads.download` of a `data:` URL with
`filename: "aicurator/.aicurator-init"`.

Per-project layout:

```
<Downloads>/aicurator/<project-name>/
├── .aicurator.json     # magic file
└── PDF/
    ├── Smith2024.pdf            # Extract input PDFs (original basenames)
    ├── Jones2023.pdf
    ├── PMID-12345678_*.pdf      # Summate input PDFs (auto-prefixed by tagger)
    └── ...
```

`.aicurator.json`:

```json
{
  "version": "v2601",
  "spreadsheetId": "1AbC_xyz_123",
  "gid": "0",
  "sheetUrl": "https://docs.google.com/spreadsheets/d/1AbC_xyz_123/edit#gid=0",
  "pathwayName": "classical complement activation",
  "stage": "extracted",
  "createdAt": "2026-05-01T17:42:08.000Z",
  "updatedAt": "2026-05-01T17:55:12.000Z"
}
```

Project discovery: scan one level deep, list subdirs whose
`.aicurator.json` parses successfully and whose version is accepted; sort
alphabetically. Refresh once on panel open and after Create/Delete.

### 1.3 State model

Two orthogonal axes in the root store:

```ts
type Stage = 'none' | 'extracted' | 'summated' | 'canonized';
type Running = 'none' | 'extract' | 'summate' | 'canonize';

interface AppStore {
  ui: { activeTab: 0 | 1 | 2 | 3 };
  project: {
    dirHandle: FileSystemDirectoryHandle | null;  // pulled from IDB on boot
    dirPermission: 'granted' | 'prompt' | 'denied';
    list: ProjectMeta[];
    selectedName: string | null;
    stage: Stage;
    running: Running;
    pathwayName: string;            // per-project, persisted in magic file
    extractPdfHandles: FileSystemFileHandle[]; // in-memory only, not persisted
  };
  settings: {
    provider: 'Anthropic' | 'OpenAI' | 'OpenRouter';
    modelName: string;
    apiKey: string;                 // chrome.storage.local
  };
  logs: Record<'extract' | 'summate' | 'canonize', LogLine[]>;
}

interface ProjectMeta {
  name: string;                // == subdir name
  spreadsheetId: string;
  gid: string;
  sheetUrl: string;
  pathwayName: string;
  stage: Stage;
}

interface LogLine {
  ts: string;       // 'HH:MM:SS' for display
  isoTs: string;    // ISO 8601 for sorting/persistence
  level: 'init' | 'info' | 'ok' | 'warn' | 'err';
  msg: string;
}
```

Tab gating (a Solid `createMemo`):

| Tab | Enabled when |
|---|---|
| Main | always |
| Extract | `selectedName !== null` AND `extractPdfHandles.length >= 1` |
| Summate | `stage ∈ {extracted, summated, canonized}` |
| Canonize | `stage ∈ {summated, canonized}` |

Start-button gating per process tab: disabled if
`running !== 'none' && running !== <this tab>`. The currently-running tab's
Start button mutates to **Cancel** (calls `AbortController.abort()`).

Re-run semantics: re-running an upstream stage shows a confirm modal
(*"Re-running Extract will overwrite the sheet and reset Summate/Canonize
state. Continue?"*). On confirm, `stage` resets to the highest still-valid
stage. Empty-sheet check is suppressed when the visible row 1 exactly
matches our 12 headers; otherwise it overlays as a separate "Sheet has
unrelated data. Overwrite?" modal — but only when re-run modal isn't already
firing (re-run subsumes empty-sheet).

If the active tab becomes disabled (e.g. project deleted, PDF list cleared
to zero), fall back to Main.

### 1.4 Skill-execution pattern

Pipelined single-shot LLM calls with deterministic JS glue. No tool-use
loop. No streaming.

- **Extract:** one LLM call with PDFs attached + adapted system prompt +
  JSON schema → JS NCBI resolution (ESearch+ESummary batch + per-ref
  title+author fallback) → JS ladder walk (PubMed > PMC > DOI > publisher >
  blank) → JS `values:batchUpdate` to top-left of sheet.
- **Summate:** per row, one LLM call with that row's PMID-prefixed PDFs +
  `summation-style.md` as system + the row schema → JS writes prose to
  column B of that row. Each row commits independently for partial-progress
  resilience.
- **Canonize:** no LLM. JS scrapes unique entity names from the four entity
  columns (C, D, E, F) over the selected row range, builds a single
  batched UniProt SPARQL query, then replaces names in-place across
  columns A (Title), B (Summation), C, D, E, F and writes back. The
  replacement map is sourced from C–F (where entity names are well-formed
  and parseable); replacement is applied to A and B via word-boundary
  regex against that same map.

### 1.5 Provider abstraction

Three providers wired in v2601: **Anthropic**, **OpenAI**, **OpenRouter**.
(Google, Ollama, Azure, x.ai are explicitly out — Grok reachable via
OpenRouter as `x-ai/grok-4`.)

```ts
// src/sidepanel/llm/provider.ts
export interface LlmCall {
  systemPrompt: string;
  userText: string;
  pdfs: { name: string; bytes: ArrayBuffer }[];
  schema?: object;          // for structured output where supported
}
export interface LlmResult {
  text: string;
  usage?: { input: number; output: number };
}
export interface Provider {
  call(req: LlmCall, signal: AbortSignal): Promise<LlmResult>;
}
```

Concrete classes: `AnthropicProvider`, `OpenAIProvider`,
`OpenRouterProvider` (extends `OpenAIProvider`, overrides only `baseUrl` and
adds the optional `HTTP-Referer`/`X-Title` headers). All do direct browser
`fetch` — no SDKs, no service-worker proxy. Anthropic gets the
`anthropic-dangerous-direct-browser-access: true` header; provider class
encapsulates that.

Structured output:

- OpenAI / OpenRouter: pass `response_format: { type: "json_schema",
  json_schema: ... }` when `schema` is set. Falls back to "ask for JSON in
  prompt + parse" if the model rejects.
- Anthropic: prompt-asks-for-JSON + JS parse + JS schema validation.

Hand-rolled validator (`services/jsonSchema.ts`, ~80 lines) — no Zod.

No probe of provider on panel open. Provider availability is checked at the
start of each run (the first request validates everything: auth, model
name, network). On any HTTP failure mid-run, log `[err] <provider>:
<status>: <body excerpt 200 chars>`, set `running='none'`, leave `stage`
unchanged. **No automatic retries.**

### 1.6 Sheet contract

Fixed 12-column layout, headers in row 1:

| Col | Header | Written by | Read by |
|---|---|---|---|
| A | Title | Extract | Summate, Canonize (rewrite) |
| B | Summation | Summate | Summate (refine), Canonize (rewrite) |
| C | Inputs | Extract | Summate, Canonize |
| D | Outputs | Extract | Summate, Canonize |
| E | Catalyst | Extract | Summate, Canonize |
| F | Regulators | Extract | Summate, Canonize |
| G | Reviews | Extract | — |
| H | Source1 | Extract | Summate, chips |
| I | Source2 | Extract | Summate, chips |
| J | Source3 | Extract | Summate, chips |
| K | Source4 | Extract | Summate, chips |
| L | Source5 | Extract | Summate, chips |

- All sheet writes use `values:batchUpdate` (not `spreadsheets:batchUpdate`).
- Subtitle rows (`A` starts with `## `) and gap rows (`A` fully wrapped in
  `()`) are skipped by Summate and Canonize (logged once per row).
- Concurrent edits: Summate/Canonize re-read the sheet on each Start; never
  write a row they didn't first read.

Sheet URL is captured from the active Chrome tab when the user hits
**Create** in Main — the active tab must match
`https://docs.google.com/spreadsheets/d/<id>/edit#gid=<gid>`. If not, refuse
to create and flash a danger-styled message in the project block. The URL
is read-only after Create; to change it, delete and recreate.

### 1.7 PDF flow

#### 1.7.1 Extract input

User picks PDFs via `showOpenFilePicker({ types: [{ accept: {
"application/pdf": [".pdf"] }}], multiple: true })`. Picked files can live
anywhere on the filesystem. Stored in-memory as
`FileSystemFileHandle[]` — **not persisted across panel close** (re-pick is
fast; the cap is 10).

UI (per Q8a):

- Top of Extract interactive zone: pathway-name input (mono, height 32px,
  required, persisted to magic file with 250ms debounce).
- Below: vertical chip list. Each chip: `📄 <basename> · <size>kB · ✕`.
  Empty list → render the dashed-placeholder *"add review-article PDFs"*.
- `+ Add PDF` button: opens picker; multi-select OK; clamp to 10 (silently
  drop overflow + log warn).
- On Start: PDFs are copied to `<project>/PDF/<original-basename>` via
  FS Access write. Then the LLM call is made with those bytes attached.

#### 1.7.2 Summate input — merged pmid-tagger

The pmid-tagger logic from `orig-plan/pmid-tagger/` is **merged into
AICurator's service worker** (one extension, not two co-installed). It
lives in:

- `src/background/service-worker.ts` — `chrome.tabs.onUpdated`,
  `onCreated`, `onRemoved`, `chrome.runtime.onMessage`,
  `chrome.downloads.onDeterminingFilename` listeners.
- `src/background/pmid-tracker.ts` — pure logic library: `tabPmid`,
  `tabUrls`, `findPmidForReferrer`, with `chrome.storage.session` mirror
  for service-worker resilience.
- `src/content/pmc-pmid.ts` — content script on
  `https://pmc.ncbi.nlm.nih.gov/articles/*` that posts the page's PMID
  back to the worker.

The `onDeterminingFilename` handler:

1. Reads `chrome.storage.local.activeProject` (panel writes this on every
   project switch). If unset, leave the filename untouched.
2. Looks up PMID for the download's referrer via `findPmidForReferrer`.
3. If a PMID is found, suggests
   `"aicurator/<active-project>/PDF/PMID-<id>_<basename>.pdf"` with
   `conflictAction: "uniquify"`.
4. If no PMID is found, leaves the filename untouched (it falls into the
   user's flat Downloads dir under its publisher-given name; the user has
   to handle that case manually, per Q9.2 lock).

#### 1.7.3 PDF chips in Summate tab (per Q9c)

When the user selects a row range in Summate, render a compact preview:
one row per sheet row, each showing its PMID chips:

- Initially `🔗 PMID 12345678` — muted-blue, click opens
  `https://pubmed.ncbi.nlm.nih.gov/12345678/` in a new tab.
- Once a `PDF/PMID-12345678_*.pdf` exists in the project dir: chip flips
  to `📄 PMID 12345678 ✓` in `--ok` green.

Detection sources:

- Subscribe to `chrome.downloads.onChanged` for instant flips on download
  completion.
- 5-second polling fallback via FS Access dir scan (catches files dropped
  in by the user via OS file manager).

Scope: chips render only for Source1..Source5 (H..L). Bare PMID text in
free-form cells is ignored.

### 1.8 NCBI E-utilities (Extract step)

JS-only, three sub-steps as in `extract-skill.md` §3:

- **3a ESearch DOI batch** at
  `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi?db=pubmed&term=<doi1>[AID]+OR+...&retmode=json&retmax=<N>`
  — chunked at ~200 DOIs per call.
- **3b ESummary** at
  `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi?db=pubmed&id=<pmid1,pmid2,...>&retmode=json`
  — per chunk.
- **3c per-ref title+author fallback** for refs with no DOI and no inline
  PMID, at one ESearch per ref. Strict single-match rule: only adopt PMID
  when `idlist.length === 1`.

The **JS-enforced no-fabrication rule** is the resolver's responsibility:

- LLM is told to leave `pmid` null when it didn't see one printed in the
  PDF.
- LLM-supplied PMIDs (`pmid_source: "inline"`) are validated by the
  resolver against the joined PDF text: if the PMID doesn't appear, it's
  stripped to null and a warn is logged.
- Resolver-added PMIDs carry `pmid_source ∈ {"esearch:doi",
  "esearch:title-author"}`.
- The post-Extract log breakdown surfaces the audit trail: counts by
  `pmid_source` so the curator can spot a silent network failure.

### 1.9 UniProt SPARQL (Canonize)

Endpoint: `https://sparql.uniprot.org/sparql`. Single batched query using
`VALUES ?label { "name1" "name2" ... }` UNION'd over `up:mnemonic`,
`up:recommendedName/up:fullName`, and `up:gene/up:name`. For each label
that returns one or more accessions:

1. **Filter to human only** (mandatory): keep only accessions where
   `up:organism = uniprotkb:9606`. If the label has no human candidate,
   leave the name unchanged in the sheet.
2. **Prefer reviewed** (SwissProt): among human candidates, keep
   `up:reviewed = true` if any exist; else fall back to TrEMBL.
3. If still ambiguous (multiple reviewed-human candidates), leave the name
   unchanged and log `[warn] ambiguous: "X" matches N proteins`.
4. The chosen accession's gene symbol (`up:encodedBy / up:locusName`,
   uppercased) is the canonical replacement.

Pipe parsing for cells (Inputs C, Outputs D, Catalyst E, Regulators F):

- Strip leading `+`/`-` (regulator polarity).
- Strip leading integer stoichiometry (`2 ATP …` → `ATP …`).
- Strip trailing `[compartment]`.
- Strip surrounding whitespace.
- Gap-marked entities `(NF-kB [nucleoplasm])` are left alone (parens
  preserved).
- After replacement, the prefix/stoichiometry/compartment scaffolding is
  re-attached on writeback.

Rewriting in Title (A) and Summation (B):

- Source of the replacement map is exclusively C/D/E/F — those columns
  have a well-formed schema; A and B are free text.
- For each `bareName → canonicalGeneSymbol` entry, build a regex
  `\b<escaped bareName>\b` (case-sensitive). Apply to A and B for the
  same row range.
- Skip the entry when `bareName` is fewer than 3 characters (avoids
  collisions like single-letter or two-letter abbreviations matching
  unrelated tokens in prose).
- Replacement is greedy in source-order; longer names are replaced first
  to avoid sub-string collisions (e.g. `ORC complex` before `ORC`).
- The replacement is applied to the whole cell value, then the cell is
  written back via `values:batchUpdate`.
- Subtitle and gap rows (skipped by the entity-column pass) are also
  skipped here: their A is `## …` or `(…)` and the regex is anchored to
  identifier-shaped tokens, so practical false positives are minimal,
  but we skip explicitly to keep semantics consistent.

Errors: zero candidates anywhere → leave alone, log `[warn]`. Multiple
human-reviewed candidates → leave alone, log `[warn]`. Network failure →
abort entire Canonize run, log `[err] UniProt unreachable`.

### 1.10 Settings persistence

Split storage:

- `chrome.storage.local`: `apiKey` only.
- `chrome.storage.sync`: `provider`, `modelName`, `selectedProject`, plus
  any future non-secret settings.

Quotas are well within limits.

Per-field 250ms debounce. On each successful `chrome.storage.set` resolve,
update `lastSaveAt = Date.now()`. The "All changes saved" hint renders
when `Date.now() - lastSaveAt < 5000`. On failure: dot turns red, a quiet
console error.

`chrome.storage.onChanged` is wired (the service worker writes
`activeProject` on download routing — the panel must reflect that). Echo
loop is moot because of the single-instance lock.

### 1.11 Logs

Per-process (`extract`/`summate`/`canonize`) `createSignal<LogLine[]>`
capped FIFO at 500 lines. On every append, debounced 1s, write the rolling
500 to `chrome.storage.local` under `logs.extract`/`logs.summate`/
`logs.canonize`. Hydrated on panel mount. **Cleared on project switch**
(previous-project logs are stale).

Auto-scroll to bottom on append unless the user has scrolled up
(`scrollTop + clientHeight >= scrollHeight - 4`). When the user is
unpinned, a floating `↓ N new` pill appears in the bottom-right of the log
window; clicking it pins back.

`role="log"` `aria-live="polite"` for screen readers.

### 1.12 Initialization order on panel open

1. Boot store with defaults.
2. Load `chrome.storage.sync` + `chrome.storage.local` in parallel; populate
   store.
3. Subscribe to `chrome.storage.onChanged`.
4. BroadcastChannel single-instance check (200ms). If sibling: render splash
   and stop.
5. Hydrate per-process log signals from `chrome.storage.local.logs.*`.
6. Read FS handle from IndexedDB. If present:
   `queryPermission({ mode: 'readwrite' })`.
   - `granted`: proceed to (7).
   - `prompt`: leave handle in store but mark `needsPermission = true`;
     UI in Main shows a "Re-grant access" inline button.
   - `denied`: clear handle from IDB; treat as not granted.
   If no handle in IDB: `needsPicked = true`; UI shows "Grant access".
7. If projects-dir handle granted: scan one level deep, parse
   `.aicurator.json` per subdir → `project.list`. Restore `selectedName`
   from `chrome.storage.sync` if it exists in the list, else select [0],
   else `selectedName = null`.
8. If a project is selected: load its `stage`, `pathwayName`, etc. from
   the magic file → store.
9. Render Main tab.

No provider probe on init.


## 2. Manifest, build, security

### 2.1 `manifest.config.ts`

```ts
import { defineManifest } from '@crxjs/vite-plugin';
export default defineManifest({
  manifest_version: 3,
  name: 'AICurator',
  version: '26.1.0',
  description: 'Reactome curation workflow side panel',
  key: '<base64 public key — pinned extension ID>',
  permissions: [
    'sidePanel', 'storage', 'tabs', 'downloads', 'identity', 'scripting',
  ],
  host_permissions: [
    'https://api.openai.com/*',
    'https://api.anthropic.com/*',
    'https://openrouter.ai/*',
    'https://sheets.googleapis.com/*',
    'https://eutils.ncbi.nlm.nih.gov/*',
    'https://sparql.uniprot.org/*',
    'https://pmc.ncbi.nlm.nih.gov/*',
    'https://pubmed.ncbi.nlm.nih.gov/*',
  ],
  oauth2: {
    client_id: '__REPLACED_AT_BUILD__',
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  },
  side_panel: { default_path: 'src/sidepanel/index.html' },
  action: { default_title: 'AICurator' },
  background: {
    service_worker: 'src/background/service-worker.ts',
    type: 'module',
  },
  content_scripts: [{
    matches: ['https://pmc.ncbi.nlm.nih.gov/articles/*'],
    js: ['src/content/pmc-pmid.ts'],
    run_at: 'document_end',
  }],
  icons: {
    '16':  'icons/16.png',
    '32':  'icons/32.png',
    '48':  'icons/48.png',
    '128': 'icons/128.png',
  },
});
```

`oauth2.client_id` is templated by a tiny Vite plugin that reads
`AICURATOR_OAUTH_CLIENT_ID` from env at build time. If unset, build emits a
warning and ships the placeholder; OAuth-dependent features fail-loud at
runtime with a banner pointing to README.

### 2.2 Pinned extension ID

The maintainer generates a key pair once:

```
openssl genrsa 2048 | openssl pkcs8 -topk8 -nocrypt -out aicurator.pem
```

Derives the public key (base64) and pastes into `manifest.config.ts`'s
`key` field. The private key is **not committed** and is only needed if
the maintainer ever switches to packing `.crx`. The committed public key
is enough to pin the extension ID across all team members' unpacked
installs.

### 2.3 GCP one-time setup (README)

1. Create a Google Cloud project.
2. Enable the **Google Sheets API**.
3. Configure the **OAuth consent screen** in Testing mode. Fill app name,
   support email, scope `https://www.googleapis.com/auth/spreadsheets`.
4. Add team members' Google accounts as **Test Users**.
5. Create an **OAuth 2.0 Client ID** of type **Chrome Extension**, with
   the pinned extension ID.
6. Copy the resulting client ID into your local `.env`:
   `AICURATOR_OAUTH_CLIENT_ID=...apps.googleusercontent.com`.
7. `npm run build`. Load `dist/` unpacked.

### 2.4 Dependencies

Added (devDeps):
- `@crxjs/vite-plugin` — MV3 + Vite glue.
- `@types/chrome` — `chrome.*` typings.

Added (deps):
- `idb-keyval` — IndexedDB key/value (~600B), used to persist the
  `FileSystemDirectoryHandle`.

No SDKs (provider, Sheets, NCBI, SPARQL all hand-rolled `fetch`). No PDF
lib (provider APIs handle PDFs). No schema validator (~80-line hand-rolled).
No test framework (per CLAUDE.md).

### 2.5 Project structure

```
aicurator/
├── public/
│   ├── icons/{16,32,48,128}.png
│   └── reactome-logo.png
├── src/
│   ├── background/
│   │   ├── service-worker.ts
│   │   └── pmid-tracker.ts
│   ├── content/
│   │   └── pmc-pmid.ts
│   └── sidepanel/
│       ├── index.html
│       ├── main.tsx
│       ├── App.tsx
│       ├── tabs/
│       │   ├── MainTab.tsx
│       │   ├── ProcessTab.tsx
│       │   ├── ExtractTab.tsx
│       │   ├── SummateTab.tsx
│       │   └── CanonizeTab.tsx
│       ├── components/
│       │   ├── TabStrip.tsx
│       │   ├── LogWindow.tsx
│       │   ├── PdfChip.tsx
│       │   ├── Field.tsx
│       │   └── Button.tsx
│       ├── store/
│       │   ├── index.ts
│       │   ├── syncStorage.ts
│       │   └── localStorage.ts
│       ├── llm/
│       │   ├── provider.ts
│       │   ├── anthropic.ts
│       │   ├── openai.ts
│       │   └── openrouter.ts
│       ├── runners/
│       │   ├── extract.ts
│       │   ├── summate.ts
│       │   └── canonize.ts
│       ├── services/
│       │   ├── projectsDir.ts
│       │   ├── magicFile.ts
│       │   ├── sheets.ts
│       │   ├── ncbi.ts
│       │   ├── uniprot.ts
│       │   ├── pdfDir.ts
│       │   ├── entityParser.ts
│       │   ├── jsonSchema.ts
│       │   └── log.ts
│       ├── prompts/
│       │   ├── extract.system.ts
│       │   ├── summate.system.ts
│       │   └── summation-style.ts
│       └── styles/
│           ├── tokens.css
│           └── app.css
├── manifest.config.ts
├── vite.config.ts
├── tsconfig.json
├── tsconfig.app.json
├── tsconfig.node.json
└── package.json
```

The current Solid-starter `src/App.tsx`, `src/App.css`, `src/index.css`,
`src/index.tsx`, and `src/assets/*` are deleted. `index.html` at repo root
and `public/favicon.svg` / `public/icons.svg` are likewise removed (the
side panel's HTML is at `src/sidepanel/index.html`).

### 2.6 `tsconfig.app.json` notes

Existing strictness (`verbatimModuleSyntax`, `erasableSyntaxOnly`,
`noUnusedLocals`, `noUnusedParameters`) is preserved. Implications:

- Every type-only import uses `import type { ... }`.
- No `enum`, no `namespace`, no parameter-properties in classes (use
  `as const` unions and explicit field declarations).
- The `chrome.*` typings come from `@types/chrome`; add it to `types` in
  the tsconfig.

### 2.7 Content Security Policy

MV3 default CSP is sufficient. `connect-src` for `fetch` is implied by
`host_permissions`. No inline scripts. No `eval`.


## 3. Implementation phases

Ordered so each phase produces a runnable extension that can be Load-Unpacked
and exercised. Each phase ends with a manual QA pass.

### Phase 0 — Scaffolding (½ day)

1. Generate the public-key pair; paste public key into
   `manifest.config.ts`'s `key`.
2. Install `@crxjs/vite-plugin@2.x`, `@types/chrome`, `idb-keyval`. Update
   `vite.config.ts` to include `crx({ manifest })`.
3. Replace `vite.config.ts` boilerplate; add `public/` icons (16/32/48/128
   PNGs cropped from the Reactome logo for now — replaced with proper
   icons later).
4. Move `design_handoff_aicurator_sidepanel/assets/reactome-logo.png` to
   `public/reactome-logo.png`.
5. Delete starter Solid files (`src/App.*`, `src/index.*`, `src/assets/*`,
   root `index.html`, `public/favicon.svg`, `public/icons.svg`).
6. Create empty stubs for `src/sidepanel/index.html`, `main.tsx`,
   `App.tsx`, plus a stub `service-worker.ts`. Run `npm run dev` and Load
   Unpacked: confirm the side panel opens with a blank white panel.

### Phase 1 — Tokens, layout, tab strip (½ day)

1. `styles/tokens.css` — paste `:root` block from
   `design_handoff_aicurator_sidepanel/AICurator Side Panel Hi-Fi.html`
   verbatim.
2. `styles/app.css` — global resets matching Hi-Fi (body font, box-sizing).
3. `App.tsx` — two-column flex (TabStrip + content).
4. `components/TabStrip.tsx` — vertical tab strip with all four tabs always
   rendered. Driven by store. Solid `createMemo` for enablement. Arrow-key
   nav. `aria-selected`. Active accent bar. Lock emoji on disabled tabs.
5. `tabs/MainTab.tsx` — header row (logo + meta), scroll region,
   placeholder content (project block + settings shells without behavior).
   Pixel-faithful to Hi-Fi.

QA: visually compare side-by-side with `AICurator Side Panel Hi-Fi.html`.

### Phase 2 — Store, settings persistence, single-instance lock (1 day)

1. `store/index.ts` — `createStore` over `AppStore` shape.
2. `store/syncStorage.ts` and `store/localStorage.ts` — adapters with the
   split-key router.
3. `chrome.storage.onChanged` listener.
4. BroadcastChannel single-instance lock.
5. `tabs/MainTab.tsx`: wire Settings fields with 250ms debounced writes.
   "All changes saved" indicator.
6. Provider dropdown shows the three locked providers.

QA: open panel; type in API key; close + reopen; verify it persisted to
`local`. Close + reopen panel in second window; verify single-instance
splash.

### Phase 3 — Projects directory + magic file + project list (1 day)

1. `services/projectsDir.ts` — FS Access wrapper:
   - `pickDirectory()` calls `showDirectoryPicker({ startIn: "downloads" })`.
   - Persist handle via `idb-keyval`.
   - `bootstrapAicuratorDir()` writes the zero-byte sentinel via
     `chrome.downloads.download` of a `data:` URL if the dir doesn't yet
     exist.
   - `queryPermission()` wrapper.
   - `listProjects()` — one-level scan, parse magic files, filter by
     accepted versions.
   - `createProject(name, sheetUrl)` — make subdir + write magic file +
     make `PDF/` subdir.
   - `deleteProject(name)` — recursive subdir removal. Confirm modal.
2. `services/magicFile.ts` — `read()` / `write()` of `.aicurator.json`,
   shape-validated.
3. `MainTab.tsx`:
   - "Grant access" button when needed.
   - Project select dropdown with **active-tab capture** of sheet URL on
     Create. Validation: refuse Create if the active tab isn't a Google
     Sheet, flash danger.
   - Delete with confirm modal.
   - Quit closes the panel (`window.close()`).

QA: load extension, grant access, navigate to a Google Sheet, click
Create, confirm `.aicurator.json` and `PDF/` exist on disk. Switch
projects in dropdown. Delete one.

### Phase 4 — Process-tab shell + log window + log persistence (½ day)

1. `tabs/ProcessTab.tsx` — shared shell: header, badge, dashed-placeholder
   interactive zone, log-wrap, log-head, log body, blinking cursor.
2. `components/LogWindow.tsx` — log signal display, auto-scroll with
   floating "↓ N new" pill, `aria-live`.
3. `services/log.ts` — `createLog(name)` factory: returns
   `{ append, lines, clear }`. Persists rolling 500 to
   `chrome.storage.local.logs.<name>` debounced 1s. Hydrates from same key
   on construction. Clears on project switch.
4. Mock log emitter on a setInterval to verify rendering and persistence.
   Remove once Extract is wired.

QA: open extension, switch to Extract tab; mock lines appear; close panel;
reopen; lines re-render; switch projects; lines clear.

### Phase 5 — Provider abstraction + a smoke-test call (1 day)

1. `llm/provider.ts` — interface as in §1.5.
2. `llm/anthropic.ts` — `messages` API call with PDF doc blocks. Includes
   `anthropic-dangerous-direct-browser-access: true` header.
3. `llm/openai.ts` — chat completions (Responses API) with
   `{type:"file"}` content blocks. Optional `response_format` json_schema.
4. `llm/openrouter.ts` — extends OpenAI; baseUrl override; HTTP-Referer +
   X-Title headers.
5. `services/jsonSchema.ts` — hand-rolled validator (~80 lines): supports
   `type`, `properties`, `items`, `required`, `enum`, `additionalProperties`.
6. Add a **Test Connection** button in Settings (small, next to API key).
   Fires a 1-token request to the configured provider/model. Logs result
   to a quiet inline status line under Settings (not the process log
   windows). Useful while wiring.

QA: pick each provider, paste a real key, click Test Connection. Verify a
small successful response is logged.

### Phase 6 — Extract pipeline (2 days)

1. `prompts/extract.system.ts` — adapted from `extract-skill.md`:
   - Drop the CSV-writing instructions (we write to sheet).
   - Drop the HTML reference list instructions.
   - Drop the NCBI-network-call instructions; substitute *"leave PMID null
     when not printed inline; populate `pmid_source: \"inline\"` only when
     the PMID is verbatim in a PDF you read"*.
   - Keep entity rules, graph rules (gaps/branches/transports/reversibility),
     reference dedup, ladder-walk-prep.
   - Output: a JSON object matching the schema below.
2. JSON schema: `{ reactions: [{ title, inputs, outputs, catalyst,
   regulators, reviews, references: [{marker, pmid?, doi?, pmcid?,
   publisher_url?, title, firstAuthor, year, journal, type, pmid_source}]
   }], missingPathwayCoverage?: boolean }`.
3. `services/ncbi.ts` — ESearch+ESummary batch (3a/3b) and per-ref
   title+author fallback (3c). Returns `{ pmid?: string, pmid_source:
   "esearch:doi" | "esearch:title-author" | null }` per input ref.
4. `services/sheets.ts`:
   - `sheetsClient.getValues(spreadsheetId, range)`.
   - `sheetsClient.batchUpdateValues(spreadsheetId, [{range, values}])`.
   - OAuth via `chrome.identity.getAuthToken({ interactive: false }) || ({ interactive: true })`.
5. `runners/extract.ts`:
   1. Pre-flight: copy picked PDFs into `<project>/PDF/` (via FS Access).
   2. Empty-sheet / re-run guard (one modal max).
   3. LLM call with PDFs + system prompt + schema. `AbortController`
      threaded through.
   4. JSON parse + schema validate.
   5. NCBI resolution.
   6. JS-enforced no-fabrication validation (cross-check inline PMIDs
      against PDF text dumps from the request payload).
   7. Source-ladder walk.
   8. Build header row + one row per reaction (subtitles/gaps inline).
   9. `values:batchUpdate` to `A1:L<N>`.
   10. Update magic file: `stage = 'extracted'`. Update store.
   11. Log final breakdown: total reactions, branches, gaps, transports,
       reversible pairs, reference counts, PubMed-source breakdown
       (`inline:` / `esearch:doi` / `esearch:title-author`).
6. `tabs/ExtractTab.tsx`:
   - Pathway-name input (persisted to magic file).
   - PDF chip list + `+ Add PDF` button (10-cap).
   - Start/Cancel button (state-aware).
   - Status badge.

QA: pick a small review PDF + a pathway name, click Start, watch the log,
verify the sheet fills with 12 columns of plausible data.

### Phase 7 — Summate pipeline (1.5 days)

1. `prompts/summate.system.ts` — adapted from `summate-skill.md` +
   `summation-style.md`:
   - Drop the cache-file behavior (project dir is already in app state).
   - Drop the approval loop (no curator-in-the-loop in the extension).
   - Keep the V94 rules and Reactome conventions.
   - Output: plain prose text.
2. `services/pdfDir.ts` — list PDFs in `<project>/PDF/`, glob
   `PMID-<id>_*.pdf` per PMID, `chrome.downloads.onChanged` subscriber +
   5s polling fallback.
3. `runners/summate.ts`:
   1. Read sheet rows in selected range.
   2. Skip subtitle/gap rows.
   3. Per row:
      - Parse PMIDs from H..L.
      - Glob PDFs.
      - If zero PDFs: log err, skip row.
      - LLM call with PDFs + system prompt + row schema.
      - Validate output is non-empty prose.
      - `values:batchUpdate` to `B<row>`.
   4. After all rows: update magic file `stage = 'summated'`.
4. `tabs/SummateTab.tsx`:
   - Radio "all" / "span" + span input with validation.
   - "Re-scan PDFs" button.
   - PDF-chip preview grid for the selected range.
   - Note to curator: *"Drop PMID-prefixed PDFs into PDF/ via the
     download tagger. Click chips to open PubMed."*
   - Start/Cancel button.

QA: download a few PMID-prefixed PDFs (via the merged tagger by browsing
PubMed → publisher → PDF). Run Summate on a small range. Verify column B
fills.

### Phase 8 — Canonize pipeline (½ day)

1. `services/uniprot.ts` — SPARQL client for the human-mandatory +
   reviewed-first algorithm. Single batched query. Hand-rolled SPARQL
   (no library). Hand-rolled XML/JSON results parse (the endpoint returns
   JSON when `Accept: application/sparql-results+json` is set).
2. `services/entityParser.ts` — pipe-cell parser with dev-only
   `runChecks()` assertions on the parser's edge cases:
   - bare name with compartment.
   - leading `+`/`-`.
   - leading stoichiometry.
   - parenthesized gap.
   - multiple entities pipe-separated.
3. `runners/canonize.ts`:
   1. Read sheet rows in selected range (columns A..F).
   2. Skip subtitle/gap rows.
   3. Build set of unique bare names from C, D, E, F via the entity
      parser.
   4. SPARQL batch.
   5. Walk results: human-mandatory → reviewed-first → ambiguous-leave-alone.
   6. Build replacement map: `bareName → canonicalGeneSymbol`. Sort entries
      by `bareName.length` descending to apply longer-first.
   7. **Entity-column pass (C, D, E, F):** per cell, per entity, re-attach
      scaffolding (prefix/stoichiometry/compartment) after replacement.
   8. **Free-text pass (A, B):** for each replacement-map entry with
      `bareName.length >= 3`, run word-boundary regex replacement against
      cell values.
   9. Single `values:batchUpdate` covering A..F for affected rows.
   10. Update magic file `stage = 'canonized'`.
4. `tabs/CanonizeTab.tsx`:
   - Radio "all" / "span" + span input (same component as Summate).
   - Start/Cancel button.

QA: run Canonize on a Summate-completed sheet. Verify gene-symbol
replacements happened in the four entity columns *and* in Title (A) and
Summation (B). Spot-check that short-bareName entries (<3 chars) didn't
collide inside prose tokens.

### Phase 9 — Service worker: merged pmid-tagger + downloads routing (½ day)

1. `src/background/pmid-tracker.ts` — port logic from
   `orig-plan/pmid-tagger/background.js` + `content.js` to TypeScript.
2. `src/background/service-worker.ts`:
   - `chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true })`.
   - Tab tracking listeners.
   - `chrome.runtime.onMessage` for the PMC content script.
   - `chrome.downloads.onDeterminingFilename` with active-project routing.
3. `src/content/pmc-pmid.ts` — port from `content.js`. Same DOM extraction,
   posts via `chrome.runtime.sendMessage`.
4. Panel: write `chrome.storage.local.activeProject` on every project switch
   (ensures the worker has fresh routing context).

QA: in PubMed, click on an article → publisher site → download PDF.
Verify it lands at `<Downloads>/aicurator/<active-project>/PDF/PMID-…_*.pdf`.

### Phase 10 — Polish, accessibility, README (½ day)

1. Tab keyboard nav (arrow keys), focus rings, `aria-live` on log windows
   (already in earlier phases — verify).
2. Re-run modal copy + styling.
3. Empty-sheet modal copy + styling.
4. Error banners for: provider failure, OAuth failure, FS access denied.
5. README rewrite covering:
   - Dev-mode-only deployment.
   - GCP one-time setup walkthrough.
   - Pinned-extension-ID generation procedure (one-time, by maintainer).
   - The `AICURATOR_OAUTH_CLIENT_ID` env var.
   - Manual reload after `git pull`.
6. CHANGELOG with the version line for `v2601`.

QA: end-to-end on a fresh review PDF + fresh sheet → Extract → Summate →
Canonize cycle.


## 4. Out of scope for v2601 (explicit non-goals)

- **Multi-instance support.** A second open panel shows the splash and
  refuses. Future TODO.
- **Resume-after-panel-close** mid-run. Closing the panel kills the run.
  Future TODO: relocate runners to an offscreen document.
- **Auto-update.** Team members `git pull` + manual reload.
- **Provider auto-retry** on HTTP failure. The curator decides.
- **Streaming responses.** Single-shot only.
- **PDF rasterization for non-PDF-native providers.** Grok via OpenRouter
  uses OpenRouter's server-side parser.
- **PDF auto-fetch from publisher sites.** The curator clicks through
  PubMed/publisher pages; the merged tagger handles naming.
- **Schema migration code.** First migration ships when v2701 is cut.
- **Lint / formatter / test framework.** Per CLAUDE.md.
- **Google, Ollama, Azure, x.ai direct providers.** Out of v2601.


## 5. Risks & mitigations

| Risk | Mitigation |
|---|---|
| `@crxjs/vite-plugin@2.x` is beta; HMR may flake on service-worker / content-script changes | Document manual reload step in README; v0.x acceptance |
| OAuth consent screen verification (>100 test users) | Stay in Testing mode; if the team grows, document the verification path as a follow-up project |
| Sheet ID extraction from active tab fails (e.g. user is on a non-Sheet URL) | Refuse Create with a danger-styled inline error; require sheet tab focus |
| LLM hallucinates a PMID inline | JS-enforced no-fabrication check strips bad PMIDs; audit log shows `pmid_source` breakdown for the curator |
| User edits sheet between Extract and Summate, breaking the 12-column layout | Summate/Canonize re-read on Start; rows that don't match the schema are skipped with a warn |
| Anthropic browser-CORS toggle changes upstream | If `anthropic-dangerous-direct-browser-access` is removed, switch to a service-worker proxy fetch (one-day migration) |
| FS Access permission revoked between sessions | Init logic queries permission on boot; "Re-grant access" button in Main if `prompt`/`denied` |
| Disk write of zero-byte sentinel file via `chrome.downloads` requires a user-visible Downloads-shelf flash | Set `shelfEnabled: false` for that one call via `chrome.downloads.setShelfEnabled` (deprecated but still works); fallback: tolerate the brief shelf entry |
| Service-worker suspension loses `tabPmid`/`tabUrls` state | Already mirrored to `chrome.storage.session` (per original pmid-tagger logic) |
| OpenRouter per-page PDF parsing fee | Document; recommend Claude/GPT models for direct PDF support |
| Token budget on large PDF sets in Extract | Cap is 10 PDFs (per user spec); log a warn if token usage is near provider limit; user can split into multiple Extract runs targeting different sub-pathways |


## 6. Total effort estimate

Phases 0–10 sum to about **9.5–10 days** of focused work for one developer
familiar with Solid + Chrome extensions, with manual QA between phases. A
reasonable calendar window is two to three weeks elapsed accounting for
GCP setup, OAuth-screen iterations, and provider API quirks.

## 7. First commit after this plan

The grill session itself constitutes a design commitment. The first
implementation commit should be the **Phase 0 scaffolding** as a single
PR-equivalent change: dependency adds, manifest, icons, deletion of starter
files, blank panel that successfully Loads Unpacked.
