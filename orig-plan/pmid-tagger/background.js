// Reactome PMID Tagger — service worker.
//
// Tracks per-tab PMID context: a tab is "tagged" with a PMID once it visits
// either pubmed.ncbi.nlm.nih.gov/<PMID>/ or a PMC article page (PMID is read
// from PMC page DOM by content.js and reported via runtime message). The tag
// persists across navigations within that tab (PubMed/PMC → publisher → PDF)
// and propagates to child tabs opened from the tagged tab. On any PDF download
// whose referrer matches a tagged tab's current URL, the filename is prefixed
// with PMID-<id>_.

const PUBMED_RE = /^https?:\/\/pubmed\.ncbi\.nlm\.nih\.gov\/(\d+)\/?/;
const PMC_PMID_URL_RE = /^https?:\/\/pmc\.ncbi\.nlm\.nih\.gov\/articles\/pmid\/(\d+)/;

// In-memory state, mirrored to chrome.storage.session for service-worker resilience.
const tabPmid = {};   // tabId -> "12345678"
const tabUrls = {};   // tabId -> last known URL

chrome.storage.session.get(['tabPmid', 'tabUrls']).then(stored => {
  if (stored.tabPmid) Object.assign(tabPmid, stored.tabPmid);
  if (stored.tabUrls) Object.assign(tabUrls, stored.tabUrls);
});

function persist() {
  chrome.storage.session.set({ tabPmid, tabUrls });
}

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (!changeInfo.url) return;
  tabUrls[tabId] = changeInfo.url;
  const m = changeInfo.url.match(PUBMED_RE) || changeInfo.url.match(PMC_PMID_URL_RE);
  if (m) {
    tabPmid[tabId] = m[1];
    console.log(`[pmid-tagger] tab ${tabId} tagged with PMID ${m[1]} from URL`);
  }
  persist();
});

chrome.runtime.onMessage.addListener((msg, sender) => {
  if (!msg || msg.type !== 'pmc-pmid' || !msg.pmid || !sender.tab) return;
  const tabId = sender.tab.id;
  if (tabPmid[tabId] !== msg.pmid) {
    tabPmid[tabId] = msg.pmid;
    console.log(`[pmid-tagger] tab ${tabId} tagged with PMID ${msg.pmid} from PMC page`);
    persist();
  }
});

chrome.tabs.onCreated.addListener((tab) => {
  if (tab.openerTabId && tabPmid[tab.openerTabId]) {
    tabPmid[tab.id] = tabPmid[tab.openerTabId];
    console.log(`[pmid-tagger] tab ${tab.id} inherited PMID ${tabPmid[tab.id]} from opener ${tab.openerTabId}`);
    persist();
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  delete tabPmid[tabId];
  delete tabUrls[tabId];
  persist();
});

function findPmidForReferrer(referrer) {
  if (!referrer) return null;
  // Exact-URL or prefix match against any tracked tab's current URL.
  for (const [tabId, url] of Object.entries(tabUrls)) {
    if (url && (url === referrer || url.startsWith(referrer))) {
      const pmid = tabPmid[tabId];
      if (pmid) return pmid;
    }
  }
  // Direct hit: download initiated on a PubMed page itself.
  const m = referrer.match(PUBMED_RE);
  if (m) return m[1];
  return null;
}

chrome.downloads.onDeterminingFilename.addListener((item, suggest) => {
  const lower = (item.filename || '').toLowerCase();
  const isPdf = item.mime === 'application/pdf' ||
                lower.endsWith('.pdf') ||
                (item.url || '').toLowerCase().endsWith('.pdf') ||
                (item.finalUrl || '').toLowerCase().endsWith('.pdf');
  if (!isPdf) {
    suggest();
    return;
  }
  const pmid = findPmidForReferrer(item.referrer || item.url);
  if (!pmid) {
    console.log(`[pmid-tagger] no PMID context for download (referrer=${item.referrer || '-'}); leaving filename unchanged`);
    suggest();
    return;
  }
  const base = (item.filename || 'download.pdf').split('/').pop().split('\\').pop();
  const newName = `PMID-${pmid}_${base}`;
  console.log(`[pmid-tagger] PMID ${pmid} → ${newName}`);
  suggest({ filename: newName, conflictAction: 'uniquify' });
});
