import { For, Show, createMemo, createSignal } from 'solid-js';
import ProcessTab, { type BadgeState } from './ProcessTab';
import { extractLog } from '../services/log';
import {
  addExtractPdfs,
  clearExtractPdfs,
  currentApiKey,
  extractPdfHandles,
  project,
  projectList,
  removeExtractPdf,
  rootHandle,
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
import { isAbortError } from '../lib/abortError';

const PDF_CAP = 10;

export default function ExtractTab() {
  const [error, setError] = createSignal<string | null>(null);
  let activeAbort: AbortController | null = null;

  const badge = createMemo<BadgeState | null>(() => {
    if (project.running === 'extract')
      return { kind: 'running', text: 'running…' };
    if (project.selectedName === null)
      return { kind: 'lock', text: 'no project selected' };
    if (project.pathwayName.trim().length === 0)
      return { kind: 'lock', text: 'enter pathway name' };
    if (extractPdfHandles().length === 0)
      return { kind: 'lock', text: 'add at least one PDF' };
    if (currentApiKey().length === 0 || settings.modelName.length === 0)
      return { kind: 'lock', text: 'configure provider in Settings' };
    return null;
  });

  const canStart = () =>
    project.selectedName !== null &&
    project.pathwayName.trim().length > 0 &&
    extractPdfHandles().length >= 1 &&
    project.running === 'none' &&
    currentApiKey().length > 0 &&
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
    // Flip to Cancel synchronously so the user gets immediate feedback and
    // a second click can't stack a duplicate request while pre-flight (the
    // sheet-probe network call) is in flight.
    activeAbort = new AbortController();
    setRunning('extract');
    try {
      const root = rootHandle();
      if (!root || !project.selectedName) return;
      const projectMeta = projectList().find(
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
          apiKey: currentApiKey(),
          modelName: settings.modelName,
        });
      } catch (err) {
        setError((err as Error).message);
        return;
      }

      const projectDir = await root.getDirectoryHandle(project.selectedName);
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
      if (isAbortError(err)) {
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
    activeAbort = new AbortController();
    setRunning('extract');
    try {
      const root = rootHandle();
      if (!root || !project.selectedName) return;
      const projectMeta = projectList().find(
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
      const projectDir = await root.getDirectoryHandle(project.selectedName);
      await runExtractMock({
        spreadsheetId: projectMeta.spreadsheetId,
        gid: projectMeta.gid,
        projectDir,
        log: extractLog,
        signal: activeAbort.signal,
      });
      await setStage('extracted');
    } catch (err) {
      if (isAbortError(err)) {
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
    <ProcessTab name="Extract" topic="extract" badge={badge} log={extractLog}>
      <div class="extract-form">
        <label class="field-label" for="pathway-name">
          PATHWAY NAME OR DESCRIPTION
        </label>
        <input
          id="pathway-name"
          class="field mono"
          placeholder={
            project.selectedName === null
              ? 'select a project first'
              : 'e.g. "classical complement activation"'
          }
          value={project.pathwayName}
          onInput={(e) => setPathwayName(e.currentTarget.value)}
          disabled={project.selectedName === null || project.running !== 'none'}
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
                <Show when={project.selectedName !== null}>
                  <button
                    type="button"
                    class="btn primary"
                    onClick={onStart}
                    disabled={!canStart()}
                  >
                    ▶ Start
                  </button>
                </Show>
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
                <Show when={project.selectedName !== null}>
                  <button
                    type="button"
                    class="btn"
                    onClick={onMockTest}
                    disabled={!canMock()}
                    title="Skip the LLM call and write hand-crafted mock data to the sheet"
                  >
                    Test sheet write
                  </button>
                </Show>
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
