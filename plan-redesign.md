# Redesign: tab visibility + active-sheet auto-detect

Output of the second grill-me session. All decisions locked. Replaces
the tab-gating section of `plan.md` (§1.3) and adds a new active-sheet
detection layer.

## Lock summary

### 1. Tab visibility (Main, Extract, Summate, Canonize)

**All four tabs are always enabled.** The lock-by-stage gating from the
original plan goes away. The user can navigate to any tab regardless of
project state.

What changes per-tab when the conditions for action aren't met:

| Element | Hidden when… | Disabled when… |
|---|---|---|
| Extract Start | no project | — |
| Extract Test-sheet-write | no project | — |
| Extract pathway-name input | — | no project (placeholder: *"select a project first"*) |
| Extract `+ Add PDF` / Clear / chip list | — | always functional (PDFs persist in memory until project picked) |
| Summate Start | no project OR `stage = 'none'` | — |
| Summate Test-sheet-write | no project OR `stage = 'none'` | — |
| Summate radio (all / span) | — | no project |
| Summate span input | — | no project |
| Summate Re-scan PDFs | no project | — |
| Summate chip grid | no project | — |
| Canonize Start | no project OR `stage ∉ {summated, canonized}` | — |
| Canonize radio (all / span) | — | no project |
| Canonize span input | — | no project |
| Curator notes (informational) | — | always visible |
| Inline error banners | — | unchanged |

Re-run modals and empty-sheet modals stay tied to `stage` exactly as
today — they fire only on Start click, so hidden Start = no modal.

### 2. Active-sheet detection — matching key

**Exact `(spreadsheetId, gid)` match.** A project is bound to one
specific tab within a Google Sheets workbook; multiple tabs in the same
workbook → multiple AICurator projects.

**Soft fallback:** if no exact `(spreadsheetId, gid)` match exists but
some project shares the `spreadsheetId` on a different gid, that project
remains visible in the dropdown but **is not auto-selected**. The
dropdown stays empty (no selection) until the user picks manually. This
prevents writing to the wrong gid.

The dropdown always shows the full project list alphabetically; "empty"
means "no current selection", not "dropdown contents pruned".

### 3. Detection triggers

**Live-tracking** via:
- `chrome.tabs.onActivated`
- `chrome.tabs.onUpdated` (specifically when `changeInfo.url` is set)

Plus a one-shot detection on panel mount.

**Two guards on every detection event:**

1. **Running guard.** If `project.running !== 'none'`, skip the event
   entirely. Don't yank the active project mid-Extract / mid-Summate /
   mid-Canonize.
2. **Non-sheet guard.** If the focused tab's URL does not parse as a
   Google Sheets URL, skip the event. Switching to PubMed for the
   pmid-tagger flow does not change the project selection.

### 4. Selection conflict resolution — additive only

Tab-change re-detection only ever **sets** the active project (when an
exact match exists). It never clears the selection.

- Sheet → matches project X: select X.
- Sheet → no match: leave current selection alone (no change).
- Non-sheet: leave current selection alone (per the non-sheet guard).

The asymmetry between **panel mount** (clears on no-match) and
**live-tracking** (never clears) is intentional and easy to explain: at
mount we have no prior state; later we honor it.

### 5. Initial state on panel mount

Order of resolution:

1. Hydrate settings + project list from FS.
2. Read active Chrome tab URL.
3. **Branch:**
   - **Active tab is a Google Sheet:**
     - Exact `(spreadsheetId, gid)` match → select that project.
     - No match → empty dropdown (selection cleared).
   - **Active tab is not a Google Sheet:**
     - Restore last-selected project from `chrome.storage.sync`
       (existing behaviour).

### 6. Auto-detect skip when Extract has pending state

`setSelectedProject` already clears `extractPdfHandles` and reloads
`pathwayName` from the magic file. To prevent silent data loss on
tab-switch, the **live-tracking handler** (not the manual dropdown)
defers the auto-select when:

- `extractPdfHandles().length > 0`, OR
- `project.pathwayName !== <stored pathwayName for current project>`

Manual dropdown selection still goes through the regular
`setSelectedProject` path and clears state as today.

### 7. Stage gating on Start

`stage` is tracked in the magic file as before. The change is **where
we gate**:

- Old: stage gates the **tab itself** (locked tabs).
- New: stage gates the **Start button** (hidden when prerequisites unmet).

| Tab | Start visibility |
|---|---|
| Main | n/a (Create / Delete / Quit follow existing rules) |
| Extract | hidden when `selectedName === null` |
| Summate | hidden when `selectedName === null` OR `stage === 'none'` |
| Canonize | hidden when `selectedName === null` OR `stage ∉ {summated, canonized}` |

`Test sheet write` follows the same rule as `Start` for its own tab.

## Implementation map

Files to touch:

1. `src/sidepanel/App.tsx`
   - `isEnabled(idx)` always returns true for idx 0..3.
   - `onMount`: after `hydrateProjectsDir`, run `detectActiveSheetMatch`.
   - Register `chrome.tabs.onActivated` + `onUpdated` listeners with the
     two guards. `onCleanup` removes them.

2. `src/sidepanel/services/projectsDir.ts`
   - Re-use existing `parseSheetUrl` and `getActiveTabSheetUrl`.
   - Add `findProjectByExactMatch(list, parsed): ProjectMeta | null`.

3. `src/sidepanel/store/index.ts`
   - New action `detectActiveSheetMatch()` — reads active tab, runs
     match, calls `setSelectedProject` if matched.
   - New action `liveTrackTabChange(tab)` — implements Q3 + Q7
     additive-only logic + Extract-pending-state skip.
   - `hydrateProjectsDir` flow updated: at end, if active tab is a
     sheet and matches, override last-selected; else fall back to
     last-selected.

4. `src/sidepanel/tabs/MainTab.tsx`
   - Project dropdown: when `selectedName === null`, show placeholder
     "— no project selected —". Same control behaviour as today.

5. `src/sidepanel/tabs/ExtractTab.tsx`
   - `<Show when={canStart()}>` around Start + Test-sheet-write.
   - Disable pathway-name input when no project.
   - Drop `tabs={...}` Phase-4 lock semantics.

6. `src/sidepanel/tabs/SummateTab.tsx`
   - `<Show when={canStart()}>` around Start + Test-sheet-write
     (`canStart` = project + stage ≥ extracted).
   - Hide Re-scan + chip grid when no project.
   - Disable radio + span input when no project.

7. `src/sidepanel/tabs/CanonizeTab.tsx`
   - `<Show when={canStart()}>` around Start
     (`canStart` = project + stage ∈ {summated, canonized}).
   - Disable radio + span input when no project.

8. Update `chrome-issues.md` if `chrome.tabs.onUpdated` has any quirks
   in the side-panel context — none expected, but verify.

## Out of scope for this redesign

- Live-tracking when running (covered by Q2's running guard — explicit
  decision: don't track during runs).
- Modal on auto-switch with pending Extract state (rejected per Q7;
  silently skip instead).
- Cross-Chrome-window detection (the `chrome.tabs.onActivated` event
  fires for the focused window only — multi-window users may see lag).
