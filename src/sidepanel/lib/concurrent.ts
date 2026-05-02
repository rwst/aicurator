// Run an async fn over each item with a hard concurrency cap.
// Used to fan out NCBI and UniProt per-label calls without blasting
// the rate limit (NCBI: 3 req/sec unauthenticated; UniProt: ~25 req/sec).
//
// Preserves input order in the returned array.

export async function mapWithLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;

  async function worker(): Promise<void> {
    while (true) {
      const i = next;
      next += 1;
      if (i >= items.length) return;
      results[i] = await fn(items[i], i);
    }
  }

  const workers: Promise<void>[] = [];
  const n = Math.max(1, Math.min(limit, items.length));
  for (let w = 0; w < n; w += 1) workers.push(worker());
  await Promise.all(workers);
  return results;
}
