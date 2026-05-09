// Google Sheets URL parsing + active-tab capture.
//
// These helpers are unrelated to the projects-directory state machine —
// they were colocated in the old services/projectsDir.ts only because
// they were both touched by the Main tab.

import type { ProjectMeta } from '../projectsDir';

export interface ParsedSheetUrl {
  spreadsheetId: string;
  gid: string;
  sheetUrl: string;
}

const SHEET_URL_RE =
  /^https:\/\/docs\.google\.com\/spreadsheets\/d\/([A-Za-z0-9_-]+)\/edit(?:[?#].*?(?:gid=(\d+)))?/;

export function parseSheetUrl(url: string): ParsedSheetUrl | null {
  const m = url.match(SHEET_URL_RE);
  if (!m) return null;
  return {
    spreadsheetId: m[1],
    gid: m[2] ?? '0',
    sheetUrl: url,
  };
}

export async function getActiveTabSheetUrl(): Promise<ParsedSheetUrl | null> {
  const tabs = await chrome.tabs.query({
    active: true,
    currentWindow: true,
  });
  const url = tabs[0]?.url;
  if (!url) return null;
  return parseSheetUrl(url);
}

export function findProjectByExactSheet(
  list: readonly ProjectMeta[],
  parsed: ParsedSheetUrl,
): ProjectMeta | null {
  return (
    list.find(
      (p) => p.spreadsheetId === parsed.spreadsheetId && p.gid === parsed.gid,
    ) ?? null
  );
}
