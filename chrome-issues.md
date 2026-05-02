# Chrome bugs encountered during AICurator development

This file documents Chrome-side bugs that affected our implementation, the
diagnosis, and the workarounds we shipped. Future maintainers: check here
before assuming a regression is in our code.

Tested against Chrome 14x (May 2026 stable channel) on Linux. Likely
present on macOS/Windows too — File System Access internals and the
downloads pipeline are not OS-specific in the relevant code paths.

---

## Issue 1 — Renderer crash on permission grant for system-special folders

### Symptom

`showDirectoryPicker` opens, the user clicks "Select folder" while the
picker is showing the **Downloads root** (or possibly Desktop, Documents
— other "well-known" directories). Instead of returning a
`FileSystemDirectoryHandle`, the entire Chrome renderer process crashes.
The side panel goes blank; sometimes the whole tab page becomes "He's
dead, Jim".

This happens **after** the user clicks Select folder — not during the
picker UI. So the crash is in the post-pick permission-grant path.

### Reproduction

1. AICurator side panel, click *Grant access*.
2. Picker opens (we use `id: 'aicurator'`, `mode: 'read'`).
3. Without navigating into any subfolder, click "Select folder" while
   the picker is at the Downloads root.
4. Renderer crashes.

### Diagnosis

The trigger appears to be Chrome's permission-grant logic for handles
that point at OS-special folders (Downloads, Desktop, etc.). The exact
code path is opaque to us, but the fingerprint matches:

- Independent of `mode` — we tested both `'read'` and `'readwrite'`.
  Both crash. (Initially we suspected readwrite was the issue and
  tightened to read-only at pick time. Did not help on its own.)
- Independent of whether we previously stored a handle in IndexedDB.
- Independent of whether `startIn: 'downloads'` is set, but `startIn`
  makes the bad case much more likely (the picker opens at the trigger
  location, so the user can hit it with one stray click).

We did not reproduce a crash when picking a regular subfolder under
Downloads (e.g. `aicurator/`). Only system-special roots seem to trip
it.

### Mitigations shipped

In `src/sidepanel/services/projectsDir.ts` and the surrounding
`grantProjectsDir` flow:

1. **Drop `startIn: 'downloads'`** so the picker doesn't open at
   Downloads root by default. The user has to navigate, which means
   they're less likely to click Select on Downloads itself by accident.
2. **Pick at `mode: 'read'`**, validate the chosen folder's name,
   *then* upgrade to readwrite via `handle.requestPermission({ mode:
   'readwrite' })`. If validation fails (handle name !== `'aicurator'`),
   we throw immediately and never request readwrite — so we never
   escalate the dangerous grant on a system-special folder.
3. **Pre-create `<Downloads>/aicurator/`** via `chrome.downloads.download`
   before opening the picker (see Issue 2 for the data-URL caveat). The
   user has a visible target so they're less inclined to click Select
   at the wrong level.
4. **In-UI warning text** in `MainTab.tsx`'s access-prompt block, in
   red: "Do not click 'Select folder' at the Downloads root — Chrome
   will crash."
5. **`id: 'aicurator'`** on the picker. After the first successful
   pick, Chrome remembers and subsequent picks open at `aicurator/`
   directly, side-stepping the bug.

None of these prevent the crash if the user explicitly Selects Downloads
root. They reduce likelihood. There is no in-extension workaround that
prevents the crash entirely — the bug is upstream of any code we can
run between the user's click and the renderer abort.

### Suggested upstream filing

If you want to file a Chromium issue, the reproduction is the steps in
*Reproduction* above against any extension that calls `showDirectoryPicker`
from a side panel. Crash signature on Linux looks like a renderer
abort with no JS stack — symptomatic of a CHECK in
`//content/browser/file_system_access/...`. Useful flags:
`chrome://flags/#file-system-access-persistent-permissions` (orthogonal
to this bug, but worth toggling during repro).

---

## Issue 2 — Renderer crash on `chrome.downloads.download` with an empty base64 data URL

### Symptom

Calling `chrome.downloads.download({ url: 'data:application/octet-stream;base64,', filename: '...' })`
where the base64 payload is **empty** (zero bytes after the comma)
crashes the renderer.

This is the "create an empty sentinel file" trick we initially used to
bootstrap `<Downloads>/aicurator/` before opening the directory picker.

### Reproduction

```js
chrome.downloads.download({
  url: 'data:application/octet-stream;base64,',
  filename: 'aicurator/.aicurator-init',
  conflictAction: 'uniquify',
  saveAs: false,
});
```

