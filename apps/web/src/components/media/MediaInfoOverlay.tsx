"use client";

// The metadata overlay ("metadata…"): publication facts with linked,
// role-grouped credits, live operation status, source, reading or listening,
// activity and availability. A successful enrichment or newly admitted title
// job rereads the media; a failed reread keeps the old values.

import type { ReactNode } from "react";
import { formatCollectionPublicationDate } from "@/components/collections/collectionRowFormatting";
import Button from "@/components/ui/Button";
import Dialog from "@/components/ui/Dialog";
import MobileSheet from "@/components/ui/MobileSheet";
import { apiFetch, type ApiPath } from "@/lib/api/client";
import { useServerValue, type Visit } from "@/lib/api/serverState";
import type { ApiJson } from "@/lib/api/wire";
import {
  groupContributorCredits,
  selectMediaAuthors,
} from "@/lib/contributors/credits";
import { formatDisplayDate } from "@/lib/display/format";
import {
  mediaDetailFromResponse,
  type MediaDetail,
} from "@/lib/media/mediaDetail";
import { mediaErrorMessage } from "@/lib/media/mediaErrorMessage";
import {
  METADATA_FAILURE_COPY,
  METADATA_FIELD_LABELS,
  METADATA_REVIEW_HELP,
  X_TITLE_CONTEXT_HELP,
  earlierMetadataRuns,
  metadataOperationName,
  metadataOperationSummary,
  metadataRetryBlockedCopy,
  xSourceCoverage,
} from "@/lib/media/mediaMetadataCopy";
import {
  reconnectMetadataOperations,
  useMediaMetadataOperations,
  type MetadataEnrichmentView,
} from "@/lib/media/mediaMetadataOperations";
import { useRenderEnvironment } from "@/lib/renderEnvironment/provider";
import { useIsMobileViewport } from "@/lib/ui/useIsMobileViewport";
import type { ReturnFocusTarget } from "@/lib/ui/overlay";
import { definePaneVisitDataKey } from "@/lib/workspace/paneReturnMemento";
import styles from "./MediaInfoOverlay.module.css";
import MetadataResearchActions from "./MetadataResearchActions";

const VISIT = definePaneVisitDataKey<Visit<MediaDetail>>("MediaInfo.Detail");

