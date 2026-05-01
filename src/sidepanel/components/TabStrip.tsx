import { For, type Accessor } from 'solid-js';

export type TabIndex = 0 | 1 | 2 | 3;

interface TabDef {
  index: TabIndex;
  label: string;
}

const TABS: readonly TabDef[] = [
  { index: 0, label: 'Main' },
  { index: 1, label: 'Extract' },
  { index: 2, label: 'Summate' },
  { index: 3, label: 'Canonize' },
] as const;

interface TabStripProps {
  activeTab: Accessor<TabIndex>;
  isEnabled: (idx: TabIndex) => boolean;
  onSelect: (idx: TabIndex) => void;
}

export default function TabStrip(props: TabStripProps) {
  const enabledIndices = (): TabIndex[] =>
    TABS.filter((t) => props.isEnabled(t.index)).map((t) => t.index);

  const moveFocus = (delta: 1 | -1) => {
    const enabled = enabledIndices();
    if (enabled.length === 0) return;
    const cur = enabled.indexOf(props.activeTab());
    const next = enabled[(cur + delta + enabled.length) % enabled.length];
    props.onSelect(next);
    // Move DOM focus to the now-active tab so screen readers and visible
    // focus rings track the change.
    queueMicrotask(() => {
      const el = document.querySelector<HTMLButtonElement>(
        `.tabs .tab[data-tab="${next}"]`,
      );
      el?.focus();
    });
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      moveFocus(1);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      moveFocus(-1);
    }
  };

  return (
    <nav
      class="tabs"
      role="tablist"
      aria-orientation="vertical"
      onKeyDown={onKeyDown}
    >
      <For each={TABS}>
        {(tab) => {
          const enabled = () => props.isEnabled(tab.index);
          const active = () => props.activeTab() === tab.index;
          return (
            <button
              type="button"
              class="tab"
              classList={{ active: active() }}
              data-tab={tab.index}
              role="tab"
              aria-selected={active()}
              tabindex={active() ? 0 : -1}
              disabled={!enabled()}
              onClick={() => enabled() && props.onSelect(tab.index)}
            >
              {tab.label}
              {!enabled() && <span class="lock">🔒</span>}
            </button>
          );
        }}
      </For>
    </nav>
  );
}
