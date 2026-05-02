// AbortController abort detection. `signal.throwIfAborted()` raises a
// DOMException named "AbortError"; we want to re-bubble those up to the
// tab handler without swallowing them or treating them as run failures.

export function isAbortError(err: unknown): boolean {
  return err instanceof Error && err.name === 'AbortError';
}