function fact(label: string, value: ReactNode): ReactNode {
  if (value === null || value === undefined || value === "") return null;
  return (
    <div className={styles.fact} key={label}>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

function group(title: string, facts: readonly ReactNode[]): ReactNode {
  if (facts.every((value) => value === null)) return null;
  return (
    <section className={styles.group} key={title}>
      <h3>{title}</h3>
      <dl>{facts}</dl>
    </section>
  );
}

function publicationDate(
  value: MediaDetail["original_published_date"],
): ReactNode {
  if (value === null) return "unknown";
  return (
    <time dateTime={value}>
      {formatCollectionPublicationDate(value)}
    </time>
  );
}

function MediaInfo({
  media,
  metadata,
  disconnected,
  refreshing,
  refreshError,
  onReread,
}: {
  readonly media: MediaDetail;
  readonly metadata: MetadataEnrichmentView;
  readonly disconnected: boolean;
  readonly refreshing: boolean;
  readonly refreshError: boolean;
  readonly onReread: () => void;
}) {
  const display = useRenderEnvironment();
  const instant = (value: string | null): ReactNode =>
    value ? (
      <time dateTime={value}>
        {formatDisplayDate(value, display, {
          dateStyle: "medium",
          timeStyle: "short",
        })}
      </time>
    ) : null;
  const authors = selectMediaAuthors(media.contributors);
  const credits = groupContributorCredits(media.contributors);
  const publisherAlreadyCredited = credits.some(
    (group) =>
      group.role === "publisher" &&
      group.credits.some((credit) => credit.label === media.publisher),
  );
  const sourceFailure = mediaErrorMessage({
    kind: "Source",
    processingStatus: media.processing_status,
    lastErrorCode: media.last_error_code,
    capabilities: { can_retry: media.capabilities.can_retry },
    sourceUrl: media.canonical_source_url,
  });
  const retrievalFailure = mediaErrorMessage({
    kind: "Retrieval",
    retrievalStatus: media.retrieval_status,
  });
  const duration = media.duration;
  const requestedUrl = media.requested_url;
  const canonicalUrl = media.canonical_url;
  const operation = metadata.operation;
  const outcome = operation?.status === "completed" ? operation.outcome : null;
  const earlierRuns = earlierMetadataRuns(metadata);
  const originalUnresolved =
    operation?.status === "no_findings" ||
    (outcome?.purpose === "bibliography" &&
      outcome.unresolved_fields.includes("original_published_date"));
  const completedAt =
    operation?.status === "completed"
      ? operation.outcome.completed_at
      : operation?.status === "no_findings" || operation?.status === "failed"
        ? operation.completed_at
        : null;
  return (
    <div className={styles.content} aria-busy={refreshing || undefined}>
      <div className={styles.resourceTitle} dir="auto">
        {media.title}
      </div>
      {refreshError ? (
        <div className={styles.refreshNotice}>
          <p role="alert">metadata updated; couldn’t load current values</p>
          <Button variant="secondary" onClick={onReread}>
            reload metadata
          </Button>
        </div>
      ) : null}
      {group("publication", [
        authors.length === 0 ? fact("authors", "unknown") : null,
        ...credits.map((role) =>
          fact(
            role.label,
            role.credits.map((credit, index) => (
              <span key={`${credit.label}-${index}`}>
                {index > 0 ? ", " : null}
                {credit.href ? (
                  <a href={credit.href} dir="auto">
                    {credit.label}
                  </a>
                ) : (
                  <span dir="auto">{credit.label}</span>
                )}
              </span>
            )),
          ),
        ),
        fact("publisher", publisherAlreadyCredited ? null : media.publisher),
        fact("first published", publicationDate(media.original_published_date)),
        fact("this edition", publicationDate(media.edition_published_date)),
        fact(
          "isbn",
          media.edition_isbn,
        ),
        fact("language", media.language),
        fact("description", media.description),
      ])}
      {group(metadataOperationName(operation?.purpose ?? metadata.retry.purpose), [
        fact(
          "status",
          <span aria-live="polite" aria-atomic="true">
            {operation
              ? metadataOperationSummary(operation)
              : `no recorded ${metadataOperationName(metadata.retry.purpose)}`}
          </span>,
        ),
        fact(
          "first publication",
          originalUnresolved
            ? media.original_published_date === null
              ? "first publication remains unknown"
              : `first publication unverified; kept ${formatCollectionPublicationDate(media.original_published_date)}`
            : null,
        ),
        fact(
          "not established by this run",
          outcome?.purpose === "bibliography" && outcome.unresolved_fields.length > 0
            ? outcome.unresolved_fields
                .map((field) => METADATA_FIELD_LABELS[field])
                .join(", ")
            : null,
        ),
        fact(
          "authors",
          outcome?.purpose === "bibliography" && outcome.retained_manual_authors
            ? "kept manually set authors"
            : null,
        ),
        fact(
          "explanation",
          operation?.status === "failed"
            ? METADATA_FAILURE_COPY[operation.code]
            : null,
        ),
        fact(
          `${metadataOperationName(metadata.retry.purpose)} availability`,
          metadata.retry.status === "blocked"
            ? metadataRetryBlockedCopy(metadata.retry)
            : "available",
        ),
        fact(
          "title evidence",
          metadata.retry.purpose === "title" ? X_TITLE_CONTEXT_HELP : null,
        ),
        fact(
          "review",
          operation?.status === "no_findings" && operation.reviewed_at === null
            ? METADATA_REVIEW_HELP
            : null,
        ),
        fact(
          "earlier work",
          earlierRuns > 0
            ? `${earlierRuns} earlier metadata ${earlierRuns === 1 ? "run remains" : "runs remain"} unfinished`
            : null,
        ),
        fact(
          "unfinished operation",
          metadata.unfinished_operation !== null &&
            metadata.unfinished_operation.job_id !== operation?.job_id ? (
            <>
              {metadataOperationSummary(metadata.unfinished_operation)} ·{" "}
              <code>{metadata.unfinished_operation.job_id}</code>
            </>
          ) : null,
        ),
        fact(
          "actions",
          <MetadataResearchActions mediaId={media.id} view={metadata} />,
        ),
        fact("requested", operation ? instant(operation.created_at) : null),
        fact(
          "started",
          operation?.started_at != null
            ? instant(operation.started_at)
            : null,
        ),
        fact("finished", instant(completedAt)),
        fact(
          "next retry",
          operation?.status === "waiting" && operation.until !== null
            ? instant(operation.until)
            : null,
        ),
        fact("operation id", operation?.job_id),
        fact(
          "generation id",
          operation?.generation_id,
        ),
        fact(
          "reviewed",
          operation?.status === "no_findings" && operation.reviewed_at !== null
            ? instant(operation.reviewed_at)
            : null,
        ),
        fact(
          "model",
          operation?.selection != null
            ? `${operation.selection.provider} / ${operation.selection.model} / ${operation.selection.reasoning}`
            : null,
        ),
        fact(
          "live status",
          disconnected ? (
            <div className={styles.refreshNotice}>
              <span>live status disconnected</span>
              <Button
                variant="secondary"
                onClick={() => reconnectMetadataOperations(media.id)}
              >
                reconnect
              </Button>
            </div>
          ) : null,
        ),
      ])}
      {group("source", [
        fact("media type", media.kind.replaceAll("_", " ")),
        fact(
          "provider",
          media.provider !== null
            ? media.provider
            : "not recorded",
        ),
        fact(
          "provider id",
          media.provider_id,
        ),
        fact(
          "captured context",
          media.x_source_context !== null
            ? xSourceCoverage(media.x_source_context)
            : null,
        ),
        fact(
          "captured",
          media.x_source_context !== null
            ? instant(media.x_source_context.published_at)
            : null,
        ),
        fact(
          "source url",
          media.canonical_source_url ? (
            <a href={media.canonical_source_url} dir="auto">
              {media.canonical_source_url}
            </a>
          ) : null,
        ),
        fact(
          requestedUrl === canonicalUrl
            ? "requested and canonical url"
            : "requested url",
          requestedUrl !== null &&
            requestedUrl !== media.canonical_source_url ? (
            <a href={requestedUrl} dir="auto">
              {requestedUrl}
            </a>
          ) : null,
        ),
        fact(
          "canonical url",
          canonicalUrl !== null &&
            canonicalUrl !== media.canonical_source_url &&
            canonicalUrl !== requestedUrl ? (
            <a href={canonicalUrl} dir="auto">
              {canonicalUrl}
            </a>
          ) : null,
        ),
      ])}
      {group("reading/listening", [
        fact("completion", media.read_state?.replaceAll("_", " ")),
        fact(
          "reading progress",
          media.progress_fraction === null
            ? null
            : `${Math.round(media.progress_fraction * 100)}%`,
        ),
        fact(
          "current playback position",
          media.listening_state
            ? `${Math.floor(media.listening_state.position_ms / 60000)}:${String(Math.floor(media.listening_state.position_ms / 1000) % 60).padStart(2, "0")}`
            : null,
        ),
        fact(
          "total duration",
          duration
            ? `${duration.estimate.total_minutes} min to ${duration.modality === "Read" ? "read" : "listen"}`
            : null,
        ),
        fact(
          "remaining duration",
          duration?.estimate.remaining_minutes != null
            ? `${duration.estimate.remaining_minutes} min left to ${duration.modality === "Read" ? "read" : "listen"}`
            : null,
        ),
      ])}
      {group("activity", [
        fact("record created", instant(media.created_at)),
        fact("record updated", instant(media.updated_at)),
        fact("metadata enriched", instant(media.metadata_enriched_at)),
        fact("last engaged", instant(media.last_engaged_at)),
      ])}
      {group("availability", [
        fact("processing", media.processing_status.replaceAll("_", " ")),
        fact("transcript state", media.transcript_state?.replaceAll("_", " ")),
        fact(
          "transcript origin",
          media.transcript_origin,
        ),
        fact("transcript coverage", media.transcript_coverage),
        fact("retrieval availability", media.retrieval_status),
        fact("retrieval reason", media.retrieval_status_reason),
        fact(
          "processing failure",
          sourceFailure
            ? `${sourceFailure.title} ${sourceFailure.explanation}`
            : null,
        ),
        fact("retrieval explanation", retrievalFailure?.explanation),
      ])}
    </div>
  );
}

export default function MediaInfoOverlay({
  open,
  mediaId,
  returnFocusTo,
  returnFocusFallback,
  onClose,
}: {
  readonly open: boolean;
  readonly mediaId: string;
  readonly returnFocusTo: ReturnFocusTarget;
  readonly returnFocusFallback: ReturnFocusTarget;
  readonly onClose: () => void;
}) {
  const isMobile = useIsMobileViewport();
  const observation = useMediaMetadataOperations(open ? mediaId : null);
  const stamp = observation.view?.last_enriched_at;
  const operation = observation.view?.operation;
  const titleJob =
    operation?.purpose === "title" ? operation.job_id : "";
  const media = useServerValue({
    key: open ? mediaId : null,
    // New source publication admits a title job before naming can succeed or fail.
    stale: `${stamp ?? ""}:${titleJob}`,
    visit: VISIT,
    load: async (signal) =>
      mediaDetailFromResponse(
        await apiFetch<ApiJson<"/media/{media_id}", "get">>(
          `/api/media/${encodeURIComponent(mediaId)}` as ApiPath,
          { signal },
        ),
        mediaId,
      ),
  });
  const content =
    media.status === "loading" ? (
      <p role="status">loading metadata…</p>
    ) : media.status === "failed" ? (
      <div className={styles.refreshNotice}>
        <p role="alert">couldn’t load metadata</p>
        <Button variant="secondary" onClick={media.refetch}>
          try again
        </Button>
      </div>
    ) : (
      <MediaInfo
        media={media.data}
        metadata={observation.view ?? media.data.metadata_enrichment}
        disconnected={observation.disconnected}
        refreshing={media.refreshing}
        refreshError={media.error !== null}
        onReread={media.refetch}
      />
    );
  return isMobile ? (
    <MobileSheet
      active={open}
      onDismiss={onClose}
      ariaLabel="metadata"
      returnFocusTo={returnFocusTo}
      returnFocusFallback={returnFocusFallback}
    >
      <h2 className={styles.sheetTitle}>metadata</h2>
      {content}
    </MobileSheet>
  ) : (
    <Dialog
      open={open}
      onClose={onClose}
      title="metadata"
      returnFocusTo={returnFocusTo}
      returnFocusFallback={returnFocusFallback}
    >
      {content}
    </Dialog>
  );
}
