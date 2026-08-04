"use client";

import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
} from "react";
import { PenLine } from "lucide-react";
import Button from "@/components/ui/Button";
import CollectionView from "@/components/collections/CollectionView";
import CollectionExhaustionNotice from "@/components/collections/CollectionExhaustionNotice";
import ConnectionsSurface from "@/components/connections/ConnectionsSurface";
import { useConnectionsComposerController } from "@/components/connections/connectionsComposerController";
import Input from "@/components/ui/Input";
import Dialog from "@/components/ui/Dialog";
import PaneSurface from "@/components/ui/PaneSurface";
import { PaneLoadingState } from "@/components/workspace/PaneLoadingState";
import { usePanePrimaryChrome } from "@/components/workspace/PanePrimaryChrome";
import {
  FeedbackNotice,
  FieldFeedback,
  type FeedbackContent,
} from "@/components/feedback/Feedback";
import { isApiError, isSameSystemApiDefect } from "@/lib/api/client";
import {
  AUTHOR_WORKS_LIMIT,
  contributorResource,
  contributorWorksResource,
} from "@/lib/api/resource";
import type {
  CollectionCursor,
  CollectionPage,
  CollectionRevision,
} from "@/lib/api/collectionPage";
import type { Presence } from "@/lib/api/presence";
import { clientResourceFetcher } from "@/lib/api/resourceTransport.client";
import { useExhaustivePagination } from "@/lib/api/useExhaustivePagination";
import { useResource } from "@/lib/api/useResource";
import { handleUnauthenticatedApiError } from "@/lib/auth/UnauthenticatedApiBoundary";
import {
  fetchContributorWorks,
  patchContributorDisplayName,
} from "@/lib/contributors/api";
import { createMutationIntent } from "@/lib/contributors/mutationIntent";
import type {
  ContributorDetail,
  ContributorWorkItem,
} from "@/lib/contributors/types";
import {
  AUTHOR_WORKS_SORT_OPTION_IDS,
  CANONICAL_AUTHOR_WORKS_VIEW,
  authorWorksSortOptionLabel,
  authorWorksSortOptionOf,
  authorWorksViewForSortOption,
  decodeAuthorWorksView,
  encodeAuthorWorksView,
  type AuthorWorksSortOptionId,
  type AuthorWorksView,
  type DecodedAuthorWorksView,
} from "@/lib/contributors/workView";
import { presentContributorWork } from "@/lib/collections/presenters/presentContributorWork";
import { useResourceInspector } from "@/lib/dossiers/useResourceInspector";
import {
  paneResourceLoaders,
  type AuthorPaneSeed,
} from "@/lib/panes/paneResourceLoaders";
import { matchesPaneFilterQuery } from "@/lib/panes/paneRowFilter";
import {
  definePaneVisitDataKey,
  type PaneResourceStatus,
  useClearAllPaneVisitData,
  usePaneIsActive,
  usePaneParam,
  usePaneReturnReady,
  usePaneRuntime,
  requirePaneRuntime,
  usePaneVisitData,
  useSetPaneLabel,
} from "@/lib/panes/paneRuntime";
import usePaneFilterRows from "@/lib/panes/usePaneFilterRows";
import usePaneScrollRetention from "@/lib/panes/usePaneScrollRetention";
import { usePaneUrlState } from "@/lib/api/usePaneUrlState";
import SelectField from "@/components/ui/SelectField";
import { parseResourceRef } from "@/lib/resourceGraph/resourceRef";
import { emptyResourceMenuGroups } from "@/lib/actions/resourceActions";
import type { ActionSelectDetail } from "@/lib/ui/actionDescriptor";
import { findPaneLandmarkFocusTarget } from "@/lib/workspace/paneDom";
import { isAbortError } from "@/lib/errors";
import styles from "./page.module.css";

const RENAME_AUTHOR_ICON = <PenLine size={16} aria-hidden="true" />;

type AuthorConnectionsResource =
  | { kind: "Ready"; ref: { scheme: "contributor"; id: string } }
  | { kind: "Loading" }
  | { kind: "Unavailable" };

/** The author detail plus the works page committed as one exact works view. */
interface CommittedAuthorWorks extends AuthorPaneSeed {
  readonly view: AuthorWorksView;
}

