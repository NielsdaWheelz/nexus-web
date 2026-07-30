"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import CollectionView from "@/components/collections/CollectionView";
import Button from "@/components/ui/Button";
import PaneSection from "@/components/ui/PaneSection";
import { ApiError } from "@/lib/api/client";
import type { CursorPage } from "@/lib/api/useCursorPagination";
import { useCursorPagination } from "@/lib/api/useCursorPagination";
import { useResource, type AsyncResource } from "@/lib/api/useResource";
import { absent, present } from "@/lib/api/presence";
import {
  browsePagePath,
  fetchBrowsePage,
  fetchBrowsePagePath,
} from "@/lib/browse/client";
import {
  decodeBrowseSectionFailure,
  type BrowseCandidate,
  type BrowseKind,
  type BrowsePage,
  type BrowseSort,
  type BrowseSource,
} from "@/lib/browse/contract";
import type { BrowseRequestRunner } from "@/lib/browse/requestGate";
import { presentBrowseCandidate } from "@/lib/collections/presenters/browse";
import styles from "@/app/(authenticated)/browse/browse.module.css";

const PAGE_SIZE = 20;

export interface BrowseSectionIdentity {
  readonly kind: BrowseKind;
  readonly source: BrowseSource;
  readonly sort: BrowseSort;
}

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

function cursorPage(page: BrowsePage): CursorPage<BrowseCandidate> {
  const nextCursor =
    page.nextCursor.kind === "Present" ? page.nextCursor.value : null;
  return {
    data: [...page.items],
    page: {
      has_more: nextCursor !== null,
      next_cursor: nextCursor,
    },
  };
}

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

function failureMessage(error: ApiError): string {
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
  const requestKey = `${query}\u0000${identity.kind}\u0000${identity.source}\u0000${identity.sort}`;
  const initialRestoreRef = useRef(restored);
  const [discardedRestore, setDiscardedRestore] = useState(false);
  const activeRestore = discardedRestore ? null : initialRestoreRef.current;
  const loaded = useResource<BrowsePage>({
    cacheKey: activeRestore === null ? requestKey : null,
    load: (signal) =>
      runRequest(signal, () =>
        fetchBrowsePage({
          query,
          ...identity,
          limit: PAGE_SIZE,
          signal,
        }),
      ),
  });
  const firstPage: AsyncResource<CursorPage<BrowseCandidate>> = useMemo(() => {
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
      return { status: "ready", data: cursorPage(activeRestore.page) };
    }
    if (activeRestore?.kind === "Failed") {
      if (activeRestore.page !== null) {
        return { status: "ready", data: cursorPage(activeRestore.page) };
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
        return { status: "ready", data: cursorPage(loaded.data) };
    }
  }, [activeRestore, loaded]);
  const initialMoreError = useMemo(
    () =>
      activeRestore?.kind === "Failed" && activeRestore.page !== null
        ? restoreFailure(activeRestore.failure)
        : null,
    [activeRestore],
  );
  const pagination = useCursorPagination({
    firstPage,
    initialMoreError,
    buildMoreHref: (cursor) =>
      browsePagePath({
        query,
        ...identity,
        limit: PAGE_SIZE,
        cursor,
      }),
    loadMorePage: async (href, signal) =>
      cursorPage(
        await runRequest(signal, () =>
          fetchBrowsePagePath(
            href as `/api/${string}`,
            { query, ...identity },
            signal,
          ),
        ),
      ),
  });
  const rows = useMemo(
    () => pagination.items.map(presentBrowseCandidate),
    [pagination.items],
  );
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
      nextCursor:
        pagination.nextCursor === null
          ? absent()
          : present(pagination.nextCursor),
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
  } else if (pagination.status === "error" || pagination.error) {
    const error = pagination.error;
    if (error === null) {
      throw new Error("Browse section failed without an error");
    }
    statusRow = (
      <div className={styles.statusRow}>
        <span>{failureMessage(error)}</span>
        <Button size="sm" variant="secondary" onClick={pagination.retry}>
          Retry
        </Button>
      </div>
    );
  } else if (rows.length === 0) {
    statusRow = <p className={styles.statusRow}>No results</p>;
  }

  return (
    <PaneSection title={label} className={styles.section}>
      {statusRow}
      <CollectionView
        returnScope={`Browse.${identity.kind}.${identity.source}`}
        rows={rows}
        status="ready"
        ariaLabel={`${label} results`}
        empty={null}
        surface={false}
        rowActionsAvailable={false}
      />
      {pagination.status === "ready" && pagination.hasMore ? (
        <div className={styles.continuation}>
          <Button
            size="sm"
            variant="secondary"
            loading={pagination.loadingMore}
            onClick={pagination.loadMore}
          >
            Load more
          </Button>
        </div>
      ) : null}
    </PaneSection>
  );
}
