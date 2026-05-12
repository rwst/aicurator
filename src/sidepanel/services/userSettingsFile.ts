// .aicurator-settings.json read/write at the root of the granted
// aicurator directory. Holds the currently-selected provider and the
// per-provider model names — so a user's "I picked Anthropic with model
// claude-opus-4-7, OpenAI with gpt-5-mini" preferences live alongside
// their projects rather than in chrome.storage.sync. API keys stay in
// chrome.storage.local (they are local secrets, not workflow state).

import { PROVIDERS, type Provider } from '../store/providers';

export const USER_SETTINGS_FILE_NAME = '.aicurator-settings.json';
const CURRENT_VERSION = 'v2609';
const ACCEPTED_VERSIONS: ReadonlySet<string> = new Set([CURRENT_VERSION]);

export interface UserSettingsFile {
  version: string;
  provider: Provider;
  modelNames: Record<Provider, string>;
}

function isProvider(v: unknown): v is Provider {
  return typeof v === 'string' && (PROVIDERS as readonly string[]).includes(v);
}

function validate(parsed: unknown): UserSettingsFile | null {
  if (!parsed || typeof parsed !== 'object') return null;
  const o = parsed as Record<string, unknown>;
  if (typeof o.version !== 'string' || !ACCEPTED_VERSIONS.has(o.version))
    return null;
  if (!isProvider(o.provider)) return null;
  if (!o.modelNames || typeof o.modelNames !== 'object') return null;
  const src = o.modelNames as Record<string, unknown>;
  const modelNames = {} as Record<Provider, string>;
  for (const p of PROVIDERS) {
    const v = src[p];
    modelNames[p] = typeof v === 'string' ? v : '';
  }
  return { version: o.version, provider: o.provider, modelNames };
}

export function emptyUserSettings(): UserSettingsFile {
  return {
    version: CURRENT_VERSION,
    provider: 'Anthropic',
    modelNames: {
      Anthropic: '',
      OpenAI: '',
      OpenRouter: '',
      Google: '',
    },
  };
}

export async function readUserSettingsFile(
  rootDir: FileSystemDirectoryHandle,
): Promise<UserSettingsFile | null> {
  let fileHandle: FileSystemFileHandle;
  try {
    fileHandle = await rootDir.getFileHandle(USER_SETTINGS_FILE_NAME);
  } catch {
    return null;
  }
  const file = await fileHandle.getFile();
  const text = await file.text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  return validate(parsed);
}

export async function writeUserSettingsFile(
  rootDir: FileSystemDirectoryHandle,
  data: UserSettingsFile,
): Promise<void> {
  const fileHandle = await rootDir.getFileHandle(USER_SETTINGS_FILE_NAME, {
    create: true,
  });
  const writable = await fileHandle.createWritable();
  await writable.write(JSON.stringify(data, null, 2));
  await writable.close();
}
