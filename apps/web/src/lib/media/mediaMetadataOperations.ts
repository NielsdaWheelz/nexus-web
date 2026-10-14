"use client";

// The metadata-research client: admission and one live observer per media (SSE
// `state` frames, never terminal); research that changes a summary field
// (title, contributors, first publication) publishes "Metadata" while the
// media is observed: by an open view, or by the tab that admitted the run.

import { useCallback, useSyncExternalStore } from "react";
import { apiFetch, isApiError } from "@/lib/api/client";
import { publishChange } from "@/lib/api/changes";
import type { ApiJson, Schema } from "@/lib/api/wire";
import {
  createMutationIntent,
  type MutationIntent,
} from "@/lib/actions/mutationIntent";
import { publishImportsInvalidation } from "@/lib/imports/api";
import { sseClientDirect } from "@/lib/api/sse-client";

export type MetadataEnrichmentView = Schema<"MetadataEnrichmentView">;
export type MetadataOperation = Schema<"MetadataOperationOut">;

const SETTLED = new Set<MetadataOperation["status"]>([
  "completed",
  "no_findings",
  "failed",
]);

export async function submitMetadataEnrichment(
  mediaId: string,
  request: Schema<"MetadataEnrichmentRequest">,
): Promise<Schema<"MetadataEnrichmentAccepted">> {
  const response = await apiFetch<
    ApiJson<"/media/{media_id}/metadata-enrichment", "post">
  >(`/api/media/${encodeURIComponent(mediaId)}/metadata-enrichment`, {
    method: "POST",
    body: JSON.stringify(request),
  });
  // The admitting tab follows its run to the end, so a summary change reaches
  // this tab's lists ("Metadata") with no metadata… overlay open. It stops when
  // the run settles, when a later job is latest, or when the stream ends.
  publishImportsInvalidation();
  const jobId = response.data.job_id;
  admitted.add(jobId);
  const stop = observe(mediaId, () => {
    const { snapshot, stop: stream } = entryFor(mediaId);
    const latest = snapshot.view?.operation;
    if (stream === null) {
      stop();
    } else if (!snapshot.disconnected && latest?.kind === "Present") {
      const { job_id, status } = latest.value;
      if (job_id !== jobId || SETTLED.has(status)) stop();
    }
  });
  return response.data;
}

interface Observation {
  readonly view: MetadataEnrichmentView | null;
  readonly disconnected: boolean;
}
interface Entry {
  snapshot: Observation;
  readonly listeners: Set<() => void>;
  stop: (() => void) | null;
}
const EMPTY: Observation = { view: null, disconnected: false };
const entries = new Map<string, Entry>();
const operationListeners = new Set<(mediaId: string) => void>();
// Jobs this tab admitted: a first frame showing one already completed is a
// change this tab made, not its baseline.
const admitted = new Set<string>();

function entryFor(mediaId: string): Entry {
  const entry = entries.get(mediaId) ?? {
    snapshot: EMPTY,
    listeners: new Set(),
    stop: null,
  };
  entries.set(mediaId, entry);
  return entry;
}

function publish(entry: Entry, snapshot: Observation): void {
  entry.snapshot = snapshot;
  for (const listener of entry.listeners) listener();
}

