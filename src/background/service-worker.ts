// AICurator service worker — Phase 0 stub.
// Phase 9 will add merged pmid-tagger logic and download routing.

chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel
    .setPanelBehavior({ openPanelOnActionClick: true })
    .catch((err) => console.error('[aicurator] setPanelBehavior failed:', err));
});
