// Lists PMID-prefixed PDFs in <project>/PDF/. The merged pmid-tagger
// (Phase 9) writes files matching PMID-<id>_*.pdf into this directory;
// we glob-by-PMID for Summate's per-row PDF lookup.

const PMID_FILE_RE = /^PMID-(\d{4,9})_/;

export async function listPmidPdfs(
  projectDir: FileSystemDirectoryHandle,
): Promise<Map<string, FileSystemFileHandle>> {
  const map = new Map<string, FileSystemFileHandle>();
  let pdfDir: FileSystemDirectoryHandle;
  try {
    pdfDir = await projectDir.getDirectoryHandle('PDF');
  } catch {
    // PDF/ doesn't exist yet (e.g. project freshly created)
    return map;
  }
  for await (const entry of pdfDir.values()) {
    if (entry.kind !== 'file') continue;
    const m = PMID_FILE_RE.exec(entry.name);
    if (!m) continue;
    // First-by-iteration wins. The FS Access API doesn't guarantee
    // ordering, but pmid-tagger uses conflictAction:'uniquify' so
    // duplicates are e.g. "PMID-123_foo.pdf" and "PMID-123_foo (1).pdf".
    if (!map.has(m[1])) map.set(m[1], entry);
  }
  return map;
}

// Watch for downloads completing. The merged pmid-tagger runs in the
// service worker; the panel subscribes here to react with chip flips.
// Returns a teardown.
export function watchDownloads(onComplete: () => void): () => void {
  const handler = (delta: chrome.downloads.DownloadDelta) => {
    if (delta.state?.current === 'complete') onComplete();
  };
  chrome.downloads.onChanged.addListener(handler);
  return () => chrome.downloads.onChanged.removeListener(handler);
}

// Extract a PMID from a PMID-prefixed filename. Returns null on no match.
export function pmidFromFilename(name: string): string | null {
  const m = PMID_FILE_RE.exec(name);
  return m ? m[1] : null;
}
