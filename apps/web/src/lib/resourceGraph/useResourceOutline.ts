"use client";

// One read adapter for arranged mixed adjacency. Callers may supply an already
// loaded branch; invalidation retires that seed and reads its current adjacency. Per-endpoint
// generations reject superseded pages and retained replies before exposing them.
import { useEffect, useMemo, useRef, useState } from "react";
import { apiFetch, isApiError, type ApiError } from "@/lib/api/client";
import { useOptionalAuthenticatedAccount } from "@/lib/account/authenticatedAccount";
import { watchWritingResource, type WritingWatch } from "@/lib/api/writingReceive";
import { usePagePrefix, readPagePrefix } from "@/lib/api/pagePrefix";
import { requestWithRetry } from "@/lib/api/serverState";
import type { ApiJson, Schema } from "@/lib/api/wire";
import { announceResourceDeletion, subscribeLinkMutations } from "./links";

const generations = new Map<string, number>();
const invalidations = new Map<string, Set<() => void>>();
const watches = new Map<string, Set<WritingWatch>>();
let readSerial = 0;
const PAGE_SIZE = 100;
/** A read carries provenance; invalidation rejects its reply without remembering deleted ids. */
export const captureResourceOutlineRead = () => readSerial;
export const isResourceOutlineReadCurrent = (ref: string, started: number) =>
  (generations.get(ref) ?? 0) <= started;
export function invalidateResourceOutlines(refs: ReadonlySet<string>): void {
  const generation = ++readSerial;
  for (const ref of refs) {
    generations.set(ref, generation);
    for (const listener of invalidations.get(ref) ?? []) listener();
  }
}

export type ResourceOutline = Schema<"OutlineOut">;
export interface ResourceOutlineRead {
  insertionSource: ResourceOutline["insertion_source"];
  source: Schema<"OutlineNodeOut"> | null;
  items: readonly Schema<"OutlineOccurrenceOut">[];
  version: number | null;
  generation: number;
  complete: boolean;
  status: "loading" | "ready" | "failed";
  error: ApiError | null;
  retrying: boolean;
  more(): void;
  retry(): void;
  refetch(): void;
}
export async function readResourceOutline(
  ref: string,
  signal?: AbortSignal,
  cursor: string | null = null,
): Promise<ResourceOutline> {
  const params = new URLSearchParams({ limit: String(PAGE_SIZE) });
  if (cursor !== null) params.set("cursor", cursor);
  const { data } = await apiFetch<ApiJson<"/resource-graph/outline/{ref}", "get">>(`/api/resource-graph/outline/${encodeURIComponent(ref)}?${params}`, { signal });
  return data;
}
type Page = ResourceOutline & { read_generation: number; watch_generations?: ReadonlyMap<WritingWatch, number> };
/** Refresh exactly the already loaded prefix, including owners without a mounted hook. */
export async function refreshResourceOutline(ref: string, loadedItemCount: number): Promise<Page> {
  const started = captureResourceOutlineRead();
  const pages = Math.max(1, Math.ceil(loadedItemCount / PAGE_SIZE));
  const prefix = await requestWithRetry((signal) => readPagePrefix({
    pages, signal, fetchPage: (cursor, current) => readResourceOutline(ref, current, cursor),
  }), new AbortController().signal);
  return {
    ...prefix.pages[0]!,
    items: prefix.pages.flatMap((page) => page.items),
    next_cursor: prefix.pages.at(-1)!.next_cursor,
    read_generation: started,
  };
}

