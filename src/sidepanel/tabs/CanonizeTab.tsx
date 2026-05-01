import { createMemo } from 'solid-js';
import ProcessTab, { type RunStatus } from './ProcessTab';
import { canonizeLog } from '../services/log';

// Phase 4 stub. Real Canonize UI (row-range radio) lands in Phase 8.
export default function CanonizeTab() {
  const status = createMemo<RunStatus>(() => 'locked');
  return (
    <ProcessTab
      name="Canonize"
      topic="canonize"
      status={status}
      log={canonizeLog}
    >
      <div class="placeholder">Phase 4 stub — Canonize UI lands in Phase 8.</div>
      <div class="actions">
        <button type="button" class="btn primary" disabled>
          ▶ Start
        </button>
        <span class="progress-hint">locked until Summate completes</span>
      </div>
    </ProcessTab>
  );
}
