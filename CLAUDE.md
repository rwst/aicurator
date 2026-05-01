# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

- `npm run dev` — Vite dev server at http://localhost:5173
- `npm run build` — type-check (`tsc -b`) then production build to `dist/`
- `npm run preview` — serve the built `dist/`

There are no tests, lint, or format scripts configured.

## Repository state vs. target

**The code in `src/` is the default `solid-ts` Vite starter** (counter + Solid/Vite logos). It has not yet been replaced with the real product.

**The real product is specified in `design_handoff_aicurator_sidepanel/README.md`** — read it before making non-trivial changes. AICurator is a Chrome MV3 extension that uses the Side Panel API (`chrome.sidePanel`) to host a Reactome curation workflow. The handoff defines the visual design (hi-fi HTML prototype, design tokens, typography), the four-tab structure, the state machine, and the recommended file layout. Treat the prototype HTML/JSX in that folder as **design reference only** — re-implement in idiomatic Solid, do not copy verbatim.

The package.json does not yet include `@crxjs/vite-plugin`, a manifest, or any `chrome.*` wiring. Adding those is part of the work, not something to assume already exists.

## Architecture (per handoff, when implemented)

- **Surface**: Chrome MV3 side panel. Background service worker calls `chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true })`. The panel page lives at `src/sidepanel/index.html`.
- **Four vertical tabs** in a left strip (Main, Extract, Summate, Canonize). Tab availability is **derived from project state** via a Solid `createMemo` — do not store enabled/disabled flags directly. The state machine: `empty → created → running → summated → canonized`. If the active tab becomes disabled (e.g. project deleted), fall back to Main.
- **State**: a single root `createStore` (`solid-js/store`) holding `ui`, `project`, `settings`, `logs`. Type definitions are in the handoff README and should be the source of truth.
- **Persistence**: `chrome.storage.sync` for projects list + settings (debounce writes 250ms per field; reconcile via `chrome.storage.onChanged` since the panel may be open in multiple tabs). `chrome.storage.local` for transient log buffers. Wrap storage in a small `syncStorage` adapter rather than calling `chrome.storage` from components.
- **Log streaming**: each process tab subscribes to its own topic via `chrome.runtime.connect({ name: 'log:extract' })` etc., backed by a per-process `createSignal<LogLine[]>` capped at ~500 lines. Auto-scroll to bottom on append **only when the user has not scrolled up** — track scroll position.
- **Design tokens**: copy the `:root` CSS variables from the handoff verbatim into `src/sidepanel/styles/tokens.css`. Hex codes, sizes, radii, focus rings are intentional and should be reproduced pixel-faithfully. The log window uses a separate dark palette (also in the handoff).

## TypeScript config notes

`tsconfig.app.json` enables `verbatimModuleSyntax`, `erasableSyntaxOnly`, `noUnusedLocals`, and `noUnusedParameters` — type-only imports must use `import type`, and unused symbols will fail the build. JSX is configured for Solid (`jsxImportSource: "solid-js"`, `jsx: "preserve"`).