### Diagnosis

Chrome's downloads pipeline appears to choke on the empty base64
payload. A non-empty data URL (any number of bytes) does **not** crash:

```js
// stable
url: 'data:text/plain,aicurator-init'
// stable
url: 'data:application/octet-stream;base64,YQ=='   // 1-byte 'a'
// crashes
url: 'data:application/octet-stream;base64,'
```

So the workaround is to ship a payload of any length. We use
`data:text/plain,aicurator-init` — a literal 16-byte sentinel that
makes the resulting `.aicurator-init` file self-documenting if a curator
ever opens it.

### Mitigations shipped

- `bootstrapAicuratorDir` in `src/sidepanel/services/projectsDir.ts`
  uses `data:text/plain,aicurator-init` (committed change).

---

## Issue 3 — File System Access permissions are session-scoped by default

### Symptom

Every time the side panel is closed and reopened, the user has to click
"Re-grant access" once (which fires `handle.requestPermission` and shows
Chrome's permission dialog) before the project list rehydrates.

### Diagnosis

This is **not a bug** — it is the FS Access API's documented behavior
in Chrome: the directory handle persists in IndexedDB, but the
**permission grant** for that handle is treated as session-scoped.
After a navigation or page destroy, `queryPermission` returns `'prompt'`
even though the handle itself is still valid.

There is one Chrome-side knob that flips this:

> `chrome://flags/#file-system-access-persistent-permissions` — when
> enabled, Chrome remembers the user's grant decisions across sessions
> for previously-authorized handles. After enabling and restarting,
> `queryPermission` returns `'granted'` directly on subsequent panel
> opens.

The flag is opt-in per user, and it's intended to become the default in
a future Chrome release.

### Mitigations shipped

None in code — this is intentional Chrome behavior and we honor it.
The README will document the flag for the dev team (Phase 10).

---

## Issue 4 — Stale-handle "permission granted, folder gone" disconnect

### Symptom

User deletes the `aicurator/` folder from disk via their file manager.
On next panel open, `queryPermission(storedHandle)` returns `'granted'`
(Chrome cached the permission decision). Any actual read/write through
the handle then fails with
`NotFoundError: A requested file or directory could not be found`.

### Diagnosis

Permission state and existence are independent in Chrome's FS Access
implementation. The handle is "valid" in that it carries identity and a
remembered grant, but the inode it points at is gone. There's no
`handle.exists()` primitive — you have to attempt an operation and
catch.

### Mitigations shipped

- `verifyHandleExists` helper in `store/index.ts` does a one-step
  `handle.values().next()` and treats `NotFoundError` as "directory
  removed". Called from:
  - `hydrateProjectsDir` (after `queryPermission === 'granted'`)
  - `reGrantProjectsDir` (after `requestPermission` resolves)
  - `createProjectAction` / `deleteProjectAction` (catch around the FS
    operation)
- On detection: the handle is cleared from IndexedDB and the store is
  reset to `'unpicked'`, so the UI flips back to the fresh "Grant
  access" prompt with a clear message.

---

## Issue 5 — `chrome.downloads.download` rejects leaf filenames that start with a dot

### Symptom

```js
chrome.downloads.download({
  url: 'data:text/plain,init',
  filename: 'aicurator/.aicurator-init',
});
// runtime.lastError → "Invalid filename"
```

The same call with `filename: 'aicurator/aicurator-init.txt'` succeeds.

### Diagnosis

Chrome's downloads pipeline treats leaf filenames whose first character
is `.` as forbidden — likely a defense against drive-by writes of dot-
files / hidden files inside the Downloads tree. The rejection is
silent except via `chrome.runtime.lastError`. There's no UI prompt.

### Mitigations shipped

- `bootstrapAicuratorDir` in `services/projectsDir.ts` writes
  `aicurator/aicurator-init.txt` instead of a hidden sentinel.

---

## Issue 6 — `@crxjs/vite-plugin@2` HMR doesn't auto-reload the service worker or content scripts

### Symptom

Edits to `src/background/service-worker.ts` or `src/content/pmc-pmid.ts`
during `npm run dev` rebuild but don't surface in Chrome until the
extension is manually reloaded via `chrome://extensions`.

### Diagnosis

Known limitation of `@crxjs/vite-plugin` 2.x. The side-panel page
does HMR via the standard Vite websocket; the service worker and
content scripts don't have an HMR transport.

### Mitigations shipped

None. Documented in plan §5 (risks) and the README (Phase 10) so
contributors know to click "Reload" after editing those files.
