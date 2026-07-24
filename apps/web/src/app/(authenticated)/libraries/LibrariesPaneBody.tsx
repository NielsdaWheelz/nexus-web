"use client";

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { apiFetch } from "@/lib/api/client";
import {
  librariesResource as librariesResourceDescriptor,
  type LibraryListResourceParams,
} from "@/lib/api/resource";
import type { CursorPage } from "@/lib/api/useCursorPagination";
import { useResource } from "@/lib/api/useResource";
import { handleUnauthenticatedApiError } from "@/lib/auth/UnauthenticatedApiBoundary";
import {
  FeedbackNotice,
  toFeedback,
  type FeedbackContent,
} from "@/components/feedback/Feedback";
import Button from "@/components/ui/Button";
import Input from "@/components/ui/Input";
import LoadMoreFooter from "@/components/ui/LoadMoreFooter";
import CollectionView from "@/components/collections/CollectionView";
import SectionOpener from "@/components/ui/SectionOpener";
import { usePanePrimaryChrome } from "@/components/workspace/PanePrimaryChrome";
import PaneToolbar from "@/components/ui/PaneToolbar";
import { presentLibrary } from "@/lib/collections/presenters/library";
import { useHydrationPreservedInput } from "@/lib/ui/useHydrationPreservedInput";
import LibrarySettingsDialog from "@/components/LibrarySettingsDialog";
import { createLibrary } from "@/lib/libraries/client";
import {
  definePaneVisitDataKey,
  useClearAllPaneVisitData,
  usePaneRuntime,
  usePaneReturnReady,
  usePaneVisitData,
} from "@/lib/panes/paneRuntime";
import {
  acceptLibraryInvite,
  declineLibraryInvite,
  fetchViewerLibraryInvites,
  type ViewerLibraryInvite,
} from "@/lib/libraries/sharing";
import { useShareController } from "@/lib/sharing/controller";
import { paneShareOpenOptions } from "@/lib/sharing/openOptions";
import { resourceShareTarget } from "@/lib/sharing/targets";
import styles from "./page.module.css";

interface Library {
  id: string;
  name: string;
  color: string | null;
  ownerUserHandle: string;
  isDefault: boolean;
  role: string;
  createdAt: string;
  updatedAt: string;
  systemKey: string | null;
  canRename: boolean;
  canDelete: boolean;
  canEditEntries: boolean;
  canManageMembers: boolean;
  canTransferOwnership: boolean;
}

interface LibrariesSnapshot {
  readonly libraries: readonly Library[];
  readonly nextCursor: string | null;
  readonly hasMore: boolean;
}

const LIBRARIES_VISIT_DATA =
  definePaneVisitDataKey<LibrariesSnapshot>("Libraries.Pagination");

