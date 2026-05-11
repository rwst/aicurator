// The ProjectsDir module owns the entire user-granted directory lifecycle
// from "user has not yet picked a folder" to "module exposes a usable,
// listed, write-permitted directory". The validate-before-escalate
// invariant (see chrome-issues.md §1) is a structural property: there is
// no public way to call escalation without first passing through
// validation.
//
// The state machine never throws — every failure mode becomes a
// ProjectsDirState variant. Consumers branch on `state().kind` and
// imperatively drive the flow with `grant()` / `forget()`.

import { createSignal, type Accessor } from 'solid-js';
import type {
  DirToken,
  ListedProject,
  ProjectsDirPorts,
} from './ports';
import { StaleHandleError } from './ports';
import { lookupHandle } from './intern';
import type { ProjectsDirState, ProjectMeta } from './types';

export type { ProjectsDirState, ProjectMeta } from './types';
export type {
  ChromeFsaPort,
  DirToken,
  HandleStorePort,
  DownloadsPort,
  ListedProject,
  ProjectsDirPorts,
  PermState,
  PickOutcome,
} from './ports';
export { StaleHandleError } from './ports';

export interface ProjectsDir {
  /** Reactive accessor — the discriminated state drives all UI. */
  state: Accessor<ProjectsDirState>;

  /**
   * Idempotent. Routes by current state:
   *   unpicked | wrong-folder | bootstrap-failed | cancelled
   *     → bootstrap + pick + validate + request readwrite
   *   stale
   *     → re-request permission; on stale handle, auto-clear + pick
   *   granted
   *     → no-op
   * Resolves on terminal state. Never throws — every error becomes a
   * state variant.
   */
  grant: () => Promise<void>;

  /** Drop the stored handle and return to 'unpicked'. */
  forget: () => Promise<void>;

  /** Re-scan subdirs and emit a fresh `granted` state. No-op if not
   * granted. Used after createProject / deleteProject mutations. */
  refreshList: () => Promise<void>;

  /** Promise that resolves once the initial rehydration finishes. UI can
   * still subscribe to `state()` immediately — this is for callers that
   * need to wait (e.g. App startup before refreshing footer match). */
  ready: () => Promise<void>;
}

