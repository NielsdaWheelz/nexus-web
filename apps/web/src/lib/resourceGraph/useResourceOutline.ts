"use client";

// One read adapter for arranged mixed adjacency. Callers may supply an already
// loaded branch; invalidation retires that seed and reads its current adjacency.
import { useEffect, useMemo, useRef, useState } from "react";
import { apiFetch, isApiError, type ApiError } from "@/lib/api/client";
import { useChangeStamp } from "@/lib/api/changes";
import { usePagePrefix } from "@/lib/api/pagePrefix";
import type { ApiJson, Schema } from "@/lib/api/wire";
import { subscribeLinkMutations } from "./links";

export type ResourceOutline = Schema<"OutlineOut">;
export interface ResourceOutlineRead {
  source: Schema<"OutlineNodeOut"> | null;
  items: readonly Schema<"OutlineOccurrenceOut">[];
  version: number | null;
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
  const params = new URLSearchParams({ limit: "100" });
  if (cursor !== null) params.set("cursor", cursor);
  const { data } = await apiFetch<
    ApiJson<"/resource-graph/outline/{ref}", "get">
  >(`/api/resource-graph/outline/${encodeURIComponent(ref)}?${params}`, {
    signal,
  });
  return data;
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
  const suppliedRef = useRef(supplied);
  if (suppliedRef.current !== supplied) {
    suppliedRef.current = supplied;
    refreshFirst.current = false;
  }
  const { prefix, loadMore } = usePagePrefix<ResourceOutline>(
    endpoint,
    `${changes}:${revision}:${supplied?.links_version ?? ""}`,
    async (cursor, signal) => {
      if (cursor === null && supplied !== null && !refreshFirst.current)
        return supplied;
      try {
        return await readResourceOutline(endpoint!, signal, cursor);
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
  useEffect(
    () =>
      subscribeLinkMutations((change) => {
        if (
          change.kind === "deleted" ||
          change.kind === "resource_deleted" ||
          change.sourceRef === endpoint ||
          change.targetRef === endpoint
        ) {
          refreshFirst.current = true;
          setRevision((value) => value + 1);
        }
      }),
    [endpoint],
  );
  const loadedPages = prefix.status === "ready" ? prefix.data.pages : null;
  const pages = useMemo(
    () => loadedPages ?? (supplied !== null ? [supplied] : null),
    [supplied, loadedPages],
  );
  const items = useMemo(
    () => pages?.flatMap((page) => page.items) ?? EMPTY,
    [pages],
  );
  return {
    source: pages?.[0]?.source ?? null,
    items,
    version: pages?.[0]?.links_version ?? null,
    complete: pages !== null && pages.at(-1)!.next_cursor === null,
    status:
      prefix.status === "ready"
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
    retrying: prefix.status === "ready" ? prefix.refreshing : prefix.status === "failed" ? prefix.retrying : true,
    more: loadMore,
    retry: refetch,
    refetch,
  };
}
