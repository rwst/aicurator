import { Match, Show, Switch, For, createSignal } from 'solid-js';
import {
  PROVIDERS,
  apiKeyKeyFor,
  saveStatus,
  setSetting,
  settings,
  project,
  projectsDir,
  projectList,
  isGranted,
  setSelectedProject,
  createProjectAction,
  deleteProjectAction,
  type Provider,
} from '../store';
import type { ProjectsDirState } from '../projectsDir';
import { getActiveTabSheetUrl } from '../services/sheetUrl';
import { testConnection, type TestResult } from '../services/testConnection';

// Derive the internal vYYXX label from the manifest's <YY>.<XX>.<patch>
// so the badge can never drift from the actual shipped version.
function internalVersion(): string {
  const [yy, xx] = chrome.runtime.getManifest().version.split('.');
  return `v${yy}${(xx ?? '0').padStart(2, '0')}`;
}

export default function MainTab() {
  const [newName, setNewName] = createSignal('');
  const [error, setError] = createSignal<string | null>(null);
  const [testStatus, setTestStatus] = createSignal<
    'idle' | 'testing' | TestResult
  >('idle');

  const onTestConnection = async () => {
    setTestStatus('testing');
    const result = await testConnection();
    setTestStatus(result);
  };

  const hasProject = () => project.selectedName !== null;
  const canCreate = () => isGranted() && newName().trim().length > 0;

  const onCreate = async () => {
    setError(null);
    const name = newName().trim();
    if (!name) return;
    const sheet = await getActiveTabSheetUrl();
    if (!sheet) {
      setError(
        'Open a Google Sheet tab and re-click Create — the active tab must be a Google Sheet URL.',
      );
      return;
    }
    try {
      await createProjectAction(name, sheet);
      setNewName('');
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const onDelete = async () => {
    const name = project.selectedName;
    if (!name) return;
    if (
      !window.confirm(
        `Delete project "${name}"? This will remove its directory, magic file, and all PDFs.`,
      )
    )
      return;
    setError(null);
    try {
      await deleteProjectAction(name);
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const dirState = () => projectsDir.state();

  return (
    <>
      <header class="header">
        <img
          class="logo"
          src={chrome.runtime.getURL('reactome-logo.png')}
          alt="Reactome"
        />
        <div class="meta">
          <span class="app">AICurator</span>
          <span class="ver">{internalVersion()}</span>
        </div>
      </header>

      <div class="scroll">
        <Show
          when={isGranted()}
          fallback={
            <div class="access-prompt">
              <span class="label">Projects directory</span>
              <p class="help">
                AICurator stores projects in <code>&lt;Downloads&gt;/aicurator/</code>.
                The folder will be auto-created when you click below.
                In the picker, <strong>navigate to <code>Downloads/aicurator/</code>
                and click "Select folder" on it.</strong>{' '}
                <strong style="color: var(--danger);">
                  Do not click "Select folder" at the Downloads root —
                  Chrome will crash.
                </strong>
              </p>
              <button
                type="button"
                class="btn primary"
                onClick={() => void projectsDir.grant()}
              >
                {dirState().kind === 'stale' ? 'Re-grant access' : 'Grant access'}
              </button>
              <Switch>
                <Match
                  when={
                    dirState().kind === 'wrong-folder'
                      ? (dirState() as Extract<ProjectsDirState, { kind: 'wrong-folder' }>)
                      : null
                  }
                >
                  {(w) => (
                    <div class="banner danger">
                      Picked folder is "{w().pickedName}" — it must be named
                      "aicurator". Open <code>&lt;Downloads&gt;/aicurator/</code>
                      {' '}in the picker, then click "Select folder".
                    </div>
                  )}
                </Match>
                <Match
                  when={
                    dirState().kind === 'bootstrap-failed'
                      ? (dirState() as Extract<ProjectsDirState, { kind: 'bootstrap-failed' }>)
                      : null
                  }
                >
                  {(b) => (
                    <div class="banner danger">
                      Could not auto-create &lt;Downloads&gt;/aicurator/. Please
                      create that folder manually in your Downloads directory,
                      then click "Grant access" again. (Cause: {b().cause})
                    </div>
                  )}
                </Match>
                <Match when={dirState().kind === 'stale'}>
                  <div class="banner warn">
                    Permission to access the aicurator folder has expired.
                    Click "Re-grant access".
                  </div>
                </Match>
              </Switch>
              <Show when={error()}>
                <div class="banner danger">{error()}</div>
              </Show>
            </div>
          }
        >
          <div class="project-block">
            <span class="label">Current project</span>
            <select
              class="select"
              aria-label="Project"
              value={project.selectedName ?? ''}
              onChange={(e) => {
                const v = e.currentTarget.value;
                void setSelectedProject(v === '' ? null : v);
              }}
            >
              <Show when={projectList().length === 0}>
                <option value="">— no project yet —</option>
              </Show>
              <For each={projectList()}>
                {(p) => <option value={p.name}>{p.name}</option>}
              </For>
            </select>
            <input
              class="field new"
              placeholder="…or type a new project name"
              value={newName()}
              onInput={(e) => setNewName(e.currentTarget.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && canCreate()) void onCreate();
              }}
            />
            <div class="btn-row">
              <button
                type="button"
                class="btn primary"
                disabled={!canCreate()}
                onClick={onCreate}
              >
                Create
              </button>
              <button
                type="button"
                class="btn danger"
                disabled={!hasProject()}
                onClick={onDelete}
              >
                Delete
              </button>
              <button
                type="button"
                class="btn"
                onClick={() => window.close()}
              >
                Quit
              </button>
            </div>
            <Show when={error()}>
              <div class="banner danger">{error()}</div>
            </Show>
          </div>
        </Show>

        <hr class="divider" />

        <div class="settings">
          <h3>Settings</h3>

          <div class="row">
            <label for="s-dir">Projects Directory</label>
            <input
              id="s-dir"
              class="field mono"
              value={
                isGranted()
                  ? '<Downloads>/aicurator/  (granted)'
                  : '<Downloads>/aicurator/  (not granted)'
              }
              disabled
            />
            <span class="help">
              Fixed location. Use <em>Grant access</em> above to authorize.
            </span>
          </div>

          <div class="row">
            <label for="s-provider">AI Model Provider</label>
            <select
              id="s-provider"
              class="select"
              value={settings.provider}
              onChange={(e) =>
                setSetting('provider', e.currentTarget.value as Provider)
              }
            >
              <For each={PROVIDERS}>{(p) => <option value={p}>{p}</option>}</For>
            </select>
          </div>

          <div class="row">
            <label for="s-model">Model Name</label>
            <input
              id="s-model"
              class="field mono"
              value={settings.modelName}
              placeholder="e.g. claude-opus-4-5, gpt-5-mini, anthropic/claude-opus-4-5"
              onInput={(e) => setSetting('modelName', e.currentTarget.value)}
            />
          </div>

          <div class="row">
            <label for="s-key">{settings.provider} API Key</label>
            <input
              id="s-key"
              class="field mono"
              type="password"
              value={settings[apiKeyKeyFor(settings.provider)]}
              onInput={(e) =>
                setSetting(apiKeyKeyFor(settings.provider), e.currentTarget.value)
              }
            />
            <span class="help">Stored locally; not synced. Each provider keeps its own key.</span>
          </div>

          <div class="row">
            <div class="conn-row">
              <button
                type="button"
                class="btn"
                onClick={onTestConnection}
                disabled={testStatus() === 'testing'}
              >
                {testStatus() === 'testing' ? 'Testing…' : 'Test connection'}
              </button>
              <Show
                when={
                  testStatus() !== 'idle' && testStatus() !== 'testing'
                }
              >
                <span
                  class="conn-status"
                  classList={{
                    ok: (testStatus() as TestResult).ok,
                    err: !(testStatus() as TestResult).ok,
                  }}
                  role="status"
                  aria-live="polite"
                >
                  {(testStatus() as TestResult).ok ? '✓ ' : '✗ '}
                  {(testStatus() as TestResult).message}
                </span>
              </Show>
            </div>
          </div>

          <Show when={saveStatus() !== 'idle'}>
            <div
              class="save-hint"
              aria-live="polite"
              role="status"
              data-status={saveStatus()}
            >
              <span
                class="dot"
                classList={{
                  error: saveStatus() === 'error',
                  saving: saveStatus() === 'saving',
                }}
              />
              {saveStatus() === 'saving' && 'Saving…'}
              {saveStatus() === 'saved' && 'All changes saved'}
              {saveStatus() === 'error' && 'Save failed — check console'}
            </div>
          </Show>
        </div>
      </div>
    </>
  );
}
