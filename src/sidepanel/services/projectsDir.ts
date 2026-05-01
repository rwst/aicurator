import { get, set, del } from 'idb-keyval';
import {
  newMagicFile,
  readMagicFile,
  writeMagicFile,
  type MagicFile,
  type Stage,
} from './magicFile';

const HANDLE_KEY = 'aicurator:projectsDirHandle';

export interface ProjectMeta {
  name: string;
  spreadsheetId: string;
  gid: string;
  sheetUrl: string;
  pathwayName: string;
  stage: Stage;
}

export interface ParsedSheetUrl {
  spreadsheetId: string;
  gid: string;
  sheetUrl: string;
}

// ── IndexedDB-backed handle persistence ──────────────────
export async function getStoredHandle(): Promise<FileSystemDirectoryHandle | null> {
  const h = await get<FileSystemDirectoryHandle>(HANDLE_KEY);
  return h ?? null;
}
export async function setStoredHandle(
  handle: FileSystemDirectoryHandle,
): Promise<void> {
  await set(HANDLE_KEY, handle);
}
export async function clearStoredHandle(): Promise<void> {
  await del(HANDLE_KEY);
}

// ── Bootstrap ────────────────────────────────────────────
// Pre-create <Downloads>/aicurator/ via a non-empty data URL written
// through chrome.downloads. Empty base64 data URLs have crashed the
// renderer in earlier attempts; a tiny plaintext payload is stable.
export async function bootstrapAicuratorDir(): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    chrome.downloads.download(
      {
        url: 'data:text/plain,aicurator-init',
        filename: 'aicurator/.aicurator-init',
        conflictAction: 'uniquify',
        saveAs: false,
      },
      (downloadId) => {
        if (chrome.runtime.lastError)
          reject(new Error(chrome.runtime.lastError.message));
        else if (downloadId === undefined)
          reject(new Error('downloads.download() returned no id'));
        else resolve();
      },
    );
  });
}

// ── Permission & picker ──────────────────────────────────
// Picker setup notes:
//   - mode:'read' at pick — we upgrade to readwrite via requestPermission
//     after validating the folder name. Avoids escalating readwrite to
//     system-special folders if the user picks the wrong one.
//   - No startIn — picker opens at the OS default. Forcing the user to
//     navigate to <Downloads>/aicurator/ reduces the chance they
//     accidentally click "Select folder" at Downloads root, which
//     triggers a Chrome renderer crash on permission grant.
//   - id:'aicurator' — Chrome remembers the last-picked location for
//     this id, so subsequent picks open at aicurator/ directly.
export async function pickDirectory(): Promise<FileSystemDirectoryHandle> {
  return await window.showDirectoryPicker({
    id: 'aicurator',
    mode: 'read',
  });
}

export async function queryPermission(
  handle: FileSystemDirectoryHandle,
): Promise<PermissionState> {
  return await handle.queryPermission({ mode: 'readwrite' });
}

export async function requestPermission(
  handle: FileSystemDirectoryHandle,
): Promise<PermissionState> {
  return await handle.requestPermission({ mode: 'readwrite' });
}

// ── Project listing ──────────────────────────────────────
export async function listProjects(
  rootDir: FileSystemDirectoryHandle,
): Promise<ProjectMeta[]> {
  const out: ProjectMeta[] = [];
  for await (const entry of rootDir.values()) {
    if (entry.kind !== 'directory') continue;
    const magic = await readMagicFile(entry);
    if (!magic) continue;
    out.push({
      name: entry.name,
      spreadsheetId: magic.spreadsheetId,
      gid: magic.gid,
      sheetUrl: magic.sheetUrl,
      pathwayName: magic.pathwayName,
      stage: magic.stage,
    });
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

// ── Sheet URL parsing & active-tab capture ──────────────
const SHEET_URL_RE =
  /^https:\/\/docs\.google\.com\/spreadsheets\/d\/([A-Za-z0-9_-]+)\/edit(?:[?#].*?(?:gid=(\d+)))?/;

export function parseSheetUrl(url: string): ParsedSheetUrl | null {
  const m = url.match(SHEET_URL_RE);
  if (!m) return null;
  return {
    spreadsheetId: m[1],
    gid: m[2] ?? '0',
    sheetUrl: url,
  };
}

export async function getActiveTabSheetUrl(): Promise<ParsedSheetUrl | null> {
  const tabs = await chrome.tabs.query({
    active: true,
    currentWindow: true,
  });
  const url = tabs[0]?.url;
  if (!url) return null;
  return parseSheetUrl(url);
}

// ── Create / Delete ──────────────────────────────────────
export async function createProject(
  rootDir: FileSystemDirectoryHandle,
  name: string,
  sheet: ParsedSheetUrl,
): Promise<MagicFile> {
  // Refuse if subdir already exists.
  let exists = false;
  try {
    await rootDir.getDirectoryHandle(name);
    exists = true;
  } catch {
    /* not present, proceed */
  }
  if (exists) throw new Error(`Project "${name}" already exists`);

  const projectDir = await rootDir.getDirectoryHandle(name, { create: true });
  await projectDir.getDirectoryHandle('PDF', { create: true });

  const magic = newMagicFile(sheet);
  await writeMagicFile(projectDir, magic);
  return magic;
}

export async function deleteProject(
  rootDir: FileSystemDirectoryHandle,
  name: string,
): Promise<void> {
  await rootDir.removeEntry(name, { recursive: true });
}
