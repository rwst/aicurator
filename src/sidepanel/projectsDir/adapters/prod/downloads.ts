// Production DownloadsPort adapter: chrome.downloads.download.
//
// Defensive: empty data: URLs crash the renderer (chrome-issues.md §2),
// so we reject before calling.

import type { DownloadsPort } from '../..';

const EMPTY_DATA_URLS = new Set([
  'data:',
  'data:,',
  'data:text/plain,',
  'data:text/plain;base64,',
  'data:application/octet-stream;base64,',
]);

export function createDownloadsProdAdapter(): DownloadsPort {
  return {
    async downloadDataUrl({ url, filename }): Promise<number> {
      if (!url.startsWith('data:')) {
        throw new Error(`downloadDataUrl: expected data: URL, got ${url}`);
      }
      if (EMPTY_DATA_URLS.has(url)) {
        throw new Error('downloadDataUrl: refusing empty data: URL');
      }
      return await new Promise<number>((resolve, reject) => {
        chrome.downloads.download(
          {
            url,
            filename,
            conflictAction: 'uniquify',
            saveAs: false,
          },
          (downloadId) => {
            if (chrome.runtime.lastError) {
              reject(new Error(chrome.runtime.lastError.message));
            } else if (downloadId === undefined) {
              reject(new Error('downloads.download() returned no id'));
            } else {
              resolve(downloadId);
            }
          },
        );
      });
    },
  };
}
