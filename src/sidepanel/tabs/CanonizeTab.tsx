import { Show, createMemo, createSignal } from 'solid-js';
import ProcessTab, { type BadgeState } from './ProcessTab';
import { canonizeLog } from '../services/log';
import { project, projectList, setRunning, setStage } from '../store';
import {
  rowSpanMode,
  rowSpanText,
  setRowSpanMode,
  setRowSpanText,
} from '../store/rowSpan';
import { runCanonize, type RowRange } from '../runners/canonize';
import { runChecks } from '../services/entityParser';
import { isAbortError } from '../lib/abortError';
import { parseRowRange } from '../services/sheetRows';

// Run dev-only parser self-checks once on tab load.
runChecks();

export default function CanonizeTab() {
  const [error, setError] = createSignal<string | null>(null);
  const mode = rowSpanMode;
  const setMode = setRowSpanMode;
  const spanText = rowSpanText;
  const setSpanText = setRowSpanText;
  let activeAbort: AbortController | null = null;

  const hasProject = () => project.selectedName !== null;
  const startVisible = () => hasProject();

  const parsedSpan = createMemo<RowRange | null>(() =>
    mode() === 'all' ? null : parseRowRange(spanText()),
  );

  const spanIsValid = () => mode() === 'all' || parsedSpan() !== null;

  const badge = createMemo<BadgeState | null>(() => {
    if (project.running === 'canonize')
      return { kind: 'running', text: 'running…' };
    if (project.selectedName === null)
      return { kind: 'lock', text: 'no project selected' };
    if (mode() === 'span' && !spanIsValid())
      return { kind: 'lock', text: 'invalid span' };
    return null;
  });

  const canStart = () =>
    project.running === 'none' && hasProject() && spanIsValid();

  const onStart = async () => {
    setError(null);
    if (!canStart()) return;
    if (!project.selectedName) return;
    const meta = projectList().find((p) => p.name === project.selectedName);
    if (!meta) {
      setError('Project metadata not found.');
      return;
    }
    activeAbort = new AbortController();
    setRunning('canonize');
    try {
      await runCanonize({
        spreadsheetId: meta.spreadsheetId,
        gid: meta.gid,
        range: parsedSpan(),
        log: canonizeLog,
        signal: activeAbort.signal,
      });
      await setStage('canonized');
    } catch (err) {
      if (isAbortError(err)) {
        canonizeLog.append('warn', 'cancelled by user');
      } else {
        canonizeLog.append('err', (err as Error).message);
        setError((err as Error).message);
      }
    } finally {
      activeAbort = null;
      setRunning('none');
    }
  };

  const onCancel = () => activeAbort?.abort();

  return (
    <ProcessTab
      name="Canonize"
      topic="canonize"
      badge={badge}
      log={canonizeLog}
    >
      <div class="canonize-form">
        <div class="row-select">
          <label class="radio">
            <input
              type="radio"
              name="canonize-mode"
              checked={mode() === 'all'}
              onChange={() => setMode('all')}
              disabled={!hasProject() || project.running !== 'none'}
            />
            <span>all rows</span>
          </label>
          <label class="radio">
            <input
              type="radio"
              name="canonize-mode"
              checked={mode() === 'span'}
              onChange={() => setMode('span')}
              disabled={!hasProject() || project.running !== 'none'}
            />
            <span>span:</span>
          </label>
          <input
            class="field mono span-input"
            placeholder="2-23"
            value={spanText()}
            onInput={(e) => setSpanText(e.currentTarget.value)}
            disabled={
              !hasProject() ||
              mode() !== 'span' ||
              project.running !== 'none'
            }
            classList={{ invalid: mode() === 'span' && !spanIsValid() }}
          />
        </div>

        <div class="curator-note">
          🔬 Replaces entity names in columns A–F with their canonical
          UniProt-confirmed gene symbols (uppercased, human only). Names
          with no human match or ambiguous matches are left unchanged.
          No LLM call — uses UniProt's SPARQL endpoint directly.
        </div>

        <div class="actions">
          <Show
            when={project.running === 'canonize'}
            fallback={
              <Show when={startVisible()}>
                <button
                  type="button"
                  class="btn primary"
                  onClick={onStart}
                  disabled={!canStart()}
                >
                  ▶ Start
                </button>
              </Show>
            }
          >
            <button type="button" class="btn danger" onClick={onCancel}>
              ✕ Cancel
            </button>
          </Show>
          <span class="progress-hint">
            <Show
              when={project.running === 'canonize'}
              fallback={
                <>
                  {mode() === 'all'
                    ? 'all data rows'
                    : spanIsValid()
                      ? `rows ${parsedSpan()!.start}–${parsedSpan()!.end}`
                      : 'invalid span'}
                </>
              }
            >
              running…
            </Show>
          </span>
        </div>

        <Show when={error()}>
          <div class="banner danger">{error()}</div>
        </Show>
      </div>
    </ProcessTab>
  );
}
