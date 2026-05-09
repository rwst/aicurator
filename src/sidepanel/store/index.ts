import { createEffect, createMemo, createRoot, createSignal } from 'solid-js';
import { createStore } from 'solid-js/store';
import { clearAllLogs } from '../services/log';
import { syncStorage } from './syncStorage';
import { localStorage } from './localStorage';
import { createProjectsDir, type ProjectMeta } from '../projectsDir';
import { createProdProjectsDirPorts } from '../projectsDir/adapters/prod';
import {
  createProject as fsCreateProject,
  deleteProject as fsDeleteProject,
} from '../services/projectOps';
import {
  findProjectByExactSheet,
  getActiveTabSheetUrl,
  type ParsedSheetUrl,
} from '../services/sheetUrl';
import { updateMagicFile, type Stage } from '../services/magicFile';

export type Provider = 'Anthropic' | 'OpenAI' | 'OpenRouter' | 'Google';
export const PROVIDERS: readonly Provider[] = [
  'Anthropic',
  'OpenAI',
  'OpenRouter',
  'Google',
] as const;

export interface Settings {
  provider: Provider;
  modelName: string;
  apiKey: string;
}

const DEFAULT_SETTINGS: Settings = {
  provider: 'Anthropic',
  modelName: '',
  apiKey: '',
};

const SETTINGS_KEYS = ['provider', 'modelName', 'apiKey'] as const;
type SettingsKey = (typeof SETTINGS_KEYS)[number];

// Whitelist of keys that live in chrome.storage.local instead of sync.
// API key is the only secret we hold; everything else syncs.
const LOCAL_ONLY_KEYS: ReadonlySet<string> = new Set(['apiKey']);

function backendFor(key: string): 'local' | 'sync' {
  return LOCAL_ONLY_KEYS.has(key) ? 'local' : 'sync';
}

async function splitGet(
  keys: readonly string[],
): Promise<Record<string, unknown>> {
  const localKeys = keys.filter((k) => backendFor(k) === 'local');
  const syncKeys = keys.filter((k) => backendFor(k) === 'sync');
  const [local, sync] = await Promise.all([
    localStorage.get(localKeys),
    syncStorage.get(syncKeys),
  ]);
  return { ...sync, ...local };
}

async function splitSet(items: Record<string, unknown>): Promise<void> {
  const local: Record<string, unknown> = {};
  const sync: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(items)) {
    (backendFor(k) === 'local' ? local : sync)[k] = v;
  }
  await Promise.all([localStorage.set(local), syncStorage.set(sync)]);
}

// ── Reactive state ───────────────────────────────────────
const [settings, setSettings] = createStore<Settings>({ ...DEFAULT_SETTINGS });

export type SaveStatus = 'idle' | 'saving' | 'saved' | 'error';
const [saveStatus, setSaveStatus] = createSignal<SaveStatus>('idle');

export type Running = 'none' | 'extract' | 'summate' | 'canonize';

export interface ProjectsState {
  selectedName: string | null;
  pathwayName: string;
  stage: Stage;
  running: Running;
}

const [project, setProject] = createStore<ProjectsState>({
  selectedName: null,
  pathwayName: '',
  stage: 'none',
  running: 'none',
});

// ── ProjectsDir module (deepened) ────────────────────────

export const projectsDir = createProjectsDir(createProdProjectsDirPorts());

/** Granted root handle, or null. Used by tabs that need to dereference
 *  a project subdirectory. */
export const rootHandle = createMemo<FileSystemDirectoryHandle | null>(() => {
  const s = projectsDir.state();
  return s.kind === 'granted' ? s.handle : null;
});

/** Project list — derived from the granted variant. Empty when not granted. */
export const projectList = createMemo<readonly ProjectMeta[]>(() => {
  const s = projectsDir.state();
  return s.kind === 'granted' ? s.list : [];
});

/** True when the directory is granted and ready for work. */
export const isGranted = createMemo<boolean>(
  () => projectsDir.state().kind === 'granted',
);

// Picked PDFs for Extract live as a separate signal, not in the createStore.
// FS handles don't proxy cleanly through Solid's deep store proxies.
const [extractPdfHandles, setExtractPdfHandles] = createSignal<
  FileSystemFileHandle[]
>([]);

export { settings, saveStatus, project, extractPdfHandles };

// ── Hydration + listeners ────────────────────────────────
function isProvider(v: unknown): v is Provider {
  return typeof v === 'string' && (PROVIDERS as readonly string[]).includes(v);
}

function applyExternalSetting(key: SettingsKey, value: unknown): void {
  if (key === 'provider' && isProvider(value)) setSettings('provider', value);
  else if (key === 'modelName' && typeof value === 'string')
    setSettings('modelName', value);
  else if (key === 'apiKey' && typeof value === 'string')
    setSettings('apiKey', value);
}

