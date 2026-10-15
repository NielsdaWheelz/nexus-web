"use client";

// Metadata research on the client: admission, review, and one live view per media. The
// server's metadata stream ends once nothing is unfinished, so a view is followed while
// research can change it: from a mount (one short read when idle), an admission (answered
// or lost), a review, a reconnect or a settled import, to its run's end even after its
// pane closes. A new stamp whose run changed a summary field publishes "Metadata".

import { useCallback, useSyncExternalStore } from "react";
import type { FeedbackContextValue } from "@/components/feedback/Feedback";
import { apiFetch, isApiError } from "@/lib/api/client";
import { publishChange } from "@/lib/api/changes";
import { openStream } from "@/lib/api/stream";
import type { ApiJson, Schema } from "@/lib/api/wire";
import { handleUnauthenticatedApiError } from "@/lib/auth/UnauthenticatedApiBoundary";
import { publishImportsInvalidation } from "@/lib/imports/api";

export type MetadataEnrichmentView = Schema<"MetadataEnrichmentView">;
export type MetadataOperation = Schema<"MetadataOperationOut">;

interface Observation {
  readonly view: MetadataEnrichmentView | null;
  readonly disconnected: boolean;
}
interface Entry {
  snapshot: Observation;
  /** The last enrichment stamp this tab knew; undefined before the first. */
  stamp: string | null | undefined;
  stop: (() => void) | null;
  readonly listeners: Set<() => void>;
}
const EMPTY: Observation = { view: null, disconnected: false };
const entries = new Map<string, Entry>();
const SUMMARY_FIELDS = new Set<string>([
  "title",
  "contributors",
  "original_published_date",
]);

function entryFor(mediaId: string): Entry {
  let entry = entries.get(mediaId);
  if (entry === undefined) {
    entry = {
      snapshot: EMPTY,
      stamp: undefined,
      stop: null,
      listeners: new Set(),
    };
    entries.set(mediaId, entry);
  }
  return entry;
}

function show(entry: Entry, snapshot: Observation): void {
  entry.snapshot = snapshot;
  for (const listener of entry.listeners) listener();
}

function receive(entry: Entry, view: MetadataEnrichmentView): void {
  const known = entry.stamp;
  entry.stamp = view.last_enriched_at;
  show(entry, { view, disconnected: false });
  if (known === undefined || view.last_enriched_at === known) return;
  // An older job can land while a newer one is latest: without its fields, assume a change.
  const latest = view.operation;
  const fields =
    latest?.status === "completed" &&
    latest.outcome.completed_at === view.last_enriched_at
      ? latest.outcome.changed_fields
      : null;
  if (fields === null || fields.some((field) => SUMMARY_FIELDS.has(field)))
    publishChange("Metadata");
}

/** Open the media's stream unless one runs; `restart` replaces a running one. */
function follow(mediaId: string, restart = false): void {
  const entry = entryFor(mediaId);
  if (entry.stop !== null && !restart) return;
  entry.stop?.();
  entry.stop = openStream<MetadataEnrichmentView, MetadataEnrichmentView>({
    path: `/api/stream/media/${encodeURIComponent(mediaId)}/metadata/events`,
    decode: (_type, view) => view,
    isTerminal: (view) => view.unfinished_count === 0,
    onEvent: (view) => receive(entry, view),
    onComplete: () => {
      entry.stop = null;
    },
    onReconnect: () => show(entry, { ...entry.snapshot, disconnected: true }),
    onError: () => {
      entry.stop = null;
      show(entry, { ...entry.snapshot, disconnected: true });
    },
  });
}

/** Read the media's view again and follow any unfinished research. */
export function reconnectMetadataOperations(mediaId: string): void {
  follow(mediaId, true);
}

/** The media's live view; mounting reads it once more. */
export function useMediaMetadataOperations(
  mediaId: string | null,
): Observation {
  const subscribe = useCallback(
    (listener: () => void) => {
      if (mediaId === null) return () => {};
      const entry = entryFor(mediaId);
      entry.listeners.add(listener);
      follow(mediaId);
      return () => entry.listeners.delete(listener);
    },
    [mediaId],
  );
  const snapshot = useCallback(
    () => (mediaId === null ? EMPTY : entryFor(mediaId).snapshot),
    [mediaId],
  );
  return useSyncExternalStore(subscribe, snapshot, () => EMPTY);
}

/**
 * Start research from the latest job the viewer saw. A refusal throws; acceptance and an
 * unknown outcome are huds, and the view is read again either way (a lost answer may hide
 * a landed run). "confirm request" resends the same expectation, which the retry rule
 * answers with the run that landed. An access reply (401/403/404) settles nothing.
 */
export async function requestMetadataResearch(
  mediaId: string,
  expectedJobId: string | null,
  hud: { feedback: FeedbackContextValue; showMetadata: () => void },
): Promise<void> {
  const hudKey = `metadata-request:${mediaId}`;
  const metadata = { label: "metadata…", onClick: hud.showMetadata };
  try {
    const { data } = await apiFetch<
      ApiJson<"/media/{media_id}/metadata-enrichment", "post">
    >(`/api/media/${encodeURIComponent(mediaId)}/metadata-enrichment`, {
      method: "POST",
      body: JSON.stringify({ expected_job_id: expectedJobId }),
    });
    // The stamp the run started from: a run landing before the first frame still counts.
    const entry = entryFor(mediaId);
    if (entry.stamp === undefined) entry.stamp = data.last_enriched_at;
  } catch (error) {
    if (isApiError(error) && error.status >= 400 && error.status < 500) {
      if (![401, 403, 404].includes(error.status)) hud.feedback.resolve(hudKey);
      throw error;
    }
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
  } finally {
    follow(mediaId, true);
    publishImportsInvalidation();
  }
  hud.feedback.publish({
    kind: "Hud",
    key: hudKey,
    content: { tone: "Neutral", title: "metadata request confirmed" },
    actions: [metadata],
  });
}

/** Mark one no-findings result reviewed for this viewer; a repeat is a no-op. */
export async function submitMetadataResultReview(
  mediaId: string,
  jobId: string,
): Promise<void> {
  await apiFetch(
    `/api/media/${encodeURIComponent(mediaId)}/metadata-enrichment/${encodeURIComponent(jobId)}/review`,
    { method: "POST" },
  );
  publishImportsInvalidation();
  follow(mediaId, true);
}
