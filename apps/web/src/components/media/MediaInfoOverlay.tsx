"use client";

// The metadata overlay ("metadata…", J2): publication facts with linked, role-grouped
// credits, source edition for pieces, the live operation status, source, reading or listening, activity,
// availability. It rereads the media whenever a new enrichment stamp or a newly admitted
// title job arrives; a failed reread keeps the old values. Desktop dialog, mobile sheet.

import { useRef, type ReactNode } from "react";
import { Fact, Failed } from "@/components/feedback/Fact";
import { Ruling } from "@/components/feedback/Ruling";
import { useTransportVerbs, type Line } from "@/components/feedback/stage";
import { TRANSPORT_LINES, transportOf } from "@/lib/api/failure";
import { formatPublicationDate } from "@/lib/resources/metadata";
import InformationFrame from "@/components/resources/InformationFrame";
import { informationFact as fact, informationGroup as group } from "@/components/resources/InformationFacts";
import { useChangeStamp } from "@/lib/api/changes";
import { useRefreshStamp } from "@/lib/consumption/refresh";
import { apiFetch } from "@/lib/api/client";
import { useServerValue, type Visit } from "@/lib/api/serverState";
import { useObservationDemand } from "@/lib/api/useObservationDemand";
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
import { mediaSearchLine, mediaSourceLine } from "@/lib/media/mediaErrorMessage";
import {
  METADATA_FAILURE_COPY,
  X_TITLE_CONTEXT_HELP,
  earlierMetadataRuns,
  metadataOperationName,
  metadataOperationSummary,
  metadataRetryBlockedCopy,
  xSourceCoverage,
} from "@/lib/media/mediaMetadataCopy";
import {
  reconnectMetadataOperation,
  useMetadataOperation,
  useMediaObservation,
  type MetadataEnrichmentView,
  type MetadataOperation,
} from "@/lib/media/mediaMetadataOperations";
import { useRenderEnvironment } from "@/lib/renderEnvironment/provider";
import type { ReturnFocusTarget } from "@/lib/ui/overlay";
import { definePaneVisitDataKey } from "@/lib/workspace/paneReturnMemento";
import styles from "./MediaInfoOverlay.module.css";
import MetadataResearchResult from "./MetadataResearchResult";
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

/** A line in a facts table is plain row text. */
const rowText = ({ fact, reason }: Line) => reason ? `${fact} ${reason}` : fact;

function instant(display: ReturnType<typeof useRenderEnvironment>, value: string | null): ReactNode {
  return value ? <time dateTime={value}>{formatDisplayDate(value, display, {
    dateStyle: "medium", timeStyle: "short",
  })}</time> : null;
}

