# AICurator Privacy Policy

_Last updated: 2026-05-07_

AICurator is a Chrome side-panel extension that helps Reactome curators
extract, summarize, and canonize information from scientific articles. This
document describes what data the extension handles and where that data goes.

## Data the extension stores locally

All user data is kept on your own machine via Chrome's extension storage APIs.
Nothing is sent to a server operated by us — there is no AICurator backend.

- `chrome.storage.sync` — your project list and settings (provider choice,
  model name, etc.). Synced across your Chrome profile by Google, per your
  Chrome account settings.
- `chrome.storage.local` — log buffers from the Extract / Summate / Canonize
  workflows and your **LLM provider API key**. Stays on the local machine.

The extension does not use cookies, analytics, telemetry, crash reporting,
advertising IDs, or any other tracking mechanism.

## Data sent to third parties

When you run a workflow, the extension makes direct browser-to-API requests
(no proxy) to whichever services you have configured:

- **LLM providers** — Anthropic, OpenAI, OpenRouter, or Google (Gemini).
  Receives the system + user prompt and any PDFs you attach. Subject to that
  provider's privacy policy and your account's data-retention settings.
- **Google Sheets API** — when you export results. Authenticated via Chrome's
  `identity` API (OAuth 2.0); the extension only requests the
  `spreadsheets` scope.
- **NCBI E-utilities, PubMed, PMC** — read-only metadata lookups for PMIDs
  and articles.
- **UniProt** (REST + SPARQL) — read-only protein lookups.

Your API key is sent only to the LLM provider you selected, in the standard
`Authorization` / `x-api-key` header for that provider.

## PDF text extraction (optional)

If you install the optional native messaging host
(`aicurator-pdftotext`), the extension passes PDF bytes to that local helper
over stdio and caches the extracted text as a `.txt` file next to the PDF on
your disk. The helper runs entirely on your machine; nothing leaves the
device through this path.

## Permissions, briefly

- `sidePanel`, `tabs`, `scripting` — render the side panel and read the
  active tab's URL/PMID.
- `storage` — persist projects, settings, logs, API key (see above).
- `downloads` — save exports you trigger.
- `identity` — Google OAuth for Sheets export.
- `nativeMessaging` — talk to the optional PDF helper.
- Host permissions — limited to the API endpoints listed above.

## Data sharing & sale

We do not sell, share, or transfer user data. We do not have access to your
data because we never receive it.

## Removal

Uninstalling the extension removes `chrome.storage.local` immediately.
`chrome.storage.sync` is removed by Chrome on the next sync. To revoke Google
Sheets access, visit
<https://myaccount.google.com/permissions>.

## Contact

Questions about this policy: <gtrwst9@gmail.com>.
