// In-memory fake adapters for the ProjectsDir module.
//
// The state machine traffics in opaque DirToken strings, never raw
// FileSystemDirectoryHandle objects, so the entire grant flow is
// testable in plain Node without jsdom or an FSA polyfill.
//
// Tests configure scenarios declaratively against the methods on the
// returned `controls` object, then drive `projectsDir.grant()` /
// `forget()` and assert against `projectsDir.state()`.

import type {
  ChromeFsaPort,
  DirToken,
  DownloadsPort,
  HandleStorePort,
  ListedProject,
  PermState,
  PickOutcome,
  ProjectsDirPorts,
} from '../..';
import { StaleHandleError } from '../..';
import { internHandle, forgetHandle } from '../../intern';

// Stub handle returned by the fake's intern map. Tests don't dereference
// state.handle — the placeholder satisfies the type without actually
// implementing the FSA contract.
function makeStubHandle(name: string): FileSystemDirectoryHandle {
  return { name, kind: 'directory' } as unknown as FileSystemDirectoryHandle;
}

// ── Fake ChromeFsaPort ──────────────────────────────────

export interface FakeFsaControls {
  /** Push a pick outcome onto the queue. The next call to
   *  pickDirectory() returns it (FIFO). */
  enqueuePick(outcome: PickOutcome | { name: string; alreadyExists?: false }): void;
  /** Set the result the next requestPermission(token, mode) will yield. */
  setNextRequestResult(token: DirToken, mode: 'read' | 'readwrite', perm: PermState): void;
  /** Insert a virtual directory at a token. permissions defaults to
   *  {read:'granted', readwrite:'prompt'}. */
  putDir(
    token: DirToken,
    opts?: {
      name?: string;
      readwrite?: PermState;
      read?: PermState;
      list?: ListedProject[];
    },
  ): void;
  /** Mark a token as no longer pointing at an extant folder.
   *  Subsequent queryPermission/listProjects/verifyExists raise
   *  StaleHandleError. */
  invalidate(token: DirToken): void;
  /** Set the list returned by listProjects for a token. */
  setList(token: DirToken, list: ListedProject[]): void;
  /** Mint and return a fresh token. */
  mintToken(name: string, opts?: { readwrite?: PermState; read?: PermState }): DirToken;
  /** Inspect call counts. */
  callCounts(): {
    pickDirectory: number;
    queryPermission: number;
    requestPermission: number;
    listProjects: number;
    verifyExists: number;
  };
}

interface FakeDir {
  name: string;
  read: PermState;
  readwrite: PermState;
  list: ListedProject[];
  alive: boolean;
}

