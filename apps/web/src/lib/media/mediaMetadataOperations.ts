"use client";

import { useCallback, useSyncExternalStore } from "react";
import { apiFetch } from "@/lib/api/client";
import type { ApiJson, Schema } from "@/lib/api/wire";
import { sseClientDirect } from "@/lib/api/sse-client";
import { fetchStreamToken } from "@/lib/api/streamToken";

export type MetadataEnrichmentView = Schema<"MetadataEnrichmentView">;
export type MetadataOperation = Schema<"MetadataOperationOut">;

export async function submitMetadataEnrichment(
  mediaId: string,
  request: Schema<"MetadataEnrichmentRequest">,
): Promise<Schema<"MetadataEnrichmentAccepted">> {
  const response = await apiFetch<ApiJson<"/media/{media_id}/metadata-enrichment", "post">>(
    `/api/media/${encodeURIComponent(mediaId)}/metadata-enrichment`,
    { method: "POST", body: JSON.stringify(request) },
  );
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
const collectionListeners = new Set<() => void>();
let collectionRevision = 0;

function entryFor(mediaId: string): Entry {
  let entry = entries.get(mediaId);
  if (!entry) {
    entry = { snapshot: EMPTY, listeners: new Set(), stop: null };
    entries.set(mediaId, entry);
  }
  return entry;
}

function publish(entry: Entry, snapshot: Observation): void {
  entry.snapshot = snapshot;
  for (const listener of entry.listeners) listener();
}

function connect(mediaId: string, entry: Entry): void {
  entry.stop = sseClientDirect<MetadataEnrichmentView>({
    initialConnection: async () => {
      const connection = await fetchStreamToken();
      return {
        url: `${connection.stream_base_url}/stream/media/${encodeURIComponent(mediaId)}/metadata/events`,
        token: connection.token,
      };
    },
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
      const previousStamp = previous?.last_enriched_at.kind === "Present"
        ? previous.last_enriched_at.value : null;
      const stamp = view.last_enriched_at.kind === "Present" ? view.last_enriched_at.value : null;
      publish(entry, { view, disconnected: false });
      for (const listener of operationListeners) listener(mediaId);
      if (stamp === null || stamp === previousStamp) return;
      const operation = view.operation.kind === "Present" ? view.operation.value : null;
      // An older job can publish while a newer job is latest. Without its field
      // list, reconcile summaries conservatively through their existing owners.
      const summaryChanged = operation?.status !== "completed"
        || operation.outcome.completed_at !== stamp
        || operation.outcome.changed_fields.some((field) =>
          field === "title" || field === "contributors" || field === "original_published_date");
      if (summaryChanged) {
        collectionRevision += 1;
        for (const listener of collectionListeners) listener();
      }
    },
    onReconnect: async () => {
      publish(entry, { ...entry.snapshot, disconnected: true });
      return "continue";
    },
    onError: () => publish(entry, { ...entry.snapshot, disconnected: true }),
  });
}

export function reconnectMetadataOperations(mediaId: string): void {
  const entry = entryFor(mediaId);
  entry.stop?.();
  entry.stop = null;
  if (entry.listeners.size > 0) connect(mediaId, entry);
}

export function useMediaMetadataOperations(mediaId: string | null): Observation {
  const subscribe = useCallback((listener: () => void) => {
    if (mediaId === null) return () => {};
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
  }, [mediaId]);
  const getSnapshot = useCallback(() => mediaId === null ? EMPTY : entryFor(mediaId).snapshot, [mediaId]);
  return useSyncExternalStore(subscribe, getSnapshot, () => EMPTY);
}

export function subscribeMetadataOperationChanges(listener: (mediaId: string) => void): () => void {
  operationListeners.add(listener);
  return () => { operationListeners.delete(listener); };
}

export function metadataCollectionSnapshot(): number { return collectionRevision; }

export function useMetadataCollectionRevision(): number {
  return useSyncExternalStore(
    (listener) => {
      collectionListeners.add(listener);
      return () => { collectionListeners.delete(listener); };
    },
    metadataCollectionSnapshot,
    () => 0,
  );
}

export const METADATA_FIELD_LABELS = {
  title: "title",
  contributors: "contributors",
  original_published_date: "first publication",
  edition_published_date: "edition publication",
  edition_isbn: "isbn",
  publisher: "publisher",
  language: "language",
  description: "description",
} satisfies Record<Schema<"MetadataField">, string>;

export const METADATA_FAILURE_COPY = {
  catalog_unavailable: "the model catalog is unavailable",
  configuration_error: "metadata research is not configured",
  model_unavailable: "the selected model is unavailable",
  authentication_failed: "the provider needs authentication",
  quota_unavailable: "the provider has no available quota",
  research_timeout: "metadata research timed out",
  invalid_output: "the research result was invalid and was not applied",
  input_too_large: "the identifying metadata exceeds the research input limit",
  output_limit: "the research result exceeded the output limit",
  stale_input: "research result was not applied; the source or credits changed",
  no_longer_eligible: "this item is no longer eligible for metadata research",
  access_revoked: "access changed; the research result was not applied",
  cancelled: "metadata research was cancelled",
  policy_violation: "the research request could not be executed",
  worker_interrupted: "metadata research was interrupted",
  execution_failed: "metadata research could not be completed",
} satisfies Record<Schema<"MetadataFailureCode">, string>;

export const METADATA_RETRY_BLOCKED_COPY = {
  not_creator: "only the creator can re-enrich metadata",
  not_eligible: "this item is not eligible for metadata research",
  active: "metadata research is already in progress",
  uncertain: "execution unresolved; retry unavailable",
} satisfies Record<Schema<"MetadataRetryBlocked">["reason"], string>;

export function metadataOperationSummary(operation: MetadataOperation): string {
  switch (operation.status) {
    case "queued": return "queued";
    case "running": return "researching metadata";
    case "recovering": return "recovering metadata research";
    case "uncertain": return "execution unresolved; retry unavailable";
    case "waiting": return "waiting to retry";
    case "no_findings": return "no metadata found";
    case "failed": return "metadata research failed";
    case "completed":
      return operation.outcome.changed_fields.length === 0 ? "no changes"
        : `updated: ${operation.outcome.changed_fields.map((field) => METADATA_FIELD_LABELS[field]).join(", ")}`;
  }
}
