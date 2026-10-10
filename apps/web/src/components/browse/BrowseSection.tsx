"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";
import CollectionView from "@/components/collections/CollectionView";
import Button from "@/components/ui/Button";
import { ApiError } from "@/lib/api/client";
import type { CursorPage } from "@/lib/api/useCursorPagination";
import { useCursorPagination } from "@/lib/api/useCursorPagination";
import { useResource, type AsyncResource } from "@/lib/api/useResource";
import { absent, present } from "@/lib/api/presence";
import { fetchBrowsePage } from "@/lib/browse/client";
import {
  decodeBrowseSectionFailure,
  type BrowseCandidate,
  type BrowsePage,
} from "@/lib/browse/contract";
import type { BrowseRequestRunner } from "@/lib/browse/requestGate";
import type { BrowseSectionIdentity } from "@/lib/browse/plan";
import { presentBrowseCandidate } from "@/lib/collections/presenters/browse";
import { useMediaQueryRevision, useMediaSummaries } from "@/lib/media/MediaSummaryProvider";
import MediaSummaryNotice from "@/components/collections/MediaSummaryNotice";
import styles from "@/app/(authenticated)/browse/browse.module.css";

const PAGE_SIZE = 20;

export interface BrowseSectionFailureSnapshot {
  readonly status: number;
  readonly code: string;
  readonly message: string;
  readonly requestId: string | null;
  readonly details: Record<string, unknown> | null;
}

export type BrowseSectionSnapshot =
  | { readonly kind: "Pending"; readonly page: null }
  | { readonly kind: "Ready"; readonly page: BrowsePage }
  | {
      readonly kind: "Failed";
      readonly page: BrowsePage | null;
      readonly failure: BrowseSectionFailureSnapshot;
    };

function snapshotFailure(error: ApiError): BrowseSectionFailureSnapshot {
  return {
    status: error.status,
    code: error.code,
    message: error.message,
    requestId: error.requestId ?? null,
    details: error.details ?? null,
  };
}

function restoreFailure(failure: BrowseSectionFailureSnapshot): ApiError {
  return new ApiError(
    failure.status,
    failure.code,
    failure.message,
    failure.requestId ?? undefined,
    failure.details ?? undefined,
  );
}

function browseSectionErrorMessage(error: ApiError): string {
  if (error.code === "E_BROWSE_REQUEST_INTERRUPTED") return "Search paused";
  if (error.code === "E_NETWORK") return "Connection lost";
  const failure = decodeBrowseSectionFailure(error);
  switch (failure.kind) {
    case "Unavailable":
      return "Source unavailable";
    case "RateLimited":
      return failure.retryAt.kind === "Present"
        ? `Rate limited until ${new Date(failure.retryAt.value).toLocaleTimeString()}`
        : "Rate limited";
    case "QuotaExhausted":
      return failure.resetAt.kind === "Present"
        ? `Quota exhausted until ${new Date(failure.resetAt.value).toLocaleTimeString()}`
        : "Quota exhausted";
    default: {
      const unhandled: never = failure;
      throw new Error(
        `Unhandled browse section failure: ${JSON.stringify(unhandled)}`,
      );
    }
  }
}

