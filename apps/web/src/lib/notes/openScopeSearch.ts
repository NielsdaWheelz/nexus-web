"use client";

import {useCallback, useEffect, useMemo, useRef, useState} from "react";
import {isApiError, isSameSystemApiDefect} from "@/lib/api/client";
import {useChangeStamp} from "@/lib/api/changes";
import {useAuthoredAccountId} from "@/lib/authored/provider";
import {queryConnections} from "@/lib/resourceGraph/links";
import {remoteConnectionScope, type OpenOutlineScope, type OutlineScopeResult} from "@/lib/resourceGraph/openOutlineScopes";

type Match = {kind: "ready"; order: readonly string[]; ids: ReadonlySet<string>} | Extract<OutlineScopeResult, {kind: "failed"}>;

export function useOpenScopeSearch(text: string, scopes: ReadonlyMap<string, OpenOutlineScope>) {
  const account = useAuthoredAccountId(), metadata = useChangeStamp("Metadata");
  const [state, setState] = useState<{ scopes: typeof scopes; key: string; items: ReadonlyMap<string, Match>; defect: {error: unknown} | null } | null>(null);
  const key = JSON.stringify([account, text, metadata]);
  const reload = useRef<((id: string) => void) | null>(null);
  useEffect(() => {
    if (text === "" || !scopes.size) return;
    const abort = new AbortController();
    const requests = new Map<string, object>();
    const load = (id: string) => {
      const scope = scopes.get(id);
      if (!scope) return;
      const ticket = {};
      requests.set(id, ticket);
      const publish = (match: Match | null, defect: {error: unknown} | null) => {
        if (abort.signal.aborted || requests.get(id) !== ticket) return;
        setState(previous => {
          const current = previous?.key === key && previous.scopes === scopes ? previous : null;
          const items = new Map(current?.items);
          if (match) items.set(id, match);
          return {scopes, key, items, defect: defect ?? current?.defect ?? null};
        });
      };
      void queryConnections({...remoteConnectionScope(scope.ref), match_text: text}, abort.signal).then(data => {
        const ids = data.matching_edge_ids;
        if (ids === null) {publish(null, {error: new Error("missing outline match proof")}); return;}
        const excluded = new Set(scope.excluded);
        publish({kind: "ready", order: data.edge_ids.filter(id => !excluded.has(id)), ids: new Set(ids.filter(id => !excluded.has(id)))}, null);
      }, error => publish(isApiError(error) && !isSameSystemApiDefect(error) ? {kind: "failed", error} : null,
        isApiError(error) && !isSameSystemApiDefect(error) ? null : {error}));
    };
    reload.current = load;
    for (const id of scopes.keys()) load(id);
    return () => {abort.abort(); reload.current = null;};
  }, [key, scopes, text]);
  const retry = useCallback((id: string) => reload.current?.(id), []);
  const current = state?.key === key && state.scopes === scopes ? state : null;
  const view = useMemo(() => {
    const needed = new Map<string, Set<string>>();
    const owners = new Set<string>();
    let complete = true, matches = false;
    for (const [id, scope] of scopes) {
      if (!text) break;
      const result = current?.items.get(id);
      if (result?.kind !== "ready") complete = false;
      if (result?.kind === "ready" && result.ids.size === 0) continue;
      matches ||= result?.kind === "ready";
      if (scope.owner !== null) owners.add(scope.owner);
      for (let child: OpenOutlineScope | undefined = scope; child?.parent != null; child = scopes.get(child.parent)) {
        if (child.entering === null) continue;
        let edges = needed.get(child.parent);
        if (!edges) {edges = new Set(); needed.set(child.parent, edges);}
        edges.add(child.entering);
      }
    }
    const results = new Map<string, OutlineScopeResult>();
    for (const [id, value] of current?.items ?? []) {
      const descendants = needed.get(id);
      results.set(id, value.kind === "failed" ? value : {kind: "ready",
        ids: new Set(value.order.filter(edge => value.ids.has(edge) || descendants?.has(edge)))});
    }
    return {owners, complete, matches, results};
  }, [scopes, current, text]);
  if (current?.defect) throw current.defect.error;
  return {...view, retry};
}
