"use client";

import { useEffect, useRef, useState } from "react";
import { useResource, type AsyncResource } from "@/lib/api/useResource";
import { useImports } from "@/lib/imports/ImportsProvider";
import { useLiveRereadFailure } from "@/lib/imports/liveReread";
import type { ImportRef } from "@/lib/imports/importRef";
import {
  fetchImportDetail,
  type ImportDetail,
} from "@/lib/imports/importsClient";

/**
 * The inspected import. Keyed to the selected ref and the provider's observation
 * revision, so an invalidation or a manual refresh re-reads it, and re-read on
 * the provider's five-second observation while the import is still Active
 * (contract D10). A detail that has left the current list filter keeps its own
 * identity: nothing here reads the list.
 */
export function useImportDetail(
  ref: ImportRef | null,
): AsyncResource<ImportDetail> {
  const { observation } = useImports();
  const absorbRereadFailure = useLiveRereadFailure();
  const cacheKey = ref === null ? null : `${ref} ${observation.revision}`;
  const keyed = useResource<ImportDetail>({
    cacheKey,
    load: (signal) => {
      if (ref === null) throw new Error("Cannot read a detail with no ref");
      return fetchImportDetail({ ref, signal });
    },
  });

  const [live, setLive] = useState<{
    readonly key: string;
    readonly detail: ImportDetail;
  } | null>(null);

  // A live detail belongs to the key it was read for, so it is dropped as that
  // key leaves: reselecting an earlier import must never shadow the read that
  // key is making now with a detail captured before the detour.
  if (live !== null && live.key !== cacheKey) setLive(null);

  const keyedDetail = keyed.status === "ready" ? keyed.data : null;
  const detail =
    live !== null && live.key === cacheKey ? live.detail : keyedDetail;

  // Only work still in flight is worth re-reading, and the state committed with
  // the key the effect runs for is the one it must judge.
  const activeRef = useRef(false);
  activeRef.current = detail !== null && detail.item.state.kind === "Active";

  // The observation revision the shown detail was read for. An observation that
  // moved the revision re-keyed the read above and is answered by that keyed
  // read alone, so it must not read the detail a second time; every later
  // observation is this pane's five-second tick. Only the provider's revision
  // marks it: selecting another import re-keys the read too, and it is not an
  // observation, so it must not cost the reader a tick.
  const revision = observation.revision;
  const tickedRevisionRef = useRef(revision);

  const observedAt = observation.observedAt;
  const lastObservedRef = useRef<string | null>(null);
  useEffect(() => {
    const previous = lastObservedRef.current;
    lastObservedRef.current = observedAt;
    // The provider's first observation is the read the keyed resource made.
    if (previous === null || previous === observedAt) return;
    const ticked = tickedRevisionRef.current;
    tickedRevisionRef.current = revision;
    if (ticked !== revision) return;
    if (cacheKey === null || ref === null || !activeRef.current) return;
    const controller = new AbortController();
    void (async () => {
      let next: ImportDetail;
      try {
        next = await fetchImportDetail({ ref, signal: controller.signal });
      } catch (error: unknown) {
        absorbRereadFailure(error, controller.signal);
        return;
      }
      if (controller.signal.aborted) return;
      setLive({ key: cacheKey, detail: next });
    })();
    return () => controller.abort();
  }, [absorbRereadFailure, cacheKey, observedAt, ref, revision]);

  return detail === null ? keyed : { status: "ready", data: detail };
}
