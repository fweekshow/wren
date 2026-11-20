const tails = new Map<string, Promise<unknown>>();

/** Run async work serially per key (one in-flight handler per user+conversation). */
export function runSerialized<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = tails.get(key) ?? Promise.resolve();
  const run = prev.then(() => fn());
  tails.set(
    key,
    run.then(
      () => undefined,
      () => undefined,
    ),
  );
  return run;
}