function MediaInfo({ media, pinned, readStatus, children }: {
  readonly media: MediaDetail;
  readonly pinned: boolean;
  readonly readStatus: ReactNode;
  readonly children: ReactNode;
}) {
  const display = useRenderEnvironment();
  const credits = groupContributorCredits(media.contributors);
  const publisherCredited = credits.some(
    (role) =>
      role.role === "publisher" &&
      role.credits.some((credit) => credit.label === media.publisher),
  );
  const sourceFailure = mediaSourceLine(media.processing_status, media.last_error_code);
  const searchState = mediaSearchLine(media.retrieval_status, media.text_search_ready);
  const { duration, listening_state: listening } = media;
  const verb = duration?.modality === "Read" ? "read" : "listen";
  const { requested_url: requested, canonical_url: canonical } = media;
  const sourceEdition = media.part_source_edition;
  return (
    <div className={styles.content}>
      <div className={styles.resourceTitle} dir="auto">
        {media.title}
      </div>
      {readStatus}
      {group(pinned ? "current metadata" : "publication", [
        fact(
          "authors",
          selectMediaAuthors(media.contributors).length === 0
            ? "unknown"
            : null,
        ),
        ...credits.map((role) =>
          fact(
            role.label.toLowerCase(),
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
        fact("publisher", sourceEdition !== null || publisherCredited ? null : media.publisher),
        fact("first published", publication(media.original_published_date)),
        fact("this edition", sourceEdition !== null ? null : publication(media.edition_published_date)),
        fact("isbn", sourceEdition !== null ? null : media.edition_isbn),
        fact("language", media.language),
        fact("description", media.description),
      ])}
      {sourceEdition !== null ? group("source edition", [
        fact("from", media.part_source?.href ? <a href={media.part_source.href} dir="auto">{media.part_source.title}</a> : media.part_source?.title),
        fact("edition published", publication(sourceEdition.published_date)),
        fact("publisher", sourceEdition.publisher),
        fact("isbn", sourceEdition.isbn),
      ]) : null}
      {children}
      {sourceEdition === null ? group("source", [
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
            ? instant(display, media.x_source_context.published_at)
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
      ]) : null}
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
        fact("record created", instant(display, media.created_at)),
        fact("record updated", instant(display, media.updated_at)),
        fact("metadata enriched", instant(display, media.metadata_enriched_at)),
        fact("last engaged", instant(display, media.last_engaged_at)),
      ])}
      {group("availability", [
        fact("processing", media.processing_status.replaceAll("_", " ")),
        fact("transcript state", media.transcript_state?.replaceAll("_", " ")),
        fact("transcript origin", media.transcript_origin),
        fact("transcript coverage", media.transcript_coverage),
        fact("search", searchState ? rowText(searchState) : media.retrieval_status === "ready" ? "available" : null),
        fact("processing failure", sourceFailure ? rowText(sourceFailure) : null),
      ])}
    </div>
  );
}

/** A retained run is inspectable independently of the current metadata read. */
function MetadataOperationInfo({ mediaId, title, metadata, operation, pinned, inspection }: {
  readonly mediaId: string;
  readonly title: string | null;
  readonly metadata: MetadataEnrichmentView | null;
  readonly operation: MetadataOperation | null;
  readonly pinned: boolean;
  readonly inspection: ReactNode;
}) {
  const display = useRenderEnvironment();
  const retry = metadata === null || title === null ? null : metadata.retry;
  const earlierRuns = metadata === null ? 0 : earlierMetadataRuns(metadata);
  const unfinished = metadata === null ? null : metadata.unfinished_operation;
  const purpose = operation?.purpose ?? retry?.purpose ?? null;
  const hasResult = operation?.status === "completed" && operation.outcome.purpose === "bibliography";
  const canUpdate = metadata !== null && title !== null;
  return group(pinned ? "this update" : purpose === null ? "metadata update" : metadataOperationName(purpose), [
    fact("observation", inspection),
    fact("status", operation !== null ? metadataOperationSummary(operation)
      : !pinned && purpose !== null ? `no recorded ${metadataOperationName(purpose)}` : null),
    fact("result", hasResult ? <MetadataResearchResult operation={operation} /> : null),
    fact("explanation", (operation?.status === "failed" || operation?.status === "held") ? METADATA_FAILURE_COPY[operation.code] : null),
    retry === null ? null : fact(`${metadataOperationName(retry.purpose)} availability`,
      retry.status === "blocked" ? metadataRetryBlockedCopy(retry) : "available"),
    fact("title evidence", retry?.purpose === "title" ? X_TITLE_CONTEXT_HELP : null),
    fact("earlier work", earlierRuns > 0
      ? `${earlierRuns} earlier metadata ${earlierRuns === 1 ? "run remains" : "runs remain"} unfinished` : null),
    fact("unfinished operation", unfinished !== null && unfinished.job_id !== operation?.job_id
      ? metadataOperationSummary(unfinished) : null),
    fact("actions", canUpdate ? <MetadataResearchActions mediaId={mediaId} title={title} view={metadata} /> : null),
    fact("requested", instant(display, operation?.created_at ?? null)),
    fact("started", instant(display, operation?.started_at ?? null)),
    fact("finished", instant(display, operation?.status === "completed" ? operation.outcome.completed_at
      : operation?.status === "failed" ? operation.completed_at : null)),
    fact("next retry", instant(display, operation?.status === "waiting" ? operation.until : null)),
    fact("held", instant(display, operation?.status === "held" ? operation.held_at : null)),
  ]);
}

