// Production HandleStorePort adapter: idb-keyval persistence of the
// FileSystemDirectoryHandle. The token is process-local, so we
// translate it to/from the actual handle via the intern map.

import { get, set, del } from 'idb-keyval';
import type { DirToken, HandleStorePort } from '../..';
import { lookupHandle } from '../../intern';

const HANDLE_KEY = 'aicurator:projectsDirHandle';

export interface HandleStoreProdDeps {
  /** Side-door: the chromeFsa adapter exposes adoptHandle() to intern
   *  a freshly-loaded handle into its token table. */
  adoptHandle(handle: FileSystemDirectoryHandle): DirToken;
}

export function createHandleStoreProdAdapter(
  deps: HandleStoreProdDeps,
): HandleStorePort {
  return {
    async saveHandle(token: DirToken): Promise<void> {
      const handle = lookupHandle(token);
      if (!handle) {
        throw new Error(`handleStore: token ${token} not interned`);
      }
      await set(HANDLE_KEY, handle);
    },
    async loadHandle(): Promise<DirToken | null> {
      const h = await get<FileSystemDirectoryHandle>(HANDLE_KEY);
      if (!h) return null;
      return deps.adoptHandle(h);
    },
    async clearHandle(): Promise<void> {
      await del(HANDLE_KEY);
    },
  };
}
