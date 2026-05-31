"use client";

import { apiFetch, type ApiPath } from "@/lib/api/client";
import {
  useAsyncResource,
  type AsyncResource,
} from "@/lib/useAsyncResource";

export function useApiResource<T>(args: {
  cacheKey: string | null;
  path: (cacheKey: string) => ApiPath;
  initialData?: T;
}): AsyncResource<T> {
  return useAsyncResource<T>({
    cacheKey: args.cacheKey,
    initialData: args.initialData,
    load: (signal) => apiFetch<T>(args.path(args.cacheKey!), { signal }),
  });
}
