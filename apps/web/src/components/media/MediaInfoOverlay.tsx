"use client";

// The metadata overlay ("metadata…", J2): publication facts with linked, role-grouped
// credits; the live operation status; source; reading or listening; activity;
// availability. It rereads the media whenever a new enrichment stamp or a newly admitted
// title job arrives; a failed reread keeps the old values. Desktop dialog, mobile sheet.

import { useRef, type ReactNode } from "react";
import { FeedbackNotice, FeedbackState, FeedbackStatus } from "@/components/feedback/Feedback";
import { formatPublicationDate } from "@/lib/resources/metadata";
import InformationFrame from "@/components/resources/InformationFrame";
import { informationFact as fact, informationGroup as group } from "@/components/resources/InformationFacts";
import { apiFetch } from "@/lib/api/client";
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
import { useMediaProcessingStatus } from "@/lib/media/useMediaProcessingStatus";
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
import type { ReturnFocusTarget } from "@/lib/ui/overlay";
import { definePaneVisitDataKey } from "@/lib/workspace/paneReturnMemento";
import styles from "./MediaInfoOverlay.module.css";
import MetadataResearchActions from "./MetadataResearchActions";

const VISIT = definePaneVisitDataKey<Visit<MediaDetail>>("MediaInfo.Detail");
const COMPLETION = {
  Unread: "unread",
  InProgress: "in progress",
  Finished: "finished",
};

const link = (href: string | null): ReactNode =>
  href ? (
    <a href={href} dir="auto">
      {href}
    </a>
  ) : null;

const publication = (value: string | null): ReactNode =>
  value === null ? (
    "unknown"
  ) : (
    <time dateTime={value}>{formatPublicationDate(value)}</time>
  );

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
  const instant = (value: string | null | undefined): ReactNode =>
    value ? (
      <time dateTime={value}>
        {formatDisplayDate(value, display, {
          dateStyle: "medium",
          timeStyle: "short",
        })}
      </time>
    ) : null;
  const credits = groupContributorCredits(media.contributors);
  const publisherCredited = credits.some(
    (role) =>
      role.role === "publisher" &&
      role.credits.some((credit) => credit.label === media.publisher),
  );
  const sourceFailure = mediaErrorMessage({
    kind: "Source",
    processingStatus: media.processing_status,
    lastErrorCode: media.last_error_code,
    capabilities: media.capabilities,
    sourceUrl: media.canonical_source_url,
  });
  const retrievalFailure = mediaErrorMessage({
    kind: "Retrieval",
    retrievalStatus: media.retrieval_status,
  });
  const { duration, listening_state: listening } = media;
  const verb = duration?.modality === "Read" ? "read" : "listen";
  const operation = metadata.operation;
  const outcome = operation?.status === "completed" ? operation.outcome : null;
  const earlierRuns = earlierMetadataRuns(metadata);
  const unfinished = metadata.unfinished_operation;
  const bibliography = outcome?.purpose === "bibliography" ? outcome : null;
  const originalUnresolved =
    operation?.status === "no_findings" ||
    bibliography?.unresolved_fields.includes("original_published_date");
  const { requested_url: requested, canonical_url: canonical } = media;
  return (
    <div className={styles.content} aria-busy={refreshing || undefined}>
      <div className={styles.resourceTitle} dir="auto">
        {media.title}
      </div>
      {refreshError ? (
        <FeedbackNotice
          content={{ tone: "Warning", title: "couldn’t refresh metadata", message: "the last loaded values are still shown." }}
          announcement="Polite"
          actions={[{ label: "retry", onClick: onReread, busy: refreshing }]}
        />
      ) : null}
      {group("publication", [
        fact(
          "authors",
          selectMediaAuthors(media.contributors).length === 0
            ? "unknown"
            : null,
        ),
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
        fact("publisher", publisherCredited ? null : media.publisher),
        fact("first published", publication(media.original_published_date)),
        fact("this edition", publication(media.edition_published_date)),
        fact("isbn", media.edition_isbn),
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
          !originalUnresolved
            ? null
            : media.original_published_date === null
              ? "first publication remains unknown"
              : `first publication unverified; kept ${formatPublicationDate(media.original_published_date)}`,
        ),
        fact(
          "not established by this run",
          bibliography?.unresolved_fields
            .map((field) => METADATA_FIELD_LABELS[field])
            .join(", "),
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
          unfinished !== null && unfinished.job_id !== operation?.job_id ? (
            <>
              {metadataOperationSummary(unfinished)} ·{" "}
              <code>{unfinished.job_id}</code>
            </>
          ) : null,
        ),
        fact(
          "actions",
          <MetadataResearchActions mediaId={media.id} view={metadata} />,
        ),
        fact("requested", instant(operation?.created_at)),
        fact("started", instant(operation?.started_at)),
        fact(
          "finished",
          instant(
            operation?.status === "completed"
              ? operation.outcome.completed_at
              : operation?.status === "no_findings" ||
                  operation?.status === "failed"
                ? operation.completed_at
                : null,
          ),
        ),
        fact(
          "next retry",
          instant(operation?.status === "waiting" ? operation.until : null),
        ),
        fact("operation id", operation?.job_id),
        fact("generation id", operation?.generation_id),
        fact(
          "reviewed",
          instant(
            operation?.status === "no_findings" ? operation.reviewed_at : null,
          ),
        ),
        fact(
          "model",
          operation?.selection
            ? `${operation.selection.route} / ${operation.selection.model} / ${operation.selection.reasoning}`
            : null,
        ),
        fact(
          "live status",
          disconnected ? (
            <FeedbackNotice
              content={{ tone: "Warning", title: "metadata updates disconnected" }}
              announcement="Polite"
              actions={[{ label: "reconnect", onClick: () => reconnectMetadataOperations(media.id) }]}
            />
          ) : null,
        ),
      ])}
      {group("source", [
        fact("media type", media.kind.replaceAll("_", " ")),
        fact("provider", media.provider ?? "not recorded"),
        fact("provider id", media.provider_id),
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
        fact("source url", link(media.canonical_source_url)),
        fact(
          requested === canonical
            ? "requested and canonical url"
            : "requested url",
          link(requested !== media.canonical_source_url ? requested : null),
        ),
        fact(
          "canonical url",
          link(
            canonical !== media.canonical_source_url && canonical !== requested
              ? canonical
              : null,
          ),
        ),
      ])}
      {group("reading/listening", [
        fact("completion", COMPLETION[media.consumption.state]),
        fact(
          "saved position",
          media.consumption.progress === null
            ? null
            : `${Math.round(media.consumption.progress * 100)}%`,
        ),
        fact(
          "current playback position",
          listening
            ? `${Math.floor(listening.position_ms / 60000)}:${String(Math.floor(listening.position_ms / 1000) % 60).padStart(2, "0")}`
            : null,
        ),
        fact(
          "total duration",
          duration ? `${duration.estimate.total_minutes} min to ${verb}` : null,
        ),
        fact(
          "remaining duration",
          duration?.estimate.remaining_minutes != null
            ? `${duration.estimate.remaining_minutes} min left to ${verb}`
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
        fact("transcript origin", media.transcript_origin),
        fact("transcript coverage", media.transcript_coverage),
        fact("search and ai", retrievalFailure
          ? <FeedbackStatus content={retrievalFailure} announcement="Polite" />
          : media.retrieval_status === "ready" ? "available" : null),
        fact(
          "processing failure",
          sourceFailure
            ? <FeedbackNotice content={sourceFailure} announcement="Polite" />
            : null,
        ),
      ])}
    </div>
  );
}

