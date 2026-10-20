"use client";

// One read adapter for arranged mixed adjacency. Callers may supply an already
// loaded branch; that branch never starts a second disclosure request. Per-endpoint
// generations reject superseded pages and retained replies before exposing them.
import { useEffect, useMemo, useRef, useState } from "react";
import { apiFetch, isApiError, type ApiError } from "@/lib/api/client";
import { useChangeStamp } from "@/lib/api/changes";
import { assertNever } from "@/lib/assertNever";
import { usePagePrefix, readPagePrefix } from "@/lib/api/pagePrefix";
import { requestWithRetry } from "@/lib/api/serverState";
import type { ApiJson, Schema } from "@/lib/api/wire";
import { subscribeLinkMutations } from "./links";

const generations = new Map<string, number>();
let readSerial = 0;
const PAGE_SIZE = 100;
/** A read carries provenance; invalidation rejects its reply without remembering deleted ids. */
export const captureResourceOutlineRead = () => readSerial;
export const isResourceOutlineReadCurrent = (ref: string, started: number) =>
  (generations.get(ref) ?? 0) <= started;
export function invalidateResourceOutlines(refs: ReadonlySet<string>): void {
  const generation = ++readSerial;
  for (const ref of refs) generations.set(ref, generation);
}

export type ResourceOutline = Schema<"OutlineOut">;
export interface ResourceOutlineRead {
  source: Schema<"OutlineNodeOut"> | null;
  items: readonly Schema<"OutlineOccurrenceOut">[];
  version: number | null;
  generation: number;
  complete: boolean;
  status: "loading" | "ready" | "failed";
  error: ApiError | null;
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
  const { data } = await apiFetch<
    ApiJson<"/resource-graph/outline/{ref}", "get">
  >(`/api/resource-graph/outline/${encodeURIComponent(ref)}?${params}`, {
    signal,
  });
  return data;
}
type Page = ResourceOutline & { read_generation: number };
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
  const changes = useChangeStamp("Notes", "Metadata");
  const [revision, setRevision] = useState(0);
  const refreshFirst = useRef(false);
  const endpoint = ref ?? supplied?.source.item.ref ?? null;
  const suppliedRef = useRef({ value: supplied, generation: captureResourceOutlineRead() });
  if (suppliedRef.current.value !== supplied) {
    suppliedRef.current = { value: supplied, generation: captureResourceOutlineRead() };
    refreshFirst.current = false;
  }
  const { prefix, loadMore } = usePagePrefix<Page>(
    endpoint,
    `${changes}:${revision}:${supplied?.links_version ?? ""}`,
    async (cursor, signal) => {
      if (cursor === null && supplied !== null && !refreshFirst.current)
        return { ...supplied, read_generation: suppliedRef.current.generation };
      const started = captureResourceOutlineRead();
      try {
        return { ...await readResourceOutline(endpoint!, signal, cursor), read_generation: started };
      } catch (error) {
        if (isApiError(error) && error.status === 409)
          refreshFirst.current = true;
        throw error;
      }
    },
  );
  const refetch = () => {
    refreshFirst.current = true;
    setRevision((value) => value + 1);
  };
  const observed = useRef({ items: EMPTY, generation: captureResourceOutlineRead() });
  useEffect(() => subscribeLinkMutations((change) => {
    if (endpoint === null) return;
    let affected: boolean;
    switch (change.kind) {
      case "deleted":
        affected = observed.current.items.some((item) => item.connection.edge_id === change.linkId) ||
          !isResourceOutlineReadCurrent(endpoint, observed.current.generation);
        break;
      case "resource_deleted":
        affected = change.ref === endpoint || observed.current.items.some((item) => item.connection.other.ref === change.ref);
        break;
      case "created":
      case "context_detached":
        affected = change.sourceRef === endpoint || change.targetRef === endpoint;
        break;
      default: return assertNever(change);
    }
    if (!affected) return;
    invalidateResourceOutlines(new Set([endpoint]));
    refreshFirst.current = true;
    setRevision((value) => value + 1);
  }), [endpoint]);
  const loadedPages = prefix.status === "ready" ? prefix.data.pages : null;
  const candidates = useMemo(
    () => loadedPages ?? (supplied !== null ? [{ ...supplied, read_generation: suppliedRef.current.generation }] : null),
    [supplied, loadedPages],
  );
  if (candidates !== null) observed.current = {
    items: candidates.flatMap((page) => page.items),
    generation: candidates[0]!.read_generation,
  };
  const pages = endpoint !== null && candidates?.every((page) => isResourceOutlineReadCurrent(endpoint, page.read_generation))
    ? candidates : null;
  const items = useMemo(
    () => pages?.flatMap((page) => page.items) ?? EMPTY,
    [pages],
  );
  return {
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
    error:
      prefix.status === "failed"
        ? prefix.error
        : prefix.status === "ready"
          ? prefix.error
          : null,
    more: loadMore,
    retry: refetch,
    refetch,
  };
}