const AUTHOR_VISIT_DATA =
  definePaneVisitDataKey<CommittedAuthorWorks>("Author.Works");
const NO_CURSOR: Presence<CollectionCursor> = { kind: "Absent" };
const ZERO_REVISION = 0 as CollectionRevision;

// The one code that turns a works fetch failure into the "Invalid works view"
// terminal state: the backend rejects a bad view/cursor with these codes.
function isInvalidViewError(error: unknown): boolean {
  return (
    isApiError(error) &&
    (error.code === "E_INVALID_REQUEST" || error.code === "E_INVALID_CURSOR")
  );
}

function authorLoadErrorMessage(error: unknown): FeedbackContent {
  if (!isApiError(error) || isSameSystemApiDefect(error)) throw error;
  switch (error.code) {
    case "E_NOT_FOUND":
      return {
        tone: "Danger",
        title: "This author is no longer available",
        requestId: error.requestId,
      };
    case "E_NETWORK":
      return {
        tone: "Danger",
        title: "This author couldn’t be loaded",
        message: "Check your connection and retry.",
        requestId: error.requestId,
      };
    default:
      throw error;
  }
}

function authorRenameErrorMessage(error: unknown): FeedbackContent {
  if (!isApiError(error) || isSameSystemApiDefect(error)) throw error;
  switch (error.code) {
    case "E_NETWORK":
      return {
        tone: "Danger",
        title: "The change couldn’t be confirmed",
        message: "Retry to safely check whether it was saved.",
        requestId: error.requestId,
      };
    case "E_NOT_FOUND":
      return {
        tone: "Danger",
        title: "This author is no longer available",
        requestId: error.requestId,
      };
    case "E_FORBIDDEN":
      return {
        tone: "Danger",
        title: "You can’t rename this author",
        requestId: error.requestId,
      };
    case "E_INVALID_REQUEST":
      return {
        tone: "Danger",
        title: "Enter a valid author name",
        requestId: error.requestId,
      };
    case "E_IDEMPOTENCY_KEY_REPLAY_MISMATCH":
      return {
        tone: "Danger",
        title: "The name wasn’t updated",
        message: "Retry the saved draft.",
        requestId: error.requestId,
      };
    default:
      throw error;
  }
}

interface PendingAuthorRevalidation {
  readonly version: number;
  readonly resolve: () => void;
  readonly reject: (error: unknown) => void;
  readonly removeAbortListener: () => void;
}

function resolveAuthorConnectionsResource(
  resourceRef: string | null,
  resourceStatus: PaneResourceStatus,
): AuthorConnectionsResource {
  const parsed = resourceRef ? parseResourceRef(resourceRef) : null;
  if (parsed?.scheme === "contributor") {
    return {
      kind: "Ready",
      ref: { scheme: "contributor", id: parsed.id },
    };
  }
  switch (resourceStatus) {
    case "none":
    case "pending":
      return { kind: "Loading" };
    case "ready":
    case "missing":
    case "unauthorized":
    case "invalid":
    case "error":
      return { kind: "Unavailable" };
    default: {
      const exhaustive: never = resourceStatus;
      return exhaustive;
    }
  }
}

