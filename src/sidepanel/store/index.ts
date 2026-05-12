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
import {
  emptyUserSettings,
  readUserSettingsFile,
  writeUserSettingsFile,
  type UserSettingsFile,
} from '../services/userSettingsFile';
import { PROVIDERS, type Provider } from './providers';

export { PROVIDERS, type Provider };

// Each provider needs its own API key — a single shared field would silently
// send the wrong credential after a provider switch. Keys are stored in
// chrome.storage.local; the active one is selected by `currentApiKey()`.
export type ApiKeyKey =
  | 'apiKeyAnthropic'
  | 'apiKeyOpenAI'
  | 'apiKeyOpenRouter'
  | 'apiKeyGoogle';

const API_KEY_BY_PROVIDER: Record<Provider, ApiKeyKey> = {
  Anthropic: 'apiKeyAnthropic',
  OpenAI: 'apiKeyOpenAI',
  OpenRouter: 'apiKeyOpenRouter',
  Google: 'apiKeyGoogle',
};

export function apiKeyKeyFor(provider: Provider): ApiKeyKey {
  return API_KEY_BY_PROVIDER[provider];
}

// Each provider also keeps its own model name — switching the provider
// dropdown must not silently re-use the last provider's model string
// (e.g. an Anthropic id sent to OpenAI). Model names persist in the
// `.aicurator-settings.json` file at the root of the granted aicurator
// directory, alongside the current provider — never in chrome.storage.
export type ModelNameKey =
  | 'modelNameAnthropic'
  | 'modelNameOpenAI'
  | 'modelNameOpenRouter'
  | 'modelNameGoogle';

const MODEL_NAME_BY_PROVIDER: Record<Provider, ModelNameKey> = {
  Anthropic: 'modelNameAnthropic',
  OpenAI: 'modelNameOpenAI',
  OpenRouter: 'modelNameOpenRouter',
  Google: 'modelNameGoogle',
};

export function modelNameKeyFor(provider: Provider): ModelNameKey {
  return MODEL_NAME_BY_PROVIDER[provider];
}

export interface Settings {
  provider: Provider;
  modelNameAnthropic: string;
  modelNameOpenAI: string;
  modelNameOpenRouter: string;
  modelNameGoogle: string;
  apiKeyAnthropic: string;
  apiKeyOpenAI: string;
  apiKeyOpenRouter: string;
  apiKeyGoogle: string;
}

const DEFAULT_SETTINGS: Settings = {
  provider: 'Anthropic',
  modelNameAnthropic: '',
  modelNameOpenAI: '',
  modelNameOpenRouter: '',
  modelNameGoogle: '',
  apiKeyAnthropic: '',
  apiKeyOpenAI: '',
  apiKeyOpenRouter: '',
  apiKeyGoogle: '',
};

const STORAGE_SETTINGS_KEYS = [
  'apiKeyAnthropic',
  'apiKeyOpenAI',
  'apiKeyOpenRouter',
  'apiKeyGoogle',
] as const;
type StorageSettingsKey = (typeof STORAGE_SETTINGS_KEYS)[number];

const FILE_SETTINGS_KEYS = [
  'provider',
  'modelNameAnthropic',
  'modelNameOpenAI',
  'modelNameOpenRouter',
  'modelNameGoogle',
] as const;
type FileSettingsKey = (typeof FILE_SETTINGS_KEYS)[number];

type SettingsKey = StorageSettingsKey | FileSettingsKey;

// All chrome.storage-resident settings (API keys) are local-only secrets.
function isFileBackedKey(key: SettingsKey): key is FileSettingsKey {
  return (FILE_SETTINGS_KEYS as readonly string[]).includes(key);
}

const LEGACY_API_KEY = 'apiKey';
const LEGACY_PROVIDER_KEY = 'provider';
const LEGACY_MODEL_NAME_KEY = 'modelName';

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

function applyStorageSetting(key: StorageSettingsKey, value: unknown): void {
  if (typeof value === 'string') setSettings(key, value);
}

export async function hydrateSettings(): Promise<void> {
  const stored = await localStorage.get(STORAGE_SETTINGS_KEYS as readonly string[]);
  for (const key of STORAGE_SETTINGS_KEYS) {
    if (key in stored) applyStorageSetting(key, stored[key]);
  }
  await migrateLegacyApiKey();
}

// One-shot migration: pre-v2608 stored a single `apiKey` shared across all
// providers. Move it into the slot for whichever provider is currently
// selected (only if that slot is empty), then drop the legacy key so the
// migration is a no-op on subsequent loads.
async function migrateLegacyApiKey(): Promise<void> {
  const legacy = (await localStorage.get([LEGACY_API_KEY]))[LEGACY_API_KEY];
  if (typeof legacy !== 'string' || legacy.length === 0) {
    await localStorage.remove([LEGACY_API_KEY]);
    return;
  }
  const slot = apiKeyKeyFor(settings.provider);
  if (settings[slot].length === 0) {
    setSettings(slot, legacy);
    await localStorage.set({ [slot]: legacy });
  }
  await localStorage.remove([LEGACY_API_KEY]);
}

