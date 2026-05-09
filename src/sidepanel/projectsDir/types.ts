// Public surface types for the ProjectsDir module.
//
// All UI consumers branch on `ProjectsDirState.kind`; the discriminated
// union is the entire UI contract. Every failure mode in the grant flow
// becomes a state variant — there is no separate error channel.

import type { Stage } from '../services/magicFile';

export interface ProjectMeta {
  name: string;
  spreadsheetId: string;
  gid: string;
  sheetUrl: string;
  pathwayName: string;
  stage: Stage;
}

export type ProjectsDirState =
  | { kind: 'unpicked' }
  | {
      kind: 'granted';
      handle: FileSystemDirectoryHandle;
      list: ProjectMeta[];
    }
  | {
      kind: 'stale';
      reason: 'permission-prompt' | 'permission-denied' | 'folder-missing';
    }
  | { kind: 'wrong-folder'; pickedName: string }
  | { kind: 'bootstrap-failed'; cause: string }
  | { kind: 'cancelled' };
