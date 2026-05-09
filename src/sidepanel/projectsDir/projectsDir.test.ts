// Boundary tests for the deepened ProjectsDir module.
//
// These exercise the seven scenarios called out in the RFC. Every
// assertion lands on the public surface — projectsDir.state(),
// projectsDir.grant(), projectsDir.forget() — plus port call counts to
// pin down the structural invariants (e.g. requestPermission must
// never be called on a wrong-named folder).

import { describe, expect, it } from 'vitest';
import { createProjectsDir } from './index';
import { createFakePorts } from './adapters/fake';

describe('ProjectsDir state machine', () => {
  it('full grant flow: bootstrap → pick → validate → escalate → persist', async () => {
    const ports = createFakePorts();
    // Pick yields an aicurator-named folder; mark its readwrite so
    // requestPermission lifts to 'granted'.
    const token = ports.controls.fsa.mintToken('aicurator');
    ports.controls.fsa.setNextRequestResult(token, 'readwrite', 'granted');
    ports.controls.fsa.setList(token, [
      {
        name: 'demo-project',
        spreadsheetId: 'sheet-1',
        gid: '0',
        sheetUrl: 'https://docs.google.com/spreadsheets/d/sheet-1/edit',
        pathwayName: '',
        stage: 'none',
      },
    ]);
    // Have pickDirectory return that token.
    // Use the raw form so the test owns the token id.
    ports.controls.fsa.enqueuePick({
      kind: 'picked',
      token,
      name: 'aicurator',
    });

    const projectsDir = createProjectsDir(ports);
    await projectsDir.ready();
    expect(projectsDir.state().kind).toBe('unpicked');

    await projectsDir.grant();

    // Bootstrap was called once with a non-empty data: URL.
    const dlCalls = ports.controls.downloads.calls();
    expect(dlCalls).toHaveLength(1);
    expect(dlCalls[0].url).toMatch(/^data:[^,]*,.+/);
    expect(dlCalls[0].url.length).toBeGreaterThan('data:,'.length);

    const s = projectsDir.state();
    expect(s.kind).toBe('granted');
    if (s.kind !== 'granted') throw new Error('unreachable');
    expect(s.list).toEqual([
      expect.objectContaining({ name: 'demo-project' }),
    ]);

    expect(ports.controls.store.current()).toBe(token);
  });

  it('cancel flow: AbortError → cancelled state, no handle persisted', async () => {
    const ports = createFakePorts();
    ports.controls.fsa.enqueuePick({ kind: 'cancelled' });

    const projectsDir = createProjectsDir(ports);
    await projectsDir.ready();
    await projectsDir.grant();

    expect(projectsDir.state().kind).toBe('cancelled');
    expect(ports.controls.store.current()).toBeNull();
    // requestPermission was never reached — picker cancellation is the
    // first short-circuit after bootstrap.
    expect(ports.controls.fsa.callCounts().requestPermission).toBe(0);
  });

  it('wrong-folder flow: requestPermission is never called', async () => {
    const ports = createFakePorts();
    const wrongToken = ports.controls.fsa.mintToken('Downloads');
    ports.controls.fsa.enqueuePick({
      kind: 'picked',
      token: wrongToken,
      name: 'Downloads',
    });

    const projectsDir = createProjectsDir(ports);
    await projectsDir.ready();
    await projectsDir.grant();

    const s = projectsDir.state();
    expect(s.kind).toBe('wrong-folder');
    if (s.kind !== 'wrong-folder') throw new Error('unreachable');
    expect(s.pickedName).toBe('Downloads');

    // The renderer-crash invariant — requestPermission must NEVER reach
    // a non-validated handle.
    expect(ports.controls.fsa.callCounts().requestPermission).toBe(0);
    expect(ports.controls.store.current()).toBeNull();
  });

  it('bootstrap-failed: picker is not opened', async () => {
    const ports = createFakePorts();
    ports.controls.downloads.rejectAll(new Error('downloads disabled'));

    const projectsDir = createProjectsDir(ports);
    await projectsDir.ready();
    await projectsDir.grant();

    const s = projectsDir.state();
    expect(s.kind).toBe('bootstrap-failed');
    if (s.kind !== 'bootstrap-failed') throw new Error('unreachable');
    expect(s.cause).toBe('downloads disabled');

    expect(ports.controls.fsa.callCounts().pickDirectory).toBe(0);
    expect(ports.controls.store.current()).toBeNull();
  });

  it('stale-handle rehydration: folder removed → stale; subsequent grant runs full flow', async () => {
    const ports = createFakePorts();
    // Preseed a token whose dir is not registered (simulates idb-loaded
    // handle whose underlying folder vanished).
    const orphan = 'fake-orphan';
    ports.controls.store.preseedHandle(orphan);

    const projectsDir = createProjectsDir(ports);
    await projectsDir.ready();

    expect(projectsDir.state().kind).toBe('stale');
    expect(ports.controls.store.current()).toBeNull(); // store auto-cleared

    // Subsequent grant() runs the full first-pick flow.
    const fresh = ports.controls.fsa.mintToken('aicurator');
    ports.controls.fsa.setNextRequestResult(fresh, 'readwrite', 'granted');
    ports.controls.fsa.enqueuePick({
      kind: 'picked',
      token: fresh,
      name: 'aicurator',
    });

    await projectsDir.grant();

    expect(projectsDir.state().kind).toBe('granted');
    expect(ports.controls.store.current()).toBe(fresh);
  });

  it('permission revoked mid-session: stale → grant runs requestPermission only', async () => {
    const ports = createFakePorts();
    // Preseed a token whose dir is alive but whose readwrite is 'prompt'.
    const token = ports.controls.fsa.mintToken('aicurator', {
      readwrite: 'prompt',
    });
    ports.controls.store.preseedHandle(token);

    const projectsDir = createProjectsDir(ports);
    await projectsDir.ready();

    const s1 = projectsDir.state();
    expect(s1.kind).toBe('stale');
    if (s1.kind !== 'stale') throw new Error('unreachable');
    expect(s1.reason).toBe('permission-prompt');

    // Re-grant should re-request without re-picking.
    ports.controls.fsa.setNextRequestResult(token, 'readwrite', 'granted');
    const picksBefore = ports.controls.fsa.callCounts().pickDirectory;

    await projectsDir.grant();

    expect(projectsDir.state().kind).toBe('granted');
    expect(ports.controls.fsa.callCounts().pickDirectory).toBe(picksBefore);
  });

  it('AbortError after partial flow: state is cancelled, not bootstrap-failed', async () => {
    const ports = createFakePorts();
    // Bootstrap succeeds; pick yields cancelled.
    ports.controls.fsa.enqueuePick({ kind: 'cancelled' });

    const projectsDir = createProjectsDir(ports);
    await projectsDir.ready();
    await projectsDir.grant();

    expect(projectsDir.state().kind).toBe('cancelled');
    // Bootstrap ran exactly once (and succeeded).
    expect(ports.controls.downloads.calls()).toHaveLength(1);
  });
});
