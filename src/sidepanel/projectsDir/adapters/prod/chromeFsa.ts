// Production ChromeFsaPort adapter: bridges window.showDirectoryPicker
// + FileSystemDirectoryHandle.{queryPermission,requestPermission} +
// directory iteration to the opaque DirToken contract.
//
// Picker setup notes:
//   - mode:'read' at pick — the state machine validates the folder name
//     before requesting readwrite. Avoids escalating readwrite on
//     system-special folders if the user picks the wrong one.
//   - No startIn — picker opens at the OS default. Forcing the user to
//     navigate to <Downloads>/aicurator/ reduces the chance they
//     accidentally click "Select folder" at Downloads root, which
//     triggers a Chrome renderer crash on permission grant.
//   - id:'aicurator' — Chrome remembers the last-picked location for
//     this id, so subsequent picks open at aicurator/ directly.

import type {
  ChromeFsaPort,
  DirToken,
  ListedProject,
  PermState,
  PickOutcome,
} from '../..';
import { StaleHandleError } from '../..';
import { internHandle, forgetHandle } from '../../intern';
import { readMagicFile } from '../../../services/magicFile';

let nextId = 0;
const TOKEN_TO_HANDLE = new Map<DirToken, FileSystemDirectoryHandle>();

export function createChromeFsaProdAdapter(): ChromeFsaPort & {
  /** Side-door used by rehydration to intern an idb-loaded handle. */
  adoptHandle(handle: FileSystemDirectoryHandle): DirToken;
} {
  function makeToken(handle: FileSystemDirectoryHandle): DirToken {
    nextId += 1;
    const t: DirToken = `prod-${nextId}`;
    TOKEN_TO_HANDLE.set(t, handle);
    internHandle(t, handle);
    return t;
  }

  function dropToken(token: DirToken): void {
    TOKEN_TO_HANDLE.delete(token);
    forgetHandle(token);
  }

  function deref(token: DirToken): FileSystemDirectoryHandle {
    const h = TOKEN_TO_HANDLE.get(token);
    if (!h) throw new StaleHandleError(`unknown token: ${token}`);
    return h;
  }

  return {
    adoptHandle(handle) {
      return makeToken(handle);
    },

    async pickDirectory(): Promise<PickOutcome> {
      let handle: FileSystemDirectoryHandle;
      try {
        handle = await window.showDirectoryPicker({
          id: 'aicurator',
          mode: 'read',
        });
      } catch (err) {
        if (err instanceof DOMException && err.name === 'AbortError') {
          return { kind: 'cancelled' };
        }
        throw err;
      }
      const token = makeToken(handle);
      return { kind: 'picked', token, name: handle.name };
    },

    async queryPermission(token, mode): Promise<PermState> {
      const handle = deref(token);
      try {
        return (await handle.queryPermission({ mode })) as PermState;
      } catch (err) {
        if (err instanceof DOMException && err.name === 'NotFoundError') {
          dropToken(token);
          throw new StaleHandleError();
        }
        throw err;
      }
    },

    async requestPermission(token, mode): Promise<PermState> {
      const handle = deref(token);
      try {
        return (await handle.requestPermission({ mode })) as PermState;
      } catch (err) {
        if (err instanceof DOMException && err.name === 'NotFoundError') {
          dropToken(token);
          throw new StaleHandleError();
        }
        throw err;
      }
    },

    async listProjects(token): Promise<ListedProject[]> {
      const handle = deref(token);
      const out: ListedProject[] = [];
      try {
        for await (const entry of handle.values()) {
          if (entry.kind !== 'directory') continue;
          const subdir = entry as FileSystemDirectoryHandle;
          const magic = await readMagicFile(subdir);
          if (!magic) continue;
          out.push({
            name: subdir.name,
            spreadsheetId: magic.spreadsheetId,
            gid: magic.gid,
            sheetUrl: magic.sheetUrl,
            pathwayName: magic.pathwayName,
            stage: magic.stage,
          });
        }
      } catch (err) {
        if (err instanceof DOMException && err.name === 'NotFoundError') {
          dropToken(token);
          throw new StaleHandleError();
        }
        throw err;
      }
      out.sort((a, b) => a.name.localeCompare(b.name));
      return out;
    },

    async verifyExists(token): Promise<void> {
      const handle = deref(token);
      try {
        const it = handle.values();
        await it.next();
      } catch (err) {
        if (err instanceof DOMException && err.name === 'NotFoundError') {
          dropToken(token);
          throw new StaleHandleError();
        }
        throw err;
      }
    },
  };
}
