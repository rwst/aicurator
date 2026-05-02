import { Show, createMemo, createSignal } from 'solid-js';
import ProcessTab, { type RunStatus } from './ProcessTab';
import { canonizeLog } from '../services/log';
import { project, setRunning, setStage } from '../store';
import { runCanonize, type RowRange } from '../runners/canonize';
import { runChecks } from '../services/entityParser';

// Run dev-only parser self-checks once on tab load.
runChecks();

export default function CanonizeTab() {
  const [error, setError] = createSignal<string | null>(null);
  const [mode, setMode] = createSignal<'all' | 'span'>('all');
  const [spanText, setSpanText] = createSignal('');
  let activeAbort: AbortController | null = null;

  const status = createMemo<RunStatus>(() => {
    if (project.running === 'canonize') return 'running';
    if (project.stage !== 'summated' && project.stage !== 'canonized')
      return 'locked';
    return 'ready';
  });

  const parsedSpan = createMemo<RowRange | null>(() => {
    if (mode() === 'all') return null;
    const m = /^\s*(\d+)\s*-\s*(\d+)\s*$/.exec(spanText());
    if (!m) return null;
    const start = parseInt(m[1], 10);
    const end = parseInt(m[2], 10);
    if (start < 2 || end < start) return null;
    return { start, end };
  });

  const spanIsValid = () => mode() === 'all' || parsedSpan() !== null;

  const canStart = () =>
    project.running === 'none' &&
    (project.stage === 'summated' || project.stage === 'canonized') &&
    spanIsValid();

  const onStart = async () => {
    setError(null);
    if (!canStart()) return;
    if (!project.selectedName) return;
    const meta = project.list.find((p) => p.name === project.selectedName);
    if (!meta) {
      setError('Project metadata not found.');
      return;
    }
    if (project.stage === 'canonized') {
      if (
        !window.confirm(
          'Re-running Canonize will overwrite entity names in columns A–F for the selected rows.\n\nContinue?',
        )
      )
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
      if (
        (err as Error).name === 'AbortError' ||
        (err as Error).message === 'aborted'
      ) {
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
      status={status}
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
              disabled={project.running !== 'none'}
            />
            <span>all rows</span>
          </label>
          <label class="radio">
            <input
              type="radio"
              name="canonize-mode"
              checked={mode() === 'span'}
              onChange={() => setMode('span')}
              disabled={project.running !== 'none'}
            />
            <span>span:</span>
          </label>
          <input
            class="field mono span-input"
            placeholder="2-23"
            value={spanText()}
            onInput={(e) => setSpanText(e.currentTarget.value)}
            disabled={mode() !== 'span' || project.running !== 'none'}
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
              <button
                type="button"
                class="btn primary"
                onClick={onStart}
                disabled={!canStart()}
              >
                ▶ Start
              </button>
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
