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
  const keyRef = useRef(cacheKey);
  if (keyRef.current !== cacheKey) {
    keyRef.current = cacheKey;
    if (live !== null) setLive(null);
  }

  const keyedDetail = keyed.status === "ready" ? keyed.data : null;
  const detail =
    live !== null && cacheKey !== null && live.key === cacheKey
      ? live.detail
      : keyedDetail;

  const shownRef = useRef<{
    readonly key: string;
    readonly ref: ImportRef;
    readonly active: boolean;
  } | null>(null);
  shownRef.current =
    detail === null || cacheKey === null || ref === null
      ? null
      : { key: cacheKey, ref, active: detail.item.state.kind === "Active" };

  // A new revision re-keys the read above, so the observation carrying it is
  // already answered by that read and must not read the detail a second time.
  const rekeyedRef = useRef(false);
  const revisionRef = useRef(observation.revision);
  if (revisionRef.current !== observation.revision) {
    revisionRef.current = observation.revision;
    rekeyedRef.current = true;
  }

  const observedAt = observation.observedAt;
  const lastObservedRef = useRef<string | null>(null);
  useEffect(() => {
    const previous = lastObservedRef.current;
    lastObservedRef.current = observedAt;
    const shown = shownRef.current;
    // The provider's first observation is the read the keyed resource made.
    if (previous === null || previous === observedAt) return;
    if (rekeyedRef.current) {
      rekeyedRef.current = false;
      return;
    }
    if (shown === null || !shown.active) return;
    const controller = new AbortController();
    void (async () => {
      let next: ImportDetail;
      try {
        next = await fetchImportDetail({
          ref: shown.ref,
          signal: controller.signal,
        });
      } catch (error: unknown) {
        absorbRereadFailure(error, controller.signal);
        return;
      }
      if (controller.signal.aborted) return;
      setLive({ key: shown.key, detail: next });
    })();
    return () => controller.abort();
  }, [absorbRereadFailure, observedAt]);

  return detail === null ? keyed : { status: "ready", data: detail };
}
