# AICurator

This is a Reactome-internal extension that team members can install via
a non-public Chrome Web Store address (ask Ralf if you don't have it).

A Chrome MV3 side-panel extension that drives a four-stage Reactome
curation workflow against a Google Sheet:

1. **Main** — pick or create a project (a folder under
   `<Downloads>/aicurator/`) bound to a Google Sheet, configure the AI
   provider, manage settings.
2. **Extract** — feed review-article PDFs and a pathway name to an LLM,
   resolve PMIDs against PubMed, write a 12-column reaction table to the
   sheet.
3. **Summate** — for each row, send the cited PMID-prefixed PDFs and the
   row context to an LLM, draft a Reactome-style summation paragraph,
   write it to column B.
4. **Canonize** — replace protein/gene mentions in columns A–F with their
   canonical UniProt-confirmed (human-only, reviewed-first) gene symbols.

Stack: Vite + SolidJS + TypeScript + `@crxjs/vite-plugin`.

The following is for people outside the team.

## Requirements

- Chrome (or a Chromium-based browser) with the **File System Access
  API** enabled.
- A Google account with permission to edit the target sheet(s) — this
  same account must be added as a **Test user** on the OAuth consent
  screen of the GCP project (see [Google Cloud setup](#google-cloud-setup)).
- An API key for **Anthropic**, **OpenAI**, or **OpenRouter** (whichever
  provider you select in Settings).
- Node.js 20+ and npm 10+ for builds.
- *(Optional, for Summate)* `libpoppler-glib` and `libjson-glib` development
  headers + `gcc`. With these installed, Summate extracts PDF text once
  via libpoppler and caches it as `<basename>.txt` next to each PDF,
  cutting per-row provider tokens substantially. Without them Summate
  falls back to sending PDFs as document blocks (original behavior).
  See [Native host setup](#native-host-setup-optional).


## Quickstart

```bash
git clone <this-repo>
cd aicurator
npm install
echo 'AICURATOR_OAUTH_CLIENT_ID=YOUR_CLIENT_ID.apps.googleusercontent.com' > .env
npm run build
```

Then load `dist/` in Chrome:

1. `chrome://extensions` → enable **Developer mode** (top-right).
2. **Load unpacked** → select the `dist/` directory.
3. The AICurator extension appears with extension ID
   `ficloojffnfibdhflbinbnonaemknfai` (pinned via the `key` field in the
   manifest — same on every team member's machine).
4. Click the AICurator action button (puzzle-piece menu → AICurator) to
   open the side panel.

`AICURATOR_OAUTH_CLIENT_ID` must be set before `npm run build`. If
omitted, the build prints a warning and Sheets OAuth fails at runtime
with a banner. See [Google Cloud setup](#google-cloud-setup) below for
how to obtain a client ID.

Subsequent updates: `git pull && npm run build`, then reload the
extension card in `chrome://extensions`. (Side-panel HMR works during
`npm run dev`, but service-worker and content-script changes require a
manual reload — known `@crxjs` limitation.)


### Native host setup (optional)

The Summate tab can ship row-cited PDFs to the LLM as either (a)
already-extracted plain text or (b) raw PDF document blocks. Path (a)
needs a small native messaging host that links libpoppler-glib:

```bash
# Debian/Ubuntu:
sudo apt install libpoppler-glib-dev libjson-glib-dev

# Fedora:
sudo dnf install poppler-glib-devel json-glib-devel

# Arch:
sudo pacman -S poppler-glib json-glib

# openSUSE:
sudo zypper install poppler-glib-devel json-glib-devel

# then:
./scripts/install-native-host.sh
```

The script compiles `scripts/native-host/aicurator-pdftotext.c` to
`~/.local/bin/aicurator-pdftotext` and writes the host manifest into
each Chrome / Chromium config dir it finds under `~/.config/`. Reload
the AICurator extension afterwards. The Summate tab's PDF-directory
line will then read **Mode: libpoppler text** (vs **native PDF blocks**
when the host is missing).

The native host is GPL-2.0 (it links libpoppler); the rest of the
extension stays Apache-2.0. The two communicate over stdio, which the
GPL FAQ recognises as separate-process IPC, so the licenses don't mix
in either direction.


## Google Cloud setup

One-time, by the project maintainer (or any team member who wants their
own copy of the OAuth client). Takes about 10 minutes.

1. **Create a GCP project** at https://console.cloud.google.com/. Name
   it `aicurator-dev` or similar.
2. **Enable the Google Sheets API**:
   APIs & Services → Library → search "Google Sheets API" → Enable.
3. **Configure the OAuth consent screen**:
   APIs & Services → OAuth consent screen.
   - User Type: External.
   - App name: AICurator. Support email: yours.
   - Scopes: add `https://www.googleapis.com/auth/spreadsheets`.
   - Test users: add your Google email (and any teammate's).
   - Save → leave Publishing status as **Testing** (do not click
     "Publish App" — that triggers Google's review process).
4. **Create the OAuth Client ID**:
   APIs & Services → Credentials → + Create credentials → OAuth client
   ID.
   - Application type: **Chrome extension**.
   - Application ID: `ficloojffnfibdhflbinbnonaemknfai` (the pinned ID
     of this extension).
   - Save and copy the resulting Client ID (looks like
     `123456789012-abc...apps.googleusercontent.com`).
5. **Wire it into the build**:
   ```bash
   echo 'AICURATOR_OAUTH_CLIENT_ID=123456789012-abc...apps.googleusercontent.com' > .env
   npm run build
   ```
   Verify substitution: `grep client_id dist/manifest.json` should show
   the real value (not the placeholder).
6. **Reload the extension** in `chrome://extensions`.
7. **First sheet write triggers OAuth consent**. Pick the same Google
   account you added as a Test user; click *Continue* on the
   "unverified app" warning (Test-mode apps always show this); approve
   the spreadsheets scope. Subsequent calls return a token silently.

### Adding a new team member

The maintainer adds the new person's Google email under OAuth consent
screen → Test users (limit: 100). They can then run AICurator using the
same committed Client ID with no GCP work of their own.

### Troubleshooting

- **"redirect_uri_mismatch"** — extension ID drifted. Verify
  `chrome://extensions` shows ID `ficloojffnfibdhflbinbnonaemknfai`.
- **"This app's request is invalid"** — consent screen scope missing.
- **"OAuth client was not found"** — `AICURATOR_OAUTH_CLIENT_ID` wasn't
  set when you ran `npm run build`. Re-set and rebuild.
- **"access_denied"** — your Google account isn't in the Test users
  list. Add it.
- **Token cache weirdness** — on the side panel's DevTools console:
  `chrome.identity.clearAllCachedAuthTokens()`.


## Daily workflow

### Projects directory

AICurator stores all per-project files in `<Downloads>/aicurator/<name>/`:

```
<Downloads>/aicurator/
├── classical-complement-2026/
│   ├── .aicurator.json     # magic file: sheet URL, gid, stage, pathway name
│   ├── extract-response.txt # raw LLM response from last Extract run (debug)
│   └── PDF/
│       ├── Smith2024.pdf            # Extract input (review article)
│       ├── PMID-12345_paper.pdf     # Summate input (auto-prefixed by tagger)
│       └── ...
└── another-project/
```

The `aicurator/` root directory must be granted via the FS Access picker
on first run. Subsequent panel opens require re-granting once per
session — this is an FS Access API limitation, not a bug. To make it
sticky, enable
`chrome://flags/#file-system-access-persistent-permissions` and restart
Chrome.

### Main tab

- **Grant access** (once) — pick or create the `aicurator/` folder
  inside your Downloads directory. **Do not click "Select folder" at
  the Downloads root** — Chrome can crash (see `chrome-issues.md`).
- **Create project** — type a name and click Create. The active Chrome
  tab must be a Google Sheet (`https://docs.google.com/spreadsheets/d/.../edit#gid=...`);
  the URL is captured at creation time and stored in the magic file.
- **Settings** — pick provider (Anthropic / OpenAI / OpenRouter), type
  the model name (e.g. `claude-opus-4-5`, `gpt-5-mini`,
  `anthropic/claude-opus-4-5` for OpenRouter), paste your API key.
  Click **Test connection** to verify auth + model + network.

### Extract tab

- Type a pathway name (persisted to the magic file).
- Add up to 10 review-article PDFs (PDFs may live anywhere on disk).
- **Start** copies PDFs into `<project>/PDF/`, calls the LLM with the
  PDFs + the [extract-skill prompt](src/sidepanel/prompts/extract.system.ts),
  validates the JSON output, resolves PMIDs against
  `eutils.ncbi.nlm.nih.gov` (DOI batch + title+author fallback), walks
  the source ladder (PubMed > PMC > DOI > publisher > blank), and
  writes the 12-column table to the sheet.
- The full LLM response is saved to `<project>/extract-response.txt`
  for debugging.
- **Test sheet write** uses synthetic mock data — useful for iterating
  on row formatting or sheet-write logic without paying for an LLM call.

### Summate tab

- Pick **all rows** or a span (e.g. `5-23`).
- Drop PMID-prefixed PDFs into `<project>/PDF/` via the integrated
  pmid-tagger (browse to PubMed → publisher PDF → download; AICurator's
  service worker auto-renames to `PMID-<id>_<basename>.pdf` and routes
  it to the active project's `PDF/` folder).
- The chip grid shows one row per processable sheet row. Each PMID chip
  starts as a muted-blue link; once the corresponding PDF lands in
  `PDF/`, the chip flips to a green `📄 PMID … ✓`.
- **Start** processes each row: parses PMIDs from columns H–L, finds
  matching PDFs, calls the LLM with the row context + PDFs + the
  [summate-skill prompt](src/sidepanel/prompts/summate.system.ts),
  writes the prose to column B.
- Each row commits independently — partial-progress survives errors.

### Canonize tab

- Pick **all rows** or a span.
- **Start** scans columns C–F for unique entity bare names, filters out
  obvious small molecules / ions, queries UniProt SPARQL (human only,
  reviewed-first) plus a UniProt REST search fallback for synonyms /
  withdrawn symbols, and rewrites columns A–F in place. Names with no
  match or ambiguous matches are left unchanged.
- No LLM call.


## PMID-tagger workflow

The merged pmid-tagger lives in the service worker
(`src/background/service-worker.ts` + `pmid-tracker.ts` + content script
`src/content/pmc-pmid.ts`). It tracks PMIDs per browser tab when the
user visits PubMed or PMC article pages, and intercepts subsequent PDF
downloads from the same tab (or its child tabs) to:

1. Read the active project name from `chrome.storage.local.activeProject`
   (the side panel writes this on every project switch).
2. Suggest `aicurator/<active-project>/PDF/PMID-<id>_<basename>.pdf` as
   the download path.

If no active project is set or no PMID context is available, downloads
land where Chrome would normally put them.

**One Chrome setting matters:** "Download PDF files instead of
automatically opening them in Chrome" must be **enabled** in
`chrome://settings/content/pdfDocuments` for the tagger to fire — Chrome's
inline PDF viewer bypasses the downloads pipeline entirely. This is
tracked in `TODO.md`.


## Development

### Scripts

- `npm run dev` — Vite dev server with side-panel HMR. Service-worker
  and content-script edits require manual extension reload.
- `npm run build` — `tsc -b && vite build`. Output to `dist/`.
- `npm run preview` — preview the built `dist/` (rarely useful for an
  extension).

### Project layout

```
src/
├── background/
│   ├── service-worker.ts        # MV3 worker, sidePanel + pmid-tagger
│   └── pmid-tracker.ts          # tab/PMID tracking lib
├── content/
│   └── pmc-pmid.ts              # PMC PMID extractor
├── sidepanel/
│   ├── index.html / main.tsx / App.tsx
│   ├── tabs/                    # MainTab + ProcessTab + Extract/Summate/Canonize
│   ├── components/              # TabStrip, LogWindow, InstanceGuard
│   ├── store/                   # createStore + storage adapters + actions
│   ├── llm/                     # Provider interface + Anthropic/OpenAI/OpenRouter
│   ├── runners/                 # extract.ts, summate.ts, canonize.ts
│   ├── services/                # sheets, ncbi, uniprot, pdfDir, log, …
│   ├── prompts/                 # extract.system.ts, summate.system.ts
│   └── styles/                  # tokens.css, app.css
└── types/
    └── fs-access.d.ts           # FS Access API type shim for TS 6
```

### Pinned extension ID

The committed `manifest.config.ts` includes a `key` field (the public
half of an RSA keypair) that pins the extension ID across all team
members' unpacked installs. The private half (`aicurator.pem`) is
**gitignored** and only needed if the maintainer ever wants to pack a
`.crx` or rotate the keypair.

To regenerate (destructive — invalidates the GCP OAuth client):

```bash
openssl genrsa 2048 | openssl pkcs8 -topk8 -nocrypt -out aicurator.pem
openssl rsa -in aicurator.pem -pubout -outform DER 2>/dev/null | openssl base64 -A
```

Paste the resulting base64 into `manifest.config.ts`'s `key` field.
Compute the new extension ID:

```bash
openssl rsa -in aicurator.pem -pubout -outform DER 2>/dev/null \
  | openssl dgst -sha256 -hex \
  | awk '{print substr($2,1,32)}' \
  | tr '0-9a-f' 'a-p'
```

Update the GCP OAuth Chrome Extension client to the new ID, and have
every team member reload the extension.


## Known issues

See `chrome-issues.md` for documented Chrome bugs we've worked around:

1. Renderer crash on FS Access permission grant for system-special
   folders (Downloads root, Desktop). Mitigated by no `startIn`,
   `mode: 'read'` then upgrade, name validation.
2. Renderer crash on `chrome.downloads.download` with empty base64 data
   URLs. Mitigated by using `data:text/plain,...`.
3. FS Access permissions are session-scoped by default. Mitigation: the
   `chrome://flags/#file-system-access-persistent-permissions` flag.
4. Stale-handle / permission-cached disconnect. Mitigated by an explicit
   existence probe.
5. `chrome.downloads.download` rejects leaf filenames starting with a
   dot. Mitigated by using `aicurator-init.txt`.
6. `@crxjs/vite-plugin@2` doesn't HMR service-worker or content-script
   changes. Manual reload required.


## Roadmap / TODO

See `TODO.md` for the current backlog:

- Copy-log-to-clipboard button in `LogWindow`.
- Resolution of the PDF-tagger / Chrome inline-PDF-viewer setting
  conflict.
- Pre-extracting PDF text via `pdftotext` (native messaging) or
  `pdfjs-dist` (in-browser) to reduce token + OpenRouter parsing cost
  on Summate calls.


## Project layout reference

- `plan.md` — the locked design plan covering all 11 phases.
- `TODO.md` — backlog items.
- `chrome-issues.md` — Chrome bugs encountered and shipped mitigations.
- `CHANGELOG.md` — release notes.
- `orig-plan/` — original specs (extract-skill.md, summate-skill.md,
  summation-style.md, info.txt, phases.txt, the standalone pmid-tagger
  source it was merged from).
- `design_handoff_aicurator_sidepanel/` — the design hand-off (README +
  Hi-Fi HTML reference).


## License

See `LICENSE` (Apache 2.0, inherited from the Solid-TS template the
project was scaffolded from).
