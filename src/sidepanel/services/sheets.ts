// Google Sheets v4 client. OAuth via chrome.identity.getAuthToken.
// All calls are direct browser fetch — CORS is open on
// sheets.googleapis.com for browser-origin requests with a Bearer token.

const SHEETS_BASE = 'https://sheets.googleapis.com/v4/spreadsheets';

interface AuthTokenResult {
  token?: string;
}

async function getAuthToken(): Promise<string> {
  // Silent attempt first. If the user has already consented in a prior
  // session, this returns a fresh token with no UI.
  try {
    const silent = (await chrome.identity.getAuthToken({
      interactive: false,
    })) as AuthTokenResult | string | undefined;
    const tok = typeof silent === 'string' ? silent : silent?.token;
    if (tok) return tok;
  } catch {
    /* fall through to interactive */
  }
  const interactive = (await chrome.identity.getAuthToken({
    interactive: true,
  })) as AuthTokenResult | string | undefined;
  const tok = typeof interactive === 'string' ? interactive : interactive?.token;
  if (!tok)
    throw new Error(
      'Google OAuth grant denied. Set AICURATOR_OAUTH_CLIENT_ID at build time, ' +
        'or check chrome://extensions for OAuth-related errors on the AICurator extension.',
    );
  return tok;
}

async function authedFetch(
  url: string,
  init: RequestInit = {},
): Promise<Response> {
  const token = await getAuthToken();
  const headers = new Headers(init.headers ?? {});
  headers.set('Authorization', `Bearer ${token}`);
  if (init.body && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }
  return fetch(url, { ...init, headers });
}

async function expectOk(resp: Response, label: string): Promise<void> {
  if (resp.ok) return;
  const text = await resp.text().catch(() => '');
  throw new Error(`${label} ${resp.status}: ${text.slice(0, 200)}`);
}

export interface ValuesUpdate {
  range: string;
  values: string[][];
}

interface SpreadsheetMeta {
  sheets: { properties: { sheetId: number; title: string } }[];
}

// Resolve a numeric gid to its sheet title via spreadsheets.get.
// Required because the Sheets values API addresses sheets by name, not
// by gid — and projects may target any tab in the workbook.
export async function getSheetName(
  spreadsheetId: string,
  gid: string,
): Promise<string> {
  const url =
    `${SHEETS_BASE}/${spreadsheetId}` +
    `?fields=sheets.properties(sheetId,title)`;
  const resp = await authedFetch(url);
  await expectOk(resp, 'Sheets get');
  const json = (await resp.json()) as SpreadsheetMeta;
  const targetGid = parseInt(gid, 10);
  const found = json.sheets?.find((s) => s.properties.sheetId === targetGid);
  if (!found) {
    throw new Error(
      `Sheet with gid=${gid} not found in spreadsheet ${spreadsheetId}. ` +
        `Available gids: ${json.sheets
          ?.map((s) => s.properties.sheetId)
          .join(', ') ?? '(none)'}`,
    );
  }
  return found.properties.title;
}

// Quote a sheet name for use in A1 notation. Always quotes — single
// quotes inside a name are escaped by doubling.
export function quoteSheet(name: string): string {
  return `'${name.replace(/'/g, "''")}'`;
}

export async function getValues(
  spreadsheetId: string,
  range: string,
): Promise<string[][]> {
  const url = `${SHEETS_BASE}/${spreadsheetId}/values/${encodeURIComponent(range)}`;
  const resp = await authedFetch(url);
  await expectOk(resp, 'Sheets get');
  const json = (await resp.json()) as { values?: string[][] };
  return json.values ?? [];
}

export async function batchUpdateValues(
  spreadsheetId: string,
  data: ValuesUpdate[],
): Promise<void> {
  if (data.length === 0) return;
  const url = `${SHEETS_BASE}/${spreadsheetId}/values:batchUpdate`;
  const body = JSON.stringify({
    valueInputOption: 'RAW',
    data,
  });
  const resp = await authedFetch(url, { method: 'POST', body });
  await expectOk(resp, 'Sheets batchUpdate');
}

// Force the next call to re-acquire a token. Use after a 401 if you
// suspect the cached token is invalid.
export async function clearCachedToken(): Promise<void> {
  try {
    const cached = (await chrome.identity.getAuthToken({
      interactive: false,
    })) as AuthTokenResult | string | undefined;
    const tok = typeof cached === 'string' ? cached : cached?.token;
    if (tok) await chrome.identity.removeCachedAuthToken({ token: tok });
  } catch {
    /* no token to clear */
  }
}
