export type BrowseRequestRunner = <T>(
  signal: AbortSignal,
  request: () => Promise<T>,
) => Promise<T>;

interface QueuedRequest<T> {
  readonly signal: AbortSignal;
  readonly request: () => Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (reason: unknown) => void;
  readonly onAbort: () => void;
}

function abortError(): DOMException {
  return new DOMException("Browse request aborted", "AbortError");
}

export function createBrowseRequestGate(maxConcurrent: number): {
  readonly run: BrowseRequestRunner;
} {
  if (!Number.isInteger(maxConcurrent) || maxConcurrent <= 0) {
    throw new RangeError("Browse request concurrency must be a positive integer.");
  }

  let active = 0;
  const queue: QueuedRequest<unknown>[] = [];

  const pump = () => {
    while (active < maxConcurrent) {
      const queued = queue.shift();
      if (queued === undefined) return;
      queued.signal.removeEventListener("abort", queued.onAbort);
      if (queued.signal.aborted) {
        queued.reject(abortError());
        continue;
      }

      active += 1;
      void queued
        .request()
        .then(queued.resolve, queued.reject)
        .finally(() => {
          active -= 1;
          pump();
        });
    }
  };

  const run = <T>(
    signal: AbortSignal,
    request: () => Promise<T>,
  ): Promise<T> => {
    if (signal.aborted) return Promise.reject(abortError());

    return new Promise((resolve, reject) => {
      const queued: QueuedRequest<unknown> = {
        signal,
        request,
        resolve: (value) => resolve(value as T),
        reject,
        onAbort: () => {
          const index = queue.indexOf(queued);
          if (index === -1) return;
          queue.splice(index, 1);
          reject(abortError());
        },
      };
      signal.addEventListener("abort", queued.onAbort, { once: true });
      queue.push(queued);
      pump();
    });
  };

  return { run };
}
