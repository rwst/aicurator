// Ports isolate the module from `window.*` and `chrome.*`. Handles cross
// the port boundary as opaque DirToken strings — never raw
// FileSystemDirectoryHandle objects — so the state machine can be tested
// in plain node without jsdom or an FSA polyfill.

export type DirToken = string;
export type PermState = 'granted' | 'denied' | 'prompt';

export type PickOutcome =
  | { kind: 'picked'; token: DirToken; name: string }
  | { kind: 'cancelled' };

/** Thrown by adapters when a token no longer points at a usable folder
 * (handle gone from store, or the underlying folder was deleted on disk). */
export class StaleHandleError extends Error {
  constructor(message = 'stale directory handle') {
    super(message);
    this.name = 'StaleHandleError';
  }
}

export interface ChromeFsaPort {
  /** showDirectoryPicker({mode:'read'}); AbortError → 'cancelled'. */
  pickDirectory(): Promise<PickOutcome>;
  queryPermission(
    token: DirToken,
    mode: 'read' | 'readwrite',
  ): Promise<PermState>;
  requestPermission(
    token: DirToken,
    mode: 'read' | 'readwrite',
  ): Promise<PermState>;
  /** Subdir names whose contents include a valid magic file (.aicurator.json).
   *  Returns ProjectMeta-shaped records — keeping the magic-file read on the
   *  adapter side avoids leaking the FSA across the port. */
  listProjects(token: DirToken): Promise<ListedProject[]>;
  /** Throws StaleHandleError if the underlying folder no longer exists. */
  verifyExists(token: DirToken): Promise<void>;
}

import type { Stage } from '../services/magicFile';
export interface ListedProject {
  name: string;
  spreadsheetId: string;
  gid: string;
  sheetUrl: string;
  pathwayName: string;
  stage: Stage;
}

export interface DownloadsPort {
  /** chrome.downloads.download with conflictAction:'uniquify'.
   *  Adapter rejects empty data: payloads defensively (renderer-crash
   *  invariant — see chrome-issues.md §2). */
  downloadDataUrl(args: { url: string; filename: string }): Promise<number>;
}

export interface HandleStorePort {
  saveHandle(token: DirToken): Promise<void>;
  loadHandle(): Promise<DirToken | null>;
  clearHandle(): Promise<void>;
}

export interface ProjectsDirPorts {
  fsa: ChromeFsaPort;
  downloads: DownloadsPort;
  store: HandleStorePort;
}
