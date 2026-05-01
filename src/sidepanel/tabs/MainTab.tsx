import { Show, For, createSignal } from 'solid-js';
import {
  PROVIDERS,
  saveStatus,
  setSetting,
  settings,
  project,
  grantProjectsDir,
  reGrantProjectsDir,
  setSelectedProject,
  createProjectAction,
  deleteProjectAction,
  type Provider,
} from '../store';
import { getActiveTabSheetUrl } from '../services/projectsDir';

export default function MainTab() {
  const [newName, setNewName] = createSignal('');
  const [error, setError] = createSignal<string | null>(null);

  const granted = () => project.dirPermission === 'granted';
  const hasProject = () => project.selectedName !== null;
  const canCreate = () => granted() && newName().trim().length > 0;

  const onGrant = async () => {
    setError(null);
    try {
      await grantProjectsDir();
    } catch (err) {
      setError(`Could not grant access: ${(err as Error).message}`);
    }
  };

  const onReGrant = async () => {
    setError(null);
    try {
      await reGrantProjectsDir();
    } catch (err) {
      setError(`Could not re-grant access: ${(err as Error).message}`);
    }
  };

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
          <span class="ver">v2601</span>
        </div>
      </header>

      <div class="scroll">
        <Show
          when={granted()}
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
              <Show
                when={
                  project.dirHandle &&
                  (project.dirPermission === 'prompt' ||
                    project.dirPermission === 'denied')
                }
                fallback={
                  <button type="button" class="btn primary" onClick={onGrant}>
                    Grant access
                  </button>
                }
              >
                <button type="button" class="btn primary" onClick={onReGrant}>
                  Re-grant access
                </button>
              </Show>
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
              <Show when={project.list.length === 0}>
                <option value="">— no project yet —</option>
              </Show>
              <For each={project.list}>
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
                granted()
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
            <label for="s-key">API Key</label>
            <input
              id="s-key"
              class="field mono"
              type="password"
              value={settings.apiKey}
              onInput={(e) => setSetting('apiKey', e.currentTarget.value)}
            />
            <span class="help">Stored locally; not synced</span>
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