export default function AuthorPaneBody() {
  const handle = usePaneParam("handle");
  if (!handle) {
    throw new Error("author route requires a handle");
  }
  const paneRuntime = usePaneRuntime();
  const runtime = requirePaneRuntime(paneRuntime, "AuthorPaneBody");
  const isPaneActive = usePaneIsActive();
  const activateTarget = runtime.activateTarget;
  // The pane URL owns the works view through a strict, total codec; `view` is
  // null only for an Invalid URL, a terminal, user-recoverable state.
  const worksViewCodec = useMemo(
    () => ({
      basePath: `/authors/${encodeURIComponent(handle)}`,
      decode: decodeAuthorWorksView,
      encode: (
        decoded: DecodedAuthorWorksView,
        current: URLSearchParams,
      ): URLSearchParams =>
        encodeAuthorWorksView(
          decoded.kind === "Valid" ? decoded.view : CANONICAL_AUTHOR_WORKS_VIEW,
          current,
        ),
      replaceOptions: {
        viewTransition: { kind: "collection-reflow" as const },
      },
    }),
    [handle],
  );
  const { state: decodedView, setState: setDecodedView } =
    usePaneUrlState(worksViewCodec);
  const view = decodedView.kind === "Valid" ? decodedView.view : null;
  // Set when the backend rejects the requested view; cleared whenever another
  // view is requested.
  const [viewInvalid, setViewInvalid] = useState(false);
  const invalidView = decodedView.kind === "Invalid" || viewInvalid;
  const worksRegionRef = useRef<HTMLElement | null>(null);
  const committedSnapshotRef = useRef<CommittedAuthorWorks | null>(null);
  const captureCommitted = useCallback(() => committedSnapshotRef.current, []);
  const restored = usePaneVisitData(AUTHOR_VISIT_DATA, captureCommitted);
  const initialRestored = useRef(restored).current;
  const clearAllVisitData = useClearAllPaneVisitData();
  const [firstPageVersion, setFirstPageVersion] = useState(0);
  const firstPageVersionRef = useRef(0);
  const pendingAuthorRevalidationRef =
    useRef<PendingAuthorRevalidation | null>(null);
  const completedAuthorRevalidationVersionRef = useRef<number | null>(null);
  const [chainEpoch, setChainEpoch] = useState(0);
  const [data, setData] = useState<CommittedAuthorWorks | null>(initialRestored);
  if (
    committedSnapshotRef.current === null &&
    initialRestored !== null &&
    data === initialRestored
  ) {
    committedSnapshotRef.current = initialRestored;
  }
  const [error, setError] = useState<FeedbackContent | null>(null);
  const [defect, setDefect] = useState<{ error: unknown } | null>(null);
  const [renameOpen, setRenameOpen] = useState(false);
  const capturePaneScroll = usePaneScrollRetention(worksRegionRef, data);
  // Set by a refresh so the already-committed view refetches once under a new
  // request identity; cleared by the commit that answers it. A view change needs
  // no flag — the requested and committed identities differ on their own.
  const refreshPendingRef = useRef(false);
  const sortSelectRef = useRef<HTMLSelectElement | null>(null);
  // Set before a view replacement the user initiated from the sort control, so
  // the commit that answers it returns focus there.
  const pendingCommitFocusRef = useRef(false);
  const focusPendingSortControl = useCallback(() => {
    if (!pendingCommitFocusRef.current) return;
    pendingCommitFocusRef.current = false;
    const element = sortSelectRef.current;
    if (element === null) return;
    requestAnimationFrame(() => element.focus());
  }, []);
  const setView = useCallback(
    (next: AuthorWorksView) => {
      capturePaneScroll();
      committedSnapshotRef.current = null;
      setDecodedView({ kind: "Valid", view: next });
    },
    [capturePaneScroll, setDecodedView],
  );
  const renameTriggerRef = useRef<HTMLButtonElement | null>(null);
  const openRename = useCallback(({ triggerEl }: ActionSelectDetail) => {
    renameTriggerRef.current = triggerEl;
    setRenameOpen(true);
  }, []);

  // The route seed composes the detail with the canonical first works page. Its
  // works are adopted only for the canonical view; every other view takes just
  // the detail and loads its own exact page.
  const allowSeedAdoptionRef = useRef(initialRestored === null);
  const seed = useResource<AuthorPaneSeed>({
    cacheKey:
      initialRestored === null && !invalidView
        ? contributorResource.cacheKey({ handle })
        : null,
    load: (signal) =>
      paneResourceLoaders.author!.load(clientResourceFetcher(signal), {
        handle,
      }) as Promise<AuthorPaneSeed>,
  });
  const seedDetail = seed.status === "ready" ? seed.data.detail : null;

  const requestedViewKey =
    view === null ? null : contributorWorksResource.cacheKey({ handle, view });
  const committedViewKey =
    data === null
      ? null
      : contributorWorksResource.cacheKey({ handle, view: data.view });
  const requestsFirstPage =
    view !== null &&
    !viewInvalid &&
    (data === null
      ? !(view.kind === "Canonical" && allowSeedAdoptionRef.current)
      : requestedViewKey !== committedViewKey || refreshPendingRef.current);
  const firstPageRequestKey =
    requestsFirstPage && requestedViewKey !== null
      ? `${requestedViewKey}:collection:${firstPageVersion}`
      : null;
  const firstPage = useResource<CollectionPage<ContributorWorkItem>>({
    cacheKey: firstPageRequestKey,
    load: (signal) => {
      if (view === null) {
        // justify-defect: a non-null request key is built from this exact view.
        throw new Error("Author works request lost its view identity");
      }
      return fetchContributorWorks(handle, {
        view,
        limit: AUTHOR_WORKS_LIMIT,
        signal,
      });
    },
  });

  // Latest-wins atomic commit: the resource reports a result only for the
  // current request identity, so a superseded view can never install its rows.
  useEffect(() => {
    const detail = data?.detail ?? seedDetail;
    if (firstPage.status === "ready" && view !== null && detail !== null) {
      allowSeedAdoptionRef.current = false;
      refreshPendingRef.current = false;
      const committed: CommittedAuthorWorks = {
        detail,
        view,
        works: firstPage.data.items,
        collectionRevision: firstPage.data.collectionRevision,
        nextCursor: firstPage.data.nextCursor,
        exhaustion:
          firstPage.data.nextCursor.kind === "Absent" ? "Complete" : "Partial",
      };
      committedSnapshotRef.current = committed;
      setData(committed);
      setChainEpoch((epoch) => epoch + 1);
      setError(null);
      focusPendingSortControl();
      const pending = pendingAuthorRevalidationRef.current;
      if (pending?.version === firstPageVersion) {
        completedAuthorRevalidationVersionRef.current = pending.version;
      }
      return;
    }
    if (firstPage.status === "error") {
      if (isInvalidViewError(firstPage.error)) {
        setViewInvalid(true);
      } else {
        try {
          setError(authorLoadErrorMessage(firstPage.error));
        } catch (caughtDefect) {
          setDefect({ error: caughtDefect });
        }
      }
      const pending = pendingAuthorRevalidationRef.current;
      if (pending?.version === firstPageVersion) {
        pendingAuthorRevalidationRef.current = null;
        completedAuthorRevalidationVersionRef.current = null;
        pending.removeAbortListener();
        pending.reject(firstPage.error);
      }
    }
  }, [
    data?.detail,
    firstPage,
    firstPageVersion,
    focusPendingSortControl,
    seedDetail,
    view,
  ]);

  // A newly requested view retires the previous view's rejection.
  useEffect(() => setViewInvalid(false), [requestedViewKey]);

  // The canonical seed commits as the canonical view; a seed failure is the
  // pane's load failure whether or not a works request is also in flight.
  useEffect(() => {
    if (seed.status === "ready") {
      if (!allowSeedAdoptionRef.current) return;
      allowSeedAdoptionRef.current = false;
      if (view === null || view.kind !== "Canonical") return;
      const committed: CommittedAuthorWorks = { ...seed.data, view };
      committedSnapshotRef.current = committed;
      setData(committed);
      setChainEpoch((epoch) => epoch + 1);
      setError(null);
      return;
    }
    if (seed.status === "error") {
      try {
        setError(authorLoadErrorMessage(seed.error));
      } catch (caughtDefect) {
        setDefect({ error: caughtDefect });
      }
    }
  }, [seed, view]);

  useLayoutEffect(() => {
    committedSnapshotRef.current = requestsFirstPage ? null : data;
    const pending = pendingAuthorRevalidationRef.current;
    if (
      data === null ||
      pending === null ||
      completedAuthorRevalidationVersionRef.current !== pending.version
    ) {
      return;
    }
    completedAuthorRevalidationVersionRef.current = null;
    pendingAuthorRevalidationRef.current = null;
    pending.removeAbortListener();
    pending.resolve();
  }, [data, requestsFirstPage]);

  const loading = !invalidView && error === null && data === null;
  usePaneReturnReady(data !== null || error !== null || invalidView);
  useSetPaneLabel(loading ? null : (data?.detail.displayName ?? "Author"));

  const rejectPendingAuthorRevalidation = useCallback((error: unknown) => {
    const pending = pendingAuthorRevalidationRef.current;
    pendingAuthorRevalidationRef.current = null;
    completedAuthorRevalidationVersionRef.current = null;
    if (!pending) return;
    pending.removeAbortListener();
    pending.reject(error);
  }, []);
  // Refresh reloads the committed works view, never the canonical seed: the
  // author detail is stable and a refreshed canonical page would contradict the
  // requested view.
  const refreshWorks = useCallback(() => {
    rejectPendingAuthorRevalidation(
      new DOMException("Author refresh was superseded.", "AbortError"),
    );
    capturePaneScroll();
    allowSeedAdoptionRef.current = false;
    refreshPendingRef.current = true;
    committedSnapshotRef.current = null;
    clearAllVisitData();
    setError(null);
    const version = firstPageVersionRef.current + 1;
    firstPageVersionRef.current = version;
    setFirstPageVersion(version);
  }, [capturePaneScroll, clearAllVisitData, rejectPendingAuthorRevalidation]);
  const revalidateWorks = useCallback(
    (signal: AbortSignal): Promise<void> => {
      if (signal.aborted) {
        return Promise.reject(
          signal.reason ??
            new DOMException("Author refresh was aborted.", "AbortError"),
        );
      }
      refreshWorks();
      const version = firstPageVersionRef.current;
      return new Promise<void>((resolve, reject) => {
        const onAbort = () => {
          const pending = pendingAuthorRevalidationRef.current;
          if (pending?.version !== version) return;
          pendingAuthorRevalidationRef.current = null;
          completedAuthorRevalidationVersionRef.current = null;
          pending.removeAbortListener();
          reject(
            signal.reason ??
              new DOMException("Author refresh was aborted.", "AbortError"),
          );
        };
        signal.addEventListener("abort", onAbort, { once: true });
        pendingAuthorRevalidationRef.current = {
          version,
          resolve,
          reject,
          removeAbortListener: () =>
            signal.removeEventListener("abort", onAbort),
        };
        if (signal.aborted) onAbort();
      });
    },
    [refreshWorks],
  );
  useEffect(
    () => () => {
      rejectPendingAuthorRevalidation(
        new DOMException("Author refresh source was replaced.", "AbortError"),
      );
    },
    [rejectPendingAuthorRevalidation],
  );
  const commitWorksPage = useCallback(
    (page: CollectionPage<ContributorWorkItem>): number => {
      const current = committedSnapshotRef.current;
      if (
        current === null ||
        current.collectionRevision !== page.collectionRevision
      ) {
        throw new Error("Author continuation settled for a stale collection");
      }
      const seen = new Set(current.works.map((work) => work.href));
      const works = [...current.works];
      for (const work of page.items) {
        if (seen.has(work.href)) continue;
        seen.add(work.href);
        works.push(work);
      }
      const next: CommittedAuthorWorks = {
        ...current,
        works,
        nextCursor: page.nextCursor,
        exhaustion: page.nextCursor.kind === "Absent" ? "Complete" : "Partial",
      };
      committedSnapshotRef.current = next;
      setData(next);
      return works.length;
    },
    [],
  );
  // Continuation runs only while the committed view is the requested one, and
  // every page of a chain carries that same view.
  const exhaustion = useExhaustivePagination<ContributorWorkItem>({
    active: isPaneActive && data !== null && !requestsFirstPage,
    chainKey: `${committedViewKey ?? ""}:${chainEpoch}`,
    cursor: data?.nextCursor ?? NO_CURSOR,
    collectionRevision: data?.collectionRevision ?? ZERO_REVISION,
    itemCount: data?.works.length ?? 0,
    loadPage: (cursor, collectionRevision, signal) => {
      if (data === null) {
        // justify-defect: continuation runs only over a committed exact view.
        throw new Error("Author works continuation lost its committed view");
      }
      return fetchContributorWorks(handle, {
        view: data.view,
        cursor,
        collectionRevision,
        limit: AUTHOR_WORKS_LIMIT,
        signal,
      });
    },
    commitPage: commitWorksPage,
    refresh: refreshWorks,
  });

  const workCount = data?.works.length ?? 0;
  const workRows = useMemo(
    () => data?.works.map(presentContributorWork) ?? [],
    [data?.works],
  );
  const getFilterStatus = useCallback(
    (query: string) => {
      const visibleCount =
        data?.works.filter((work) =>
          matchesPaneFilterQuery(query, [work.title]),
        ).length ?? 0;
      const unit = { singular: "work", plural: "works" };
      return exhaustion.kind === "Complete"
        ? {
            kind: "Complete" as const,
            visibleCount,
            totalCount: workCount,
            unit,
          }
        : {
            kind: "Partial" as const,
            visibleCount,
            loadedCount: workCount,
            unit,
          };
    },
    [data?.works, exhaustion.kind, workCount],
  );
  const dismissFilterRowsRef = useRef<() => void>(() => undefined);
  const clearDomainFilters = useCallback(() => {
    dismissFilterRowsRef.current();
    pendingCommitFocusRef.current = true;
    setView(CANONICAL_AUTHOR_WORKS_VIEW);
  }, [setView]);
  const domainFilterControls = useMemo(
    () =>
      invalidView || view === null ? undefined : (
        <>
          <SelectField
            layout="Stacked"
            label="Sort by"
            ref={sortSelectRef}
            value={authorWorksSortOptionOf(view)}
            onChange={(event) => {
              pendingCommitFocusRef.current = true;
              setView(
                authorWorksViewForSortOption(
                  event.target.value as AuthorWorksSortOptionId,
                ),
              );
            }}
          >
            {AUTHOR_WORKS_SORT_OPTION_IDS.map((optionId) => (
              <option key={optionId} value={optionId}>
                {authorWorksSortOptionLabel(optionId)}
              </option>
            ))}
          </SelectField>
          {view.kind === "Canonical" ? null : (
            <Button variant="secondary" size="sm" onClick={clearDomainFilters}>
              Clear filters
            </Button>
          )}
        </>
      ),
    [clearDomainFilters, invalidView, setView, view],
  );
  const { query: filterQuery, publication: search } = usePaneFilterRows({
    sourceKey: `Author.Works:${handle}`,
    inputLabel: "Filter works",
    placeholder: "Filter works",
    getRowStatus: getFilterStatus,
    // Truthful while the controls are published; an invalid view publishes none.
    activeDomainControlCount:
      invalidView || view === null || view.kind === "Canonical" ? 0 : 1,
    filters: domainFilterControls,
  });
  dismissFilterRowsRef.current = search.onDismiss;
  const filteredWorkRows = useMemo(
    () =>
      workRows.filter((row) =>
        matchesPaneFilterQuery(filterQuery, [row.title.text]),
      ),
    [filterQuery, workRows],
  );
  const canonicalHandle = data?.detail.handle ?? null;
  const connectionsComposerController = useConnectionsComposerController({
    scheme: "contributor",
    id: canonicalHandle ?? handle,
  });
  const connectionsResource = useMemo(
    () =>
      resolveAuthorConnectionsResource(
        paneRuntime?.resourceRef ?? null,
        paneRuntime?.resourceStatus ?? "none",
      ),
    [paneRuntime?.resourceRef, paneRuntime?.resourceStatus],
  );
  const connectionsBody = useMemo(
    () =>
      connectionsResource.kind === "Ready" ? (
        <ConnectionsSurface
          resourceRef={connectionsResource.ref}
          composerController={connectionsComposerController}
          activateTarget={activateTarget}
        />
      ) : connectionsResource.kind === "Loading" ? (
        <FeedbackNotice
          content={{ tone: "Info", title: "Loading connections…" }}
          announcement="None"
        />
      ) : (
        <FeedbackNotice
          content={{
            tone: "Neutral",
            title: "Connections unavailable",
            message: "This author’s resource identity could not be resolved.",
          }}
          announcement="None"
        />
      ),
    [activateTarget, connectionsComposerController, connectionsResource],
  );
  const { companionAction } = useResourceInspector({
    scheme: "contributor",
    handle: canonicalHandle,
    bodies: { linkedItems: connectionsBody },
  });
  const executeRefresh = useCallback(
    async ({ signal }: { readonly signal: AbortSignal }) => {
      try {
        await revalidateWorks(signal);
        return {
          kind: "Complete" as const,
          announcement: "Author refreshed",
        };
      } catch (refreshError: unknown) {
        if (isAbortError(refreshError)) throw refreshError;
        return {
          kind: "Failed" as const,
          announcement: "Author failed to refresh",
        };
      }
    },
    [revalidateWorks],
  );
  usePanePrimaryChrome({
    search,
    refresh: {
      sourceKey: `Author.Works:${handle}`,
      execute: executeRefresh,
    },
    actions: companionAction ? [companionAction] : [],
    // Renaming the author belongs beside the identity it renames, which now
    // lives in chrome — not stranded above the works list.
    menu: data
      ? {
          kind: "ResourceMenu",
          target: data.detail.actionTarget,
          groups: {
            ...emptyResourceMenuGroups(),
            operations: data.detail.canRename
              ? [
                  {
                    kind: "command",
                    id: "Author.Rename",
                    label: "Edit name…",
                    icon: RENAME_AUTHOR_ICON,
                    // The dialog owns focus return to this exact trigger, so the
                    // menu must not claim it back as it closes.
                    restoreFocusOnClose: false,
                    onSelect: openRename,
                  },
                ]
              : [],
          },
        }
      : undefined,
    header: {
      kind: "Section",
      meta: invalidView
        ? { kind: "None" }
        : loading || requestsFirstPage || exhaustion.kind !== "Complete"
          ? { kind: "Pending" }
          : { kind: "Count", value: workCount, unit: "work" },
    },
  });

  const otherNames = data?.detail.otherNames ?? [];
  const handleRenamed = useCallback(
    (detail: ContributorDetail) => {
      setData((current) =>
        current && current.detail.handle === detail.handle
          ? { ...current, detail }
          : current,
      );
      clearAllVisitData();
    },
    [clearAllVisitData],
  );

  if (defect) throw defect.error;

  if (invalidView) {
    return (
      <FeedbackNotice
        content={{ tone: "Danger", title: "Invalid works view" }}
        announcement="Assertive"
        actions={[
          {
            label: "Reset view",
            onClick: () => {
              search.onDismiss();
              setDecodedView({
                kind: "Valid",
                view: CANONICAL_AUTHOR_WORKS_VIEW,
              });
            },
          },
        ]}
      />
    );
  }

  return (
    <PaneSurface
      state={
        loading || (error && !data) ? (
          <>
            {loading ? (
              <PaneLoadingState label="Loading author…" announcement="Polite" />
            ) : null}
            {loading && filterQuery.trim() ? (
              <FeedbackNotice
                content={{
                  tone: "Neutral",
                  title: "No matching work found so far.",
                }}
                announcement="None"
              />
            ) : null}
            {error && !data ? (
              <FeedbackNotice content={error} announcement="Assertive" />
            ) : null}
          </>
        ) : null
      }
    >
      {data ? (
        <div className={styles.detail}>
          {otherNames.length > 0 ? (
            <section className={styles.otherNames}>
              <h2 className={styles.sectionHeading}>Other names</h2>
              <p className={styles.otherNamesList}>
                {otherNames.map((name, index) => (
                  <span key={`${name}-${index}`}>
                    {index > 0 ? ", " : null}
                    <span dir="auto">{name}</span>
                  </span>
                ))}
              </p>
            </section>
          ) : null}

          <section aria-label="Works" ref={worksRegionRef}>
            <CollectionView
              returnScope="Author.Works"
              rows={filteredWorkRows}
              status="ready"
              ariaLabel="Works"
              rowChangePresentation={{
                kind: "ImmediateOnKeyChange",
                key: filterQuery.trim(),
              }}
              collectionBusy={exhaustion.kind === "Draining"}
              surface={false}
              notice={
                error && data ? (
                  <FeedbackNotice content={error} announcement="Assertive" />
                ) : undefined
              }
              empty={
                filterQuery.trim() ? (
                  exhaustion.kind === "Complete" ? (
                    <FeedbackNotice
                      content={{
                        tone: "Neutral",
                        title: "No works match this filter.",
                      }}
                      announcement="None"
                    />
                  ) : (
                    <FeedbackNotice
                      content={{
                        tone: "Neutral",
                        title: "No matching work found so far.",
                      }}
                      announcement="None"
                    />
                  )
                ) : (
                  <p className={styles.empty}>No works yet.</p>
                )
              }
              footer={<CollectionExhaustionNotice state={exhaustion} />}
            />
          </section>

          {renameOpen ? (
            <RenameAuthorDialog
              handle={data.detail.handle}
              currentName={data.detail.displayName}
              onClose={() => setRenameOpen(false)}
              onRenamed={handleRenamed}
              returnFocusTo={() => renameTriggerRef.current}
              returnFocusFallback={() =>
                findPaneLandmarkFocusTarget(runtime.paneId)
              }
            />
          ) : null}
        </div>
      ) : null}
    </PaneSurface>
  );
}

