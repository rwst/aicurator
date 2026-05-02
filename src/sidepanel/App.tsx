import { Match, Switch, createSignal, onMount } from 'solid-js';
import TabStrip, { type TabIndex } from './components/TabStrip';
import InstanceGuard from './components/InstanceGuard';
import MainTab from './tabs/MainTab';
import ExtractTab from './tabs/ExtractTab';
import SummateTab from './tabs/SummateTab';
import CanonizeTab from './tabs/CanonizeTab';
import {
  hydrateProjectsDir,
  hydrateSettings,
  project,
  subscribeToStorageChanges,
} from './store';
import { hydrateAllLogs } from './services/log';

export default function App() {
  const [activeTab, setActiveTab] = createSignal<TabIndex>(0);

  const isEnabled = (idx: TabIndex) => {
    if (idx === 0) return true;
    if (idx === 1) return project.selectedName !== null;
    if (idx === 2)
      return (
        project.stage === 'extracted' ||
        project.stage === 'summated' ||
        project.stage === 'canonized'
      );
    if (idx === 3)
      return project.stage === 'summated' || project.stage === 'canonized';
    return false;
  };

  // If the active tab becomes disabled (e.g. project deleted), fall back
  // to Main so we don't render a locked tab.
  const onSelect = (idx: TabIndex) => {
    if (isEnabled(idx)) setActiveTab(idx);
  };

  onMount(() => {
    subscribeToStorageChanges();
    void hydrateSettings();
    void hydrateProjectsDir();
    void hydrateAllLogs();
  });

  return (
    <InstanceGuard>
      <div class="panel" aria-label="AICurator side panel">
        <TabStrip
          activeTab={activeTab}
          isEnabled={isEnabled}
          onSelect={onSelect}
        />
        <section class="content">
          <Switch>
            <Match when={activeTab() === 0}>
              <MainTab />
            </Match>
            <Match when={activeTab() === 1 && isEnabled(1)}>
              <ExtractTab />
            </Match>
            <Match when={activeTab() === 2 && isEnabled(2)}>
              <SummateTab />
            </Match>
            <Match when={activeTab() === 3 && isEnabled(3)}>
              <CanonizeTab />
            </Match>
          </Switch>
        </section>
      </div>
    </InstanceGuard>
  );
}
