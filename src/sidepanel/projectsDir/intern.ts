// Process-local map from opaque DirToken → FileSystemDirectoryHandle.
//
// The state machine traffics in opaque tokens (testable, no FSA
// dependency). When state reaches `granted` it needs a real handle to
// hand back to downstream code — that's what this map carries. The
// production adapter populates the map when a pick lands or a stored
// handle is rehydrated; tests don't populate it (their state shape
// inspections never reach for state.handle).

import type { DirToken } from './ports';

const MAP = new Map<DirToken, FileSystemDirectoryHandle>();

export function internHandle(
  token: DirToken,
  handle: FileSystemDirectoryHandle,
): void {
  MAP.set(token, handle);
}

export function lookupHandle(
  token: DirToken,
): FileSystemDirectoryHandle | undefined {
  return MAP.get(token);
}

export function forgetHandle(token: DirToken): void {
  MAP.delete(token);
}
