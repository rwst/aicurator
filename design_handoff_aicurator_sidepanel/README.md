# Handoff: AICurator Chrome Extension — Side Panel UI

## Overview
AICurator is a Chrome Extension that uses the **Side Panel API** (`chrome.sidePanel`) to occupy the right half of a widescreen Chrome tab. The side panel hosts a curation workflow with four vertical tabs (Main, Extract, Summate, Canonize) plus per-project settings synced via `chrome.storage.sync`.

This handoff covers the **Main tab** (project picker + settings) plus shells for the three process tabs (Extract / Summate / Canonize) — each with an interactive zone above and a scrollable terminal-style log window below.

## About the Design Files
The HTML files in this bundle are **design references** — vanilla-HTML/CSS/JS prototypes that demonstrate the intended look, layout, and basic state behavior. They are **not production code to copy verbatim**.

Your task is to **re-implement these designs in the target stack: Vite + SolidJS + TypeScript**, structured as a Chrome Extension MV3 with a Side Panel. Copy exact tokens (colors, sizes, fonts, spacing) from the prototype, but write idiomatic Solid components, signals, and stores.

## Target Stack
- **Build**: Vite (with `@crxjs/vite-plugin` recommended for MV3 + HMR)
- **UI**: SolidJS + TypeScript
- **Styling**: CSS (vanilla custom properties is fine — keep the token names from the prototype). Solid's CSS Modules also work.
- **Extension surface**: Chrome Side Panel API (`chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true })`)
- **Storage**: `chrome.storage.sync` for projects list + settings; `chrome.storage.local` for transient log buffers

## Fidelity
**High-fidelity.** The hex codes, type sizes, spacing, border radii, focus rings, and tab/log treatments are intentional — recreate them pixel-faithfully. Behavior is partial-fidelity (mock state transitions are wired; real provider/file logic is to be implemented).

---

## Screens / Tabs

### Tab 1 — Main
The only tab enabled when no project exists. Holds project picker + global settings.

**Layout (top to bottom):**
1. **Header** — `padding: 16px 18px 12px`, `background: var(--bg-soft)`, bottom border `1px solid var(--border)`. Flex row, gap 12px.
   - Reactome logo PNG, `height: 26px` (auto width). Asset at `assets/reactome-logo.png` (286×66 source, height-constrained).
   - Meta column: `"AICurator"` at 11px / weight 600 / muted; below it `"v0.3.1"` at 9px / Courier / faint.
2. **Scroll region** — `padding: 18px 18px 22px`, `overflow-y: auto`, fills remaining space.
3. **Project block** — centered column, gap 10px:
   - Uppercase label `"CURRENT PROJECT"` (11px, letter-spacing 1.2px, weight 700, muted)
   - `<select>` of project names from `chrome.storage.sync`, 92% width, height 36px
   - `<input>` "new project name" — 92% width, height 36px, `border-style: dashed`, bg `#fafbfc`
   - Button row: `Create` (primary), `Delete` (danger ghost), `Quit` (default)
4. **Divider** — `<hr>` 1px `var(--border)`, margin 18px 0
5. **Settings** — `<h3>Settings</h3>` then 4 stacked rows. Each row:
   - 11px uppercase-ish label (weight 600, muted)
   - Field below it (full-width, height 32px, font-size 12px)
   - Optional 10px helper text
   - Last row: tiny `<span class="dot"></span>` + `"All changes saved"` indicator (10px faint, 6px green dot)

**Settings fields:**
| Field | Control | Type | Notes |
|---|---|---|---|
| Projects Directory | `<input>` mono | text path | Courier New, displays e.g. `~/aicurator/projects` |
| AI Model Provider | `<select>` | enum | `OpenAI`, `Anthropic`, `Google`, `Local (Ollama)`, `Azure OpenAI` |
| Model Name | `<input>` mono | text | Courier New |
| API Key | `<input type="password">` mono | secret | Visible only on this device note |

### Tab 2 — Extract / Tab 3 — Summate / Tab 4 — Canonize
Identical structure; differ only in title and (eventual) interactive controls.

**Layout (top to bottom, fills 100% of content area):**
1. **Process header** — `padding: 14px 18px 12px`, `bg-soft`, bottom border. Flex row space-between.
   - `<h2>` (16px / 700) — name. Gets `.disabled` color when locked.
   - Status badge (right) — small pill, 10px, padding 3px 8px, radius 10px:
     - Locked: warm `🔒 finish previous step` (warn colors)
     - Running: teal `running…` (accent colors)
     - Ready: omitted
2. **Interactive zone** — `padding: 18px`, bottom border. Holds:
   - Dashed-border placeholder card (will hold the real controls — extraction params, summation strategy picker, canonization rules etc.)
   - Action row: `▶ Start` primary button + 11px progress hint (`ready` / `in progress · 38%` / `locked until previous step completes`)
