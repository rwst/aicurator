// Create / delete operations on a project subdirectory.
//
// These take the granted root handle as input — they are concerned with
// file-tree mutations, not the directory grant lifecycle (which lives
// in src/sidepanel/projectsDir/).

import {
  newMagicFile,
  writeMagicFile,
  type MagicFile,
} from './magicFile';
import type { ParsedSheetUrl } from './sheetUrl';

export async function createProject(
  rootDir: FileSystemDirectoryHandle,
  name: string,
  sheet: ParsedSheetUrl,
): Promise<MagicFile> {
  // Refuse if subdir already exists.
  let exists = false;
  try {
    await rootDir.getDirectoryHandle(name);
    exists = true;
  } catch {
    /* not present, proceed */
  }
  if (exists) throw new Error(`Project "${name}" already exists`);

  const projectDir = await rootDir.getDirectoryHandle(name, { create: true });
  await projectDir.getDirectoryHandle('PDF', { create: true });

  const magic = newMagicFile(sheet);
  await writeMagicFile(projectDir, magic);
  return magic;
}

export async function deleteProject(
  rootDir: FileSystemDirectoryHandle,
  name: string,
): Promise<void> {
  await rootDir.removeEntry(name, { recursive: true });
}
