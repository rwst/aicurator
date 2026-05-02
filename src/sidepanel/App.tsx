import { Match, Switch, createSignal, onCleanup, onMount } from 'solid-js';
import TabStrip, { type TabIndex } from './components/TabStrip';
import InstanceGuard from './components/InstanceGuard';
import MainTab from './tabs/MainTab';
import ExtractTab from './tabs/ExtractTab';
import SummateTab from './tabs/SummateTab';
import CanonizeTab from './tabs/CanonizeTab';
import {
  detectActiveSheetMatch,
  hydrateProjectsDir,
  hydrateSettings,
  liveTrackTabChange,
  subscribeToStorageChanges,
} from './store';
import { hydrateAllLogs } from './services/log';

export default function App() {
  const [activeTab, setActiveTab] = createSignal<TabIndex>(0);

  // All tabs always enabled per the redesign — within-tab UI hides Start
  // when prerequisites aren't met.
  const isEnabled = (_idx: TabIndex) => true;

  onMount(() => {
    subscribeToStorageChanges();
    void hydrateSettings();
    void hydrateAllLogs();
    void (async () => {
      await hydrateProjectsDir();
      await detectActiveSheetMatch();
    })();

    const onTabActivated = () => {
      void liveTrackTabChange();
    };
    const onTabUpdated = (
      _tabId: number,
      changeInfo: { url?: string },
      tab: chrome.tabs.Tab,
    ) => {
      if (!changeInfo.url || !tab.active) return;
      void liveTrackTabChange();
    };
    chrome.tabs.onActivated.addListener(onTabActivated);
    chrome.tabs.onUpdated.addListener(onTabUpdated);
    onCleanup(() => {
      chrome.tabs.onActivated.removeListener(onTabActivated);
      chrome.tabs.onUpdated.removeListener(onTabUpdated);
    });
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