export default function MediaInfoOverlay({
  open,
  mediaId,
  returnFocusTo,
  returnFocusFallback,
  skipReturnFocus,
  onClose,
}: {
  readonly open: boolean;
  readonly mediaId: string;
  readonly returnFocusTo: ReturnFocusTarget;
  readonly returnFocusFallback: ReturnFocusTarget;
  readonly skipReturnFocus?: () => boolean;
  readonly onClose: () => void;
}) {
  const contentRoot = useRef<HTMLDivElement>(null);
  const observation = useMediaMetadataOperations(open ? mediaId : null);
  const processing = useMediaProcessingStatus(open ? mediaId : null);
  const view = observation.view;
  const titleJob =
    view?.operation?.purpose === "title" ? view.operation.job_id : "";
  const media = useServerValue({
    key: open ? `/media/${mediaId}` : null,
    // New source publication admits a title job before naming can succeed or fail.
    stale: `${view?.last_enriched_at ?? ""}:${titleJob}`,
    visit: VISIT,
    load: async (signal) =>
      mediaDetailFromResponse(
        await apiFetch<ApiJson<"/media/{media_id}", "get">>(
          `/api/media/${encodeURIComponent(mediaId)}`,
          { signal },
        ),
        mediaId,
      ),
  });
  const content =
    media.status === "loading" ? (
      <FeedbackState content={{ tone: "Neutral", title: "loading metadata…" }} announcement="Polite" />
    ) : media.status === "failed" ? (
      <FeedbackState
        content={{ tone: "Danger", title: "couldn’t load metadata", requestId: media.error.requestId }}
        announcement="Polite"
        actions={[{ label: "retry", onClick: media.refetch, busy: media.retrying }]}
        returnFocus={() => contentRoot.current}
      />
    ) : (
      <MediaInfo
        media={processing.snapshot ? { ...media.data, ...processing.snapshot } : media.data}
        metadata={observation.view ?? media.data.metadata_enrichment}
        disconnected={observation.disconnected}
        refreshing={media.refreshing}
        refreshError={media.error !== null}
        onReread={media.refetch}
      />
    );
  return <InformationFrame open={open} title="metadata" returnFocusTo={returnFocusTo}
    returnFocusFallback={returnFocusFallback} skipReturnFocus={skipReturnFocus} onClose={onClose} contentRef={contentRoot}>
    {content}
  </InformationFrame>;
}
