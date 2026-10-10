"use client";

import { useEffect, useState, type ReactNode } from "react";
import { apiFetch, isApiError, isSameSystemApiDefect } from "@/lib/api/client";
import type { ApiJson } from "@/lib/api/wire";
import { handleUnauthenticatedApiError } from "@/lib/auth/UnauthenticatedApiBoundary";
import { formatCollectionPublicationDate } from "@/components/collections/collectionRowFormatting";
import Dialog from "@/components/ui/Dialog";
import Button from "@/components/ui/Button";
import MobileSheet from "@/components/ui/MobileSheet";
import { groupContributorCredits, selectMediaAuthors } from "@/lib/contributors/formatting";
import { mediaDetailFromResponse, type MediaDetail } from "@/lib/media/mediaDetail";
import {
  METADATA_FAILURE_COPY,
  METADATA_FIELD_LABELS,
  METADATA_RETRY_BLOCKED_COPY,
  metadataOperationSummary,
  reconnectMetadataOperations,
  useMediaMetadataOperations,
  type MetadataEnrichmentView,
} from "@/lib/media/mediaMetadataOperations";
import { mediaErrorMessage } from "@/lib/media/mediaErrorMessage";
import { useIsMobileViewport } from "@/lib/ui/useIsMobileViewport";
import type { ReturnFocusTarget } from "@/lib/ui/useReturnFocus";
import styles from "./MediaInfoOverlay.module.css";

interface Props {
  readonly open: boolean;
  readonly mediaId: string;
  readonly returnFocusTo: ReturnFocusTarget;
  readonly returnFocusFallback: ReturnFocusTarget;
  readonly onClose: () => void;
}

type LoadState =
  | { readonly kind: "Loading"; readonly mediaId: string }
  | { readonly kind: "Error"; readonly mediaId: string }
  | { readonly kind: "Defect"; readonly mediaId: string; readonly error: unknown }
  | { readonly kind: "Ready"; readonly mediaId: string; readonly media: MediaDetail };

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

function instant(value: string | null): ReactNode {
  return value ? (
    <time dateTime={value}>
      {new Intl.DateTimeFormat(undefined, {
        dateStyle: "medium",
        timeStyle: "short",
      }).format(new Date(value))}
    </time>
  ) : null;
}

function publicationDate(value: MediaDetail["original_published_date"]): ReactNode {
  if (value.kind === "Absent") return "unknown";
  return (
    <time dateTime={value.value}>
      {formatCollectionPublicationDate(value.value)}
    </time>
  );
}

