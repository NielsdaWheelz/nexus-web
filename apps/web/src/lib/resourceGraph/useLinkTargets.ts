"use client";

// Target admission owns ten-row pages. Results are selectable only for the exact
// settled query; active identity belongs to the input, never to presentation.
import { useOptionalNoteEditorHost } from "@/lib/notes/editorHost";
import { useAuthoredPages } from "@/lib/notes/hooks";
import { authoredItem } from "@/lib/notes/presentation";
import { useChangeStamp } from "@/lib/api/changes";
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
  const host = useOptionalNoteEditorHost();
  const query = raw.slice(1).trim();
  const settled = useSettled(raw, 200);
  const settledQuery = settled.slice(1).trim();
  const stale = useChangeStamp("Notes", "NoteBodies", "Metadata");
  const admitted = enabled && query.length >= 2;
  const list = usePaneFreeServerList<LinkTargetResult>({
    key:
      admitted && settledQuery.length >= 2 && host?.references !== "local"
        ? `/resource-items/targets/search?${new URLSearchParams({ q: settledQuery, source_ref: JSON.stringify(sourceRef), exclude_refs: JSON.stringify(excludeRef ? [excludeRef] : []) })}`
        : null,
    stale,
    // The endpoint fixes its page size; no limit parameter is supported.
    pageSize: 10,
    active: active && raw === settled,
    id: targetKey,
    fetchPage: async (cursor, _limit, signal) => {
      const { data } = await apiFetch<
        ApiJson<"/resource-items/targets/search", "post">
      >("/api/resource-items/targets/search", {
        method: "POST",
        signal,
        body: JSON.stringify({
          q: settledQuery,
          source_ref: sourceRef,
          exclude_refs: excludeRef ? [excludeRef] : [],
          cursor,
        }),
      });
      return { items: data.targets, next_cursor: data.next_cursor };
    },
  });
  const local = useAuthoredPages({ kind: "search", text: admitted && settledQuery.length >= 2 ? settledQuery : "", cursor: null, limit: 100, scopes: [{ kind: "all", id: null }], families: null });
  const localTargets: LinkTargetResult[] = (local.data?.rows ?? []).filter(row => row.resource.ref !== excludeRef && row.resource.kind !== "highlight").map(row => ({ kind: "resource", item: authoredItem(row.resource), existing_link_id: null }));
  const current = admitted && raw === settled && local.data !== null;
  const remoteTargets = list.current ? list.items.filter(target => !/^(note_block|page|highlight):/u.test(target.item.ref)) : [];
  const seen = new Set<string>();
  const items = [...localTargets, ...remoteTargets].filter(target => { const key = targetKey(target); if (seen.has(key)) return false; seen.add(key); return true; });
  return {
    items: current ? items : EMPTY,
    current,
    querySettled: raw === settled,
    minimum: query.length < 2,
    loading: admitted && (raw !== settled || local.data === null && local.error === null),
    localError: local.error,
    localComplete: local.data?.next_cursor === null,
    moreLocal: local.more,
    error: admitted && raw === settled && list.failure?.op !== "More" ? (list.failure?.error ?? null) : null,
    list,
    retry: list.retry,
  };
}