export default function BrowseSection({
  label,
  query,
  identity,
  restored,
  onController,
  runRequest,
}: {
  readonly label: string;
  readonly query: string;
  readonly identity: BrowseSectionIdentity;
  readonly restored: BrowseSectionSnapshot | null;
  readonly onController: (
    identity: BrowseSectionIdentity,
    snapshot: BrowseSectionSnapshot,
  ) => void;
  readonly runRequest: BrowseRequestRunner;
}) {
  const headingId = useId();
  const queryRevision = useMediaQueryRevision();
  const requestKey = `${query}\u0000${identity.kind}\u0000${identity.source}\u0000${identity.sort}`;
  const initialRestoreRef = useRef(restored);
  const [discardedRestore, setDiscardedRestore] = useState(false);
  const activeRestore = discardedRestore ? null : initialRestoreRef.current;
  const [updatedPage, setUpdatedPage] = useState<CursorPage<BrowseCandidate> | null>(null);
  const [prefixRequest, setPrefixRequest] = useState<{
    key: string; revision: number; count: number;
  } | null>(null);
  const adoptedQueryRevisionRef = useRef(queryRevision);
  const loaded = useResource<{ page: BrowsePage; queryRevision: number }>({
    cacheKey: activeRestore === null && updatedPage === null
      ? `${requestKey}:facts:${identity.source === "Nexus" ? queryRevision : "external"}` : null,
    load: async (signal) => ({ queryRevision,
      page: await runRequest(signal, () =>
        fetchBrowsePage({
          query,
          ...identity,
          limit: PAGE_SIZE,
          signal,
        }),
      ),
    }),
  });
  useEffect(() => {
    if (loaded.status !== "ready" || updatedPage !== null ||
      (identity.source === "Nexus" && loaded.data.queryRevision !== queryRevision)) return;
    adoptedQueryRevisionRef.current = loaded.data.queryRevision;
    setUpdatedPage(loaded.data.page);
  }, [loaded, updatedPage, identity.source, queryRevision]);
  const firstPage: AsyncResource<CursorPage<BrowseCandidate>> = useMemo(() => {
    if (updatedPage !== null) return { status: "ready", data: updatedPage };
    if (activeRestore?.kind === "Pending") {
      return {
        status: "error",
        error: new ApiError(
          0,
          "E_BROWSE_REQUEST_INTERRUPTED",
          "Browse request stopped when the pane changed",
        ),
        retry: () => setDiscardedRestore(true),
      };
    }
    if (activeRestore?.kind === "Ready") {
      return { status: "ready", data: activeRestore.page };
    }
    if (activeRestore?.kind === "Failed") {
      if (activeRestore.page !== null) {
        return { status: "ready", data: activeRestore.page };
      }
      return {
        status: "error",
        error: restoreFailure(activeRestore.failure),
        retry: () => setDiscardedRestore(true),
      };
    }
    switch (loaded.status) {
      case "idle":
        return { status: "idle" };
      case "loading":
        return { status: "loading" };
      case "error":
        return loaded;
      case "ready":
        return { status: "ready", data: loaded.data.page };
    }
  }, [activeRestore, loaded, updatedPage]);
  const initialMoreError = useMemo(
    () =>
      updatedPage === null && activeRestore?.kind === "Failed" && activeRestore.page !== null
        ? restoreFailure(activeRestore.failure)
        : null,
    [activeRestore, updatedPage],
  );
  const pagination = useCursorPagination({
    firstPage,
    initialMoreError,
    loadMoreEnabled: prefixRequest === null && (identity.source !== "Nexus" ||
      (adoptedQueryRevisionRef.current === queryRevision && (activeRestore?.page == null || updatedPage !== null))),
    loadMorePage: async (cursor, signal) =>
      runRequest(signal, () =>
        fetchBrowsePage({
          query,
          ...identity,
          limit: PAGE_SIZE,
          cursor,
          signal,
        }),
      ),
  });
  const summaries = useMediaSummaries(pagination.items.flatMap((candidate) =>
    candidate.resolution.kind === "InNexusMedia" ? [candidate.resolution.mediaSummary] : []));
  const restoreNeedsRefreshRef = useRef(activeRestore?.page != null);
  useEffect(() => {
    if (identity.source !== "Nexus" || pagination.status !== "ready" ||
      (adoptedQueryRevisionRef.current === queryRevision && !restoreNeedsRefreshRef.current) ||
      (prefixRequest?.key === requestKey && prefixRequest.revision === queryRevision)) return;
    setPrefixRequest({ key: requestKey, revision: queryRevision, count: pagination.items.length });
  }, [identity.source, pagination.status, prefixRequest,
    pagination.items.length, requestKey, queryRevision]);
  const prefix = useResource<{ request: NonNullable<typeof prefixRequest>; page: BrowsePage }>({
    cacheKey: prefixRequest !== null && prefixRequest.revision === queryRevision
      ? `${prefixRequest.key}:facts:${prefixRequest.revision}` : null,
    load: async (signal) => {
      const request = prefixRequest;
      if (request === null) {
        // justify-defect: the prefix query is enabled only for its request.
        throw new Error("Browse prefix lost its request");
      }
      let page = await runRequest(signal, () => fetchBrowsePage({
        query, ...identity, limit: request.count === 0 ? PAGE_SIZE : Math.min(PAGE_SIZE, request.count), signal,
      }));
      const items = [...page.items];
      while (items.length < request.count && page.nextCursor.kind === "Present") {
        const cursor = page.nextCursor.value;
        page = await runRequest(signal, () => fetchBrowsePage({ query, ...identity, cursor,
          limit: Math.min(PAGE_SIZE, request.count - items.length), signal,
        }));
        items.push(...page.items);
      }
      return { request, page: { ...page, items } };
    },
  });
  useEffect(() => {
    if (prefix.status !== "ready" || prefix.data.request !== prefixRequest ||
      prefixRequest?.key !== requestKey || prefixRequest.revision !== queryRevision) return;
    // The prefix includes every loaded occurrence. Stable row keys retain focus.
    setUpdatedPage(prefix.data.page);
    adoptedQueryRevisionRef.current = prefix.data.request.revision;
    restoreNeedsRefreshRef.current = false;
    setPrefixRequest(null);
  }, [prefix, prefixRequest, requestKey, queryRevision]);
  const rows = pagination.items.flatMap((candidate) => {
    if (candidate.resolution.kind !== "InNexusMedia") return [presentBrowseCandidate(candidate)];
    const mediaSummary = summaries.resolve(candidate.resolution.mediaSummary);
    return mediaSummary.kind === "Absent" ? [] : [presentBrowseCandidate({
      ...candidate, resolution: { ...candidate.resolution, mediaSummary: mediaSummary.value },
    })];
  });
  const lastSnapshotKeyRef = useRef<string | null>(null);
  const controller = useMemo<BrowseSectionSnapshot>(() => {
    if (pagination.status === "loading") {
      return { kind: "Pending", page: null };
    }
    if (pagination.status === "error") {
      const error = pagination.error;
      if (error === null) {
        throw new Error("Browse section failed without an error");
      }
      return {
        kind: "Failed",
        page: null,
        failure: snapshotFailure(error),
      };
    }
    const page: BrowsePage = {
      query,
      ...identity,
      sort:
        identity.sort === "Relevance" ? absent() : present(identity.sort),
      items: pagination.items,
      nextCursor: pagination.nextCursor,
    };
    return pagination.error
      ? {
          kind: "Failed",
          page,
          failure: snapshotFailure(pagination.error),
        }
      : { kind: "Ready", page };
  }, [
    identity,
    pagination.error,
    pagination.items,
    pagination.nextCursor,
    pagination.status,
    query,
  ]);

  useEffect(() => {
    const snapshotKey = JSON.stringify([requestKey, controller]);
    if (lastSnapshotKeyRef.current === snapshotKey) return;
    lastSnapshotKeyRef.current = snapshotKey;
    onController(identity, controller);
  }, [
    controller,
    identity,
    onController,
    requestKey,
  ]);

  let statusRow = null;
  if (pagination.status === "loading") {
    statusRow = (
      <p className={styles.statusRow} aria-busy="true">
        Loading…
      </p>
    );
  } else if (pagination.status === "error" || (pagination.error && identity.source !== "Nexus")) {
    const error = pagination.error;
    if (error === null) {
      throw new Error("Browse section failed without an error");
    }
    statusRow = (
      <div className={styles.statusRow}>
        <span>{browseSectionErrorMessage(error)}</span>
        <Button
          size="sm"
          variant="secondary"
          aria-label={`Retry ${label}`}
          onClick={pagination.retry}
          disabled={prefixRequest !== null}
        >
          Retry
        </Button>
      </div>
    );
  } else if (rows.length === 0) {
    statusRow = <p className={styles.statusRow}>No results</p>;
  }

  return (
    <section className={styles.sourceSection} aria-labelledby={headingId}>
      <h3 id={headingId} className={styles.sourceHeading}>
        {label}
      </h3>
      {statusRow}
      <CollectionView
        returnScope={`Browse.${identity.kind}.${identity.source}`}
        rows={rows}
        status="ready"
        ariaLabel={`${label} results`}
        notice={<MediaSummaryNotice
          error={summaries.error ?? (prefix.status === "error" ? prefix.error : null) ??
            (pagination.status === "ready" && identity.source === "Nexus" ? pagination.error : null)}
          retry={() => {
            if (summaries.error !== null) summaries.retry();
            if (prefix.status === "error") prefix.retry();
            if (pagination.status === "ready" && pagination.error !== null && prefixRequest === null &&
              (identity.source !== "Nexus" || adoptedQueryRevisionRef.current === queryRevision)) pagination.retry();
          }}
        />}
        empty={null}
        surface={false}
      />
      {pagination.status === "ready" && pagination.hasMore && !pagination.error ? (
        <div className={styles.continuation}>
          <Button
            size="sm"
            variant="secondary"
            loading={pagination.loadingMore}
            disabled={prefixRequest !== null ||
              (identity.source === "Nexus" && adoptedQueryRevisionRef.current !== queryRevision)}
            onClick={pagination.loadMore}
          >
            Load more
          </Button>
        </div>
      ) : null}
    </section>
  );
}