export async function hydrateSettings(): Promise<void> {
  const stored = await splitGet(SETTINGS_KEYS as readonly string[]);
  for (const key of SETTINGS_KEYS) {
    if (key in stored) applyExternalSetting(key, stored[key]);
  }
}

export function subscribeToStorageChanges(): void {
  chrome.storage.onChanged.addListener((changes, area) => {
    for (const key of SETTINGS_KEYS) {
      const change = changes[key];
      if (!change) continue;
      const expectedArea = backendFor(key);
      if (area !== expectedArea) continue;
      // Echo guard: skip if equal to current store value.
      if (settings[key] === change.newValue) continue;
      applyExternalSetting(key, change.newValue);
    }
  });
}

// ── Debounced writes ─────────────────────────────────────
const DEBOUNCE_MS = 250;
const SAVED_FLASH_MS = 5000;

const pendingTimers = new Map<SettingsKey, ReturnType<typeof setTimeout>>();
let savedFlashTimer: ReturnType<typeof setTimeout> | null = null;

export function setSetting<K extends SettingsKey>(
  key: K,
  value: Settings[K],
): void {
  setSettings(key, value);
  const existing = pendingTimers.get(key);
  if (existing) clearTimeout(existing);
  pendingTimers.set(
    key,
    setTimeout(() => {
      pendingTimers.delete(key);
      void writeOne(key, value);
    }, DEBOUNCE_MS),
  );
}

async function writeOne<K extends SettingsKey>(
  key: K,
  value: Settings[K],
): Promise<void> {
  setSaveStatus('saving');
  try {
    await splitSet({ [key]: value });
    setSaveStatus('saved');
    if (savedFlashTimer) clearTimeout(savedFlashTimer);
    savedFlashTimer = setTimeout(() => {
      savedFlashTimer = null;
      setSaveStatus('idle');
    }, SAVED_FLASH_MS);
  } catch (err) {
    console.error('[aicurator] settings save failed:', err);
    setSaveStatus('error');
  }
}

// ── Project actions ──────────────────────────────────────

const SELECTED_PROJECT_KEY = 'selectedProject';

function applyMetaToStore(name: string | null): void {
  if (!name) {
    setProject({ pathwayName: '', stage: 'none' });
    return;
  }
  const meta = projectList().find((p) => p.name === name);
  if (meta) setProject({ pathwayName: meta.pathwayName, stage: meta.stage });
}

/** Resolve which project should be selected after a list refresh: keep the
 *  stored choice if it still exists, otherwise fall back to the first
 *  project, otherwise null. */
async function reconcileSelectedFromList(
  list: readonly ProjectMeta[],
): Promise<void> {
  const stored = await syncStorage.get([SELECTED_PROJECT_KEY]);
  const candidate = stored[SELECTED_PROJECT_KEY];
  let next: string | null = null;
  if (typeof candidate === 'string' && list.some((p) => p.name === candidate)) {
    next = candidate;
  } else if (list.length > 0) {
    next = list[0].name;
  }
  setProject('selectedName', next);
  applyMetaToStore(next);
  if (next) {
    await syncStorage.set({ [SELECTED_PROJECT_KEY]: next });
    await localStorage.set({ activeProject: next });
  } else {
    await localStorage.set({ activeProject: '' });
  }
}

export async function setSelectedProject(name: string | null): Promise<void> {
  setProject('selectedName', name);
  applyMetaToStore(name);
  // PDF picks are session-state, not project-state — clear them on switch.
  setExtractPdfHandles([]);
  if (name) {
    await syncStorage.set({ [SELECTED_PROJECT_KEY]: name });
    // Tell the service worker which project to route downloads into.
    await localStorage.set({ activeProject: name });
  } else {
    await localStorage.set({ activeProject: '' });
  }
}

export async function createProjectAction(
  name: string,
  sheet: ParsedSheetUrl,
): Promise<void> {
  const root = rootHandle();
  if (!root) throw new Error('Projects directory not granted');
  try {
    await fsCreateProject(root, name, sheet);
  } catch (err) {
    if (err && (err as Error).name === 'NotFoundError') {
      await projectsDir.forget();
      throw new Error(
        'The aicurator folder is no longer on disk. ' +
          'Click "Grant access" to pick it again.',
      );
    }
    throw err;
  }
  await projectsDir.refreshList();
  await setSelectedProject(name);
}

export async function deleteProjectAction(name: string): Promise<void> {
  const root = rootHandle();
  if (!root) throw new Error('Projects directory not granted');
  try {
    await fsDeleteProject(root, name);
  } catch (err) {
    if (err && (err as Error).name === 'NotFoundError') {
      await projectsDir.forget();
      throw new Error(
        'The aicurator folder is no longer on disk. ' +
          'Click "Grant access" to pick it again.',
      );
    }
    throw err;
  }
  await projectsDir.refreshList();
}

