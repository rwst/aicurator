import { createMemo } from 'solid-js';
import ProcessTab, { type RunStatus } from './ProcessTab';
import { extractLog } from '../services/log';
import { project } from '../store';

// Phase 4 stub. Real Extract UI (pathway-name input, PDF chips, etc.)
// lands in Phase 6.
export default function ExtractTab() {
  const status = createMemo<RunStatus>(() =>
    project.selectedName === null ? 'locked' : 'ready',
  );

  const onTestLine = () =>
    extractLog.append('info', `mock log line at ${new Date().toISOString()}`);
  const onTestBurst = () => {
    for (let i = 0; i < 100; i += 1) {
      extractLog.append('info', `burst line ${i + 1}/100`);
    }
  };
  const onTestLevels = () => {
    extractLog.append('init', 'process initialized');
    extractLog.append('info', 'reading source directory…');
    extractLog.append('ok', '14 files indexed');
    extractLog.append('warn', 'rate limit at 78%');
    extractLog.append('err', 'sample error message');
  };

  return (
    <ProcessTab name="Extract" topic="extract" status={status} log={extractLog}>
      <div class="placeholder">
        Phase 4 stub — Extract controls land in Phase 6.
      </div>
      <div class="actions">
        <button type="button" class="btn primary" disabled>
          ▶ Start
        </button>
        <button type="button" class="btn" onClick={onTestLine}>
          + 1 line
        </button>
        <button type="button" class="btn" onClick={onTestLevels}>
          + 5 levels
        </button>
        <button type="button" class="btn" onClick={onTestBurst}>
          + 100 burst
        </button>
        <span class="progress-hint">Phase 4 demo</span>
      </div>
    </ProcessTab>
  );
}
