"use client";

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import {
  type CollectionCursor,
  type CollectionPage,
  type CollectionRevision,
} from "@/lib/api/collectionPage";
import { absent, type Presence } from "@/lib/api/presence";
import {
  librariesResource as librariesResourceDescriptor,
  type LibraryListResourceParams,
} from "@/lib/api/resource";
import { useExhaustivePagination } from "@/lib/api/useExhaustivePagination";
import { useResource } from "@/lib/api/useResource";
import { handleUnauthenticatedApiError } from "@/lib/auth/UnauthenticatedApiBoundary";
import {
  FeedbackNotice,
  type FeedbackContent,
} from "@/components/feedback/Feedback";
import Button from "@/components/ui/Button";
import Input from "@/components/ui/Input";
import CollectionExhaustionNotice from "@/components/collections/CollectionExhaustionNotice";
import CollectionView from "@/components/collections/CollectionView";
import SectionOpener from "@/components/ui/SectionOpener";
import { usePanePrimaryChrome } from "@/components/workspace/PanePrimaryChrome";
import { presentLibrary } from "@/lib/collections/presenters/library";
import {
  isReservedLibraryName,
  libraryPresentation,
  RESERVED_LIBRARY_NAME_MESSAGE,
} from "@/lib/libraries/presentation";
import { isAbortError } from "@/lib/errors";
import { useHydrationPreservedInput } from "@/lib/ui/useHydrationPreservedInput";
import {
  createLibrary,
  fetchLibrariesPage,
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
import type { PaneRefreshPublication } from "@/lib/panes/panePublications";
import {
  acceptLibraryInvite,
  declineLibraryInvite,
  fetchViewerLibraryInvites,
} from "@/lib/libraries/governance";
import type {
  LibraryOut,
  ViewerLibraryInvitation,
} from "@/lib/libraries/contract";
import {
  libraryRequestErrorMessage,
  type LibraryRequest,
} from "@/lib/libraries/libraryRequestErrorMessage";
import styles from "./page.module.css";

type Library = LibraryOut;
const EMPTY_LIBRARIES: readonly Library[] = [];

interface LibrariesSnapshot {
  readonly libraries: readonly Library[];
  readonly collectionRevision: CollectionRevision;
  readonly nextCursor: Presence<CollectionCursor>;
  readonly exhaustion: "Partial" | "Complete";
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
  requirePaneRuntime(usePaneRuntime(), "LibrariesPaneBody");
  const isPaneActive = usePaneIsActive();
  const committedSnapshotRef = useRef<LibrariesSnapshot | null>(null);
  const refreshFallbackSnapshotRef = useRef<LibrariesSnapshot | null>(null);
  const captureCommitted = useCallback(() => committedSnapshotRef.current, []);
  const restored = usePaneVisitData(LIBRARIES_VISIT_DATA, captureCommitted);
  const allowResourceAdoptionRef = useRef(restored === null);
  const [controller, setController] = useState<LibrariesSnapshot | null>(
    restored,
  );
  const [librariesRefreshVersion, setLibrariesRefreshVersion] = useState(0);
  const librariesRefreshVersionRef = useRef(0);
  const pendingLibrariesRevalidationRef =
    useRef<PendingLibrariesRevalidation | null>(null);
  const completedLibrariesRevalidationVersionRef = useRef<number | null>(null);
  const [chainEpoch, setChainEpoch] = useState(0);
  const [refreshingLibraries, setRefreshingLibraries] = useState(false);
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
  const librariesResource = useResource<
    CollectionPage<Library>,
    LibraryListResourceParams
  >({
    descriptor: librariesResourceDescriptor,
    params:
      restored !== null && librariesRefreshVersion === 0
        ? null
        : { refreshVersion: librariesRefreshVersion },
    load: (_params, signal) => fetchLibrariesPage({ limit: 100, signal }),
  });
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
    controller !== null
      ? "ready"
      : librariesResource.status === "error"
        ? "error"
        : "loading";
  usePaneReturnReady(
    controller !== null || librariesResource.status === "error",
  );

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
    if (committedSnapshotRef.current !== null) {
      refreshFallbackSnapshotRef.current = committedSnapshotRef.current;
    }
    committedSnapshotRef.current = null;
    clearAllVisitData();
    allowResourceAdoptionRef.current = true;
    setRefreshingLibraries(true);
    setChainEpoch((epoch) => epoch + 1);
    const version = librariesRefreshVersionRef.current + 1;
    librariesRefreshVersionRef.current = version;
    setLibrariesRefreshVersion(version);
  }, [clearAllVisitData, rejectPendingLibrariesRevalidation]);
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
          allowResourceAdoptionRef.current = false;
          setRefreshingLibraries(false);
          committedSnapshotRef.current = refreshFallbackSnapshotRef.current;
          refreshFallbackSnapshotRef.current = null;
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

  useEffect(() => {
    if (
      librariesResource.status === "ready" &&
      allowResourceAdoptionRef.current
    ) {
      allowResourceAdoptionRef.current = false;
      const next: LibrariesSnapshot = {
        libraries: librariesResource.data.items,
        collectionRevision: librariesResource.data.collectionRevision,
        nextCursor: librariesResource.data.nextCursor,
        exhaustion:
          librariesResource.data.nextCursor.kind === "Absent"
            ? "Complete"
            : "Partial",
      };
      committedSnapshotRef.current = next;
      setController(next);
      setRefreshingLibraries(false);
      setChainEpoch((epoch) => epoch + 1);
      const pending = pendingLibrariesRevalidationRef.current;
      if (pending?.version === librariesRefreshVersion) {
        completedLibrariesRevalidationVersionRef.current = pending.version;
      }
    } else if (
      librariesResource.status === "error" &&
      allowResourceAdoptionRef.current
    ) {
      allowResourceAdoptionRef.current = false;
      setRefreshingLibraries(false);
      committedSnapshotRef.current = refreshFallbackSnapshotRef.current;
      refreshFallbackSnapshotRef.current = null;
      const pending = pendingLibrariesRevalidationRef.current;
      if (pending?.version === librariesRefreshVersion) {
        rejectPendingLibrariesRevalidation(librariesResource.error);
      }
    }
  }, [
    librariesRefreshVersion,
    librariesResource,
    rejectPendingLibrariesRevalidation,
  ]);

  useLayoutEffect(() => {
    committedSnapshotRef.current = controller;
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
  }, [controller]);

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
  const exhaustion = useExhaustivePagination<Library>({
    active: isPaneActive && controller !== null && !refreshingLibraries,
    chainKey: `libraries:${chainEpoch}`,
    cursor: controller?.nextCursor ?? NO_CURSOR,
    collectionRevision: controller?.collectionRevision ?? ZERO_REVISION,
    itemCount: controller?.libraries.length ?? 0,
    loadPage: (cursor, collectionRevision, signal) =>
      fetchLibrariesPage({
        cursor,
        collectionRevision,
        limit: 100,
        signal,
      }),
    commitPage: commitLibrariesPage,
    refresh: refreshLibraries,
  });
  const collectionComplete =
    controller !== null && exhaustion.kind === "Complete";
  const initialLoadError =
    controller === null && librariesResource.status === "error"
      ? libraryRequestErrorMessage(
          librariesResource.error,
          {
            title: "Libraries couldn’t be loaded",
            request: "LibraryCollectionRead",
          },
        )
      : null;
  const refreshLoadError =
    controller !== null && librariesResource.status === "error"
      ? libraryRequestErrorMessage(
          librariesResource.error,
          {
            title: "Libraries couldn’t be refreshed",
            request: "LibraryCollectionRead",
          },
        )
      : null;

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
      if (handleUnauthenticatedApiError(err)) return;
      presentFailure(err, "Library wasn’t created", "LibraryCreate");
    } finally {
      setCreating(false);
    }
  };

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
  const { query: filterQuery, publication: search } = usePaneFilterRows({
    sourceKey: "Libraries.Index",
    inputLabel: "Filter libraries",
    placeholder: "Filter libraries",
    getRowStatus: getFilterStatus,
    activeDomainControlCount: 0,
  });
  const libraryRows = libraries.map((library) => presentLibrary(library));
  const filteredLibraryRows = libraryRows.filter((row) =>
    matchesPaneFilterQuery(filterQuery, [row.title.text]),
  );
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
      kind: "section",
      folio: collectionComplete
        ? { kind: "count", value: libraries.length, unit: "library" }
        : { kind: "none" },
      pending:
        status === "loading" ||
        refreshingLibraries ||
        !collectionComplete,
    },
  });

  if (defect) throw defect.error;

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
      <CollectionView
        returnScope="Libraries.Items"
        rows={filteredLibraryRows}
        status={status}
        ariaLabel="Libraries"
        rowChangePresentation={{
          kind: "ImmediateOnKeyChange",
          key: filterQuery.trim(),
        }}
        collectionBusy={refreshingLibraries || exhaustion.kind === "Draining"}
        opener={
          <SectionOpener heading="Libraries" actions={createLibraryAction} />
        }
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
          initialLoadError ? (
            <FeedbackNotice
              content={initialLoadError}
              announcement="Assertive"
              actions={[
                {
                  label: "Retry",
                  onClick: () => {
                    if (librariesResource.status === "error") {
                      librariesResource.retry();
                    }
                  },
                },
              ]}
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
                state={refreshingLibraries ? { kind: "Idle" } : exhaustion}
              />
              {refreshLoadError ? (
                <FeedbackNotice
                  content={refreshLoadError}
                  announcement="Assertive"
                  actions={[
                    {
                      label: "Retry",
                      onClick: () => {
                        if (librariesResource.status === "error") {
                          librariesResource.retry();
                        }
                      },
                    },
                  ]}
                />
              ) : null}
            </>
          ) : null
        }
      />
    </>
  );
}