function RenameAuthorDialog({
  handle,
  currentName,
  onClose,
  onRenamed,
  returnFocusTo,
  returnFocusFallback,
}: {
  handle: string;
  currentName: string;
  onClose: () => void;
  onRenamed: (detail: ContributorDetail) => void;
  returnFocusTo: () => HTMLElement | null;
  returnFocusFallback: () => HTMLElement | null;
}) {
  const [value, setValue] = useState(currentName);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<FeedbackContent | null>(null);
  const [defect, setDefect] = useState<{ error: unknown } | null>(null);
  const intentRef = useRef(createMutationIntent());
  const emptyErrorId = useId();

  const trimmed = value.trim();
  const isBlank = trimmed.length === 0;
  const isUnchanged = trimmed === currentName.trim();
  const canSave = !isBlank && !isUnchanged && !saving;

  const emptyFeedback = useMemo<FeedbackContent | null>(
    () => (isBlank ? { tone: "Danger", title: "Enter a name." } : null),
    [isBlank],
  );

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!canSave) return;
    setSaving(true);
    setNotice(null);
    const clientMutationId = intentRef.current.clientMutationId(trimmed);
    try {
      const detail = await patchContributorDisplayName(handle, {
        clientMutationId,
        displayName: trimmed,
      });
      intentRef.current.discard();
      onRenamed(detail);
      onClose();
    } catch (renameError) {
      if (handleUnauthenticatedApiError(renameError)) return;
      if (isApiError(renameError)) {
        // A proven 409 replay mismatch rotates the mutation id — the reused key is
        // now bound to a different request server-side (spec §7 shared
        // mutation-intent rule; matches MediaAuthorsEditor). Other 4xx keep the
        // key. The draft is preserved either way.
        if (renameError.code === "E_IDEMPOTENCY_KEY_REPLAY_MISMATCH") {
          intentRef.current.rotate();
        }
        try {
          setNotice(authorRenameErrorMessage(renameError));
        } catch (caughtDefect) {
          setDefect({ error: caughtDefect });
        }
      } else {
        setDefect({ error: renameError });
      }
    } finally {
      setSaving(false);
    }
  }

  if (defect) throw defect.error;

  return (
    <Dialog
      open
      title="Edit name"
      onClose={onClose}
      returnFocusTo={returnFocusTo}
      returnFocusFallback={returnFocusFallback}
    >
      <form className={styles.renameForm} onSubmit={submit}>
        <p className={styles.renameHelper}>
          Used across Nexus. Each work keeps the name it was credited under.
        </p>
        <label className={styles.renameField}>
          <span className={styles.renameLabel}>Author name</span>
          <Input
            value={value}
            dir="auto"
            autoFocus
            aria-invalid={isBlank || undefined}
            aria-describedby={isBlank ? emptyErrorId : undefined}
            onChange={(nextEvent) => setValue(nextEvent.target.value)}
          />
        </label>
        <FieldFeedback content={emptyFeedback} id={emptyErrorId} />
        {notice ? (
          <FeedbackNotice content={notice} announcement="Assertive" />
        ) : null}
        <div className={styles.renameActions}>
          <Button type="button" variant="secondary" size="md" onClick={onClose}>
            Cancel
          </Button>
          <Button
            type="submit"
            variant="primary"
            size="md"
            disabled={!canSave}
            loading={saving}
          >
            Save
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