3. **Log window** — fills remaining height, dark theme:
   - `.log-head`: 6px 12px, `#161b22` bg, 11px label `"log · extract"`, three grey traffic-light dots on the right
   - `.log` body: `#1c2128` bg, `Courier New` 11.5px, line-height 1.55, color `#c9d1d9`, scrollable
   - Each line: `<ts>` muted (`#6b7682`) + `[lvl]` (48px wide, color by level) + `<msg>`
   - Levels & colors:
     - `info` `#58a6ff`, `ok` `#56d364`, `warn` `#e3b341`, `err` `#f85149`, `init` `#8b949e`
   - Blinking `█` cursor at the bottom (7×13px green block, 1s steps(2) infinite)

---

## Vertical Tab Strip (left edge of panel)

- `width: 92px`, `bg: var(--bg-tabs)` (#eef2f5), right border 1px `var(--border)`
- Each tab: full-width button, `padding: 14px 6px`, centered text, font 12px / 600 / letter-spacing 0.3px, color muted by default
- **Active tab**: white background (`var(--bg)`), text becomes `var(--text)`, plus a 3px-wide accent bar (`var(--accent)`) anchored to the right edge (`top:6; bottom:6; right:-1; width:3; border-radius: 2px 0 0 2px`)
- **Hover** (non-disabled): bg `rgba(61,169,201,0.08)`, color `var(--text)`
- **Disabled**: color `var(--disabled-text)` (#b8bfc6), `cursor: not-allowed`, plus a smaller 🔒 emoji on a second line below the label (10px)

---

## Interactions & Behavior

### Tab gating
Tab availability is derived from project state — implement as a Solid `createMemo`:
- `Main` — always enabled
- `Extract` — enabled when `projectState !== 'empty'` (a project exists)
- `Summate` — enabled when `projectState === 'running'` (Extract has started/finished)
- `Canonize` — enabled when Summate has completed (extend the state machine; in the prototype this stays locked)

When a tab the user is on becomes disabled (e.g. project deleted), fall back to `Main`.

### Project actions
- **Create**: if the new-name input is non-empty, create that project; otherwise no-op. Persist projects array to `chrome.storage.sync`. Switch `selectedProject` to the new one and clear the input.
- **Delete**: confirm, then remove from sync storage; if no projects remain, return to `empty` state.
- **Quit**: closes the side panel (`window.close()` on the panel page).

### Settings persistence
- Read on mount via `chrome.storage.sync.get(['projectsDir','provider','modelName','apiKey','projects','selectedProject'])`
- Write on change with a 250ms debounce per field; show "All changes saved" hint with a green dot once a write resolves
- Listen for `chrome.storage.onChanged` and reconcile (panel may be open in multiple tabs)

### Log streaming
Each process tab subscribes to its own log topic. Suggested: a per-process `createSignal<LogLine[]>` capped to the last ~500 lines, fed by messages from a background service worker over `chrome.runtime.connect({name: 'log:extract'})` etc. Auto-scroll the log to the bottom on each append unless the user has scrolled up (track scroll position).

### Animations & transitions
- Tab background/color: 120ms
- Buttons: 120ms bg/border, 80ms `translateY(1px)` on `:active`
- Focus ring on inputs: `box-shadow: 0 0 0 3px rgba(61,169,201,0.18)` plus `border-color: var(--accent)`
- Cursor blink: `@keyframes blink { 50% { opacity: 0; } }` on a 1s steps(2) infinite loop

---

## State Management (Solid)

Recommend a single root store (`createStore` from `solid-js/store`):

```ts
type ProjectState = 'empty' | 'created' | 'running' | 'summated' | 'canonized';
type Provider = 'OpenAI' | 'Anthropic' | 'Google' | 'Local (Ollama)' | 'Azure OpenAI';

interface AppStore {
  ui: { activeTab: 0 | 1 | 2 | 3 };
  project: {
    state: ProjectState;
    list: string[];
    selected: string | null;
    newName: string;
  };
  settings: {
    projectsDir: string;
    provider: Provider;
    modelName: string;
    apiKey: string;
  };
  logs: Record<'extract' | 'summate' | 'canonize', LogLine[]>;
}

interface LogLine { ts: string; level: 'init' | 'info' | 'ok' | 'warn' | 'err'; msg: string; }
```

Wrap reads/writes to `chrome.storage.sync` in a small `syncStorage` adapter that maps the relevant slice (`project.list`, `project.selected`, `settings.*`) to/from storage keys.

---

## Design Tokens

```css
:root {
  /* surfaces */
  --bg: #ffffff;
  --bg-soft: #f6f8fa;
  --bg-tabs: #eef2f5;
  --border: #d8dde2;
  --border-strong: #b8c0c8;

  /* text */
  --text: #1f2933;
  --text-muted: #6b7682;
  --text-faint: #9aa3ad;

  /* brand / accent (Reactome teal) */
  --accent: #3da9c9;
  --accent-deep: #2d8aa8;
  --accent-soft: #e6f3f7;

  /* status */
  --danger: #b94a48;
  --warn: #b3771a;
  --ok: #2f7d4f;

  /* disabled */
  --disabled-bg: #f1f3f5;
  --disabled-text: #b8bfc6;

  /* shape */
  --radius: 6px;
  --radius-sm: 4px;

  /* shadow */
  --shadow-sm: 0 1px 2px rgba(20, 30, 40, 0.04);
  --shadow-md: 0 2px 8px rgba(20, 30, 40, 0.08);
}
```

**Log palette (dark):**
- bg `#1c2128`, head bg `#161b22`, head border `#2a313a`
- text `#c9d1d9`, ts `#6b7682`
- info `#58a6ff`, ok `#56d364`, warn `#e3b341`, err `#f85149`, init `#8b949e`

**Typography:**
- Body: `Arial, Helvetica, sans-serif`, 13px / 1.4
- Mono / log / version / API key / paths: `'Courier New', Courier, monospace`
- Sizes used: 16 (h2), 13 (body), 12 (controls), 11 (labels/uppercase), 11.5 (log), 10 (helpers), 9 (version)
- Letter-spacing 0.3px for tab labels and small caps; 1.2px for the "CURRENT PROJECT" microcopy

**Spacing scale (px):** 4, 6, 8, 10, 12, 14, 16, 18, 22

---

## Project Structure (suggested)

```
aicurator/
├── public/
│   └── icons/ (16, 32, 48, 128)
├── src/
│   ├── manifest.ts                  # MV3 manifest (use @crxjs)
│   ├── sidepanel/
│   │   ├── index.html
│   │   ├── main.tsx                 # Solid render root
│   │   ├── App.tsx
│   │   ├── tabs/
│   │   │   ├── MainTab.tsx
│   │   │   ├── ProcessTab.tsx       # shared shell for Extract/Summate/Canonize
│   │   │   ├── ExtractTab.tsx
│   │   │   ├── SummateTab.tsx
│   │   │   └── CanonizeTab.tsx
│   │   ├── components/
│   │   │   ├── TabStrip.tsx
│   │   │   ├── LogWindow.tsx
│   │   │   ├── Field.tsx
│   │   │   └── Button.tsx
│   │   ├── store.ts                 # createStore + syncStorage adapter
│   │   ├── logs.ts                  # log signal factory + runtime port wiring
│   │   └── styles/
│   │       ├── tokens.css           # paste the :root block above
│   │       └── app.css
│   └── background/
│       └── service-worker.ts        # opens side panel, owns process runners
├── assets/
│   └── reactome-logo.png
├── vite.config.ts
└── package.json
```

**Manifest essentials (MV3):**
```json
{
  "permissions": ["sidePanel", "storage"],
  "side_panel": { "default_path": "src/sidepanel/index.html" },
  "action": { "default_title": "AICurator" },
  "background": { "service_worker": "src/background/service-worker.ts", "type": "module" }
}
```
In the service worker:
```ts
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
```

---

## Assets

- `assets/reactome-logo.png` — official Reactome wordmark (286×66 PNG). Render at `height: 26px` in the panel header. Already included in this handoff.

---

## Files in this bundle

- `AICurator Side Panel Hi-Fi.html` — chosen direction, hi-fi prototype with all four tabs and mock state machine. Use as the source of truth for visual treatment and interaction.
- `AICurator Side Panel Wireframes.html` + supporting `.jsx` files — the original 5-direction wireframe exploration. Reference only; **the chosen direction is "Variant B" (tabs left, spacious settings)**.
- `assets/reactome-logo.png` — logo asset.

---

## Recommended next implementation steps

1. **Scaffold**: `npm create vite@latest aicurator -- --template solid-ts`, then add `@crxjs/vite-plugin` and configure for MV3.
2. **Tokens + base layout**: drop in `tokens.css`, build `App.tsx` with the two-column flex (TabStrip + content).
3. **Main tab**: wire `chrome.storage.sync` for settings and the projects list; verify round-trips by opening DevTools on the side panel.
4. **Tab gating**: implement the `ProjectState` machine and disable/enable tabs accordingly.
5. **Process-tab shell**: build `ProcessTab.tsx` with the dark log window. Stream mock log lines on a timer first; replace with a real port to the service worker once a process runner exists.
6. **Provider integration**: behind the `Start` button, call out to the chosen provider (use a `fetch` wrapped to forward through the service worker if you hit CORS issues from the panel page).
