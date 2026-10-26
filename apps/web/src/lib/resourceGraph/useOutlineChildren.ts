"use client";

// One outer outline owns one atomic availability wave. The read primitive owns
// retained results and retries; descriptor identity and structural provenance
// decide which retained answers still apply. No adjacency prefix proves emptiness.
import {useCallback, useId, useLayoutEffect, useState} from "react";
import {apiFetch} from "@/lib/api/client";
import {useServerValue, type Visit} from "@/lib/api/serverState";
import type {ApiJson, Schema} from "@/lib/api/wire";
import {useWritingRevision} from "@/lib/api/writingReceive";
import {useRefreshStamp} from "@/lib/consumption/refresh";
import {readWriting} from "@/lib/notes/writes";
import {usePaneIsActive, usePaneIsVisible, usePaneRuntime} from "@/lib/panes/paneRuntime";
import {definePaneVisitDataKey} from "@/lib/workspace/paneReturnMemento";
import {captureResourceOutlineRead, invalidateResourceOutlines,
  subscribeResourceOutlineInvalidations} from "./useResourceOutline";

export interface OutlineChildrenDescriptor {
  identity: string;
  occurrence: Schema<"OutlineChildrenOccurrenceRequest">;
  localChildren: boolean;
}
interface Proof { identity: string; value: boolean | null }
interface Snapshot {
  lifetime: number;
  structure: number;
  items: ReadonlyMap<string, Proof>;
}

export function useOutlineChildren(scope: string, descriptors: ReadonlyMap<string, OutlineChildrenDescriptor>) {
  const runtime = usePaneRuntime();
  const outsideOwner = useId();
  const [stamp, setStamp] = useState(() => {
    const serial = captureResourceOutlineRead();
    return {serial, structure: serial};
  });
  useLayoutEffect(() => {
    const stop = subscribeResourceOutlineInvalidations((cause, serial) => {
      setStamp(current => ({serial, structure: cause === "structure" ? serial : current.structure}));
    });
    // Child effects may invalidate before this scope subscribes on its first commit.
    const serial = captureResourceOutlineRead();
    setStamp(current => current.serial === serial ? current : {serial, structure: serial});
    return stop;
  }, []);
  const writingRevision = useWritingRevision();
  const active = usePaneIsActive();
  const visible = usePaneIsVisible();
  const foreground = useRefreshStamp(active && visible, 0);
  const lifetime = readWriting().generation;
  const entries = [...descriptors].sort(([a], [b]) => a.localeCompare(b));
  const stale = JSON.stringify([entries.map(([key, descriptor]) => [key, descriptor.identity]),
    stamp.serial, writingRevision, foreground, lifetime]);
  const read = useServerValue<Snapshot>({
    key: entries.length === 0 ? null : JSON.stringify(["outline-children",
      runtime?.paneId ?? outsideOwner, runtime?.visitId ?? outsideOwner, scope]),
    stale,
    visit: definePaneVisitDataKey<Visit<Snapshot>>(`Outline.Children:${scope}`),
    load: async signal => {
      const items = new Map<string, Proof>();
      for (let offset = 0; offset < entries.length; offset += 100) {
        signal.throwIfAborted();
        const chunk = entries.slice(offset, offset + 100);
        const request: Schema<"OutlineChildrenRequest"> = {
          occurrences: chunk.map(([, descriptor]) => descriptor.occurrence),
        };
        const {data} = await apiFetch<ApiJson<"/resource-graph/outline/children/query", "post">>(
          "/api/resource-graph/outline/children/query", {method: "POST", body: JSON.stringify(request), signal});
        if (data.items.length !== chunk.length)
          throw new Error("outline child availability cardinality mismatch");
        chunk.forEach(([key, descriptor], index) => {
          items.set(key, {identity: descriptor.identity, value: data.items[index]!});
        });
      }
      signal.throwIfAborted();
      return {lifetime, structure: stamp.structure, items};
    },
  });
  // Restored visit evidence follows the same account/context fences as a live
  // response. Refresh retains compatible controls; structural changes retire all.
  const snapshot = read.status === "ready" && read.data.lifetime === lifetime &&
    read.data.structure === stamp.structure ? read.data : null;
  const items = new Map<string, Proof>();
  for (const [key, descriptor] of entries) {
    const proof = snapshot?.items.get(key);
    if (proof?.identity === descriptor.identity) items.set(key, proof);
  }
  const retry = useCallback(() => invalidateResourceOutlines(new Set(), "refresh"), []);
  return {
    items,
    loading: entries.some(([key, descriptor]) => !descriptor.localChildren && !items.has(key)),
    error: entries.length === 0 || read.status === "loading" ? null : read.error,
    retry,
  };
}
