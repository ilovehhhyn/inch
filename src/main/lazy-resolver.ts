// Runs an asynchronous lookup once and shares its answer, but never keeps a failure.

/** The first call starts `lookup`; callers while it runs share it; a success is kept for good; a failure is dropped so the next call tries again. */
export function lazyUntilItFails<Value>(lookup: () => Promise<Value>): () => Promise<Value> {
  let pending: Promise<Value> | undefined;
  return () => {
    pending ??= lookup().catch((error: unknown) => {
      pending = undefined;
      throw error;
    });
    return pending;
  };
}
