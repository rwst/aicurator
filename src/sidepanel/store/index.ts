import { createEffect, createRoot, createSignal } from 'solid-js';
import { createStore } from 'solid-js/store';
import { clearAllLogs } from '../services/log';
import { syncStorage } from './syncStorage';
import { localStorage } from './localStorage';
import {
  bootstrapAicuratorDir,
  clearStoredHandle,
  createProject as fsCreateProject,
  deleteProject as fsDeleteProject,
  findProjectByExactSheet,
  getActiveTabSheetUrl,
  getStoredHandle,
  listProjects,
  pickDirectory,
  queryPermission,
  requestPermission,
  setStoredHandle,
  type ParsedSheetUrl,
  type ProjectMeta,
} from '../services/projectsDir';
import { updateMagicFile, type Stage } from '../services/magicFile';

export type Provider = 'Anthropic' | 'OpenAI' | 'OpenRouter';
export const PROVIDERS: readonly Provider[] = [
  'Anthropic',
  'OpenAI',
  'OpenRouter',
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

// dirPermission: the FS-Access permission state for the projects-dir
// handle. 'unpicked' means the user has not yet granted any directory.
export type DirPermission = PermissionState | 'unpicked';
export type Running = 'none' | 'extract' | 'summate' | 'canonize';

export interface ProjectsState {
  dirHandle: FileSystemDirectoryHandle | null;
  dirPermission: DirPermission;
  list: ProjectMeta[];
  selectedName: string | null;
  pathwayName: string;
  stage: Stage;
  running: Running;
}

const [project, setProject] = createStore<ProjectsState>({
  dirHandle: null,
  dirPermission: 'unpicked',
  list: [],
  selectedName: null,
  pathwayName: '',
  stage: 'none',
  running: 'none',
});

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

// Probe whether the directory the handle refers to actually still exists
// on disk. Permission state and existence are independent in Chrome:
// queryPermission can return 'granted' for a handle whose underlying
// folder has been removed.
async function verifyHandleExists(
  handle: FileSystemDirectoryHandle,
): Promise<boolean> {
  try {
    const it = handle.values();
    await it.next();
    return true;
  } catch (err) {
    if (err && (err as Error).name === 'NotFoundError') return false;
    throw err;
  }
}

async function resetToUnpicked(): Promise<void> {
  await clearStoredHandle();
  setProject({
    dirHandle: null,
    dirPermission: 'unpicked',
    list: [],
    selectedName: null,
  });
}

export async function hydrateProjectsDir(): Promise<void> {
  const handle = await getStoredHandle();
  if (!handle) {
    setProject({ dirHandle: null, dirPermission: 'unpicked', list: [] });
    return;
  }
  let perm: PermissionState;
  try {
    perm = await queryPermission(handle);
  } catch (err) {
    console.warn('[aicurator] stored handle is stale, clearing:', err);
    await resetToUnpicked();
    return;
  }
  if (perm === 'granted') {
    // Permission cached, but does the folder still exist?
    const exists = await verifyHandleExists(handle);
    if (!exists) {
      console.warn('[aicurator] aicurator/ folder removed since last session');
      await resetToUnpicked();
      return;
    }
  }
  setProject({ dirHandle: handle, dirPermission: perm });
  if (perm === 'granted') {
    try {
      await refreshProjectList();
    } catch (err) {
      console.warn('[aicurator] project list scan failed:', err);
    }
  }
}

function applyMetaToStore(name: string | null): void {
  if (!name) {
    setProject({ pathwayName: '', stage: 'none' });
    return;
  }
  const meta = project.list.find((p) => p.name === name);
  if (meta) setProject({ pathwayName: meta.pathwayName, stage: meta.stage });
}

export async function refreshProjectList(): Promise<void> {
  if (!project.dirHandle || project.dirPermission !== 'granted') return;
  const list = await listProjects(project.dirHandle);
  setProject('list', list);
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

export async function grantProjectsDir(): Promise<void> {
  // Pre-create <Downloads>/aicurator/ so the user has a visible target.
  // Best-effort: failure here doesn't block the picker.
  try {
    await bootstrapAicuratorDir();
  } catch (err) {
    console.warn('[aicurator] bootstrap warning:', err);
  }
  const handle = await pickDirectory();
  // Validate folder name BEFORE escalating to readwrite. If the user
  // picked the wrong folder (Downloads root, Desktop, etc.), throw now —
  // never request readwrite on a system-special folder.
  if (handle.name !== 'aicurator') {
    throw new Error(
      `Picked folder is "${handle.name}" — it must be named "aicurator". ` +
        `Open <Downloads>/aicurator/ in the picker, then click "Select folder".`,
    );
  }
  const perm = await requestPermission(handle);
  if (perm !== 'granted') {
    throw new Error(
      'Read/write permission was not granted for the aicurator folder.',
    );
  }
  await setStoredHandle(handle);
  setProject({ dirHandle: handle, dirPermission: perm });
  await refreshProjectList();
}

export async function reGrantProjectsDir(): Promise<void> {
  if (!project.dirHandle) return grantProjectsDir();
  let perm: PermissionState;
  try {
    perm = await requestPermission(project.dirHandle);
  } catch (err) {
    console.warn('[aicurator] re-grant failed, clearing stale handle:', err);
    await resetToUnpicked();
    throw new Error(
      'The previous aicurator folder no longer exists. ' +
        'Click "Grant access" to pick a new one.',
    );
  }
  if (perm === 'granted') {
    // Verify the folder is still on disk, even though the grant succeeded.
    const exists = await verifyHandleExists(project.dirHandle);
    if (!exists) {
      await resetToUnpicked();
      throw new Error(
        'The previous aicurator folder no longer exists. ' +
          'Click "Grant access" to pick a new one.',
      );
    }
  }
  setProject('dirPermission', perm);
  if (perm === 'granted') {
    try {
      await refreshProjectList();
    } catch (err) {
      console.warn('[aicurator] project list scan failed:', err);
    }
  }
}

export async function forgetProjectsDir(): Promise<void> {
  await clearStoredHandle();
  setProject({
    dirHandle: null,
    dirPermission: 'unpicked',
    list: [],
    selectedName: null,
  });
}

export async function createProjectAction(
  name: string,
  sheet: ParsedSheetUrl,
): Promise<void> {
  if (!project.dirHandle || project.dirPermission !== 'granted')
    throw new Error('Projects directory not granted');
  try {
    await fsCreateProject(project.dirHandle, name, sheet);
  } catch (err) {
    if (err && (err as Error).name === 'NotFoundError') {
      await resetToUnpicked();
      throw new Error(
        'The aicurator folder is no longer on disk. ' +
          'Click "Grant access" to pick it again.',
      );
    }
    throw err;
  }
  await refreshProjectList();
  await setSelectedProject(name);
}

export async function deleteProjectAction(name: string): Promise<void> {
  if (!project.dirHandle || project.dirPermission !== 'granted')
    throw new Error('Projects directory not granted');
  try {
    await fsDeleteProject(project.dirHandle, name);
  } catch (err) {
    if (err && (err as Error).name === 'NotFoundError') {
      await resetToUnpicked();
      throw new Error(
        'The aicurator folder is no longer on disk. ' +
          'Click "Grant access" to pick it again.',
      );
    }
    throw err;
  }
  await refreshProjectList();
}

// Re-export for convenience.
export { setStoredHandle };

// ── Per-project field helpers ────────────────────────────

async function withProjectDir<T>(
  fn: (projectDir: FileSystemDirectoryHandle) => Promise<T>,
): Promise<T> {
  if (
    !project.dirHandle ||
    project.dirPermission !== 'granted' ||
    !project.selectedName
  ) {
    throw new Error('No active project');
  }
  const projectDir = await project.dirHandle.getDirectoryHandle(
    project.selectedName,
  );
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
    // Refresh list metadata to keep ProjectMeta in sync.
    setProject(
      'list',
      project.list.map((p) =>
        p.name === project.selectedName ? { ...p, pathwayName: name } : p,
      ),
    );
  } catch (err) {
    console.warn('[aicurator] persist pathway name failed:', err);
  }
}

export async function setStage(stage: Stage): Promise<void> {
  setProject('stage', stage);
  await withProjectDir((dir) => updateMagicFile(dir, { stage }));
  setProject(
    'list',
    project.list.map((p) =>
      p.name === project.selectedName ? { ...p, stage } : p,
    ),
  );
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

// Avoid unused-var error from the bootstrapAicuratorDir re-export not used here.
void bootstrapAicuratorDir;

// ── Active-sheet auto-detection ──────────────────────────

function pathwayDirty(): boolean {
  if (!project.selectedName) {
    return project.pathwayName.trim().length > 0;
  }
  const meta = project.list.find((p) => p.name === project.selectedName);
  return project.pathwayName !== (meta?.pathwayName ?? '');
}

function hasPendingExtractState(): boolean {
  return extractPdfHandles().length > 0 || pathwayDirty();
}

// Mount-time detection. Sheet match → select that project. Sheet but no
// match → clear selection (per Q1 spec). Non-sheet → leave whatever
// refreshProjectList restored from chrome.storage.sync (Q6).
export async function detectActiveSheetMatch(): Promise<void> {
  if (project.dirPermission !== 'granted') return;
  const parsed = await getActiveTabSheetUrl();
  if (!parsed) return;
  const matched = findProjectByExactSheet(project.list, parsed);
  if (matched) {
    if (matched.name !== project.selectedName) {
      await setSelectedProject(matched.name);
    }
  } else if (project.selectedName !== null) {
    await setSelectedProject(null);
  }
}

// Live-tracking handler. Additive-only: only ever sets a project, never
// clears (Q3). Skipped during runs (Q2 running guard), on non-sheet tabs
// (Q2 non-sheet guard), and when Extract has pending unsaved state (Q7).
export async function liveTrackTabChange(): Promise<void> {
  if (project.running !== 'none') return;
  if (project.dirPermission !== 'granted') return;
  const parsed = await getActiveTabSheetUrl();
  if (!parsed) return;
  const matched = findProjectByExactSheet(project.list, parsed);
  if (!matched) return;
  if (matched.name === project.selectedName) return;
  if (hasPendingExtractState()) return;
  await setSelectedProject(matched.name);
}

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
