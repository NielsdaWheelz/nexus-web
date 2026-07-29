"use client";

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { isApiError, isSameSystemApiDefect } from "@/lib/api/client";
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
  toFeedback,
  type FeedbackContent,
} from "@/components/feedback/Feedback";
import Button from "@/components/ui/Button";
import Input from "@/components/ui/Input";
import CollectionExhaustionNotice from "@/components/collections/CollectionExhaustionNotice";
import CollectionView from "@/components/collections/CollectionView";
import SectionOpener from "@/components/ui/SectionOpener";
import { usePanePrimaryChrome } from "@/components/workspace/PanePrimaryChrome";
import PaneToolbar from "@/components/ui/PaneToolbar";
import { presentLibrary } from "@/lib/collections/presenters/library";
import {
  isReservedLibraryName,
  RESERVED_LIBRARY_NAME_MESSAGE,
} from "@/lib/libraries/presentation";
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
  usePaneRuntime,
  usePaneReturnReady,
  usePaneVisitData,
} from "@/lib/panes/paneRuntime";
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
import styles from "./page.module.css";

type Library = LibraryOut;

interface LibrariesSnapshot {
  readonly libraries: readonly Library[];
  readonly collectionRevision: CollectionRevision;
  readonly nextCursor: Presence<CollectionCursor>;
  readonly exhaustion: "Partial" | "Complete";
}

const LIBRARIES_VISIT_DATA = definePaneVisitDataKey<LibrariesSnapshot>(
  "Libraries.CompleteCollection",
);
const NO_CURSOR = absent<CollectionCursor>();
const ZERO_REVISION = 0 as CollectionRevision;