export default function MediaInfoOverlay({
  open,
  mediaId,
  jobId,
  returnFocusTo,
  returnFocusFallback,
  skipReturnFocus,
  onClose,
}: {
  readonly open: boolean;
  readonly mediaId: string;
  readonly jobId: string | null;
  readonly returnFocusTo: ReturnFocusTarget;
  readonly returnFocusFallback: ReturnFocusTarget;
  readonly skipReturnFocus?: () => boolean;
  readonly onClose: () => void;
}) {
  const contentRoot = useRef<HTMLDivElement>(null);
  const transportVerbs = useTransportVerbs();
  const exact = useMetadataOperation(open ? mediaId : null, open ? jobId : null);
  const pinnedOperation = "operation" in exact ? exact.operation : null;
  let inspection: ReactNode = null;
  if (jobId !== null) {
    if (exact.status === "loading") inspection = <Ruling />;
    if (exact.status === "reconnecting") inspection = "reconnecting to this update";
    if (exact.status === "suspended" || exact.status === "interrupted") {
      const transport = transportOf(exact.error);
      const verbs = transportVerbs(transport, exact.status === "interrupted" ? { retry: {
        label: "check status", commandKey: `metadata status:${mediaId}:${jobId}`,
        run: () => reconnectMetadataOperation(mediaId, jobId),
      } } : undefined);
      inspection = <Fact line={TRANSPORT_LINES[transport].read("this update")} verbs={verbs ?? undefined} />;
    }
  }
  const observation = useMediaObservation(open ? mediaId : null, open);
  const observed = observation.status === "ready" ? observation.observation : null;
  const view = observed?.metadata_enrichment ?? null;
  const processing = observed?.processing ?? null;
  const changes = useChangeStamp("Metadata");
  const observing = useObservationDemand(open);
  const foreground = useRefreshStamp(observing, 0);
  const titleJob =
    view?.operation?.purpose === "title" ? view.operation.job_id : "";
  const media = useServerValue({
    enabled: observing,
    key: open ? `/media/${mediaId}` : null,
    // New source publication admits a title job before naming can succeed or fail.
    stale: `${view?.last_enriched_at ?? ""}:${titleJob}:${changes}:${foreground}`,
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
  const metadata = view ?? (media.status === "ready" ? media.data.metadata_enrichment : null);
  const operationInfo = jobId !== null || metadata !== null ? <MetadataOperationInfo
    mediaId={mediaId}
    title={media.status === "ready" ? media.data.title : null}
    metadata={metadata}
    operation={jobId === null ? metadata?.operation ?? null : pinnedOperation}
    pinned={jobId !== null}
    inspection={inspection}
  /> : null;
  const readStatus = media.status === "loading" ? <Ruling /> : media.error !== null
    ? <Failed error={media.error} noun="current metadata" retry={{ run: media.refetch, busy: media.status === "ready" ? media.refreshing : media.retrying }} /> : null;
  const content = observation.status === "ready" && observation.observation === null
    ? <Fact line={{ fact: "this item isn’t available to you." }} /> : media.status === "ready" ? <MediaInfo
    media={processing ? { ...media.data, ...processing } : media.data}
    pinned={jobId !== null}
    readStatus={readStatus}
  >{operationInfo}</MediaInfo> : <div className={styles.content}>
    {jobId === null ? readStatus : group("current metadata", [fact("details", readStatus)])}
    {operationInfo}
  </div>;
  return <InformationFrame open={open} title="metadata" returnFocusTo={returnFocusTo}
    returnFocusFallback={returnFocusFallback} skipReturnFocus={skipReturnFocus} onClose={onClose} contentRef={contentRoot}>
    {content}
  </InformationFrame>;
}
