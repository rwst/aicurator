// .aicurator.json read/write with shape validation.
// Versioning per plan §0: we accept exactly the versions in ACCEPTED_VERSIONS.

export const MAGIC_FILE_NAME = '.aicurator.json';
const CURRENT_VERSION = 'v2601';
const ACCEPTED_VERSIONS: ReadonlySet<string> = new Set([CURRENT_VERSION]);

export type Stage = 'none' | 'extracted' | 'summated' | 'canonized';

export interface MagicFile {
  version: string;
  spreadsheetId: string;
  gid: string;
  sheetUrl: string;
  pathwayName: string;
  stage: Stage;
  createdAt: string;
  updatedAt: string;
}

function isStage(v: unknown): v is Stage {
  return (
    v === 'none' || v === 'extracted' || v === 'summated' || v === 'canonized'
  );
}

function validate(parsed: unknown): MagicFile | null {
  if (!parsed || typeof parsed !== 'object') return null;
  const o = parsed as Record<string, unknown>;
  if (typeof o.version !== 'string' || !ACCEPTED_VERSIONS.has(o.version))
    return null;
  if (typeof o.spreadsheetId !== 'string' || !o.spreadsheetId) return null;
  if (typeof o.gid !== 'string') return null;
  if (typeof o.sheetUrl !== 'string') return null;
  if (typeof o.pathwayName !== 'string') return null;
  if (!isStage(o.stage)) return null;
  if (typeof o.createdAt !== 'string') return null;
  if (typeof o.updatedAt !== 'string') return null;
  return {
    version: o.version,
    spreadsheetId: o.spreadsheetId,
    gid: o.gid,
    sheetUrl: o.sheetUrl,
    pathwayName: o.pathwayName,
    stage: o.stage,
    createdAt: o.createdAt,
    updatedAt: o.updatedAt,
  };
}

export async function readMagicFile(
  projectDir: FileSystemDirectoryHandle,
): Promise<MagicFile | null> {
  let fileHandle: FileSystemFileHandle;
  try {
    fileHandle = await projectDir.getFileHandle(MAGIC_FILE_NAME);
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

export async function writeMagicFile(
  projectDir: FileSystemDirectoryHandle,
  data: MagicFile,
): Promise<void> {
  const fileHandle = await projectDir.getFileHandle(MAGIC_FILE_NAME, {
    create: true,
  });
  const writable = await fileHandle.createWritable();
  await writable.write(JSON.stringify(data, null, 2));
  await writable.close();
}

export function newMagicFile(opts: {
  spreadsheetId: string;
  gid: string;
  sheetUrl: string;
}): MagicFile {
  const now = new Date().toISOString();
  return {
    version: CURRENT_VERSION,
    spreadsheetId: opts.spreadsheetId,
    gid: opts.gid,
    sheetUrl: opts.sheetUrl,
    pathwayName: '',
    stage: 'none',
    createdAt: now,
    updatedAt: now,
  };
}
