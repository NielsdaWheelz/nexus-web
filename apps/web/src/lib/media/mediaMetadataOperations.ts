"use client";

// The metadata-research client: admission and one live observer per media (SSE
// `state` frames, never terminal); research that changes a summary field
// (title, contributors, first publication) publishes "Metadata" while the
// media is observed: by an open view, or by the tab that admitted the run.

import { useCallback, useSyncExternalStore } from "react";
import type { FeedbackContextValue } from "@/components/feedback/Feedback";
import { apiFetch, isApiError } from "@/lib/api/client";
import { publishChange } from "@/lib/api/changes";
import type { ApiJson, Schema } from "@/lib/api/wire";
import { publishImportsInvalidation } from "@/lib/imports/api";
import { openStream } from "@/lib/api/stream";
import { handleUnauthenticatedApiError } from "@/lib/auth/UnauthenticatedApiBoundary";

export type MetadataEnrichmentView = Schema<"MetadataEnrichmentView">;
export type MetadataOperation = Schema<"MetadataOperationOut">;

const SETTLED = new Set<MetadataOperation["status"]>([
  "completed",
  "no_findings",
  "failed",
]);

async function submitMetadataEnrichment(
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
    } else if (!snapshot.disconnected && latest != null) {
      const { job_id, status } = latest;
      if (job_id !== jobId || SETTLED.has(status)) stop();
    }
  });
  return response.data;
}

// A request whose outcome is unknown keeps its client id, keyed by what the viewer
// saw, so "confirm request" replays it exactly; a settling answer forgets it. An
// access reply (401/403/404) precedes the server's replay lookup, so it settles
// nothing.
const unconfirmed = new Map<string, string>();

/**
 * Admit metadata research for a media whose latest job the viewer saw as
 * `expectedJobId`. A refusal throws; acceptance and an unknown outcome are huds.
 */
export async function requestMetadataResearch(
  mediaId: string,
  expectedJobId: string | null,
  hud: { feedback: FeedbackContextValue; showMetadata: () => void },
): Promise<void> {
  const key = `${mediaId}|${expectedJobId}`;
  const clientMutationId = unconfirmed.get(key) ?? crypto.randomUUID();
  const hudKey = `metadata-request:${mediaId}`;
  const metadata = { label: "metadata…", onClick: hud.showMetadata };
  try {
    await submitMetadataEnrichment(mediaId, {
      client_mutation_id: clientMutationId,
      expected_job_id: expectedJobId,
    });
  } catch (error) {
    if (isApiError(error) && error.status >= 400 && error.status < 500) {
      if (![401, 403, 404].includes(error.status)) {
        unconfirmed.delete(key);
        hud.feedback.resolve(hudKey);
      }
      throw error;
    }
    unconfirmed.set(key, clientMutationId);
    const confirm = () =>
      void requestMetadataResearch(mediaId, expectedJobId, hud).catch(
        (refused: unknown) => {
          if (handleUnauthenticatedApiError(refused)) return;
          hud.feedback.publish({
            kind: "Hud",
            content: {
              tone: "Danger",
              title: "could not confirm metadata request",
              message: isApiError(refused) ? refused.message : undefined,
            },
          });
        },
      );
    hud.feedback.publish({
      kind: "Hud",
      key: hudKey,
      content: {
        tone: "Danger",
        title: "metadata request unconfirmed",
        message: "confirm this request to safely check whether it was queued",
      },
      actions: [{ label: "confirm request", onClick: confirm }, metadata],
    });
    return;
  }
  unconfirmed.delete(key);
  hud.feedback.publish({
    kind: "Hud",
    key: hudKey,
    content: { tone: "Neutral", title: "metadata request confirmed" },
    actions: [metadata],
  });
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
  entry.stop = openStream<MetadataEnrichmentView, MetadataEnrichmentView>({
    path: `/api/stream/media/${encodeURIComponent(mediaId)}/metadata/events`,
    decode: (type, data) => {
      if (type !== "state") {
        // justify-defect: this same-deploy endpoint has one registered event type.
        throw new TypeError(`Unknown metadata event: ${type}`);
      }
      return data;
    },
    // Absent and settled operations must keep observing later automatic jobs.
    isTerminal: () => false,
    onEvent: (view) => {
      const previous = entry.snapshot.view;
      const previousStamp =
        previous?.last_enriched_at != null ? previous.last_enriched_at : null;
      const stamp = view.last_enriched_at;
      const operation = view.operation;
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
    onReconnect: () => {
      publish(entry, { ...entry.snapshot, disconnected: true });
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

/**
 * Acknowledge one exact no-findings job for this viewer. The server answers a
 * repeat with the review already recorded, so a retry needs no frozen id.
 */
export async function submitMetadataResultReview(
  mediaId: string,
  jobId: string,
): Promise<void> {
  await apiFetch<
    ApiJson<"/media/{media_id}/metadata-enrichment/{job_id}/review", "post">
  >(
    `/api/media/${encodeURIComponent(mediaId)}/metadata-enrichment/${encodeURIComponent(jobId)}/review`,
    {
      method: "POST",
      body: JSON.stringify({ client_mutation_id: crypto.randomUUID() }),
    },
  );
  publishImportsInvalidation();
  reconnectMetadataOperations(mediaId);
}
