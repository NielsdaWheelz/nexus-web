"use client";

import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { apiFetch, isApiError, isSameSystemApiDefect, type ApiError } from "@/lib/api/client";
import type { Presence } from "@/lib/api/presence";
import type { ApiJson } from "@/lib/api/wire";
import { handleUnauthenticatedApiError } from "@/lib/auth/UnauthenticatedApiBoundary";
import { useConsumptionProjectionRevision } from "@/lib/consumption/projectionRevision";
import { useMetadataCollectionRevision } from "@/lib/media/mediaMetadataOperations";
import { isAbortError } from "@/lib/errors";
import type { MediaSummary } from "./mediaSummary";

interface Entry {
  summary: Presence<MediaSummary>;
  generation: number;
  retainCount: number;
  error: ApiError | null;
}

function queryFacts(summary: MediaSummary): string {
  return JSON.stringify([summary.title, summary.contributors, summary.originalPublishedDate,
    summary.processingStatus, summary.duration.kind === "Present" ? {
      kind: "Present", value: { modality: summary.duration.value.modality,
        totalMinutes: summary.duration.value.estimate.totalMinutes },
    } : summary.duration]);
}

function createMediaSummaries() {
  const entries = new Map<string, Entry>();
  const pending = new Set<string>();
  const listeners = new Set<() => void>();
  let revision = 0;
  let queryRevision = 0;
  let controller: AbortController | null = null;
  let closed = false;
  let scheduled = false;
  let defect: unknown = null;

  function notify() {
    revision += 1;
    for (const listener of listeners) listener();
  }

  function schedule() {
    if (closed || scheduled || controller !== null || pending.size === 0) return;
    scheduled = true;
    queueMicrotask(() => {
      scheduled = false;
      void refresh();
    });
  }

  async function refresh() {
    if (closed || controller !== null) return;
    const mediaIds = [...pending].filter((id) => entries.get(id)!.retainCount > 0).slice(0, 100);
    if (mediaIds.length === 0) return;
    const generations = new Map(mediaIds.map((id) => [id, entries.get(id)!.generation]));
    for (const id of mediaIds) pending.delete(id);
    const request = new AbortController();
    controller = request;
    try {
      const result = await apiFetch<ApiJson<"/media/summaries/resolve", "post">>(
        "/api/media/summaries/resolve",
        { method: "POST", body: JSON.stringify({ mediaIds }), signal: request.signal },
      );
      if (closed || request.signal.aborted) return;
      for (const item of result.data.items) {
        const entry = entries.get(item.mediaId)!;
        if (entry.generation !== generations.get(item.mediaId)) continue;
        const previous = entry.summary;
        const next = item.summary;
        if (previous.kind !== next.kind || (previous.kind === "Present" && next.kind === "Present" &&
          queryFacts(previous.value) !== queryFacts(next.value))) {
          queryRevision += 1;
        }
        entry.summary = next;
        entry.error = null;
      }
    } catch (error) {
      if (closed || isAbortError(error) || handleUnauthenticatedApiError(error)) return;
      if (!isApiError(error) || isSameSystemApiDefect(error)) {
        defect = error;
      } else {
        for (const id of mediaIds) {
          const entry = entries.get(id)!;
          if (entry.generation === generations.get(id)) entry.error = error;
        }
      }
    } finally {
      if (controller === request) controller = null;
      if (!closed) {
        notify();
        schedule();
      }
    }
  }

  function invalidate(ids: readonly string[]) {
    for (const id of ids) {
      const entry = entries.get(id);
      if (!entry) continue;
      entry.generation += 1;
      entry.error = null;
      if (entry.retainCount > 0) pending.add(id);
    }
    schedule();
  }

  function invalidateQueries() {
    queryRevision += 1;
    invalidate([...entries.keys()]);
    notify();
  }

  return {
    open() { closed = false; schedule(); },
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    snapshot: () => revision,
    queryRevision: () => queryRevision,
    retain(seeds: readonly MediaSummary[]) {
      const ids = [...new Set(seeds.map((seed) => seed.mediaId))];
      for (const seed of seeds) {
        if (!entries.has(seed.mediaId)) entries.set(seed.mediaId, {
          summary: { kind: "Present", value: seed }, generation: 0, retainCount: 0, error: null,
        });
      }
      for (const id of ids) {
        const entry = entries.get(id)!;
        if (entry.retainCount === 0) invalidate([id]);
        entry.retainCount += 1;
        pending.add(id);
      }
      schedule();
      return () => {
        for (const id of ids) {
          const entry = entries.get(id)!;
          entry.retainCount -= 1;
          if (entry.retainCount === 0) pending.delete(id);
        }
      };
    },
    resolve(seed: MediaSummary): Presence<MediaSummary> {
      const summary = entries.get(seed.mediaId)?.summary;
      return summary ?? { kind: "Present", value: seed };
    },
    error(ids: readonly string[]) {
      if (defect !== null) throw defect;
      return ids.map((id) => entries.get(id)?.error).find((error) => error != null) ?? null;
    },
    retry: invalidate,
    invalidateAll() { invalidate([...entries.keys()]); },
    invalidateQueries,
    invalidateBibliography(mediaId: string) {
      queryRevision += 1;
      invalidate([mediaId]);
      notify();
    },
    close() {
      closed = true;
      controller?.abort();
      pending.clear();
    },
  };
}