export default function LibrariesPaneBody() {
  const committedSnapshotRef = useRef<LibrariesSnapshot | null>(null);
  const captureCommitted = useCallback(
    () => committedSnapshotRef.current,
    [],
  );
  const restored = usePaneVisitData(LIBRARIES_VISIT_DATA, captureCommitted);
  const allowResourceAdoptionRef = useRef(restored === null);
  const [controller, setController] = useState<LibrariesSnapshot | null>(
    restored,
  );
  const paneRuntime = usePaneRuntime();
  const { openShare } = useShareController();
  const [librariesRefreshVersion, setLibrariesRefreshVersion] = useState(0);
  const clearAllVisitData = useClearAllPaneVisitData();
  const [loadingMore, setLoadingMore] = useState(false);
  const [moreError, setMoreError] = useState<FeedbackContent | null>(null);
  const [feedback, setFeedback] = useState<FeedbackContent | null>(null);
  const [invitesRefreshVersion, setInvitesRefreshVersion] = useState(0);
  const [viewerInvites, setViewerInvites] = useState<ViewerLibraryInvite[]>([]);
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
  const librariesResource = useResource<
    CursorPage<Library>,
    LibraryListResourceParams
  >({
    descriptor: librariesResourceDescriptor,
    params:
      restored !== null && librariesRefreshVersion === 0
        ? null
        : { refreshVersion: librariesRefreshVersion },
  });
  const libraries = controller?.libraries ?? [];
  const viewerInvitesResource = useResource<ViewerLibraryInvite[]>({
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

  usePanePrimaryChrome({
    header: {
      kind: "section",
      folio: { kind: "count", value: libraries.length, unit: "library" },
      pending: status === "loading",
    },
  });

  const refreshLibraries = useCallback(() => {
    committedSnapshotRef.current = null;
    clearAllVisitData();
    allowResourceAdoptionRef.current = true;
    setController(null);
    setMoreError(null);
    setLibrariesRefreshVersion((version) => version + 1);
  }, [clearAllVisitData]);

  const [settingsLibrary, setSettingsLibrary] = useState<Library | null>(null);

  useEffect(() => {
    if (
      librariesResource.status === "ready" &&
      allowResourceAdoptionRef.current
    ) {
      allowResourceAdoptionRef.current = false;
      setController({
        libraries: librariesResource.data.data,
        nextCursor: librariesResource.data.page.next_cursor,
        hasMore: librariesResource.data.page.has_more,
      });
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

  const loadError =
    controller === null && librariesResource.status === "error"
      ? toFeedback(librariesResource.error, {
          fallback: "Failed to load libraries",
        })
      : moreError;

  const loadMore = useCallback(async () => {
    const cursor = controller?.nextCursor ?? null;
    if (cursor === null || loadingMore) return;
    setLoadingMore(true);
    setMoreError(null);
    try {
      const page = await apiFetch<CursorPage<Library>>(
        librariesResourceDescriptor.clientPath({
          refreshVersion: librariesRefreshVersion,
          cursor,
        }),
      );
      setController((current) =>
        current === null
          ? current
          : {
              libraries: [...current.libraries, ...page.data],
              nextCursor: page.page.next_cursor,
              hasMore: page.page.has_more,
            },
      );
    } catch (error) {
      if (handleUnauthenticatedApiError(error)) return;
      setMoreError(
        toFeedback(error, { fallback: "Failed to load more libraries" }),
      );
    } finally {
      setLoadingMore(false);
    }
  }, [controller?.nextCursor, librariesRefreshVersion, loadingMore]);

  const inviteLoadError =
    viewerInvitesResource.status === "error"
      ? toFeedback(viewerInvitesResource.error, {
          fallback: "Library invitations could not be loaded.",
        })
      : null;

  const handleCreateLibrary = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newLibraryName.trim()) return;

    setCreating(true);
    try {
      await createLibrary({ name: newLibraryName.trim() });
      setNewLibraryName("");
      setFeedback(null);
      refreshLibraries();
    } catch (err) {
      if (handleUnauthenticatedApiError(err)) return;
      setFeedback(
        toFeedback(err, {
          fallback: "Failed to create library",
        })
      );
    } finally {
      setCreating(false);
    }
  };

  const handleDeleteLibrary = async (library: Library) => {
    if (!confirm(`Delete "${library.name}"? This cannot be undone.`)) return;

    try {
      await apiFetch(`/api/libraries/${library.id}`, {
        method: "DELETE",
      });
      setController((current) =>
        current === null
          ? current
          : {
              ...current,
              libraries: current.libraries.filter(
                (item) => item.id !== library.id,
              ),
            },
      );
      clearAllVisitData();
    } catch (err) {
      if (handleUnauthenticatedApiError(err)) return;
      setFeedback(
        toFeedback(err, {
          fallback: "Failed to delete library",
        })
      );
    }
  };

  const handleRename = useCallback(
    async (name: string) => {
      if (!settingsLibrary) return;
      await apiFetch(`/api/libraries/${settingsLibrary.id}`, {
        method: "PATCH",
        body: JSON.stringify({ name }),
      });
      setSettingsLibrary((prev) => (prev ? { ...prev, name } : null));
      setController((current) =>
        current === null
          ? current
          : {
              ...current,
              libraries: current.libraries.map((library) =>
                library.id === settingsLibrary.id
                  ? { ...library, name }
                  : library,
              ),
            },
      );
      clearAllVisitData();
    },
    [clearAllVisitData, settingsLibrary],
  );

  const handleDeleteFromSettings = useCallback(async () => {
    if (!settingsLibrary) return;
    await apiFetch(`/api/libraries/${settingsLibrary.id}`, {
      method: "DELETE",
    });
    const deletedId = settingsLibrary.id;
    setSettingsLibrary(null);
    setController((current) =>
      current === null
        ? current
        : {
            ...current,
            libraries: current.libraries.filter(
              (library) => library.id !== deletedId,
            ),
          },
    );
    clearAllVisitData();
  }, [clearAllVisitData, settingsLibrary]);

  const handleInvitation = useCallback(
    async (invite: ViewerLibraryInvite, action: "accept" | "decline") => {
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
              <div className={styles.invitationRow} key={invite.invitationHandle}>
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
            onShare: ({ triggerEl }) =>
              openShare(
                resourceShareTarget(`library:${library.id}`),
                paneShareOpenOptions(triggerEl, paneRuntime?.paneId ?? ""),
              ),
            onOpenSettings: () => setSettingsLibrary(library),
            onDelete: () => void handleDeleteLibrary(library),
          }),
        )}
        status={status}
        ariaLabel="Libraries"
        opener={<SectionOpener heading="Libraries" />}
        notice={feedback ? <FeedbackNotice feedback={feedback} /> : undefined}
        error={loadError ? <FeedbackNotice feedback={loadError} /> : undefined}
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
              {loadError ? <FeedbackNotice feedback={loadError} /> : null}
              <LoadMoreFooter
                hasMore={controller?.hasMore ?? false}
                loading={loadingMore}
                onLoadMore={loadMore}
                label="Load more libraries"
              />
            </>
          ) : null
        }
        toolbar={
          <PaneToolbar
            search={
              <form className={styles.createForm} onSubmit={handleCreateLibrary}>
                <Input
                  {...newLibraryNameInputProps}
                  placeholder="New library name..."
                  className={styles.inputField}
                  disabled={creating}
                />
                <Button
                  type="submit"
                  variant="primary"
                  size="md"
                  disabled={creating || !newLibraryName.trim()}
                >
                  {creating ? "Creating..." : "Create"}
                </Button>
              </form>
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
