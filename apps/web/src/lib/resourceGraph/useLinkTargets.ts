"use client";

// Target admission owns ten-row pages. Results are selectable only for the exact
// settled query; active identity belongs to the input, never to presentation.
import { apiFetch } from "@/lib/api/client";
import { useSettled } from "@/lib/api/serverState";
import { usePaneFreeServerList } from "@/lib/api/useServerList";
import type { ApiJson, Schema } from "@/lib/api/wire";
export type LinkTargetResult =
  | Schema<"ResourceTargetResourceOut">
  | Schema<"ResourceTargetPassageOut">;
export const targetKey = (target: LinkTargetResult): string =>
  target.kind === "resource" ? target.item.ref : target.candidate_ref;
const EMPTY: readonly LinkTargetResult[] = [];
export function useLinkTargets(
  raw: string,
  sourceRef: string | null,
  enabled: boolean,
  active: boolean,
  excludeRef: string | null = sourceRef,
) {
  const query = raw.slice(1).trim();
  const settled = useSettled(query, 200);
  const admitted = enabled && query.length >= 2;
  const list = usePaneFreeServerList<LinkTargetResult>({
    key:
      admitted && settled.length >= 2
        ? JSON.stringify([settled, sourceRef, excludeRef])
        : null,
    stale: "",
    // The endpoint fixes its page size; no limit parameter is supported.
    pageSize: 10,
    active: active && query === settled,
    id: targetKey,
    fetchPage: async (cursor, _limit, signal) => {
      const { data } = await apiFetch<
        ApiJson<"/resource-items/targets/search", "post">
      >("/api/resource-items/targets/search", {
        method: "POST",
        signal,
        body: JSON.stringify({
          q: settled,
          source_ref: sourceRef,
          exclude_refs: excludeRef ? [excludeRef] : [],
          cursor,
        }),
      });
      return { items: data.targets, next_cursor: data.next_cursor };
    },
  });
  const current = admitted && query === settled && list.current;
  return {
    items: current ? list.items : EMPTY,
    querySettled: query === settled,
    minimum: query.length < 2,
    loading: admitted && (query !== settled || (!list.current && list.failure === null)),
    error: admitted && query === settled && list.failure?.op !== "More" ? (list.failure?.error ?? null) : null,
    list,
    retry: list.retry,
  };
}
