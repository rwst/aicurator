// Thin promise wrapper around chrome.storage.sync. The split-storage router
// in store/index.ts decides which keys go here vs. localStorage.

export const syncStorage = {
  async get(keys: readonly string[]): Promise<Record<string, unknown>> {
    if (keys.length === 0) return {};
    return (await chrome.storage.sync.get(keys as unknown as string[])) as Record<
      string,
      unknown
    >;
  },
  async set(items: Record<string, unknown>): Promise<void> {
    if (Object.keys(items).length === 0) return;
    await chrome.storage.sync.set(items);
  },
  async remove(keys: readonly string[]): Promise<void> {
    if (keys.length === 0) return;
    await chrome.storage.sync.remove(keys as unknown as string[]);
  },
};
