import { createMemo } from 'solid-js';
import ProcessTab, { type RunStatus } from './ProcessTab';
import { summateLog } from '../services/log';

// Phase 4 stub. Real Summate UI (row-range radio, PDF chips, etc.)
// lands in Phase 7.
export default function SummateTab() {
  // Phase 4: stage tracking not wired yet, so always locked.
  const status = createMemo<RunStatus>(() => 'locked');
  return (
    <ProcessTab name="Summate" topic="summate" status={status} log={summateLog}>
      <div class="placeholder">Phase 4 stub — Summate UI lands in Phase 7.</div>
      <div class="actions">
        <button type="button" class="btn primary" disabled>
          ▶ Start
        </button>
        <span class="progress-hint">locked until Extract completes</span>
      </div>
    </ProcessTab>
  );
}
