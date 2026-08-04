"use client";

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { isApiError } from "@/lib/api/client";
import {
  type CollectionCursor,
  type CollectionPage,
  type CollectionRevision,
} from "@/lib/api/collectionPage";
import { absent, type Presence } from "@/lib/api/presence";
import { librariesResource } from "@/lib/api/resource";
import { useExhaustivePagination } from "@/lib/api/useExhaustivePagination";
import { usePaneUrlState } from "@/lib/api/usePaneUrlState";
import { useResource } from "@/lib/api/useResource";
import { handleUnauthenticatedApiError } from "@/lib/auth/UnauthenticatedApiBoundary";
import {
  FeedbackNotice,
  type FeedbackContent,
} from "@/components/feedback/Feedback";
import Button from "@/components/ui/Button";
import Input from "@/components/ui/Input";
import SelectField from "@/components/ui/SelectField";
import CollectionExhaustionNotice from "@/components/collections/CollectionExhaustionNotice";
import CollectionView from "@/components/collections/CollectionView";
import { usePanePrimaryChrome } from "@/components/workspace/PanePrimaryChrome";
import { presentLibrary } from "@/lib/collections/presenters/library";
import {
  CANONICAL_LIBRARIES_INDEX_VIEW,
  LIBRARIES_SORT_OPTION_IDS,
  decodeLibrariesIndexView,
  encodeLibrariesIndexView,
  librariesSortOptionLabel,
  librariesSortOptionOf,
  librariesViewForSortOption,
  type DecodedLibrariesIndexView,
  type LibrariesIndexView,
  type LibrariesSortOptionId,
} from "@/lib/libraries/libraryIndexView";
import {
  isReservedLibraryName,
  libraryPresentation,
  RESERVED_LIBRARY_NAME_MESSAGE,
} from "@/lib/libraries/presentation";
import { isAbortError } from "@/lib/errors";
import { publishLibraryPlacementChange } from "@/lib/libraries/placementRevision";
import { RESOURCE_ACTION_CATALOG } from "@/lib/actions/resourceActions";
import { useHydrationPreservedInput } from "@/lib/ui/useHydrationPreservedInput";
import LibrarySettingsDialog from "@/components/LibrarySettingsDialog";
import {
  createLibrary,
  deleteMemberLibrary,
  fetchLibrariesPage,
  renameMemberLibrary,
} from "@/lib/libraries/client";
import {
  definePaneVisitDataKey,
  requirePaneRuntime,
  useClearAllPaneVisitData,
  usePaneIsActive,
  usePaneRuntime,
  usePaneReturnReady,
  usePaneVisitData,
} from "@/lib/panes/paneRuntime";
import { matchesPaneFilterQuery } from "@/lib/panes/paneRowFilter";
import usePaneFilterRows from "@/lib/panes/usePaneFilterRows";
import usePaneScrollRetention from "@/lib/panes/usePaneScrollRetention";
import type { PaneRefreshPublication } from "@/lib/panes/panePublications";
import { findPaneSearchFocusTarget } from "@/lib/workspace/paneDom";
import {
  acceptLibraryInvite,
  declineLibraryInvite,
  fetchViewerLibraryInvites,
} from "@/lib/libraries/governance";
import type {
  LibraryOut,
  ViewerLibraryInvitation,
} from "@/lib/libraries/contract";
import { useStringIdSet } from "@/lib/useStringIdSet";
import {
  libraryRequestErrorMessage,
  type LibraryRequest,
} from "@/lib/libraries/libraryRequestErrorMessage";
import styles from "./page.module.css";

type Library = LibraryOut;
const EMPTY_LIBRARIES: readonly Library[] = [];
const LIBRARIES_PAGE_LIMIT = 100;

/** The index committed as one exact view: its rows, revision, and cursor. */
interface LibrariesSnapshot {
  readonly view: LibrariesIndexView;
  readonly libraries: readonly Library[];
  readonly collectionRevision: CollectionRevision;
  readonly nextCursor: Presence<CollectionCursor>;
  readonly exhaustion: "Partial" | "Complete";
}

// The one code that turns a first-page failure into the "Invalid libraries
// view" terminal state: the backend rejects a bad view/cursor with these codes.
function isInvalidViewError(error: unknown): boolean {
  return (
    isApiError(error) &&
    (error.code === "E_INVALID_REQUEST" || error.code === "E_INVALID_CURSOR")
  );
}

