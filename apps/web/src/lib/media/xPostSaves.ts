"use client";

// A hosted document observes its distinct captures together. A complete read owns
// the mapping; a missing or failed batch never establishes that a post is unsaved.
import { useEffect, useMemo, useRef } from "react";
import { apiFetch } from "@/lib/api/client";
import { useChangeStamp } from "@/lib/api/changes";
import { usePaneFreeServerValue, type ServerValue } from "@/lib/api/serverState";
import type { ApiJson, Schema } from "@/lib/api/wire";
import type { ReaderDocument } from "@/lib/documentReader/model";
import { useImports } from "@/lib/imports/ImportsProvider";

type PostSaveState = Schema<"XPostSaveStateOut">["items"][number];
export type PostSaveStates = ServerValue<ReadonlyMap<string, PostSaveState>>;

export function usePostSaveStates(doc: ReaderDocument | null): PostSaveStates {
  const captures = useMemo(() => doc?.kind === "text"
    ? [...new Set(doc.units.flatMap(unit => unit.xPost?.owner ? [unit.xPost.owner.capture_id] : []))].sort()
    : [], [doc]);
  const entries = useChangeStamp("Entries");
  const { observation, revision, retainObserver } = useImports();
  const state = usePaneFreeServerValue({
    key: captures.length === 0 ? null : `x-post-save-state:${JSON.stringify(captures)}`,
    stale: `${entries}:${revision}`,
    load: async signal => {
      const items = new Map<string, PostSaveState>();
      for (let start = 0; start < captures.length; start += 100) {
        const { data } = await apiFetch<ApiJson<"/x/captures/save-state", "post">>("/api/x/captures/save-state", {
          method: "POST", body: JSON.stringify({ capture_ids: captures.slice(start, start + 100) }), signal,
        });
        for (const item of data.items) items.set(item.capture_id, item);
      }
      return items;
    },
  });
  const active = state.status === "ready" && [...state.data.values()].some(item =>
    item.kind === "resolved" && item.acquisition?.obligation.classification === "Active");
  useEffect(() => active ? retainObserver() : undefined, [active, retainObserver]);
  const observed = useRef(observation);
  const { revalidate } = state;
  useEffect(() => {
    if (observed.current === observation) return;
    observed.current = observation;
    revalidate({ passive: true });
  }, [observation, revalidate]);
  return state;
}
