"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError, isApiError } from "@/lib/api/client";
import { isAbortError } from "@/lib/errors";

export type AsyncResource<T> =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "ready"; data: T }
  | { status: "error"; error: ApiError; retry: () => void };

const MAX_ATTEMPTS = 3;
const BASE_DELAY_MS = 250;
const MAX_DELAY_MS = 2000;

export function useAsyncResource<T>(args: {
  cacheKey: string | null;
  load: (signal: AbortSignal) => Promise<T>;
  initialData?: T;
}): AsyncResource<T> {
  const { cacheKey } = args;
  const loadRef = useRef(args.load);
  loadRef.current = args.load;

  const [retryTick, setRetryTick] = useState(0);
  const retry = useCallback(() => setRetryTick((n) => n + 1), []);

  const skipKeyRef = useRef(
    args.initialData !== undefined && cacheKey !== null ? cacheKey : null,
  );

  const [resource, setResource] = useState<AsyncResource<T>>(() => {
    if (args.initialData !== undefined && cacheKey !== null) {
      return { status: "ready", data: args.initialData };
    }
    return cacheKey === null ? { status: "idle" } : { status: "loading" };
  });

  useEffect(() => {
    if (cacheKey === null) {
      setResource({ status: "idle" });
      return;
    }
    if (skipKeyRef.current === cacheKey) {
      skipKeyRef.current = null;
      return;
    }

    const controller = new AbortController();
    let delayTimer: ReturnType<typeof setTimeout> | null = null;
    let attempt = 1;
    setResource({ status: "loading" });

    const run = async () => {
      try {
        const data = await loadRef.current(controller.signal);
        if (controller.signal.aborted) return;
        setResource({ status: "ready", data });
      } catch (err) {
        if (isAbortError(err) || controller.signal.aborted) return;
        const retryable = !isApiError(err) || err.status >= 500;
        if (retryable && attempt < MAX_ATTEMPTS) {
          attempt += 1;
          const delay = Math.min(
            BASE_DELAY_MS * 2 ** (attempt - 2),
            MAX_DELAY_MS,
          );
          const jittered = delay * (0.75 + Math.random() * 0.5);
          delayTimer = setTimeout(run, jittered);
          return;
        }
        const apiError = isApiError(err)
          ? err
          : new ApiError(
              0,
              "E_NETWORK",
              err instanceof Error ? err.message : "Request failed",
            );
        setResource({ status: "error", error: apiError, retry });
      }
    };
    run();

    return () => {
      controller.abort();
      if (delayTimer !== null) clearTimeout(delayTimer);
    };
  }, [cacheKey, retryTick, retry]);

  return resource;
}