const EMPTY: readonly Schema<"OutlineOccurrenceOut">[] = [];
export function useResourceOutline(
  ref: string | null,
  supplied: ResourceOutline | null = null,
): ResourceOutlineRead {
  const accountId = useOptionalAuthenticatedAccount()?.accountId ?? null;
  const watch = useRef<WritingWatch | null>(null);
  const [revision, setRevision] = useState(0);
  const refreshFirst = useRef(false);
  const endpoint = ref ?? supplied?.source.item.ref ?? null;
  const suppliedRef = useRef({ value: supplied, generation: captureResourceOutlineRead() });
  if (suppliedRef.current.value !== supplied) {
    suppliedRef.current = { value: supplied, generation: captureResourceOutlineRead() };
    refreshFirst.current = false;
  }
  const { prefix, loadMore } = usePagePrefix<Page>(
    endpoint === null ? null : `resource-outline:${endpoint}`,
    `${revision}:${supplied?.links_version ?? ""}`,
    async (cursor, signal) => {
      const watch_generations = new Map([...(watches.get(JSON.stringify([accountId, endpoint])) ?? [])].map(current => [current, current.capture()]));
      if (cursor === null && supplied !== null && !refreshFirst.current)
        return { ...supplied, read_generation: suppliedRef.current.generation, watch_generations };
      const started = captureResourceOutlineRead();
      try {
        return { ...await readResourceOutline(endpoint!, signal, cursor), read_generation: started, watch_generations };
      } catch (error) {
        if (isApiError(error) && error.status === 409)
          refreshFirst.current = true;
        throw error;
      }
    },
  );
  const refetch = () => {
    if (endpoint !== null) invalidateResourceOutlines(new Set([endpoint]));
  };
  useEffect(() => {
    if (endpoint === null) return;
    let listeners = invalidations.get(endpoint);
    if (!listeners) { listeners = new Set(); invalidations.set(endpoint, listeners); }
    const invalidate = () => { refreshFirst.current = true; setRevision(value => value + 1); };
    listeners.add(invalidate);
    const current = accountId === null ? null : watchWritingResource({
      accountId, ref: endpoint, lanes: ["links_version"],
      invalidate: () => invalidateResourceOutlines(new Set([endpoint])),
    });
    watch.current = current;
    const key = JSON.stringify([accountId, endpoint]);
    let watching = watches.get(key);
    if (!watching) { watching = new Set(); watches.set(key, watching); }
    if (current) watching.add(current);
    return () => {
      if (current) watching.delete(current);
      if (watching.size === 0) watches.delete(key);
      current?.stop();
      if (watch.current === current) watch.current = null;
      listeners.delete(invalidate);
      if (listeners.size === 0) invalidations.delete(endpoint);
    };
  }, [accountId, endpoint]);
  const error = prefix.status === "loading" ? null : prefix.error;
  useEffect(() => {
    if (endpoint !== null && error?.status === 404)
      announceResourceDeletion(endpoint);
  }, [endpoint, error]);
  useEffect(() => subscribeLinkMutations(change => {
    if (endpoint === null) return;
    if ((change.kind === "resource_deleted" && change.ref === endpoint) ||
        (change.kind === "context_detached" && (change.sourceRef === endpoint || change.targetRef === endpoint)))
      invalidateResourceOutlines(new Set([endpoint]));
  }), [endpoint]);
  const loadedPages = prefix.status === "ready" ? prefix.data.pages : null;
  const candidates = useMemo<readonly Page[] | null>(
    () => loadedPages ?? (supplied !== null ? [{ ...supplied, read_generation: suppliedRef.current.generation }] : null),
    [supplied, loadedPages],
  );
  const pages = endpoint !== null && candidates?.every((page) => isResourceOutlineReadCurrent(endpoint, page.read_generation))
    ? candidates : null;
  useEffect(() => {
    const first = pages?.[0];
    const current = watch.current;
    const generation = current === null ? undefined : first?.watch_generations?.get(current);
    if (first && current && generation !== undefined && endpoint !== null && isResourceOutlineReadCurrent(endpoint, first.read_generation))
      current.adopt({ links_version: first.links_version }, generation);
  }, [endpoint, pages]);
  const items = useMemo(
    () => pages?.flatMap((page) => page.items) ?? EMPTY,
    [pages],
  );
  return {
    insertionSource: pages?.[0]?.insertion_source ?? null,
    source: pages?.[0]?.source ?? null,
    items,
    version: pages?.[0]?.links_version ?? null,
    generation: pages?.[0]?.read_generation ?? captureResourceOutlineRead(),
    complete: pages !== null && pages.at(-1)!.next_cursor === null,
    status:
      candidates !== null && pages === null ? "loading" : prefix.status === "ready"
        ? prefix.error !== null
          ? "failed"
          : prefix.refreshing
            ? "loading"
            : "ready"
        : prefix.status,
    error,
    retrying: prefix.status === "ready" ? prefix.refreshing : prefix.status === "failed" ? prefix.retrying : true,
    more: loadMore,
    retry: refetch,
    refetch,
  };
}
