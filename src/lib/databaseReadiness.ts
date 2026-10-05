export function createDatabaseReadiness(
  initialize: () => Promise<void>,
  options: { now?: () => number; retryDelayMs?: number } = {},
): PromiseLike<void> {
  const now = options.now ?? Date.now;
  const retryDelayMs = options.retryDelayMs ?? 1000;
  let initialization: Promise<void> | undefined;
  let retryAfter = Infinity;
  return {
    then(onfulfilled, onrejected) {
      if (!initialization || now() >= retryAfter) {
        retryAfter = Infinity;
        initialization = Promise.resolve().then(initialize).catch(error => {
          retryAfter = now() + retryDelayMs;
          throw error;
        });
      }
      return initialization.then(onfulfilled, onrejected);
    },
  };
}
