import type { ResourceDescriptor } from "@/lib/api/resource";

// Per-request deadline for the active pane's server seed, awaited before first
// shell mount. A timed-out prefetch is omitted and the pane reads on the client.
// Required account, reader-profile and workspace-session reads use the normal
// server-request deadline; inactive panes are never seeded by entry.
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
