import {
  For,
  Show,
  createEffect,
  createMemo,
  createSignal,
  onCleanup,
  onMount,
} from 'solid-js';
import ProcessTab, { type BadgeState } from './ProcessTab';
import { summateLog } from '../services/log';
import {
  project,
  setRunning,
  setStage,
  settings,
} from '../store';
import {
  rowSpanMode,
  rowSpanText,
  setRowSpanMode,
  setRowSpanText,
} from '../store/rowSpan';
import { listPmidPdfs, watchDownloads } from '../services/pdfDir';
import { probeMode, type Mode } from '../services/pdfText';
import {
  runSummate,
  runSummateMock,
  type RowRange,
} from '../runners/summate';
import { makeProvider } from '../llm/provider';
import { getSheetName, getValues, quoteSheet } from '../services/sheets';
import { isAbortError } from '../lib/abortError';
import {
  isSkippableRow,
  parsePmidsFromRow,
  parseRowRange,
  SUMMATE_READ_RANGE_END,
} from '../services/sheetRows';

const POLL_FALLBACK_MS = 5000;

export default function SummateTab() {
  const [error, setError] = createSignal<string | null>(null);
  const mode = rowSpanMode;
  const setMode = setRowSpanMode;
  const spanText = rowSpanText;
  const setSpanText = setRowSpanText;
  const [pdfMap, setPdfMap] = createSignal<Map<string, FileSystemFileHandle>>(
    new Map(),
  );
  const [sheetRows, setSheetRows] = createSignal<string[][]>([]);
  const [rowsLoaded, setRowsLoaded] = createSignal(false);
  const [extractMode, setExtractMode] = createSignal<Mode | 'probing'>('probing');
  let activeAbort: AbortController | null = null;

  const hasProject = () => project.selectedName !== null;
  const startVisible = () => hasProject();

  const parsedSpan = createMemo<RowRange | null>(() =>
    mode() === 'all' ? null : parseRowRange(spanText()),
  );

  const spanIsValid = () => mode() === 'all' || parsedSpan() !== null;

  const chipRows = createMemo(() => {
    if (!rowsLoaded() || sheetRows().length === 0) return [];
    const rows = sheetRows();
    let startRow = 2;
    let endRow = rows.length;
    const span = parsedSpan();
    if (span) {
      startRow = Math.max(2, span.start);
      endRow = Math.min(endRow, span.end);
    }
    const out: { rowNum: number; title: string; pmids: string[] }[] = [];
    for (let r = startRow; r <= endRow; r += 1) {
      const row = rows[r - 1] ?? [];
      const title = row[0] ?? '';
      if (isSkippableRow(title)) continue;
      const pmids = parsePmidsFromRow(row);
      if (pmids.length > 0) {
        out.push({ rowNum: r, title, pmids });
      }
    }
    return out;
  });

  const summatableRowCount = createMemo(() => {
    if (!hasProject()) return 0;
    return chipRows().filter((rr) =>
      rr.pmids.some((pmid) => pdfMap().has(pmid)),
    ).length;
  });

  const badge = createMemo<BadgeState | null>(() => {
    if (project.running === 'summate')
      return { kind: 'running', text: 'running…' };
    if (project.selectedName === null)
      return { kind: 'lock', text: 'no project selected' };
    if (settings.apiKey.length === 0 || settings.modelName.length === 0)
      return { kind: 'lock', text: 'configure provider in Settings' };
    if (mode() === 'span' && !spanIsValid())
      return { kind: 'lock', text: 'invalid span' };
    if (summatableRowCount() === 0)
      return { kind: 'lock', text: 'no PDFs for selected rows' };
    return null;
  });

  const canStart = () =>
    project.running === 'none' &&
    hasProject() &&
    settings.apiKey.length > 0 &&
    settings.modelName.length > 0 &&
    spanIsValid() &&
    summatableRowCount() > 0;

  const canMock = () =>
    project.running === 'none' && hasProject() && spanIsValid();

  const rescanPdfs = async () => {
    if (!project.dirHandle || !project.selectedName) return;
    try {
      const projectDir = await project.dirHandle.getDirectoryHandle(
        project.selectedName,
      );
      const map = await listPmidPdfs(projectDir);
      setPdfMap(map);
    } catch (err) {
      console.warn('[summate] rescan PDFs failed:', err);
    }
  };

  const loadSheetRows = async () => {
    if (!project.selectedName) return;
    const meta = project.list.find((p) => p.name === project.selectedName);
    if (!meta) return;
    try {
      const sheetName = await getSheetName(meta.spreadsheetId, meta.gid);
      const sheetRef = quoteSheet(sheetName);
      const rows = await getValues(
        meta.spreadsheetId,
        `${sheetRef}!A:${SUMMATE_READ_RANGE_END}`,
      );
      setSheetRows(rows);
      setRowsLoaded(true);
    } catch (err) {
      setError(`Could not read sheet: ${(err as Error).message}`);
    }
  };

  // Wire downloads listener + 5s poll fallback while the tab is mounted.
  onMount(() => {
    void probeMode().then(setExtractMode);
    void rescanPdfs();
    void loadSheetRows();
    const teardownWatch = watchDownloads(() => {
      void rescanPdfs();
    });
    const interval = setInterval(() => {
      void rescanPdfs();
    }, POLL_FALLBACK_MS);
    onCleanup(() => {
      teardownWatch();
      clearInterval(interval);
    });
  });

  createEffect(() => {
    void project.selectedName;
    setRowsLoaded(false);
    setSheetRows([]);
  });

  const onStart = async () => {
    setError(null);
    if (!canStart()) return;
    if (!project.dirHandle || !project.selectedName) return;
    const meta = project.list.find((p) => p.name === project.selectedName);
    if (!meta) {
      setError('Project metadata not found.');
      return;
    }
    let provider;
    try {
      provider = makeProvider({
        provider: settings.provider,
        apiKey: settings.apiKey,
        modelName: settings.modelName,
      });
    } catch (err) {
      setError((err as Error).message);
      return;
    }

    activeAbort = new AbortController();
    setRunning('summate');
    try {
      const projectDir = await project.dirHandle.getDirectoryHandle(
        project.selectedName,
      );
      let pdfDir: FileSystemDirectoryHandle | null = null;
      try {
        pdfDir = await projectDir.getDirectoryHandle('PDF');
      } catch {
        /* PDF subdir absent — runner will skip text caching */
      }
      // Refresh PDF list immediately before run so we don't miss recent
      // downloads.
      const freshPdfMap = await listPmidPdfs(projectDir);
      setPdfMap(freshPdfMap);

      await runSummate({
        spreadsheetId: meta.spreadsheetId,
        gid: meta.gid,
        projectDir,
        pdfDir,
        pdfMap: freshPdfMap,
        range: parsedSpan(),
        provider,
        log: summateLog,
        signal: activeAbort.signal,
      });
      await setStage('summated');
      void loadSheetRows();
    } catch (err) {
      if (isAbortError(err)) {
        summateLog.append('warn', 'cancelled by user');
      } else {
        summateLog.append('err', (err as Error).message);
        setError((err as Error).message);
      }
    } finally {
      activeAbort = null;
      setRunning('none');
    }
  };

  const onMockTest = async () => {
    setError(null);
    if (!canMock()) return;
    if (!project.selectedName) return;
    const meta = project.list.find((p) => p.name === project.selectedName);
    if (!meta) return;
    activeAbort = new AbortController();
    setRunning('summate');
    try {
      await runSummateMock({
        spreadsheetId: meta.spreadsheetId,
        gid: meta.gid,
        range: parsedSpan(),
        log: summateLog,
        signal: activeAbort.signal,
      });
      await setStage('summated');
      void loadSheetRows();
    } catch (err) {
      summateLog.append('err', (err as Error).message);
      setError((err as Error).message);
    } finally {
      activeAbort = null;
      setRunning('none');
    }
  };

  const onCancel = () => activeAbort?.abort();

  return (
    <ProcessTab name="Summate" topic="summate" badge={badge} log={summateLog}>
      <div class="summate-form">
        <div class="row-select">
          <label class="radio">
            <input
              type="radio"
              name="summate-mode"
              checked={mode() === 'all'}
              onChange={() => setMode('all')}
              disabled={!hasProject() || project.running !== 'none'}
            />
            <span>all rows</span>
          </label>
          <label class="radio">
            <input
              type="radio"
              name="summate-mode"
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

        <Show when={hasProject()}>
          <div class="pdfdir-line">
            <span>
              PDF directory: <code>{project.selectedName}/PDF/</code> ·{' '}
              <strong>{pdfMap().size}</strong> PMID-prefixed PDF
              {pdfMap().size === 1 ? '' : 's'} · Mode:{' '}
              <strong>
                {extractMode() === 'probing'
                  ? '…'
                  : extractMode() === 'pdftotext'
                    ? 'libpoppler text'
                    : 'native PDF blocks'}
              </strong>
            </span>
            <button
              type="button"
              class="btn btn-tiny"
              onClick={() => {
                void rescanPdfs();
                void loadSheetRows();
              }}
              disabled={project.running !== 'none'}
            >
              Re-scan
            </button>
          </div>
        </Show>

        <div class="curator-note">
          📥 Drop PMID-prefixed PDFs into <code>PDF/</code> via the merged
          download tagger (browse to a PubMed/PMC article tab, then download
          the publisher PDF; AICurator renames it). Click chips below to open
          PubMed.
        </div>

        <Show when={hasProject() && chipRows().length > 0}>
          <div class="chip-grid">
            <For each={chipRows()}>
              {(rr) => (
                <div class="chip-row">
                  <span class="chip-row-num">row {rr.rowNum}</span>
                  <span class="chip-row-title" title={rr.title}>
                    {rr.title.length > 40
                      ? rr.title.slice(0, 40) + '…'
                      : rr.title}
                  </span>
                  <For each={rr.pmids}>
                    {(pmid) => (
                      <a
                        class="pmid-chip"
                        classList={{ ready: pdfMap().has(pmid) }}
                        href={`https://pubmed.ncbi.nlm.nih.gov/${pmid}/`}
                        target="_blank"
                        rel="noopener noreferrer"
                      >
                        {pdfMap().has(pmid) ? '📄' : '🔗'} PMID {pmid}
                        {pdfMap().has(pmid) ? ' ✓' : ''}
                      </a>
                    )}
                  </For>
                </div>
              )}
            </For>
          </div>
        </Show>

        <div class="actions">
          <Show
            when={project.running === 'summate'}
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
                <button
                  type="button"
                  class="btn"
                  onClick={onMockTest}
                  disabled={!canMock()}
                  title="Skip the LLM call and write hand-crafted mock summations to the selected rows"
                >
                  Test sheet write
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
              when={project.running === 'summate'}
              fallback={
                <>
                  {mode() === 'all'
                    ? `${chipRows().length} processable rows`
                    : spanIsValid()
                      ? `${chipRows().length} processable rows in span`
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
