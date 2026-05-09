import { Match, Switch, createSignal, onCleanup, onMount } from 'solid-js';
import TabStrip, { type TabIndex } from './components/TabStrip';
import ActiveProjectFooter from './components/ActiveProjectFooter';
import InstanceGuard from './components/InstanceGuard';
import MainTab from './tabs/MainTab';
import ExtractTab from './tabs/ExtractTab';
import SummateTab from './tabs/SummateTab';
import CanonizeTab from './tabs/CanonizeTab';
import {
  hydrateSettings,
  projectsDir,
  refreshActiveSheetMatch,
  subscribeToStorageChanges,
} from './store';
import { hydrateAllLogs } from './services/log';

export default function App() {
  const [activeTab, setActiveTab] = createSignal<TabIndex>(0);

  // All tabs always enabled — within-tab gating handles unmet preconditions
  // (hidden actions + locked-with-reason badge).
  const isEnabled = (_idx: TabIndex) => true;

  onMount(() => {
    subscribeToStorageChanges();
    void hydrateSettings();
    void hydrateAllLogs();
    void (async () => {
      await projectsDir.ready();
      await refreshActiveSheetMatch();
    })();

    const refresh = () => {
      void refreshActiveSheetMatch();
    };
    const onTabUpdated = (
      _tabId: number,
      changeInfo: { url?: string },
      tab: chrome.tabs.Tab,
    ) => {
      if (!changeInfo.url || !tab.active) return;
      refresh();
    };
    chrome.tabs.onActivated.addListener(refresh);
    chrome.tabs.onUpdated.addListener(onTabUpdated);
    onCleanup(() => {
      chrome.tabs.onActivated.removeListener(refresh);
      chrome.tabs.onUpdated.removeListener(onTabUpdated);
    });
  });

  return (
    <InstanceGuard>
      <div class="panel" aria-label="AICurator side panel">
        <div class="tabs-column">
          <TabStrip
            activeTab={activeTab}
            isEnabled={isEnabled}
            onSelect={setActiveTab}
          />
          <ActiveProjectFooter />
        </div>
        <section class="content">
          <Switch>
            <Match when={activeTab() === 0}>
              <MainTab />
            </Match>
            <Match when={activeTab() === 1}>
              <ExtractTab />
            </Match>
            <Match when={activeTab() === 2}>
              <SummateTab />
            </Match>
            <Match when={activeTab() === 3}>
              <CanonizeTab />
            </Match>
          </Switch>
        </section>
      </div>
    </InstanceGuard>
  );
}
