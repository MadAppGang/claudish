/**
 * Runs `run` on every item, at most `jobs` at a time, and returns the results in the order of
 * `items`. A throw from one run leaves only after every worker has ended, so a run that is
 * in progress always reaches its own cleanup first.
 */
export async function runPool<T, R>(
  items: readonly T[],
  jobs: number,
  run: (item: T) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const i = next++;
      results[i] = await run(items[i] as T);
    }
  };
  const ended = await Promise.allSettled(
    Array.from({ length: Math.min(jobs, items.length) }, worker)
  );
  for (const e of ended) if (e.status === "rejected") throw e.reason;
  return results;
}
