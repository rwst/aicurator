import { createSignal, onMount } from 'solid-js';
import TabStrip, { type TabIndex } from './components/TabStrip';
import InstanceGuard from './components/InstanceGuard';
import MainTab from './tabs/MainTab';
import {
  hydrateProjectsDir,
  hydrateSettings,
  subscribeToStorageChanges,
} from './store';

export default function App() {
  const [activeTab, setActiveTab] = createSignal<TabIndex>(0);

  // Phase 2: only Main is enabled. Phase 3+ wires project state.
  const isEnabled = (idx: TabIndex) => idx === 0;

  onMount(() => {
    subscribeToStorageChanges();
    void hydrateSettings();
    void hydrateProjectsDir();
  });

  return (
    <InstanceGuard>
      <div class="panel" aria-label="AICurator side panel">
        <TabStrip
          activeTab={activeTab}
          isEnabled={isEnabled}
          onSelect={setActiveTab}
        />
        <section class="content">
          {activeTab() === 0 && <MainTab />}
          {/* process tabs land in Phase 4 */}
        </section>
      </div>
    </InstanceGuard>
  );
}