export function createProjectsDir(deps: ProjectsDirPorts): ProjectsDir {
  const { fsa, downloads, store } = deps;

  const [state, setState] = createSignal<ProjectsDirState>({ kind: 'unpicked' });
  let currentToken: DirToken | null = null;

  // Single-flight: serialize grant() calls so a double-click can't
  // interleave the bootstrap → pick → validate sequence with itself.
  let inflight: Promise<void> | null = null;

  const ready = rehydrate();

  function setGranted(token: DirToken, list: ListedProject[]): void {
    setState({
      kind: 'granted',
      handle: tokenAsHandle(token),
      list: list.map(toProjectMeta),
    });
  }

  async function rehydrate(): Promise<void> {
    let token: DirToken | null;
    try {
      token = await store.loadHandle();
    } catch {
      token = null;
    }
    if (!token) {
      currentToken = null;
      setState({ kind: 'unpicked' });
      return;
    }
    let perm;
    try {
      perm = await fsa.queryPermission(token, 'readwrite');
    } catch (err) {
      if (err instanceof StaleHandleError) {
        await safeClear();
        currentToken = null;
        setState({ kind: 'stale', reason: 'folder-missing' });
        return;
      }
      // Unknown adapter error — treat as stale to recover.
      await safeClear();
      currentToken = null;
      setState({ kind: 'stale', reason: 'folder-missing' });
      return;
    }
    if (perm !== 'granted') {
      currentToken = token;
      setState({
        kind: 'stale',
        reason: perm === 'denied' ? 'permission-denied' : 'permission-prompt',
      });
      return;
    }
    // Permission cached — verify the folder is still on disk.
    try {
      await fsa.verifyExists(token);
    } catch (err) {
      if (err instanceof StaleHandleError) {
        await safeClear();
        currentToken = null;
        setState({ kind: 'stale', reason: 'folder-missing' });
        return;
      }
      throw err;
    }
    currentToken = token;
    const list = await fsa.listProjects(token).catch(() => []);
    setGranted(token, list);
  }

  function grant(): Promise<void> {
    if (inflight) return inflight;
    inflight = doGrant().finally(() => {
      inflight = null;
    });
    return inflight;
  }

  async function doGrant(): Promise<void> {
    await ready;
    const cur = state();

    // Granted → no-op.
    if (cur.kind === 'granted') return;

    // Stale → re-request permission on the existing token, no re-pick.
    if (cur.kind === 'stale' && currentToken) {
      const token = currentToken;
      let perm;
      try {
        perm = await fsa.requestPermission(token, 'readwrite');
      } catch (err) {
        if (err instanceof StaleHandleError) {
          await safeClear();
          currentToken = null;
          // Fall through to a fresh pick.
          return runFreshPick();
        }
        throw err;
      }
      if (perm === 'granted') {
        try {
          await fsa.verifyExists(token);
        } catch (err) {
          if (err instanceof StaleHandleError) {
            await safeClear();
            currentToken = null;
            return runFreshPick();
          }
          throw err;
        }
        const list = await fsa.listProjects(token).catch(() => []);
        setGranted(token, list);
        return;
      }
      // Permission still not granted — emit refreshed stale state and stop.
      setState({
        kind: 'stale',
        reason: perm === 'denied' ? 'permission-denied' : 'permission-prompt',
      });
      return;
    }

    return runFreshPick();
  }

  async function runFreshPick(): Promise<void> {
    // Kick off the Downloads/aicurator/ bootstrap WITHOUT awaiting — the
    // click's transient user activation must still be live when
    // showDirectoryPicker runs. Awaiting chrome.downloads.download here
    // consumes the activation on Windows (Defender/SmartScreen latency)
    // and the picker rejects with AbortError before its dialog renders.
    // The 16-byte data: URL typically completes during the picker's open
    // animation, so aicurator/ is visible to the user by the time they
    // navigate to Downloads. (See CHANGELOG v2607.)
    const bootstrapPromise = downloads
      .downloadDataUrl({
        url: 'data:text/plain,aicurator-init',
        filename: 'aicurator/aicurator-init.txt',
      })
      .then(
        (): Error | null => null,
        (err: unknown): Error =>
          err instanceof Error ? err : new Error(String(err)),
      );

    // Pick. AbortError → cancelled (port maps it before we see it).
    const outcome = await fsa.pickDirectory();
    const bootstrapErr = await bootstrapPromise;

    // bootstrap-failed takes priority — without aicurator/ in Downloads
    // the picker showed an empty parent and any pick was incidental.
    if (bootstrapErr) {
      setState({ kind: 'bootstrap-failed', cause: bootstrapErr.message });
      return;
    }

    if (outcome.kind === 'cancelled') {
      setState({ kind: 'cancelled' });
      return;
    }

    const { token, name } = outcome;

    // Validate name BEFORE escalating to readwrite. The renderer-crash
    // invariant lives here: requestPermission is only ever called on a
    // token whose folder name === 'aicurator'.
    if (name !== 'aicurator') {
      setState({ kind: 'wrong-folder', pickedName: name });
      return;
    }

    const perm = await fsa.requestPermission(token, 'readwrite');
    if (perm !== 'granted') {
      setState({
        kind: 'stale',
        reason: perm === 'denied' ? 'permission-denied' : 'permission-prompt',
      });
      return;
    }

    await store.saveHandle(token);
    currentToken = token;
    const list = await fsa.listProjects(token).catch(() => []);
    setGranted(token, list);
  }

  async function forget(): Promise<void> {
    await safeClear();
    currentToken = null;
    setState({ kind: 'unpicked' });
  }

  async function refreshList(): Promise<void> {
    if (!currentToken) return;
    const cur = state();
    if (cur.kind !== 'granted') return;
    let list;
    try {
      list = await fsa.listProjects(currentToken);
    } catch (err) {
      if (err instanceof StaleHandleError) {
        await safeClear();
        currentToken = null;
        setState({ kind: 'stale', reason: 'folder-missing' });
        return;
      }
      throw err;
    }
    setGranted(currentToken, list);
  }

  async function safeClear(): Promise<void> {
    try {
      await store.clearHandle();
    } catch {
      /* swallow — we're already on a recovery path */
    }
  }

  return {
    state,
    grant,
    forget,
    refreshList,
    ready: () => ready,
  };
}

function tokenAsHandle(token: DirToken): FileSystemDirectoryHandle {
  const h = lookupHandle(token);
  // The state machine never reaches `granted` without the production
  // adapter (or a test that explicitly opts in) interning a handle for
  // the token. If this fires, an adapter is broken.
  if (!h) throw new Error(`projectsDir: no handle interned for token ${token}`);
  return h;
}

function toProjectMeta(p: ListedProject): ProjectMeta {
  return {
    name: p.name,
    spreadsheetId: p.spreadsheetId,
    gid: p.gid,
    sheetUrl: p.sheetUrl,
    pathwayName: p.pathwayName,
    stage: p.stage,
  };
}
