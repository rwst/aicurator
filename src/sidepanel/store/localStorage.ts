// Thin promise wrapper around chrome.storage.local. The split-storage router
// in store/index.ts decides which keys come here vs. syncStorage.

export const localStorage = {
  async get(keys: readonly string[]): Promise<Record<string, unknown>> {
    if (keys.length === 0) return {};
    return (await chrome.storage.local.get(keys as unknown as string[])) as Record<
      string,
      unknown
    >;
  },
  async set(items: Record<string, unknown>): Promise<void> {
    if (Object.keys(items).length === 0) return;
    await chrome.storage.local.set(items);
  },
  async remove(keys: readonly string[]): Promise<void> {
    if (keys.length === 0) return;
    await chrome.storage.local.remove(keys as unknown as string[]);
  },
};
