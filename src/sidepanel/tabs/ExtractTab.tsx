import { For, Show, createMemo, createSignal } from 'solid-js';
import ProcessTab, { type RunStatus } from './ProcessTab';
import { extractLog } from '../services/log';
import {
  addExtractPdfs,
  clearExtractPdfs,
  extractPdfHandles,
  project,
  removeExtractPdf,
  setPathwayName,
  setRunning,
  setStage,
  settings,
} from '../store';
import {
  hasUnrelatedSheetData,
  runExtract,
  runExtractMock,
} from '../runners/extract';
import { makeProvider } from '../llm/provider';

const PDF_CAP = 10;

export default function ExtractTab() {
  const [error, setError] = createSignal<string | null>(null);
  let activeAbort: AbortController | null = null;

  const status = createMemo<RunStatus>(() => {
    if (project.running === 'extract') return 'running';
    if (project.selectedName === null) return 'locked';
    return 'ready';
  });

  const canStart = () =>
    project.selectedName !== null &&
    project.pathwayName.trim().length > 0 &&
    extractPdfHandles().length >= 1 &&
    project.running === 'none' &&
    settings.apiKey.length > 0 &&
    settings.modelName.length > 0;

  const onAddPdf = async () => {
    setError(null);
    try {
      const picked = await window.showOpenFilePicker({
        id: 'aicurator-extract-pdfs',
        multiple: true,
        excludeAcceptAllOption: true,
        types: [
          { description: 'PDF documents', accept: { 'application/pdf': ['.pdf'] } },
        ],
      });
      const before = extractPdfHandles().length;
      const space = PDF_CAP - before;
      if (picked.length > space) {
        extractLog.append(
          'warn',
          `PDF cap is ${PDF_CAP}; skipping ${picked.length - space} of ${picked.length} picks`,
        );
      }
      addExtractPdfs(picked.slice(0, space));
    } catch (err) {
      // User-cancelled picker raises AbortError; ignore.
      if ((err as Error).name !== 'AbortError') {
        setError(`Could not add PDFs: ${(err as Error).message}`);
      }
    }
  };

  const onStart = async () => {
    setError(null);
    if (!canStart()) return;
    if (!project.dirHandle || !project.selectedName) return;
    const projectMeta = project.list.find(
      (p) => p.name === project.selectedName,
    );
    if (!projectMeta) {
      setError('Project metadata not found in store.');
      return;
    }

    // Re-run modal subsumes empty-sheet check (Q7 + §1.6 of plan).
    if (project.stage !== 'none') {
      if (
        !window.confirm(
          'Re-running Extract will overwrite the sheet header + rows and reset Summate / Canonize state.\n\nContinue?',
        )
      )
        return;
    } else if (
      await hasUnrelatedSheetData(projectMeta.spreadsheetId, projectMeta.gid)
    ) {
      if (
        !window.confirm(
          '⚠ The target sheet contains data in row 1 that is not the AICurator 12-column header.\n\nProceeding will overwrite it. Continue?',
        )
      )
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
    setRunning('extract');
    try {
      const projectDir = await project.dirHandle.getDirectoryHandle(
        project.selectedName,
      );
      await runExtract({
        pathwayName: project.pathwayName,
        pdfHandles: extractPdfHandles(),
        spreadsheetId: projectMeta.spreadsheetId,
        gid: projectMeta.gid,
        projectDir,
        provider,
        log: extractLog,
        signal: activeAbort.signal,
      });
      await setStage('extracted');
    } catch (err) {
      if ((err as Error).name === 'AbortError' || (err as Error).message === 'aborted') {
        extractLog.append('warn', 'cancelled by user');
      } else {
        extractLog.append('err', (err as Error).message);
        setError((err as Error).message);
      }
    } finally {
      activeAbort = null;
      setRunning('none');
    }
  };

  const onCancel = () => {
    activeAbort?.abort();
  };

  const canMock = () =>
    project.selectedName !== null && project.running === 'none';

  const onMockTest = async () => {
    setError(null);
    if (!canMock()) return;
    if (!project.dirHandle || !project.selectedName) return;
    const projectMeta = project.list.find(
      (p) => p.name === project.selectedName,
    );
    if (!projectMeta) {
      setError('Project metadata not found in store.');
      return;
    }
    if (project.stage !== 'none') {
      if (
        !window.confirm(
          'Re-running mock Extract will overwrite the sheet and reset Summate / Canonize state.\n\nContinue?',
        )
      )
        return;
    } else if (
      await hasUnrelatedSheetData(projectMeta.spreadsheetId, projectMeta.gid)
    ) {
      if (
        !window.confirm(
          '⚠ The target sheet contains data in row 1 that is not the AICurator 12-column header.\n\nProceeding will overwrite it. Continue?',
        )
      )
        return;
    }
    activeAbort = new AbortController();
    setRunning('extract');
    try {
      const projectDir = await project.dirHandle.getDirectoryHandle(
        project.selectedName,
      );
      await runExtractMock({
        spreadsheetId: projectMeta.spreadsheetId,
        gid: projectMeta.gid,
        projectDir,
        log: extractLog,
        signal: activeAbort.signal,
      });
      await setStage('extracted');
    } catch (err) {
      if (
        (err as Error).name === 'AbortError' ||
        (err as Error).message === 'aborted'
      ) {
        extractLog.append('warn', 'cancelled by user');
      } else {
        extractLog.append('err', (err as Error).message);
        setError((err as Error).message);
      }
    } finally {
      activeAbort = null;
      setRunning('none');
    }
  };

  const formatSize = (bytes: number) => {
    if (bytes < 1024) return `${bytes}B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)}kB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
  };

  return (
    <ProcessTab name="Extract" topic="extract" status={status} log={extractLog}>
      <div class="extract-form">
        <label class="field-label" for="pathway-name">
          PATHWAY NAME OR DESCRIPTION
        </label>
        <input
          id="pathway-name"
          class="field mono"
          placeholder='e.g. "classical complement activation"'
          value={project.pathwayName}
          onInput={(e) => setPathwayName(e.currentTarget.value)}
          disabled={project.running !== 'none'}
        />

        <Show when={extractPdfHandles().length === 0}>
          <div class="placeholder">
            add review-article PDFs (max {PDF_CAP})
          </div>
        </Show>
        <Show when={extractPdfHandles().length > 0}>
          <div class="pdf-chips">
            <For each={extractPdfHandles()}>
              {(handle) => <PdfChip handle={handle} formatSize={formatSize} />}
            </For>
          </div>
        </Show>

        <div class="actions">
          <Show
            when={project.running === 'extract'}
            fallback={
              <>
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
                  onClick={onAddPdf}
                  disabled={
                    extractPdfHandles().length >= PDF_CAP ||
                    project.running !== 'none'
                  }
                >
                  + Add PDF
                </button>
                <Show when={extractPdfHandles().length > 0}>
                  <button
                    type="button"
                    class="btn"
                    onClick={() => clearExtractPdfs()}
                  >
                    Clear
                  </button>
                </Show>
                <button
                  type="button"
                  class="btn"
                  onClick={onMockTest}
                  disabled={!canMock()}
                  title="Skip the LLM call and write hand-crafted mock data to the sheet — useful for iterating on sheet-write logic"
                >
                  Test sheet write
                </button>
              </>
            }
          >
            <button type="button" class="btn danger" onClick={onCancel}>
              ✕ Cancel
            </button>
          </Show>
          <span class="progress-hint">
            <Show
              when={project.running === 'extract'}
              fallback={
                <>
                  {extractPdfHandles().length}/{PDF_CAP} PDFs
                  {project.stage !== 'none' && ` · re-run will overwrite sheet`}
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

function PdfChip(props: {
  handle: FileSystemFileHandle;
  formatSize: (bytes: number) => string;
}) {
  const [size, setSize] = createSignal<number | null>(null);
  void props.handle.getFile().then((f) => setSize(f.size));
  return (
    <span class="pdf-chip">
      📄 {props.handle.name}
      <Show when={size() !== null}>
        <span class="pdf-chip-size">· {props.formatSize(size()!)}</span>
      </Show>
      <button
        type="button"
        class="pdf-chip-remove"
        aria-label={`Remove ${props.handle.name}`}
        onClick={() => removeExtractPdf(props.handle.name)}
      >
        ✕
      </button>
    </span>
  );
}