export function createFakeFsaPort(): { port: ChromeFsaPort; controls: FakeFsaControls } {
  const dirs = new Map<DirToken, FakeDir>();
  const pickQueue: PickOutcome[] = [];
  const nextRequestResult = new Map<string, PermState>();
  let counter = 0;
  const counts = {
    pickDirectory: 0,
    queryPermission: 0,
    requestPermission: 0,
    listProjects: 0,
    verifyExists: 0,
  };

  function reqKey(token: DirToken, mode: 'read' | 'readwrite') {
    return `${token}::${mode}`;
  }

  function mintToken(
    name: string,
    opts: { readwrite?: PermState; read?: PermState } = {},
  ): DirToken {
    counter += 1;
    const token = `fake-${counter}`;
    dirs.set(token, {
      name,
      read: opts.read ?? 'granted',
      readwrite: opts.readwrite ?? 'prompt',
      list: [],
      alive: true,
    });
    internHandle(token, makeStubHandle(name));
    return token;
  }

  function evictToken(token: DirToken): void {
    forgetHandle(token);
  }
  void evictToken;

  const port: ChromeFsaPort = {
    async pickDirectory(): Promise<PickOutcome> {
      counts.pickDirectory += 1;
      const next = pickQueue.shift();
      if (!next) return { kind: 'cancelled' };
      return next;
    },
    async queryPermission(token, mode): Promise<PermState> {
      counts.queryPermission += 1;
      const dir = dirs.get(token);
      if (!dir || !dir.alive) throw new StaleHandleError();
      return dir[mode];
    },
    async requestPermission(token, mode): Promise<PermState> {
      counts.requestPermission += 1;
      const dir = dirs.get(token);
      if (!dir || !dir.alive) throw new StaleHandleError();
      const programmed = nextRequestResult.get(reqKey(token, mode));
      if (programmed) {
        nextRequestResult.delete(reqKey(token, mode));
        dir[mode] = programmed;
        return programmed;
      }
      return dir[mode];
    },
    async listProjects(token): Promise<ListedProject[]> {
      counts.listProjects += 1;
      const dir = dirs.get(token);
      if (!dir || !dir.alive) throw new StaleHandleError();
      return [...dir.list];
    },
    async verifyExists(token): Promise<void> {
      counts.verifyExists += 1;
      const dir = dirs.get(token);
      if (!dir || !dir.alive) throw new StaleHandleError();
    },
  };

  const controls: FakeFsaControls = {
    enqueuePick(outcome) {
      if ('kind' in outcome && outcome.kind === 'cancelled') {
        pickQueue.push(outcome);
        return;
      }
      if ('kind' in outcome && outcome.kind === 'picked') {
        pickQueue.push(outcome);
        return;
      }
      // Sugar: { name } → mint token + enqueue
      const o = outcome as { name: string };
      const token = mintToken(o.name);
      pickQueue.push({ kind: 'picked', token, name: o.name });
    },
    setNextRequestResult(token, mode, perm) {
      nextRequestResult.set(reqKey(token, mode), perm);
    },
    putDir(token, opts) {
      dirs.set(token, {
        name: opts?.name ?? 'aicurator',
        read: opts?.read ?? 'granted',
        readwrite: opts?.readwrite ?? 'granted',
        list: opts?.list ?? [],
        alive: true,
      });
    },
    invalidate(token) {
      const dir = dirs.get(token);
      if (dir) dir.alive = false;
    },
    setList(token, list) {
      const dir = dirs.get(token);
      if (dir) dir.list = list;
    },
    mintToken,
    callCounts: () => ({ ...counts }),
  };

  return { port, controls };
}

// ── Fake DownloadsPort ──────────────────────────────────

export interface FakeDownloadsControls {
  /** Make the next call to downloadDataUrl reject with this error. */
  rejectNextWith(err: Error): void;
  /** Reject all downloads. */
  rejectAll(err: Error): void;
  calls(): { url: string; filename: string }[];
}

export function createFakeDownloadsPort(): {
  port: DownloadsPort;
  controls: FakeDownloadsControls;
} {
  const callLog: { url: string; filename: string }[] = [];
  let nextRejection: Error | null = null;
  let permanentRejection: Error | null = null;
  let nextId = 1;

  const port: DownloadsPort = {
    async downloadDataUrl(args) {
      callLog.push({ ...args });
      if (permanentRejection) throw permanentRejection;
      if (nextRejection) {
        const err = nextRejection;
        nextRejection = null;
        throw err;
      }
      return nextId++;
    },
  };

  const controls: FakeDownloadsControls = {
    rejectNextWith(err) {
      nextRejection = err;
    },
    rejectAll(err) {
      permanentRejection = err;
    },
    calls: () => callLog.map((c) => ({ ...c })),
  };

  return { port, controls };
}

// ── Fake HandleStorePort ────────────────────────────────

export interface FakeStoreControls {
  /** Pre-seed the persisted token (simulates a previous session). */
  preseedHandle(token: DirToken): void;
  current(): DirToken | null;
}

export function createFakeStorePort(): {
  port: HandleStorePort;
  controls: FakeStoreControls;
} {
  let stored: DirToken | null = null;

  const port: HandleStorePort = {
    async saveHandle(token) {
      stored = token;
    },
    async loadHandle() {
      return stored;
    },
    async clearHandle() {
      stored = null;
    },
  };

  const controls: FakeStoreControls = {
    preseedHandle(token) {
      stored = token;
    },
    current: () => stored,
  };

  return { port, controls };
}

// ── Bundle ──────────────────────────────────────────────

export interface FakePorts extends ProjectsDirPorts {
  controls: {
    fsa: FakeFsaControls;
    downloads: FakeDownloadsControls;
    store: FakeStoreControls;
  };
}

export function createFakePorts(): FakePorts {
  const fsa = createFakeFsaPort();
  const downloads = createFakeDownloadsPort();
  const store = createFakeStorePort();
  return {
    fsa: fsa.port,
    downloads: downloads.port,
    store: store.port,
    controls: {
      fsa: fsa.controls,
      downloads: downloads.controls,
      store: store.controls,
    },
  };
}