function MediaInfo({ media, metadata, disconnected, refreshing, refreshError, onReread }: {
  readonly media: MediaDetail;
  readonly metadata: MetadataEnrichmentView;
  readonly disconnected: boolean;
  readonly refreshing: boolean;
  readonly refreshError: boolean;
  readonly onReread: () => void;
}) {
  const authors = selectMediaAuthors(media.contributors);
  const credits = groupContributorCredits(media.contributors);
  const publisherAlreadyCredited = credits.some((group) =>
    group.role === "publisher" && group.credits.some((credit) => credit.label === media.publisher),
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
  const duration = media.duration.kind === "Present" ? media.duration.value : null;
  const requestedUrl = media.requested_url.kind === "Present" ? media.requested_url.value : null;
  const canonicalUrl = media.canonical_url.kind === "Present" ? media.canonical_url.value : null;
  const operation = metadata.operation.kind === "Present" ? metadata.operation.value : null;
  const outcome = operation?.status === "completed" ? operation.outcome : null;
  const originalUnresolved = operation?.status === "no_findings"
    || outcome?.unresolved_fields.includes("original_published_date");
  const completedAt = operation?.status === "completed" ? operation.outcome.completed_at
    : operation?.status === "no_findings" || operation?.status === "failed" ? operation.completed_at : null;
  return (
    <div className={styles.content} aria-busy={refreshing || undefined}>
      <div className={styles.resourceTitle} dir="auto">{media.title}</div>
      {refreshError ? (
        <div className={styles.refreshNotice}>
          <p role="alert">metadata updated; couldn’t load current values</p>
          <Button variant="secondary" onClick={onReread}>reload metadata</Button>
        </div>
      ) : null}
      {group("publication", [
        authors.length === 0 ? fact("authors", "unknown") : null,
        ...credits.map((role) =>
          fact(role.label, role.credits.map((credit, index) => (
            <span key={`${credit.label}-${index}`}>
              {index > 0 ? ", " : null}
              {credit.href ? (
                <a href={credit.href} dir="auto">{credit.label}</a>
              ) : (
                <span dir="auto">{credit.label}</span>
              )}
            </span>
          ))),
        ),
        fact("publisher", publisherAlreadyCredited ? null : media.publisher),
        fact("first published", publicationDate(media.original_published_date)),
        fact("this edition", publicationDate(media.edition_published_date)),
        fact("isbn", media.edition_isbn.kind === "Present" ? media.edition_isbn.value : null),
        fact("language", media.language),
        fact("description", media.description),
      ])}
      {group("metadata research", [
        fact("status", <span aria-live="polite" aria-atomic="true">
          {operation ? metadataOperationSummary(operation) : "no current metadata operation"}
        </span>),
        fact("first publication", originalUnresolved ? (
          media.original_published_date.kind === "Absent" ? "first publication remains unknown"
            : `first publication unverified; kept ${formatCollectionPublicationDate(media.original_published_date.value)}`
        ) : null),
        fact("unresolved fields", outcome && outcome.unresolved_fields.length > 0
          ? outcome.unresolved_fields.map((field) => METADATA_FIELD_LABELS[field]).join(", ") : null),
        fact("authors", outcome?.retained_manual_authors ? "kept manually set authors" : null),
        fact("explanation", operation?.status === "failed" ? METADATA_FAILURE_COPY[operation.code] : null),
        fact("re-enrichment", metadata.retry.status === "blocked"
          ? METADATA_RETRY_BLOCKED_COPY[metadata.retry.reason] : "available"),
        fact("requested", operation ? instant(operation.created_at) : null),
        fact("started", operation?.started_at.kind === "Present" ? instant(operation.started_at.value) : null),
        fact("finished", instant(completedAt)),
        fact("next retry", operation?.status === "waiting" && operation.until.kind === "Present"
          ? instant(operation.until.value) : null),
        fact("operation id", operation?.job_id),
        fact("model", operation?.selection.kind === "Present"
          ? `${operation.selection.value.provider} / ${operation.selection.value.model} / ${operation.selection.value.reasoning}` : null),
        fact("live status", disconnected ? (
          <div className={styles.refreshNotice}>
            <span>live status disconnected</span>
            <Button variant="secondary" onClick={() => reconnectMetadataOperations(media.id)}>reconnect</Button>
          </div>
        ) : null),
      ])}
      {group("source", [
        fact("media type", media.kind.replaceAll("_", " ")),
        fact("provider", media.provider.kind === "Present" ? media.provider.value : "not recorded"),
        fact("provider id", media.provider_id.kind === "Present" ? media.provider_id.value : null),
        fact("source url", media.canonical_source_url ? (
          <a href={media.canonical_source_url} dir="auto">
            {media.canonical_source_url}
          </a>
        ) : null),
        fact(requestedUrl === canonicalUrl ? "requested and canonical url" : "requested url",
          requestedUrl !== null && requestedUrl !== media.canonical_source_url ? (
            <a href={requestedUrl} dir="auto">{requestedUrl}</a>
          ) : null),
        fact("canonical url", canonicalUrl !== null && canonicalUrl !== media.canonical_source_url
          && canonicalUrl !== requestedUrl ? (
            <a href={canonicalUrl} dir="auto">{canonicalUrl}</a>
          ) : null),
      ])}
      {group("reading/listening", [
        fact("completion", media.read_state?.replaceAll("_", " ")),
        fact("reading progress", media.progress_fraction === null
          ? null : `${Math.round(media.progress_fraction * 100)}%`),
        fact("current playback position", media.listening_state
          ? `${Math.floor(media.listening_state.position_ms / 60000)}:${String(Math.floor(media.listening_state.position_ms / 1000) % 60).padStart(2, "0")}`
          : null),
        fact("total duration", duration
          ? `${duration.estimate.totalMinutes} min to ${duration.modality === "Read" ? "read" : "listen"}`
          : null),
        fact("remaining duration", duration?.estimate.remainingMinutes.kind === "Present"
          ? `${duration.estimate.remainingMinutes.value} min left to ${duration.modality === "Read" ? "read" : "listen"}`
          : null),
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
        fact("transcript origin", media.transcript_origin.kind === "Present"
          ? media.transcript_origin.value : null),
        fact("transcript coverage", media.transcript_coverage),
        fact("retrieval availability", media.retrieval_status),
        fact("retrieval reason", media.retrieval_status_reason),
        fact("processing failure", sourceFailure
          ? `${sourceFailure.title} ${sourceFailure.explanation}` : null),
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
}: Props) {
  const isMobile = useIsMobileViewport();
  const [state, setState] = useState<LoadState>({ kind: "Loading", mediaId });
  const [request, setRequest] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshError, setRefreshError] = useState(false);
  const observation = useMediaMetadataOperations(open ? mediaId : null);
  const publicationStamp = observation.view?.last_enriched_at.kind === "Present"
    ? observation.view.last_enriched_at.value : null;
  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    setState((previous) => previous.kind === "Ready" && previous.mediaId === mediaId
      ? previous : { kind: "Loading", mediaId });
    setRefreshing(true);
    setRefreshError(false);
    void apiFetch<ApiJson<"/media/{media_id}", "get">>(`/api/media/${encodeURIComponent(mediaId)}`, {
      signal: controller.signal,
    })
      .then((raw) => {
        if (controller.signal.aborted) return;
        try {
          setState({
            kind: "Ready",
            mediaId,
            media: mediaDetailFromResponse(raw, mediaId),
          });
        } catch (error) {
          setState({ kind: "Defect", mediaId, error });
        }
        setRefreshing(false);
      })
      .catch((error) => {
        if (!controller.signal.aborted && !handleUnauthenticatedApiError(error)) {
          setRefreshing(false);
          if (!isApiError(error) || isSameSystemApiDefect(error)) {
            setState({ kind: "Defect", mediaId, error });
            return;
          }
          setRefreshError(true);
          setState((previous) => previous.kind === "Ready" && previous.mediaId === mediaId
            ? previous : { kind: "Error", mediaId });
        }
      });
    return () => controller.abort();
  }, [open, mediaId, request, publicationStamp]);
  const visible = state.mediaId === mediaId ? state : { kind: "Loading" as const };
  if (visible.kind === "Defect") throw visible.error;
  const content = visible.kind === "Loading" ? (
    <p role="status">loading metadata…</p>
  ) : visible.kind === "Error" ? (
    <div>
      <p role="alert">couldn’t load metadata</p>
      <Button
        variant="secondary"
        onClick={() => {
          setState({ kind: "Loading", mediaId });
          setRequest((current) => current + 1);
        }}
      >
        try again
      </Button>
    </div>
  ) : (
    <MediaInfo
      media={visible.media}
      metadata={observation.view ?? visible.media.metadata_enrichment}
      disconnected={observation.disconnected}
      refreshing={refreshing}
      refreshError={refreshError}
      onReread={() => setRequest((current) => current + 1)}
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