const Context = createContext<ReturnType<typeof createMediaSummaries> | null>(null);

export function MediaSummaryProvider({ children }: { children: ReactNode }) {
  const [owner] = useState(createMediaSummaries);
  const consumption = useConsumptionProjectionRevision();
  const metadata = useMetadataCollectionRevision();
  const seenMetadata = useRef(metadata);
  useEffect(() => {
    if (seenMetadata.current === metadata) return;
    seenMetadata.current = metadata;
    owner.invalidateQueries();
  }, [metadata, owner]);
  useEffect(() => { owner.invalidateAll(); }, [owner, consumption.revision]);
  useEffect(() => {
    owner.open();
    const refresh = () => { if (document.visibilityState !== "hidden") owner.invalidateQueries(); };
    window.addEventListener("focus", refresh);
    window.addEventListener("online", refresh);
    window.addEventListener("pageshow", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      window.removeEventListener("focus", refresh);
      window.removeEventListener("online", refresh);
      window.removeEventListener("pageshow", refresh);
      document.removeEventListener("visibilitychange", refresh);
      owner.close();
    };
  }, [owner]);
  return <Context.Provider value={owner}>{children}</Context.Provider>;
}

export function useMediaSummaries(seeds: readonly MediaSummary[]) {
  const owner = useContext(Context);
  if (owner === null) throw new Error("Media summaries require their account provider");
  const revision = useSyncExternalStore(owner.subscribe, owner.snapshot, () => 0);
  const key = [...new Set(seeds.map((seed) => seed.mediaId))].sort().join(",");
  const seedsRef = useRef(seeds);
  seedsRef.current = seeds;
  useEffect(() => owner.retain(seedsRef.current), [owner, key]);
  return useMemo(() => {
    const ids = key === "" ? [] : key.split(",");
    return {
      resolve: owner.resolve,
      error: owner.error(ids),
      retry: () => owner.retry(ids),
      revision,
      queryRevision: owner.queryRevision(),
    };
  }, [owner, revision, key]);
}

export function useMediaBibliographyInvalidation() {
  const owner = useContext(Context);
  if (owner === null) throw new Error("Media summaries require their account provider");
  return owner.invalidateBibliography;
}

export function useMediaQueryRevision() {
  const owner = useContext(Context);
  if (owner === null) throw new Error("Media summaries require their account provider");
  useSyncExternalStore(owner.subscribe, owner.snapshot, () => 0);
  return owner.queryRevision();
}
