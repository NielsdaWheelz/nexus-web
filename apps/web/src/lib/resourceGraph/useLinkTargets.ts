"use client";

// The picker combines two independently admitted sources. Only the exact
// settled query's results may be selected.
import { useOptionalNoteEditorHost } from "@/lib/notes/editorHost";
import { localResourceHref } from "@/lib/resources/localResource";
import { authoredItem } from "@/lib/notes/presentation";
import { useChangeStamp } from "@/lib/api/changes";
import { apiFetch } from "@/lib/api/client";
import { useSettled } from "@/lib/api/serverState";
import { usePaneFreeServerList } from "@/lib/api/useServerList";
import { useLocalDiscovery } from "@/lib/search/localDiscovery";
import { SEARCH_READ_TIMEOUT_MS } from "@/lib/search/policy";
import type { ApiJson, Schema } from "@/lib/api/wire";

export type LinkTargetResult =
  | Schema<"ResourceTargetResourceOut">
  | Schema<"ResourceTargetPassageOut">;

export const targetKey = (target: LinkTargetResult): string =>
  target.kind === "resource" ? target.item.ref : target.candidate_ref;

export function useLinkTargets(
  raw: string,
  sourceRef: string | null,
  enabled: boolean,
  active: boolean,
  excludeRef: string | null = sourceRef,
) {
  const host = useOptionalNoteEditorHost();
  const query = raw.slice(1).trim().normalize("NFC");
  const settled = useSettled(query, 200);
  const stale = useChangeStamp("Notes", "NoteBodies", "Metadata");
  const minimum = Array.from(query).length < 2;
  const admitted = enabled && !minimum && query === settled;
  const remote = host?.references !== "local";
  const exclude_refs = excludeRef === null ? [] : [excludeRef];
  const isRemoteTarget = (target: LinkTargetResult) => !/^(note_block|page|highlight):/u.test(target.item.ref);
  const list = usePaneFreeServerList<LinkTargetResult>({
    key: admitted && remote
      ? JSON.stringify(["reference", query, sourceRef, exclude_refs])
      : null,
    stale,
    // The endpoint fixes its page size; no limit parameter is supported.
    pageSize: 10, readPolicy: "search:target-picker-prefix", retry: "capacity",
    cursorRecovery: "manual",
    prefixTimeoutMs: pages => SEARCH_READ_TIMEOUT_MS.hybrid * (pages ?? 101),
    active: active && admitted,
    continuation: item => isRemoteTarget(item) && !localTargets.some(target => targetKey(target) === targetKey(item)),
    id: targetKey,
    fetchPage: async (cursor, _limit, signal) => {
      const { data } = await apiFetch<
        ApiJson<"/resource-items/targets/search", "post">
      >("/api/resource-items/targets/search", {
        method: "POST",
        signal,
        body: JSON.stringify({ q: query, source_ref: sourceRef, exclude_refs, cursor }),
      });
      return { items: data.targets, next_cursor: data.next_cursor };
    },
  });
  const remoteTargets = list.current ? list.items.filter(isRemoteTarget) : [];
  const remoteKeys = new Set(remoteTargets.map(targetKey));
  const local = useLocalDiscovery(admitted ? { kind: "search", text: query, cursor: null, limit: 100,
    scopes: [{ kind: "all", id: null }], families: null } : null, active,
  ({ resource }) => resource.ref !== excludeRef && resource.kind !== "highlight" && !remoteKeys.has(resource.ref));
  const localTargets: LinkTargetResult[] = (local.data?.rows ?? [])
    .filter(({ resource }) => resource.ref !== excludeRef && resource.kind !== "highlight")
    .map(({ resource, activation_ref }) => ({ kind: "resource", item: authoredItem(resource, activation_ref,
      localResourceHref(resource, { activationRef: activation_ref })), existing_link_id: null }));
  const seen = new Set<string>();
  const items = [...localTargets, ...remoteTargets].filter(target => {
    const key = targetKey(target);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const current = admitted && (local.data !== null || list.current);
  const localCanContinue = current && local.data !== null && local.data.next_cursor !== null && local.error === null;
  const remoteCanContinue = current && list.current && !list.complete && list.failure === null;
  return {
    items: current ? items : [],
    current,
    querySettled: query === settled,
    minimum,
    loading: enabled && !minimum && (!admitted || local.pending || remote && list.status === "loading"),
    complete: current && local.data?.next_cursor === null && local.error === null && (!remote || list.complete && list.failure === null),
    localError: local.error,
    localPending: local.pending,
    retryLocal: local.retry,
    localCanContinue,
    localNeedsAction: local.continuationNeedsAction,
    moreLocal: local.more,
    remoteCanContinue,
    error: admitted ? list.failure?.error ?? null : null,
    list,
    retry: () => {
      if (list.failure?.error.code === "E_INVALID_CURSOR") void list.refetch().catch(() => {});
      else list.retry();
    },
    fetchAhead() {
      if (localCanContinue) local.fetchAhead();
      if (remoteCanContinue) list.fetchAhead();
    },
  };
}