// One-shot migration: pre-v2609 stored `provider` and a single `modelName`
// in chrome.storage.sync. After the user grants the aicurator directory we
// surface those values as the initial file contents (so a returning user
// keeps their selection), then drop the legacy keys so subsequent runs are
// no-ops.
async function migrateLegacySyncedSettings(): Promise<void> {
  const stored = await syncStorage.get([
    LEGACY_PROVIDER_KEY,
    LEGACY_MODEL_NAME_KEY,
  ]);
  const legacyProvider = stored[LEGACY_PROVIDER_KEY];
  const legacyModelName = stored[LEGACY_MODEL_NAME_KEY];
  if (isProvider(legacyProvider)) {
    setSettings('provider', legacyProvider);
  }
  if (typeof legacyModelName === 'string' && legacyModelName.length > 0) {
    const slot = modelNameKeyFor(settings.provider);
    if (settings[slot].length === 0) {
      setSettings(slot, legacyModelName);
    }
  }
  await syncStorage.remove([LEGACY_PROVIDER_KEY, LEGACY_MODEL_NAME_KEY]);
}

/** API key for the currently-selected provider. Reactive — re-runs when the
 *  user switches the provider dropdown or types into the key field. */
export function currentApiKey(): string {
  return settings[apiKeyKeyFor(settings.provider)];
}

/** Model name for the currently-selected provider. Reactive — re-runs when
 *  the user switches the provider dropdown or types into the model field. */
export function currentModelName(): string {
  return settings[modelNameKeyFor(settings.provider)];
}

export function subscribeToStorageChanges(): void {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    for (const key of STORAGE_SETTINGS_KEYS) {
      const change = changes[key];
      if (!change) continue;
      // Echo guard: skip if equal to current store value.
      if (settings[key] === change.newValue) continue;
      applyStorageSetting(key, change.newValue);
    }
  });
}

// ── Debounced writes ─────────────────────────────────────
const DEBOUNCE_MS = 250;
const SAVED_FLASH_MS = 5000;

const pendingStorageTimers = new Map<
  StorageSettingsKey,
  ReturnType<typeof setTimeout>
>();
let pendingFileTimer: ReturnType<typeof setTimeout> | null = null;
let savedFlashTimer: ReturnType<typeof setTimeout> | null = null;

export function setSetting<K extends SettingsKey>(
  key: K,
  value: Settings[K],
): void {
  setSettings(key, value);
  if (isFileBackedKey(key)) {
    if (pendingFileTimer) clearTimeout(pendingFileTimer);
    pendingFileTimer = setTimeout(() => {
      pendingFileTimer = null;
      void writeFileSettings();
    }, DEBOUNCE_MS);
    return;
  }
  const storageKey = key as StorageSettingsKey;
  const existing = pendingStorageTimers.get(storageKey);
  if (existing) clearTimeout(existing);
  pendingStorageTimers.set(
    storageKey,
    setTimeout(() => {
      pendingStorageTimers.delete(storageKey);
      void writeStorageOne(storageKey, settings[storageKey]);
    }, DEBOUNCE_MS),
  );
}

function flashSaved(): void {
  setSaveStatus('saved');
  if (savedFlashTimer) clearTimeout(savedFlashTimer);
  savedFlashTimer = setTimeout(() => {
    savedFlashTimer = null;
    setSaveStatus('idle');
  }, SAVED_FLASH_MS);
}

async function writeStorageOne(
  key: StorageSettingsKey,
  value: string,
): Promise<void> {
  setSaveStatus('saving');
  try {
    await localStorage.set({ [key]: value });
    flashSaved();
  } catch (err) {
    console.error('[aicurator] settings save failed:', err);
    setSaveStatus('error');
  }
}

function snapshotFileSettings(): UserSettingsFile {
  const seed = emptyUserSettings();
  return {
    ...seed,
    provider: settings.provider,
    modelNames: {
      Anthropic: settings.modelNameAnthropic,
      OpenAI: settings.modelNameOpenAI,
      OpenRouter: settings.modelNameOpenRouter,
      Google: settings.modelNameGoogle,
    },
  };
}

async function writeFileSettings(): Promise<void> {
  const root = rootHandle();
  // No granted directory yet — keep the change in memory; it'll be flushed
  // by the grant-effect below once the user grants access.
  if (!root) return;
  setSaveStatus('saving');
  try {
    await writeUserSettingsFile(root, snapshotFileSettings());
    flashSaved();
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

// Hydrate provider + per-provider model names from
// `.aicurator-settings.json` at the root of the granted aicurator
// directory whenever the directory transitions to `granted`. If no
// file exists yet, drain the legacy chrome.storage.sync `provider` /
// `modelName` (one-shot) and seed the file with current values. This
// is the only place that reads/writes the file on the granted-only
// path; `setSetting` debounces follow-up writes through
// `writeFileSettings`.
createRoot(() => {
  let lastRoot: FileSystemDirectoryHandle | null = null;
  createEffect(() => {
    const root = rootHandle();
    if (root === lastRoot) return;
    lastRoot = root;
    if (!root) return;
    void (async () => {
      try {
        const existing = await readUserSettingsFile(root);
        if (existing) {
          setSettings('provider', existing.provider);
          setSettings('modelNameAnthropic', existing.modelNames.Anthropic);
          setSettings('modelNameOpenAI', existing.modelNames.OpenAI);
          setSettings('modelNameOpenRouter', existing.modelNames.OpenRouter);
          setSettings('modelNameGoogle', existing.modelNames.Google);
          // Legacy keys, if any, are now strictly redundant — drop them.
          await syncStorage.remove([LEGACY_PROVIDER_KEY, LEGACY_MODEL_NAME_KEY]);
          return;
        }
        // First-grant bootstrap: pull legacy synced values into the
        // in-memory store, then write the file from the resulting
        // snapshot so the user's prior selection is preserved.
        await migrateLegacySyncedSettings();
        await writeUserSettingsFile(root, snapshotFileSettings());
      } catch (err) {
        console.warn('[aicurator] hydrate user settings file failed:', err);
      }
    })();
  });
});