// ── Per-project field helpers ────────────────────────────

async function withProjectDir<T>(
  fn: (projectDir: FileSystemDirectoryHandle) => Promise<T>,
): Promise<T> {
  const root = rootHandle();
  if (!root || !project.selectedName) {
    throw new Error('No active project');
  }
  const projectDir = await root.getDirectoryHandle(project.selectedName);
  return await fn(projectDir);
}

const PATHWAY_DEBOUNCE_MS = 250;
let pathwayTimer: ReturnType<typeof setTimeout> | null = null;

export function setPathwayName(name: string): void {
  setProject('pathwayName', name);
  if (pathwayTimer) clearTimeout(pathwayTimer);
  pathwayTimer = setTimeout(() => {
    pathwayTimer = null;
    void persistPathwayName(name);
  }, PATHWAY_DEBOUNCE_MS);
}

async function persistPathwayName(name: string): Promise<void> {
  try {
    await withProjectDir((dir) => updateMagicFile(dir, { pathwayName: name }));
    // Bump the metadata cached in the granted variant by re-scanning.
    await projectsDir.refreshList();
  } catch (err) {
    console.warn('[aicurator] persist pathway name failed:', err);
  }
}

export async function setStage(stage: Stage): Promise<void> {
  setProject('stage', stage);
  await withProjectDir((dir) => updateMagicFile(dir, { stage }));
  await projectsDir.refreshList();
}

export function setRunning(r: Running): void {
  setProject('running', r);
}

export function addExtractPdfs(handles: FileSystemFileHandle[]): void {
  const cap = 10;
  const cur = extractPdfHandles();
  const have = new Set(cur.map((h) => h.name));
  const toAdd: FileSystemFileHandle[] = [];
  for (const h of handles) {
    if (have.has(h.name)) continue;
    if (cur.length + toAdd.length >= cap) break;
    toAdd.push(h);
  }
  if (toAdd.length > 0) {
    setExtractPdfHandles([...cur, ...toAdd]);
  }
  return;
}

export function removeExtractPdf(name: string): void {
  setExtractPdfHandles(extractPdfHandles().filter((h) => h.name !== name));
}

export function clearExtractPdfs(): void {
  setExtractPdfHandles([]);
}

// ── Active-sheet match (display-only) ────────────────────
// The ActiveProjectFooter uses this to show a "Switch to: <project>"
// button when the focused Chrome tab is a Sheets URL that matches some
// project other than the currently-selected one. Project selection
// only changes via the dropdown or the explicit Switch button click —
// never via tab activation alone.

const [activeSheetMatch, setActiveSheetMatch] = createSignal<string | null>(
  null,
);
export { activeSheetMatch };

export async function refreshActiveSheetMatch(): Promise<void> {
  if (!isGranted()) {
    setActiveSheetMatch(null);
    return;
  }
  const parsed = await getActiveTabSheetUrl();
  if (!parsed) {
    setActiveSheetMatch(null);
    return;
  }
  const matched = findProjectByExactSheet(projectList(), parsed);
  setActiveSheetMatch(matched?.name ?? null);
}

// ── Reactive bridges ─────────────────────────────────────

// Keep selectedName/pathwayName/stage in sync whenever the project list
// in the granted variant changes (initial grant, re-grant, create,
// delete, refresh after stage update). On initial hydration this picks
// the stored selection; on subsequent changes it reconciles against
// what's still present.
createRoot(() => {
  let prevList: readonly ProjectMeta[] | null = null;
  createEffect(() => {
    const list = projectList();
    // First reactive pass — kick off the initial reconciliation.
    if (prevList === null) {
      prevList = list;
      void reconcileSelectedFromList(list);
      return;
    }
    // Subsequent passes — only react if the list contents changed.
    if (prevList !== list) {
      prevList = list;
      // If the currently-selected project disappeared, pick a new one.
      const cur = project.selectedName;
      if (cur && !list.some((p) => p.name === cur)) {
        void reconcileSelectedFromList(list);
      } else {
        // Refresh per-project metadata cached in the store.
        applyMetaToStore(cur);
      }
    }
  });
});

// Clear logs whenever the user switches between projects.
// (Pure hydrate from null → name doesn't trigger this — that path keeps
// the previously persisted logs visible.)
createRoot(() => {
  let last: string | null = null;
  createEffect(() => {
    const cur = project.selectedName;
    if (last !== null && cur !== last) void clearAllLogs();
    last = cur;
  });
});

// Keep the footer's active-sheet match in sync whenever the project
// list changes (re-grant after panel re-open, Create, Delete) — the
// initial mount-time refresh runs before the list exists if FS-Access
// permission needs re-granting.
createRoot(() => {
  createEffect(() => {
    void projectList();
    void refreshActiveSheetMatch();
  });
});
