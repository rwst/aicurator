# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

- `npm run dev` — Vite dev server at http://localhost:5173
- `npm run build` — type-check (`tsc -b`) then production build to `dist/`
- `npm run preview` — serve the built `dist/`

There are no tests, lint, or format scripts configured.

## Repository state

The product is implemented (current internal version `v2604`, manifest `26.4.0`). Feature ledger lives in `CHANGELOG.md`; backlog in `TODO.md`; documented Chrome quirks in `chrome-issues.md`. Locked design plan in `plan.md`.

`design_handoff_aicurator_sidepanel/README.md` is the source of truth for **visual design** (design tokens, typography, hi-fi prototype HTML). Treat the prototype HTML/JSX as reference only; the implementation is in `src/sidepanel/` and is the source of truth for behavior.

## Architecture

- **Surface**: Chrome MV3 side panel. Background service worker calls `chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true })`. The panel page lives at `src/sidepanel/index.html`.
- **Four vertical tabs** (Main, Extract, Summate, Canonize) — all process tabs are **always available** (post-v2602). Per-tab `badge` memos surface why Start is locked (no project selected, missing provider config, invalid span, etc.). Summate and Canonize share row-span input state via `store/rowSpan.ts` (whatever you pick in one is pre-set in the other). Memos that depend on other memos must be declared after their dependencies — Solid `createMemo` evaluates eagerly, so out-of-order references hit a TDZ.
- **State**: a single root `createStore` (`solid-js/store`) holding `ui`, `project`, `settings`, `logs`. Type definitions in the handoff README.
- **Persistence**: `chrome.storage.sync` for projects list + settings (debounced 250 ms per field; reconciled via `chrome.storage.onChanged`). `chrome.storage.local` for log buffers and the API key. Storage is wrapped in `syncStorage` / `localStorage` adapters — components don't call `chrome.storage` directly.
- **Log streaming**: each process tab connects via `chrome.runtime.connect({ name: 'log:extract' })` etc., backed by a per-process `createSignal<LogLine[]>` capped at 500 lines. Auto-scroll only when the user has not scrolled up.
- **PDF text extraction (Summate)**: optional native messaging host (`scripts/native-host/aicurator-pdftotext.c`) linking `libpoppler-glib`. Built and installed via `scripts/install-native-host.sh`. The sidepanel pings it once per session (`services/pdfText.ts`); if present, Summate caches `<basename>.txt` next to each PDF and splices the text into the user prompt; if absent, it sends PDFs as document blocks as before. Host is GPL-2.0, separated from the Apache-2.0 extension by stdio IPC.
- **LLM providers** (`src/sidepanel/llm/`): four direct-fetch providers — Anthropic, OpenAI, OpenRouter, Google (Gemini). All implement the same `Provider` interface (system prompt, user text, base64 PDFs, optional JSON schema, optional max-tokens). Extended thinking / reasoning is enabled at max strength wherever the model supports it, gated by model-name regex per provider so non-reasoning models keep working untouched. Google's `responseSchema` is OpenAPI-subset, not full JSON Schema — the Google provider runs a recursive sanitizer that strips `additionalProperties`, `$ref`, `oneOf`, etc. so the same `EXTRACT_SCHEMA` round-trips across all four.
- **Design tokens**: `:root` CSS variables in `src/sidepanel/styles/tokens.css`, copied verbatim from the handoff. The log window uses a separate dark palette.

## TypeScript config notes

`tsconfig.app.json` enables `verbatimModuleSyntax`, `erasableSyntaxOnly`, `noUnusedLocals`, and `noUnusedParameters` — type-only imports must use `import type`, and unused symbols will fail the build. JSX is configured for Solid (`jsxImportSource: "solid-js"`, `jsx: "preserve"`).
