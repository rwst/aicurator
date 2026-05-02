// AICurator service worker. Owns:
//   - chrome.sidePanel.setPanelBehavior (open on action click)
//   - merged pmid-tagger logic (tab-PMID tracking + download routing)
//   - active-project routing for downloads (writes into
//     <Downloads>/aicurator/<project>/PDF/)

import {
  basenameOf,
  findPmidForReferrer,
  isPdfDownload,
  pmidFromUrl,
  type TagState,
} from './pmid-tracker';

// ── Side panel behavior ──────────────────────────────────
chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel
    .setPanelBehavior({ openPanelOnActionClick: true })
    .catch((err) => console.error('[aicurator] setPanelBehavior failed:', err));
});

// ── Tag state (in-memory, mirrored to session for SW resilience) ──
const tabPmid: Record<number, string> = {};
const tabUrls: Record<number, string> = {};

void chrome.storage.session.get(['tabPmid', 'tabUrls']).then((stored) => {
  if (stored.tabPmid) Object.assign(tabPmid, stored.tabPmid);
  if (stored.tabUrls) Object.assign(tabUrls, stored.tabUrls);
});

function persist(): void {
  void chrome.storage.session.set({ tabPmid, tabUrls });
}

// ── Active-project cache ─────────────────────────────────
// Read once at boot, then updated reactively via storage.onChanged.
let activeProject: string | undefined;

void chrome.storage.local.get('activeProject').then((stored) => {
  if (typeof stored.activeProject === 'string' && stored.activeProject) {
    activeProject = stored.activeProject;
  }
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (!('activeProject' in changes)) return;
  const next = changes.activeProject.newValue;
  activeProject = typeof next === 'string' && next ? next : undefined;
});

// ── Tab tracking ─────────────────────────────────────────
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (!changeInfo.url) return;
  tabUrls[tabId] = changeInfo.url;
  const pmid = pmidFromUrl(changeInfo.url);
  if (pmid) {
    tabPmid[tabId] = pmid;
    console.log(`[aicurator] tab ${tabId} tagged with PMID ${pmid} from URL`);
  }
  persist();
});

chrome.runtime.onMessage.addListener((msg, sender) => {
  if (!msg || msg.type !== 'pmc-pmid' || !msg.pmid || !sender.tab) return;
  const tabId = sender.tab.id;
  if (typeof tabId !== 'number') return;
  if (tabPmid[tabId] !== msg.pmid) {
    tabPmid[tabId] = msg.pmid;
    console.log(
      `[aicurator] tab ${tabId} tagged with PMID ${msg.pmid} from PMC content script`,
    );
    persist();
  }
});

chrome.tabs.onCreated.addListener((tab) => {
  if (
    typeof tab.openerTabId === 'number' &&
    tabPmid[tab.openerTabId] &&
    typeof tab.id === 'number'
  ) {
    tabPmid[tab.id] = tabPmid[tab.openerTabId];
    console.log(
      `[aicurator] tab ${tab.id} inherited PMID ${tabPmid[tab.id]} from opener ${tab.openerTabId}`,
    );
    persist();
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  delete tabPmid[tabId];
  delete tabUrls[tabId];
  persist();
});

// ── Download routing ─────────────────────────────────────
// PDF downloads with a tagged referrer get routed to
// <Downloads>/aicurator/<active-project>/PDF/PMID-<id>_<basename>.pdf.
// If the active project is unknown, we fall back to the original
// pmid-tagger behavior: prefix the basename in the user's Downloads
// root, and let the curator move it manually.
chrome.downloads.onDeterminingFilename.addListener((item, suggest) => {
  if (!isPdfDownload(item)) {
    suggest();
    return;
  }
  const state: TagState = { tabPmid, tabUrls };
  const pmid = findPmidForReferrer(state, item.referrer || item.url);
  if (!pmid) {
    console.log(
      `[aicurator] no PMID context for download (referrer=${item.referrer || '-'}); leaving filename unchanged`,
    );
    suggest();
    return;
  }
  const base = basenameOf(item.filename || 'download.pdf');
  const prefixed = `PMID-${pmid}_${base}`;
  const targetPath = activeProject
    ? `aicurator/${activeProject}/PDF/${prefixed}`
    : prefixed;
  console.log(`[aicurator] PMID ${pmid} → ${targetPath}`);
  suggest({ filename: targetPath, conflictAction: 'uniquify' });
});
