import { apiFetch } from "@/lib/api/client";
import type { ResourceFetcher } from "@/lib/api/resourceTransport";

// Client transport: same-origin BFF fetch with the caller's abort signal baked in,
// so mount and prefetch cancellation propagate to the underlying request.
export function clientResourceFetcher(signal: AbortSignal): ResourceFetcher {
  return (descriptor, params) => apiFetch(descriptor.clientPath(params), { signal });
}