interface PendingLibrariesRevalidation {
  readonly version: number;
  readonly resolve: () => void;
  readonly reject: (error: unknown) => void;
  readonly removeAbortListener: () => void;
}

const LIBRARIES_VISIT_DATA = definePaneVisitDataKey<LibrariesSnapshot>(
  "Libraries.CompleteCollection",
);
const NO_CURSOR = absent<CollectionCursor>();
const ZERO_REVISION = 0 as CollectionRevision;

export default function LibrariesPaneBody() {
  const paneRuntime = requirePaneRuntime(usePaneRuntime(), "LibrariesPaneBody");
  const isPaneActive = usePaneIsActive();
  const visibleRowIdsRef = useRef<readonly string[]>([]);
  const pendingFocusNeighborRef = useRef<string | null | undefined>(undefined);
  const pendingFocusRafRef = useRef(0);
  const deferredSettingsFocusNeighborRef = useRef<
    string | null | undefined
  >(undefined);
  const filterQueryRef = useRef("");
  const [focusRecoverySerial, setFocusRecoverySerial] = useState(0);
  const focusNeighborFor = useCallback((removedId: string) => {
    const visibleIds = visibleRowIdsRef.current;
    const index = visibleIds.indexOf(removedId);
    return index < 0
      ? null
      : (visibleIds[index + 1] ?? visibleIds[index - 1] ?? null);
  }, []);
  const setFocusNeighbor = useCallback((removedId: string) => {
    pendingFocusNeighborRef.current = focusNeighborFor(removedId);
  }, [focusNeighborFor]);
  const committedSnapshotRef = useRef<LibrariesSnapshot | null>(null);
  const captureCommitted = useCallback(() => committedSnapshotRef.current, []);
  const restored = usePaneVisitData(LIBRARIES_VISIT_DATA, captureCommitted);
  const [controller, setController] = useState<LibrariesSnapshot | null>(
    restored,
  );
  const deletingLibraryIds = useStringIdSet();
  const [librariesRefreshVersion, setLibrariesRefreshVersion] = useState(0);
  const librariesRefreshVersionRef = useRef(0);
  const pendingLibrariesRevalidationRef =
    useRef<PendingLibrariesRevalidation | null>(null);
  const completedLibrariesRevalidationVersionRef = useRef<number | null>(null);
  const [chainEpoch, setChainEpoch] = useState(0);
  const clearAllVisitData = useClearAllPaneVisitData();
  const [feedback, setFeedback] = useState<FeedbackContent | null>(null);
  const [defect, setDefect] = useState<{ error: unknown } | null>(null);
  const [invitesRefreshVersion, setInvitesRefreshVersion] = useState(0);
  const [viewerInvites, setViewerInvites] = useState<ViewerLibraryInvitation[]>(
    [],
  );
  const [busyInvitationHandle, setBusyInvitationHandle] = useState<
    string | null
  >(null);
  const [declineInvitationHandle, setDeclineInvitationHandle] = useState<
    string | null
  >(null);
  const {
    value: newLibraryName,
    setValue: setNewLibraryName,
    inputProps: newLibraryNameInputProps,
  } = useHydrationPreservedInput();
  const [creating, setCreating] = useState(false);
  const libraryCreateReplayRef = useRef<{
    libraryId: string;
    name: string;
  } | null>(null);

  // The pane URL owns the index view through a strict, total codec; `view` is
  // null only for an Invalid URL, a terminal, user-recoverable state.
  const librariesViewCodec = useMemo(
    () => ({
      basePath: "/libraries",
      decode: decodeLibrariesIndexView,
      encode: (
        decoded: DecodedLibrariesIndexView,
        current: URLSearchParams,
      ): URLSearchParams =>
        encodeLibrariesIndexView(
          decoded.kind === "Valid"
            ? decoded.view
            : CANONICAL_LIBRARIES_INDEX_VIEW,
          current,
        ),
      replaceOptions: {
        viewTransition: { kind: "collection-reflow" as const },
      },
    }),
    [],
  );
  const { state: decodedView, setState: setDecodedView } =
    usePaneUrlState(librariesViewCodec);
  const view = decodedView.kind === "Valid" ? decodedView.view : null;
  // Set when the backend rejects the requested view; cleared whenever another
  // view is requested.
  const [viewInvalid, setViewInvalid] = useState(false);
  const invalidView = decodedView.kind === "Invalid" || viewInvalid;
  const listRegionRef = useRef<HTMLDivElement | null>(null);
  const capturePaneScroll = usePaneScrollRetention(listRegionRef, controller);
  // Set by a refresh, which re-requests the view already committed; the
  // requested/committed key comparison alone cannot see that.
  const committedViewInvalidatedRef = useRef(false);
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
  // A view replacement only writes the URL: the committed rows stay rendered,
  // and the requested/committed key mismatch that the new URL creates is what
  // requests the exact first page. Invalidating the commit here instead would
  // re-request the OLD view during the view transition's async window.
  const setView = useCallback(
    (next: LibrariesIndexView) => {
      capturePaneScroll();
      setDecodedView({ kind: "Valid", view: next });
    },
    [capturePaneScroll, setDecodedView],
  );

  const requestedViewKey =
    view === null
      ? null
      : librariesResource.cacheKey({
          refreshVersion: librariesRefreshVersion,
          view,
        });
  const committedViewKey =
    controller === null
      ? null
      : librariesResource.cacheKey({
          refreshVersion: librariesRefreshVersion,
          view: controller.view,
        });
  // The committed rows are not the ones the URL asks for, so the exact first
  // page is outstanding and continuation stays fenced until it commits.
  const requestsFirstPage =
    view === null ||
    controller === null ||
    requestedViewKey !== committedViewKey ||
    committedViewInvalidatedRef.current;
  // The canonical first page at refresh zero is the route's server seed (whose
  // resource key this one matches); every other exact view and every refresh
  // owns its own request under its own identity. An invalid view requests
  // nothing at all.
  const firstPage = useResource<CollectionPage<Library>>({
    cacheKey: requestsFirstPage && !invalidView ? requestedViewKey : null,
    load: (signal) => {
      if (view === null) {
        // justify-defect: a non-null request key is built from this exact view.
        throw new Error("Libraries index request lost its view identity");
      }
      return fetchLibrariesPage({
        view,
        limit: LIBRARIES_PAGE_LIMIT,
        signal,
      });
    },
  });
  const loadFailure =
    firstPage.status === "error" && !isInvalidViewError(firstPage.error)
      ? {
          content: libraryRequestErrorMessage(firstPage.error, {
            title:
              controller === null
                ? "Libraries couldn’t be loaded"
                : "Libraries couldn’t be refreshed",
            request: "LibraryCollectionRead",
          }),
          retry: firstPage.retry,
        }
      : null;
  const libraries = controller?.libraries ?? EMPTY_LIBRARIES;
  const viewerInvitesResource = useResource<ViewerLibraryInvitation[]>({
    cacheKey: `viewer-library-invites:${invitesRefreshVersion}`,
    load: fetchViewerLibraryInvites,
  });
  const readyViewerInvites =
    viewerInvitesResource.status === "ready"
      ? viewerInvitesResource.data
      : null;
  const status =
    controller !== null ? "ready" : loadFailure !== null ? "error" : "loading";
  usePaneReturnReady(controller !== null || loadFailure !== null || invalidView);

  const rejectPendingLibrariesRevalidation = useCallback((error: unknown) => {
    const pending = pendingLibrariesRevalidationRef.current;
    pendingLibrariesRevalidationRef.current = null;
    completedLibrariesRevalidationVersionRef.current = null;
    if (!pending) return;
    pending.removeAbortListener();
    pending.reject(error);
  }, []);
  const refreshLibraries = useCallback(() => {
    rejectPendingLibrariesRevalidation(
      new DOMException("Libraries refresh was superseded.", "AbortError"),
    );
    capturePaneScroll();
    committedViewInvalidatedRef.current = true;
    committedSnapshotRef.current = null;
    clearAllVisitData();
    setChainEpoch((epoch) => epoch + 1);
    const version = librariesRefreshVersionRef.current + 1;
    librariesRefreshVersionRef.current = version;
    setLibrariesRefreshVersion(version);
  }, [
    capturePaneScroll,
    clearAllVisitData,
    rejectPendingLibrariesRevalidation,
  ]);
  const revalidateLibraries = useCallback(
    (signal: AbortSignal): Promise<void> => {
      if (signal.aborted) {
        return Promise.reject(
          signal.reason ??
            new DOMException("Libraries refresh was aborted.", "AbortError"),
        );
      }
      refreshLibraries();
      const version = librariesRefreshVersionRef.current;
      return new Promise<void>((resolve, reject) => {
        const onAbort = () => {
          const pending = pendingLibrariesRevalidationRef.current;
          if (pending?.version !== version) return;
          pendingLibrariesRevalidationRef.current = null;
          completedLibrariesRevalidationVersionRef.current = null;
          pending.removeAbortListener();
          reject(
            signal.reason ??
              new DOMException("Libraries refresh was aborted.", "AbortError"),
          );
        };
        signal.addEventListener("abort", onAbort, { once: true });
        pendingLibrariesRevalidationRef.current = {
          version,
          resolve,
          reject,
          removeAbortListener: () =>
            signal.removeEventListener("abort", onAbort),
        };
        if (signal.aborted) onAbort();
      });
    },
    [refreshLibraries],
  );
  useEffect(
    () => () => {
      rejectPendingLibrariesRevalidation(
        new DOMException("Libraries refresh was replaced.", "AbortError"),
      );
    },
    [rejectPendingLibrariesRevalidation],
  );

  const [settingsLibrary, setSettingsLibrary] = useState<Library | null>(null);
  const installSafeMutation = useCallback(
    (
      collectionRevision: CollectionRevision,
      update: (libraries: readonly Library[]) => readonly Library[],
    ) => {
      const current = committedSnapshotRef.current;
      if (current === null) {
        throw new Error("Libraries mutation settled without a committed list");
      }
      const next: LibrariesSnapshot = {
        ...current,
        libraries: update(current.libraries),
        collectionRevision,
      };
      committedSnapshotRef.current = next;
      setController(next);
      clearAllVisitData();
      setChainEpoch((epoch) => epoch + 1);
    },
    [clearAllVisitData],
  );

  // Latest-wins atomic commit: the resource reports a result only under the
  // current request identity, so a superseded view can never install its rows.
  useEffect(() => {
    if (firstPage.status === "ready" && view !== null) {
      committedViewInvalidatedRef.current = false;
      const next: LibrariesSnapshot = {
        view,
        libraries: firstPage.data.items,
        collectionRevision: firstPage.data.collectionRevision,
        nextCursor: firstPage.data.nextCursor,
        exhaustion:
          firstPage.data.nextCursor.kind === "Absent" ? "Complete" : "Partial",
      };
      committedSnapshotRef.current = next;
      setController(next);
      setChainEpoch((epoch) => epoch + 1);
      focusPendingSortControl();
      const pending = pendingLibrariesRevalidationRef.current;
      if (pending?.version === librariesRefreshVersion) {
        completedLibrariesRevalidationVersionRef.current = pending.version;
      }
      return;
    }
    if (firstPage.status === "error") {
      if (isInvalidViewError(firstPage.error)) setViewInvalid(true);
      const pending = pendingLibrariesRevalidationRef.current;
      if (pending?.version === librariesRefreshVersion) {
        rejectPendingLibrariesRevalidation(firstPage.error);
      }
    }
  }, [
    firstPage,
    focusPendingSortControl,
    librariesRefreshVersion,
    rejectPendingLibrariesRevalidation,
    view,
  ]);

  // A newly requested view retires the previous view's rejection.
  useEffect(() => setViewInvalid(false), [requestedViewKey]);

  useLayoutEffect(() => {
    committedSnapshotRef.current = requestsFirstPage ? null : controller;
    const pending = pendingLibrariesRevalidationRef.current;
    if (
      controller === null ||
      pending === null ||
      completedLibrariesRevalidationVersionRef.current !== pending.version
    ) {
      return;
    }
    completedLibrariesRevalidationVersionRef.current = null;
    pendingLibrariesRevalidationRef.current = null;
    pending.removeAbortListener();
    pending.resolve();
  }, [controller, requestsFirstPage]);

  useEffect(() => {
    if (readyViewerInvites) {
      setViewerInvites(readyViewerInvites);
    }
  }, [readyViewerInvites]);

  const commitLibrariesPage = useCallback(
    (page: CollectionPage<Library>): number => {
      const current = committedSnapshotRef.current;
      if (
        current === null ||
        current.collectionRevision !== page.collectionRevision
      ) {
        throw new Error(
          "Libraries continuation settled for a stale collection",
        );
      }
      const seen = new Set(current.libraries.map((library) => library.id));
      const libraries = [...current.libraries];
      for (const library of page.items) {
        if (seen.has(library.id)) continue;
        seen.add(library.id);
        libraries.push(library);
      }
      const next: LibrariesSnapshot = {
        ...current,
        libraries,
        collectionRevision: page.collectionRevision,
        nextCursor: page.nextCursor,
        exhaustion: page.nextCursor.kind === "Absent" ? "Complete" : "Partial",
      };
      committedSnapshotRef.current = next;
      setController(next);
      return libraries.length;
    },
    [],
  );
  // Continuation runs only while the committed view is the requested one, and
  // every page of a chain carries that same view.
  const exhaustion = useExhaustivePagination<Library>({
    active: isPaneActive && controller !== null && !requestsFirstPage,
    chainKey: `${committedViewKey ?? ""}:${chainEpoch}`,
    cursor: controller?.nextCursor ?? NO_CURSOR,
    collectionRevision: controller?.collectionRevision ?? ZERO_REVISION,
    itemCount: controller?.libraries.length ?? 0,
    loadPage: (cursor, collectionRevision, signal) => {
      if (controller === null) {
        // justify-defect: continuation runs only over a committed exact view.
        throw new Error("Libraries continuation lost its committed view");
      }
      return fetchLibrariesPage({
        view: controller.view,
        cursor,
        collectionRevision,
        limit: LIBRARIES_PAGE_LIMIT,
        signal,
      });
    },
    commitPage: commitLibrariesPage,
    refresh: refreshLibraries,
  });
  const collectionComplete =
    controller !== null && exhaustion.kind === "Complete";

  const inviteLoadError =
    viewerInvitesResource.status === "error"
      ? libraryRequestErrorMessage(
          viewerInvitesResource.error,
          {
            title: "Library invitations couldn’t be loaded",
            request: "InvitationRead",
          },
        )
      : null;

  const presentFailure = useCallback(
    (error: unknown, title: string, request: LibraryRequest): void => {
      try {
        setFeedback(libraryRequestErrorMessage(error, { title, request }));
      } catch (caughtDefect) {
        setDefect({ error: caughtDefect });
      }
    },
    [],
  );

  const newLibraryNameReserved = isReservedLibraryName(newLibraryName);

  const handleCreateLibrary = async (e: React.FormEvent) => {
    e.preventDefault();
    const name = newLibraryName.trim();
    if (!name || newLibraryNameReserved) return;
    const replay =
      libraryCreateReplayRef.current?.name === name
        ? libraryCreateReplayRef.current
        : { libraryId: crypto.randomUUID(), name };
    libraryCreateReplayRef.current = replay;

    setCreating(true);
    try {
      await createLibrary(replay);
      libraryCreateReplayRef.current = null;
      setNewLibraryName("");
      setFeedback(null);
      refreshLibraries();
    } catch (err) {
      pendingFocusNeighborRef.current = undefined;
      if (handleUnauthenticatedApiError(err)) return;
      presentFailure(err, "Library wasn’t created", "LibraryCreate");
    } finally {
      setCreating(false);
    }
  };

  const handleDeleteLibrary = async (
    library: Library,
    triggerEl: HTMLButtonElement | null,
  ) => {
    if (!confirm(`Delete "${library.name}"? This cannot be undone.`)) return;
    if (deletingLibraryIds.has(library.id)) return;
    deletingLibraryIds.add(library.id);

    try {
      const collectionRevision = await deleteMemberLibrary(library.id);
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => resolve()),
      );
      const activeElement = document.activeElement;
      if (
        activeElement === document.body ||
        activeElement === triggerEl ||
        (activeElement instanceof HTMLElement && !activeElement.isConnected)
      ) {
        setFocusNeighbor(library.id);
      }
      installSafeMutation(collectionRevision, (current) =>
        current.filter((candidate) => candidate.id !== library.id),
      );
      publishLibraryPlacementChange("Unknown");
    } catch (err) {
      if (handleUnauthenticatedApiError(err)) return;
      presentFailure(err, "Library wasn’t deleted", "LibraryMutation");
    } finally {
      deletingLibraryIds.remove(library.id);
    }
  };

  const handleRename = useCallback(
    async (name: string) => {
      if (!settingsLibrary) return;
      const result = await renameMemberLibrary(settingsLibrary.id, name);
      const query = filterQueryRef.current;
      deferredSettingsFocusNeighborRef.current =
        query.trim() &&
        !matchesPaneFilterQuery(query, [
          libraryPresentation(result.library).name,
        ])
          ? focusNeighborFor(settingsLibrary.id)
          : undefined;
      installSafeMutation(result.collectionRevision, (current) =>
        current.map((library) =>
          library.id === result.library.id ? result.library : library,
        ),
      );
      setSettingsLibrary(result.library);
    },
    [focusNeighborFor, installSafeMutation, settingsLibrary],
  );

  const handleDeleteFromSettings = useCallback(async () => {
    if (!settingsLibrary) return;
    const libraryId = settingsLibrary.id;
    try {
    const collectionRevision = await deleteMemberLibrary(libraryId);
      setFocusNeighbor(libraryId);
    installSafeMutation(collectionRevision, (current) =>
      current.filter((library) => library.id !== libraryId),
    );
    publishLibraryPlacementChange("Unknown");
      deferredSettingsFocusNeighborRef.current = undefined;
    setSettingsLibrary(null);
    } catch (error) {
      pendingFocusNeighborRef.current = undefined;
      throw error;
    }
  }, [installSafeMutation, setFocusNeighbor, settingsLibrary]);

  const handleInvitation = useCallback(
    async (invite: ViewerLibraryInvitation, action: "accept" | "decline") => {
      if (busyInvitationHandle !== null) return;
      setBusyInvitationHandle(invite.invitationHandle);
      try {
        if (action === "accept") {
          await acceptLibraryInvite(invite.invitationHandle);
          setFeedback(null);
          refreshLibraries();
        } else {
          await declineLibraryInvite(invite.invitationHandle);
          setFeedback(null);
        }
        setViewerInvites((current) =>
          current.filter(
            (row) => row.invitationHandle !== invite.invitationHandle,
          ),
        );
        setDeclineInvitationHandle(null);
        setInvitesRefreshVersion((version) => version + 1);
      } catch (error) {
        if (handleUnauthenticatedApiError(error)) return;
        presentFailure(
          error,
          action === "accept"
            ? "Invitation couldn’t be accepted"
            : "Invitation couldn’t be declined",
          "InvitationMutation",
        );
      } finally {
        setBusyInvitationHandle(null);
      }
    },
    [busyInvitationHandle, presentFailure, refreshLibraries],
  );
  const getFilterStatus = useCallback(
    (query: string) => {
      const visibleCount = libraries.filter((library) =>
        matchesPaneFilterQuery(query, [libraryPresentation(library).name]),
      ).length;
      const unit = { singular: "library", plural: "libraries" };
      return collectionComplete
        ? {
            kind: "Complete" as const,
            visibleCount,
            totalCount: libraries.length,
            unit,
          }
        : {
            kind: "Partial" as const,
            visibleCount,
            loadedCount: libraries.length,
            unit,
          };
    },
    [collectionComplete, libraries],
  );
  const dismissFilterRowsRef = useRef<() => void>(() => undefined);
  const clearDomainFilters = useCallback(() => {
    dismissFilterRowsRef.current();
    pendingCommitFocusRef.current = true;
    setView(CANONICAL_LIBRARIES_INDEX_VIEW);
  }, [setView]);
  const domainFilterControls = useMemo(
    () =>
      invalidView || view === null ? undefined : (
        <>
          <SelectField
            layout="Stacked"
            label="Sort by"
            ref={sortSelectRef}
            value={librariesSortOptionOf(view)}
            onChange={(event) => {
              pendingCommitFocusRef.current = true;
              setView(
                librariesViewForSortOption(
                  event.target.value as LibrariesSortOptionId,
                ),
              );
            }}
          >
            {LIBRARIES_SORT_OPTION_IDS.map((optionId) => (
              <option key={optionId} value={optionId}>
                {librariesSortOptionLabel(optionId)}
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
    sourceKey: "Libraries.Index",
    inputLabel: "Filter libraries",
    placeholder: "Filter libraries",
    getRowStatus: getFilterStatus,
    activeDomainControlCount:
      view === null || invalidView || view.kind === "Canonical" ? 0 : 1,
    filters: domainFilterControls,
  });
  dismissFilterRowsRef.current = search.onDismiss;
  filterQueryRef.current = filterQuery;
  const libraryRows = libraries.map((library) =>
    presentLibrary(library, {
      settings: library.canRename
        ? {
            kind: "Available",
            execute: () => {
              deferredSettingsFocusNeighborRef.current = undefined;
              setSettingsLibrary(library);
            },
          }
        : { kind: "Unavailable" },
      deleteLibrary: library.canDelete
        ? {
            kind: "Available",
            execute: ({ triggerEl }) =>
              handleDeleteLibrary(library, triggerEl),
          }
        : { kind: "Unavailable" },
      busyIds: deletingLibraryIds.ids.has(library.id)
        ? new Set([RESOURCE_ACTION_CATALOG.DeleteLibrary.id])
        : new Set(),
    }),
  );
  const filteredLibraryRows = libraryRows.filter((row) =>
    matchesPaneFilterQuery(filterQuery, [row.title.text]),
  );
  visibleRowIdsRef.current = filteredLibraryRows.map((row) => row.id);
  const visibleRowSignature = visibleRowIdsRef.current.join("\u001f");
  useEffect(() => {
    const neighborId = pendingFocusNeighborRef.current;
    if (neighborId === undefined) return;
    const focus = () => {
      if (pendingFocusNeighborRef.current !== neighborId) return;
      pendingFocusNeighborRef.current = undefined;
      const pane = Array.from(
        document.querySelectorAll<HTMLElement>("[data-pane-id]"),
      ).find((candidate) => candidate.dataset.paneId === paneRuntime.paneId);
      const row =
        neighborId === null
          ? null
          : pane?.querySelector<HTMLElement>(
              `[data-collection-row-id="${CSS.escape(neighborId)}"]`,
            );
      const focusable = row?.querySelector<HTMLElement>(
        'a, button, [tabindex]:not([tabindex="-1"])',
      );
      if (focusable) {
        focusable.focus();
        return;
      }
      findPaneSearchFocusTarget(paneRuntime.paneId)?.focus();
    };
    const outer = requestAnimationFrame(() => {
      pendingFocusRafRef.current = requestAnimationFrame(focus);
    });
    pendingFocusRafRef.current = outer;
    return () => cancelAnimationFrame(pendingFocusRafRef.current);
  }, [focusRecoverySerial, paneRuntime.paneId, visibleRowSignature]);
  const closeSettings = useCallback(() => {
    setSettingsLibrary(null);
    const neighbor = deferredSettingsFocusNeighborRef.current;
    deferredSettingsFocusNeighborRef.current = undefined;
    if (neighbor === undefined) return;
    pendingFocusNeighborRef.current = neighbor;
    setFocusRecoverySerial((serial) => serial + 1);
  }, []);
  const executeRefresh = useCallback<PaneRefreshPublication["execute"]>(
    async ({ signal, reportProgress }) => {
      reportProgress({
        kind: "Determinate",
        finishedCount: 0,
        requestedCount: 1,
      });
      try {
        await revalidateLibraries(signal);
        reportProgress({
          kind: "Determinate",
          finishedCount: 1,
          requestedCount: 1,
        });
        return {
          kind: "Complete" as const,
          announcement: "Libraries refreshed",
        };
      } catch (error: unknown) {
        if (isAbortError(error)) throw error;
        return {
          kind: "Failed" as const,
          announcement: "Libraries failed to refresh",
        };
      }
    },
    [revalidateLibraries],
  );
  usePanePrimaryChrome({
    search,
    refresh: {
      sourceKey: "Libraries.Index",
      execute: executeRefresh,
    },
    header: {
      kind: "Section",
      // The metadata describes the exhaustive committed view, never the subset.
      meta:
        collectionComplete && !invalidView
          ? { kind: "Count", value: libraries.length, unit: "library" }
          : invalidView
            ? { kind: "None" }
            : { kind: "Pending" },
    },
  });

  if (defect) throw defect.error;

  if (invalidView) {
    return (
      <FeedbackNotice
        content={{ tone: "Danger", title: "Invalid libraries view" }}
        announcement="Assertive"
        actions={[
          {
            label: "Reset view",
            onClick: () => {
              search.onDismiss();
              setDecodedView({
                kind: "Valid",
                view: CANONICAL_LIBRARIES_INDEX_VIEW,
              });
            },
          },
        ]}
      />
    );
  }

  const createLibraryAction = (
    <div>
      <form className={styles.createForm} onSubmit={handleCreateLibrary}>
        <Input
          {...newLibraryNameInputProps}
          placeholder="New library name..."
          className={styles.inputField}
          disabled={creating}
          aria-label="New library name"
          aria-invalid={newLibraryNameReserved || undefined}
          aria-describedby={
            newLibraryNameReserved ? "library-name-reserved" : undefined
          }
        />
        <Button
          type="submit"
          variant="primary"
          size="md"
          disabled={
            creating || !newLibraryName.trim() || newLibraryNameReserved
          }
        >
          {creating ? "Creating..." : "Create"}
        </Button>
      </form>
      {newLibraryNameReserved ? (
        <p
          id="library-name-reserved"
          role="alert"
          className={styles.createHint}
        >
          {RESERVED_LIBRARY_NAME_MESSAGE}
        </p>
      ) : null}
    </div>
  );

  return (
    <>
      {inviteLoadError ? (
        <div className={styles.invitationInbox}>
          <FeedbackNotice
            content={inviteLoadError}
            announcement="Assertive"
            actions={[
              {
                label: "Retry invitations",
                onClick: () =>
                  setInvitesRefreshVersion((version) => version + 1),
              },
            ]}
          />
        </div>
      ) : null}
      {viewerInvites.length > 0 ? (
        <section
          className={styles.invitationInbox}
          aria-labelledby="library-invitations-heading"
        >
          <div>
            <h2 id="library-invitations-heading">Library invitations</h2>
            <p>Accept to add the library here, or decline the invitation.</p>
          </div>
          <div className={styles.invitationRows}>
            {viewerInvites.map((invite) => (
              <div
                className={styles.invitationRow}
                key={invite.invitationHandle}
              >
                <span>
                  {invite.libraryName} ·{" "}
                  {invite.role === "admin" ? "Admin" : "Member"}
                </span>
                {declineInvitationHandle === invite.invitationHandle ? (
                  <span className={styles.invitationActions}>
                    <span>Decline this invitation?</span>
                    <Button
                      variant="danger"
                      size="sm"
                      loading={busyInvitationHandle === invite.invitationHandle}
                      onClick={() => void handleInvitation(invite, "decline")}
                    >
                      Decline
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={busyInvitationHandle !== null}
                      onClick={() => setDeclineInvitationHandle(null)}
                    >
                      Keep
                    </Button>
                  </span>
                ) : (
                  <span className={styles.invitationActions}>
                    <Button
                      variant="primary"
                      size="sm"
                      loading={busyInvitationHandle === invite.invitationHandle}
                      disabled={busyInvitationHandle !== null}
                      onClick={() => void handleInvitation(invite, "accept")}
                    >
                      Accept
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={busyInvitationHandle !== null}
                      onClick={() =>
                        setDeclineInvitationHandle(invite.invitationHandle)
                      }
                    >
                      Decline
                    </Button>
                  </span>
                )}
              </div>
            ))}
          </div>
        </section>
      ) : null}
      <div ref={listRegionRef}>
      <CollectionView
        returnScope="Libraries.Items"
        rows={filteredLibraryRows}
        status={status}
        ariaLabel="Libraries"
        rowChangePresentation={{
          kind: "ImmediateOnKeyChange",
          key: filterQuery.trim(),
        }}
        collectionBusy={requestsFirstPage || exhaustion.kind === "Draining"}
        toolbar={createLibraryAction}
        notice={
          feedback ? (
            <FeedbackNotice content={feedback} announcement="Assertive" />
          ) : status === "loading" && filterQuery.trim() ? (
            <FeedbackNotice
              content={{
                tone: "Neutral",
                title: "No matching library found so far.",
              }}
              announcement="Polite"
            />
          ) : undefined
        }
        error={
          controller === null && loadFailure !== null ? (
            <FeedbackNotice
              content={loadFailure.content}
              announcement="Assertive"
              actions={[{ label: "Retry", onClick: loadFailure.retry }]}
            />
          ) : undefined
        }
        empty={
          filterQuery.trim() ? (
            <FeedbackNotice
              content={{
                tone: "Neutral",
                title: collectionComplete
                  ? "No libraries match this filter."
                  : "No matching library found so far.",
              }}
              announcement="Polite"
            />
          ) : (
            <FeedbackNotice
              content={{
                tone: "Neutral",
                title: "No libraries yet.",
                message: "Create your first library above.",
              }}
              announcement="Polite"
            />
          )
        }
        footer={
          status === "ready" ? (
            <>
              <CollectionExhaustionNotice
                state={requestsFirstPage ? { kind: "Idle" } : exhaustion}
              />
              {loadFailure !== null ? (
                <FeedbackNotice
                  content={loadFailure.content}
                  announcement="Assertive"
                  actions={[{ label: "Retry", onClick: loadFailure.retry }]}
                />
              ) : null}
            </>
          ) : null
        }
      />
      </div>

      {settingsLibrary ? (
        <LibrarySettingsDialog
          open
          onClose={closeSettings}
          library={{
            id: settingsLibrary.id,
            name: settingsLibrary.name,
            canRename: settingsLibrary.canRename,
            canDelete: settingsLibrary.canDelete,
          }}
          onRename={handleRename}
          onDelete={handleDeleteFromSettings}
        />
      ) : null}
    </>
  );
}
