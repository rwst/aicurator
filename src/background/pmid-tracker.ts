// Pure logic for pmid-tagger. Ported from orig-plan/pmid-tagger/background.js.
// The service worker holds a TagState in memory + chrome.storage.session
// for resilience across worker suspension.

const PUBMED_RE = /^https?:\/\/pubmed\.ncbi\.nlm\.nih\.gov\/(\d+)\/?/;
const PMC_PMID_URL_RE =
  /^https?:\/\/pmc\.ncbi\.nlm\.nih\.gov\/articles\/pmid\/(\d+)/;

export interface TagState {
  tabPmid: Record<number, string>;
  tabUrls: Record<number, string>;
}

export function pmidFromUrl(url: string): string | null {
  const m = PUBMED_RE.exec(url) ?? PMC_PMID_URL_RE.exec(url);
  return m ? m[1] : null;
}

// Match a download's referrer against the live tab tracking map. Try
// (a) exact / prefix match against tracked tab URLs; (b) direct PubMed
// URL embedded in the referrer.
export function findPmidForReferrer(
  state: TagState,
  referrer: string | undefined,
): string | null {
  if (!referrer) return null;
  for (const [tabIdStr, url] of Object.entries(state.tabUrls)) {
    if (!url) continue;
    if (url === referrer || url.startsWith(referrer)) {
      const pmid = state.tabPmid[Number(tabIdStr)];
      if (pmid) return pmid;
    }
  }
  const m = PUBMED_RE.exec(referrer);
  return m ? m[1] : null;
}

export function isPdfDownload(item: chrome.downloads.DownloadItem): boolean {
  const lower = (item.filename ?? '').toLowerCase();
  return (
    item.mime === 'application/pdf' ||
    lower.endsWith('.pdf') ||
    (item.url ?? '').toLowerCase().endsWith('.pdf') ||
    (item.finalUrl ?? '').toLowerCase().endsWith('.pdf')
  );
}

export function basenameOf(filename: string): string {
  return filename.split('/').pop()!.split('\\').pop() ?? filename;
}
