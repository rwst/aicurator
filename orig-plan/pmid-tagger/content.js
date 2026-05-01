// Runs on PMC article pages. Extracts the PMID from page metadata or
// visible text and reports it to the background service worker, which
// tags the tab so subsequent downloads in this tab carry the PMID prefix.

(function () {
  let pmid = null;

  // Preferred: meta tags placed by PMC for citation tools.
  for (const name of ['ncbi_uid', 'citation_pmid']) {
    const el = document.querySelector(`meta[name="${name}"]`);
    if (el && /^\d{4,9}$/.test(el.content || '')) {
      pmid = el.content;
      break;
    }
  }

  // Fallback: visible text. PMC article header always renders "PMID: 12345678".
  if (!pmid && document.body) {
    const m = document.body.innerText.match(/\bPMID:?\s*(\d{4,9})\b/);
    if (m) pmid = m[1];
  }

  if (pmid) {
    chrome.runtime.sendMessage({ type: 'pmc-pmid', pmid });
  }
})();
