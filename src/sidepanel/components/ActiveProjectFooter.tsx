import { Show } from 'solid-js';
import { activeSheetMatch, project, setSelectedProject } from '../store';

// Footer pinned below the four tab buttons in the left strip.
// Shows the currently-selected project's name and, when the focused
// Chrome tab is a Sheets URL pointing to a different project, an
// explicit "Switch to: <project>" button.

export default function ActiveProjectFooter() {
  const showSwitch = () =>
    activeSheetMatch() !== null && activeSheetMatch() !== project.selectedName;

  return (
    <div class="active-project-footer">
      <span class="apf-label">PROJECT</span>
      <span
        class="apf-name"
        title={project.selectedName ?? '(none)'}
      >
        {project.selectedName ?? '—'}
      </span>
      <Show when={showSwitch()}>
        <button
          type="button"
          class="apf-switch"
          onClick={() => void setSelectedProject(activeSheetMatch())}
          title={`Switch to ${activeSheetMatch()}`}
        >
          <span class="apf-switch-label">Switch to:</span>
          <span class="apf-switch-target">{activeSheetMatch()}</span>
        </button>
      </Show>
    </div>
  );
}
