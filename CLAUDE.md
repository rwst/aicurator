# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

- `npm run dev` — Vite dev server at http://localhost:5173
- `npm run build` — type-check (`tsc -b`) then production build to `dist/`
- `npm run preview` — serve the built `dist/`
- `npm run test` — Vitest run (node env, no jsdom). Boundary tests for the deepened ports-and-adapters modules: `projectsDir`, `llm`, `refResolver`, `canonizer`. No lint or format scripts configured.

## Repository state

The product is implemented (current internal version `v2606`, manifest `26.6.0`). Feature ledger lives in `CHANGELOG.md`; backlog in `TODO.md`; documented Chrome quirks in `chrome-issues.md`. Locked design plan in `plan.md`.

`design_handoff_aicurator_sidepanel/README.md` is the source of truth for **visual design** (design tokens, typography, hi-fi prototype HTML). Treat the prototype HTML/JSX as reference only; the implementation is in `src/sidepanel/` and is the source of truth for behavior.

## Architecture

- **Surface**: Chrome MV3 side panel. Background service worker calls `chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true })`. The panel page lives at `src/sidepanel/index.html`.
- **Four vertical tabs** (Main, Extract, Summate, Canonize) — all process tabs are **always available** (post-v2602). Per-tab `badge` memos surface why Start is locked (no project selected, missing provider config, invalid span, etc.). Summate and Canonize share row-span input state via `store/rowSpan.ts` (whatever you pick in one is pre-set in the other). Memos that depend on other memos must be declared after their dependencies — Solid `createMemo` evaluates eagerly, so out-of-order references hit a TDZ.
- **State**: a single root `createStore` (`solid-js/store`) holding `ui`, `project`, `settings`, `logs`. Type definitions in the handoff README.
- **Persistence**: `chrome.storage.sync` for projects list + settings (debounced 250 ms per field; reconciled via `chrome.storage.onChanged`). `chrome.storage.local` for log buffers and the API key. Storage is wrapped in `syncStorage` / `localStorage` adapters — components don't call `chrome.storage` directly.
- **Log streaming**: each process tab connects via `chrome.runtime.connect({ name: 'log:extract' })` etc., backed by a per-process `createSignal<LogLine[]>` capped at 500 lines. Auto-scroll only when the user has not scrolled up.
- **PDF text extraction (Summate)**: optional native messaging host (`scripts/native-host/aicurator-pdftotext.c`) linking `libpoppler-glib`. Built and installed via `scripts/install-native-host.sh`. The sidepanel pings it once per session (`services/pdfText.ts`); if present, Summate caches `<basename>.txt` next to each PDF and splices the text into the user prompt; if absent, it sends PDFs as document blocks as before. Host is GPL-2.0, separated from the Apache-2.0 extension by stdio IPC.
- **Projects directory** (`src/sidepanel/projectsDir/`): a deepened, port-isolated state machine owning the FS-Access grant lifecycle. Public surface is `state()` (discriminated `ProjectsDirState`: `unpicked | granted | stale | wrong-folder | bootstrap-failed | cancelled`), `grant()`, `forget()`, `refreshList()`. The validate-before-escalate invariant (chrome-issues.md §1) is structural — no public path bypasses name validation. Three ports (`ChromeFsaPort`, `DownloadsPort`, `HandleStorePort`) traffic in opaque `DirToken` strings so the state machine is testable in plain node.
- **LLM providers** (`src/sidepanel/llm/`): four direct-fetch providers — Anthropic, OpenAI, OpenRouter, Google (Gemini) — composed from pure-value strategies (`SchemaDialect`, `ThinkingPolicy`, `MessageFormat`) plus two ports (`HttpTransport`, `Base64Encoder`). Public API is `generateText(req)` and `generateJson<T>(req)` returning a discriminated `JsonResult<T> = {kind:'strict'} | {kind:'best-effort', degraded}` — a caller cannot reach `result.data` without first switching on `kind`, and the post-parse validate runs uniformly across providers regardless of strictness. Schema sanitization for Gemini happens once at construction time and surfaces synchronously via `provider.warnings`; `assertSchemaCompatible(schema, providerName)` is a sync precheck. Reasoning gating stays per-provider via the `ThinkingPolicy`.
- **Reference resolver** (`src/sidepanel/services/refResolver/`): NCBI PMID resolution as a strategy chain (`InlineVerifier` → `DoiBatch` → `TitleAuthor`). Priority is structural — resolved slots are stripped before the next strategy runs. Single error path: `resolve()` throws only on abort; every other failure becomes a `transientError` on the result. Shared `TokenBucketRateLimiter` lives in the production HTTP NCBI adapter so DOI's ESearch+ESummary and title+author calls all consume the same 3/sec budget; tests verify the sliding-window invariant under a virtual clock against the real algorithm. `summary.bySource` is computed from the final `ResolvedRef[]` so per-ref labels and aggregate counts cannot drift.
- **Canonizer** (`src/sidepanel/services/canonizer/`): full parse → classify → 3-pass UniProt resolve → rewrite pipeline. `CanonizeColumnLayout` is first-class config (`freeText`, `entities`, `isSkippableRow`) declared by the runner via `REACTION_LAYOUT`; the canonizer iterates it and dispatches the right rewriter per column, so the runner can't pick the wrong mechanism. `UniprotPort` exposes three semantic methods (`searchSparqlReviewed` / `searchSparqlTrembl` / `searchRest`) so priority assertions are trivial in tests. `Clock` owns `withTimeout` so the 60s SPARQL hang test passes in zero real time. The `genePrefLabel`/`geneAltLabel`-only SPARQL paths (and the deliberate exclusion of protein-name paths to avoid Timeless ↔ TIPIN cross-gene collisions) are baked in with no public knob.
- **Design tokens**: `:root` CSS variables in `src/sidepanel/styles/tokens.css`, copied verbatim from the handoff. The log window uses a separate dark palette.

## TypeScript config notes

`tsconfig.app.json` enables `verbatimModuleSyntax`, `erasableSyntaxOnly`, `noUnusedLocals`, and `noUnusedParameters` — type-only imports must use `import type`, and unused symbols will fail the build. JSX is configured for Solid (`jsxImportSource: "solid-js"`, `jsx: "preserve"`).
