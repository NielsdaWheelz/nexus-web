import type { ResourceDescriptor } from "@/lib/api/resource";

// Paint-adjacent prefetch deadline for the server fetcher — never paint-blocking:
// callFastAPI aborts the upstream here, a timed-out seed is omitted, and the client
// useResource fetches normally. Shared with the bootstrap server data root.
export const PREFETCH_OPTS = { timeoutMs: 500 } as const;

// One fetch-and-parse over a ResourceDescriptor with the transport injected —
// callFastAPI (bearer cookie + deadline) on the server, apiFetch (abort signal) on
// the client. Pane loaders compose over this, so a single fetch/merge body serves
// the server seed, the client mount, and prefetch-on-intent. Returns the parsed
// envelope verbatim; every loader does its own `.data`.
export type ResourceFetcher = <P, T>(
  descriptor: ResourceDescriptor<P>,
  params: P,
) => Promise<T>;