export default function LibrariesPaneBody() {
  const paneRuntime = requirePaneRuntime(usePaneRuntime(), "LibrariesPaneBody");
  const committedSnapshotRef = useRef<LibrariesSnapshot | null>(null);
  const captureCommitted = useCallback(() => committedSnapshotRef.current, []);
  const restored = usePaneVisitData(LIBRARIES_VISIT_DATA, captureCommitted);
  const allowResourceAdoptionRef = useRef(restored === null);
  const [controller, setController] = useState<LibrariesSnapshot | null>(
    restored,
  );
  const deletingLibraryIds = useStringIdSet();
  const [librariesRefreshVersion, setLibrariesRefreshVersion] = useState(0);
  const [chainEpoch, setChainEpoch] = useState(0);
  const [refreshingLibraries, setRefreshingLibraries] = useState(false);
  const clearAllVisitData = useClearAllPaneVisitData();
  const [feedback, setFeedback] = useState<FeedbackContent | null>(null);
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
  const libraries = controller?.libraries ?? [];
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

  const refreshLibraries = useCallback(() => {
    committedSnapshotRef.current = null;
    clearAllVisitData();
    allowResourceAdoptionRef.current = true;
    setRefreshingLibraries(true);
    setChainEpoch((epoch) => epoch + 1);
    setLibrariesRefreshVersion((version) => version + 1);
  }, [clearAllVisitData]);

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
    }
  }, [librariesResource]);

  useLayoutEffect(() => {
    committedSnapshotRef.current = controller;
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
    active: paneRuntime.isActive && controller !== null && !refreshingLibraries,
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
  usePanePrimaryChrome({
    header: {
      kind: "section",
      folio: collectionComplete
        ? { kind: "count", value: libraries.length, unit: "library" }
        : { kind: "none" },
      pending:
        status === "loading" ||
        refreshingLibraries ||
        exhaustion.kind === "Draining",
    },
  });
  const initialLoadError =
    controller === null && librariesResource.status === "error"
      ? toFeedback(librariesResource.error, {
          fallback: "Failed to load libraries",
        })
      : null;
  const refreshLoadError =
    controller !== null && librariesResource.status === "error"
      ? toFeedback(librariesResource.error, {
          fallback: "Failed to refresh libraries",
        })
      : null;

  const inviteLoadError =
    viewerInvitesResource.status === "error"
      ? toFeedback(viewerInvitesResource.error, {
          fallback: "Library invitations could not be loaded.",
        })
      : null;

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
      setFeedback(
        toFeedback(err, {
          fallback: "Failed to create library",
        }),
      );
    } finally {
      setCreating(false);
    }
  };

  const handleDeleteLibrary = async (library: Library) => {
    if (!confirm(`Delete "${library.name}"? This cannot be undone.`)) return;
    if (deletingLibraryIds.has(library.id)) return;
    deletingLibraryIds.add(library.id);

    try {
      const collectionRevision = await deleteMemberLibrary(library.id);
      installSafeMutation(collectionRevision, (current) =>
        current.filter((candidate) => candidate.id !== library.id),
      );
      publishLibraryPlacementChange("Unknown");
    } catch (err) {
      if (handleUnauthenticatedApiError(err)) return;
      if (!isApiError(err) || isSameSystemApiDefect(err)) throw err;
      setFeedback(
        toFeedback(err, {
          fallback: "Failed to delete library",
        }),
      );
    } finally {
      deletingLibraryIds.remove(library.id);
    }
  };

  const handleRename = useCallback(
    async (name: string) => {
      if (!settingsLibrary) return;
      const result = await renameMemberLibrary(settingsLibrary.id, name);
      installSafeMutation(result.collectionRevision, (current) =>
        current.map((library) =>
          library.id === result.library.id ? result.library : library,
        ),
      );
      setSettingsLibrary(result.library);
    },
    [installSafeMutation, settingsLibrary],
  );

  const handleDeleteFromSettings = useCallback(async () => {
    if (!settingsLibrary) return;
    const libraryId = settingsLibrary.id;
    const collectionRevision = await deleteMemberLibrary(libraryId);
    installSafeMutation(collectionRevision, (current) =>
      current.filter((library) => library.id !== libraryId),
    );
    publishLibraryPlacementChange("Unknown");
    setSettingsLibrary(null);
  }, [installSafeMutation, settingsLibrary]);

  const handleInvitation = useCallback(
    async (invite: ViewerLibraryInvitation, action: "accept" | "decline") => {
      if (busyInvitationHandle !== null) return;
      setBusyInvitationHandle(invite.invitationHandle);
      try {
        if (action === "accept") {
          await acceptLibraryInvite(invite.invitationHandle);
          setFeedback({
            severity: "success",
            title: "Library invitation accepted.",
          });
          refreshLibraries();
        } else {
          await declineLibraryInvite(invite.invitationHandle);
          setFeedback({
            severity: "success",
            title: "Library invitation declined.",
          });
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
        setFeedback(
          toFeedback(error, {
            fallback:
              action === "accept"
                ? "The invitation could not be accepted."
                : "The invitation could not be declined.",
          }),
        );
      } finally {
        setBusyInvitationHandle(null);
      }
    },
    [busyInvitationHandle, refreshLibraries],
  );

  return (
    <>
      {inviteLoadError ? (
        <div className={styles.invitationInbox}>
          <FeedbackNotice feedback={inviteLoadError} />
          <Button
            variant="secondary"
            size="sm"
            onClick={() => setInvitesRefreshVersion((version) => version + 1)}
          >
            Retry invitations
          </Button>
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
        rows={libraries.map((library) =>
          presentLibrary(library, {
            settings: library.canRename
              ? {
                  kind: "Available",
                  execute: () => setSettingsLibrary(library),
                }
              : { kind: "Unavailable" },
            deleteLibrary: library.canDelete
              ? {
                  kind: "Available",
                  execute: () => handleDeleteLibrary(library),
                }
              : { kind: "Unavailable" },
            busyIds: deletingLibraryIds.ids.has(library.id)
              ? new Set([RESOURCE_ACTION_CATALOG.DeleteLibrary.id])
              : new Set(),
          }),
        )}
        status={status}
        ariaLabel="Libraries"
        collectionBusy={refreshingLibraries || exhaustion.kind === "Draining"}
        opener={<SectionOpener heading="Libraries" />}
        notice={feedback ? <FeedbackNotice feedback={feedback} /> : undefined}
        error={
          initialLoadError ? (
            <FeedbackNotice feedback={initialLoadError} />
          ) : undefined
        }
        empty={
          <FeedbackNotice
            severity="neutral"
            title="No libraries yet."
            message="Create your first library above."
          />
        }
        footer={
          status === "ready" ? (
            <>
              <CollectionExhaustionNotice
                state={refreshingLibraries ? { kind: "Idle" } : exhaustion}
              />
              {refreshLoadError ? (
                <>
                  <FeedbackNotice feedback={refreshLoadError} />
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      if (librariesResource.status === "error") {
                        librariesResource.retry();
                      }
                    }}
                  >
                    Retry
                  </Button>
                </>
              ) : null}
            </>
          ) : null
        }
        toolbar={
          <PaneToolbar
            filters={
              <>
                <form
                  className={styles.createForm}
                  onSubmit={handleCreateLibrary}
                >
                  <Input
                    {...newLibraryNameInputProps}
                    placeholder="New library name..."
                    className={styles.inputField}
                    disabled={creating}
                    aria-invalid={newLibraryNameReserved || undefined}
                    aria-describedby={
                      newLibraryNameReserved
                        ? "library-name-reserved"
                        : undefined
                    }
                  />
                  <Button
                    type="submit"
                    variant="primary"
                    size="md"
                    disabled={
                      creating ||
                      !newLibraryName.trim() ||
                      newLibraryNameReserved
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
              </>
            }
          />
        }
      />

      {settingsLibrary ? (
        <LibrarySettingsDialog
          open
          onClose={() => setSettingsLibrary(null)}
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