function connect(mediaId: string, entry: Entry): void {
  entry.stop = sseClientDirect<MetadataEnrichmentView>({
    path: `/stream/media/${encodeURIComponent(mediaId)}/metadata/events`,
    decode: (type, data) => {
      if (type !== "state") {
        // justify-defect: this same-deploy endpoint has one registered event type.
        throw new TypeError(`Unknown metadata event: ${type}`);
      }
      return data as MetadataEnrichmentView;
    },
    // Absent and settled operations must keep observing later automatic jobs.
    isTerminal: () => false,
    onEvent: (view) => {
      const previous = entry.snapshot.view;
      const previousStamp =
        previous?.last_enriched_at.kind === "Present"
          ? previous.last_enriched_at.value
          : null;
      const stamp =
        view.last_enriched_at.kind === "Present"
          ? view.last_enriched_at.value
          : null;
      const operation =
        view.operation.kind === "Present" ? view.operation.value : null;
      // The first frame is this tab's baseline, unless it shows a run this tab
      // admitted already completed (it settled before the stream opened).
      const baseline =
        previous === null &&
        !(
          operation?.status === "completed" &&
          operation.outcome.completed_at === stamp &&
          admitted.has(operation.job_id)
        );
      publish(entry, { view, disconnected: false });
      for (const listener of operationListeners) listener(mediaId);
      if (baseline || stamp === null || stamp === previousStamp) return;
      // An older job can publish while a newer job is latest. Without its field
      // list, reconcile summaries conservatively through their existing owners.
      const summaryChanged =
        operation?.status !== "completed" ||
        operation.outcome.completed_at !== stamp ||
        operation.outcome.changed_fields.some(
          (field) =>
            field === "title" ||
            field === "contributors" ||
            field === "original_published_date",
        );
      if (summaryChanged) publishChange("Metadata");
    },
    onReconnect: async () => {
      publish(entry, { ...entry.snapshot, disconnected: true });
      return "continue";
    },
    // The stream is over: the next observer opens a new one.
    onError: () => {
      entry.stop = null;
      publish(entry, { ...entry.snapshot, disconnected: true });
    },
  });
}

/** Adds a listener to the media's one observer; the last to leave closes it. */
function observe(mediaId: string, listener: () => void): () => void {
  const entry = entryFor(mediaId);
  entry.listeners.add(listener);
  if (entry.stop === null) connect(mediaId, entry);
  return () => {
    entry.listeners.delete(listener);
    if (entry.listeners.size === 0) {
      entry.stop?.();
      entry.stop = null;
    }
  };
}

export function reconnectMetadataOperations(mediaId: string): void {
  const entry = entryFor(mediaId);
  entry.stop?.();
  entry.stop = null;
  if (entry.listeners.size > 0) connect(mediaId, entry);
}

export function useMediaMetadataOperations(
  mediaId: string | null,
): Observation {
  const subscribe = useCallback(
    (listener: () => void) =>
      mediaId === null ? () => {} : observe(mediaId, listener),
    [mediaId],
  );
  const getSnapshot = useCallback(
    () => (mediaId === null ? EMPTY : entryFor(mediaId).snapshot),
    [mediaId],
  );
  return useSyncExternalStore(subscribe, getSnapshot, () => EMPTY);
}

export function subscribeMetadataOperationChanges(
  listener: (mediaId: string) => void,
): () => void {
  operationListeners.add(listener);
  return () => {
    operationListeners.delete(listener);
  };
}

const reviewIntents = new Map<string, MutationIntent>();

/** One exact result; an uncertain response keeps the same mutation identity. */
export async function submitMetadataResultReview(
  mediaId: string,
  jobId: string,
): Promise<void> {
  const key = `${mediaId}:${jobId}`;
  let intent = reviewIntents.get(key);
  if (intent === undefined) {
    intent = createMutationIntent();
    reviewIntents.set(key, intent);
  }
  try {
    await apiFetch<
      ApiJson<"/media/{media_id}/metadata-enrichment/{job_id}/review", "post">
    >(
      `/api/media/${encodeURIComponent(mediaId)}/metadata-enrichment/${encodeURIComponent(jobId)}/review`,
      {
        method: "POST",
        body: JSON.stringify({
          client_mutation_id: intent.clientMutationId(jobId),
        }),
      },
    );
    intent.discard();
    reviewIntents.delete(key);
    publishImportsInvalidation();
    reconnectMetadataOperations(mediaId);
    for (const listener of operationListeners) listener(mediaId);
  } catch (error) {
    if (isApiError(error) && error.status >= 400 && error.status < 500) {
      intent.discard();
      reviewIntents.delete(key);
    }
    throw error;
  }
}
