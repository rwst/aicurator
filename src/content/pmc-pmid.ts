// Content script for https://pmc.ncbi.nlm.nih.gov/articles/* — extracts
// the article's PMID and posts it to the service worker so the tab gets
// tagged for downstream PDF download routing.
//
// Ported from orig-plan/pmid-tagger/content.js.

(() => {
  let pmid: string | null = null;

  for (const name of ['ncbi_uid', 'citation_pmid'] as const) {
    const el = document.querySelector<HTMLMetaElement>(
      `meta[name="${name}"]`,
    );
    if (el && /^\d{4,9}$/.test(el.content ?? '')) {
      pmid = el.content;
      break;
    }
  }

  if (!pmid && document.body) {
    const m = /\bPMID:?\s*(\d{4,9})\b/.exec(document.body.innerText);
    if (m) pmid = m[1];
  }

  if (pmid) {
    chrome.runtime.sendMessage({ type: 'pmc-pmid', pmid }).catch(() => {
      /* worker may be in cold-start; safe to drop */
    });
  }
})();
