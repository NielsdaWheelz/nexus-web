"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { apiFetch } from "@/lib/api/client";
import {
  librariesResource as librariesResourceDescriptor,
  type LibraryListResourceParams,
} from "@/lib/api/resource";
import { useCursorPagination, type CursorPage } from "@/lib/api/useCursorPagination";
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
  acceptLibraryInvite,
  declineLibraryInvite,
  fetchViewerLibraryInvites,
  type ViewerLibraryInvite,
} from "@/lib/libraries/sharing";
import { usePaneRuntime } from "@/lib/panes/paneRuntime";
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

export default function LibrariesPaneBody() {
  const paneRuntime = usePaneRuntime();
  const { openShare } = useShareController();
  const [localLibraries, setLocalLibraries] = useState<Library[] | null>(null);
  const [librariesRefreshVersion, setLibrariesRefreshVersion] = useState(0);
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
    params: { refreshVersion: librariesRefreshVersion },
  });
  const paginatedLibraries = useCursorPagination<Library>({
    firstPage: librariesResource,
    buildMoreHref: (cursor) =>
      librariesResourceDescriptor.clientPath({
        refreshVersion: librariesRefreshVersion,
        cursor,
      }),
  });
  const viewerInvitesResource = useResource<ViewerLibraryInvite[]>({
    cacheKey: `viewer-library-invites:${invitesRefreshVersion}`,
    load: fetchViewerLibraryInvites,
  });
  const readyViewerInvites =
    viewerInvitesResource.status === "ready"
      ? viewerInvitesResource.data
      : null;
  const readyLibraries =
    librariesResource.status === "ready" ? librariesResource.data.data : null;
  const libraries = localLibraries ?? readyLibraries ?? [];
  const status =
    libraries.length > 0 || paginatedLibraries.status === "ready"
      ? "ready"
      : paginatedLibraries.status === "error"
        ? "error"
        : "loading";

  usePanePrimaryChrome({
    header: {
      kind: "section",
      folio: { kind: "count", value: libraries.length, unit: "library" },
      pending: status === "loading",
    },
  });

  const refreshLibraries = useCallback(() => {
    setLibrariesRefreshVersion((version) => version + 1);
  }, []);

  const [settingsLibrary, setSettingsLibrary] = useState<Library | null>(null);

  useEffect(() => {
    if (librariesResource.status === "ready") {
      setLocalLibraries(readyLibraries);
    }
  }, [librariesResource.status, readyLibraries]);

  useEffect(() => {
    if (readyViewerInvites) {
      setViewerInvites(readyViewerInvites);
    }
  }, [readyViewerInvites]);

  const paginatedLibrarySignature = useMemo(
    () => paginatedLibraries.items.map((library) => library.id).join("\u001f"),
    [paginatedLibraries.items],
  );

  useEffect(() => {
    if (paginatedLibraries.status !== "ready" || paginatedLibraries.items.length === 0) {
      return;
    }
    setLocalLibraries((current) => {
      if (current === null) {
        return paginatedLibraries.items;
      }
      const currentById = new Map(current.map((library) => [library.id, library]));
      const merged = paginatedLibraries.items.map((library) => currentById.get(library.id) ?? library);
      for (const library of current) {
        if (!paginatedLibraries.items.some((item) => item.id === library.id)) {
          merged.push(library);
        }
      }
      return merged;
    });
  }, [paginatedLibraries.status, paginatedLibrarySignature, paginatedLibraries.items]);

  const loadError =
    paginatedLibraries.error !== null
      ? toFeedback(paginatedLibraries.error, {
          fallback: "Failed to load libraries",
        })
      : null;
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
      setLocalLibraries((current) =>
        (current ?? readyLibraries ?? []).filter((item) => item.id !== library.id),
      );
      refreshLibraries();
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
      setLocalLibraries((current) =>
        (current ?? readyLibraries ?? []).map((library) =>
          library.id === settingsLibrary.id ? { ...library, name } : library,
        ),
      );
      refreshLibraries();
    },
    [refreshLibraries, readyLibraries, settingsLibrary],
  );

  const handleDeleteFromSettings = useCallback(async () => {
    if (!settingsLibrary) return;
    await apiFetch(`/api/libraries/${settingsLibrary.id}`, {
      method: "DELETE",
    });
    const deletedId = settingsLibrary.id;
    setSettingsLibrary(null);
    setLocalLibraries((current) =>
      (current ?? readyLibraries ?? []).filter(
        (library) => library.id !== deletedId,
      ),
    );
    refreshLibraries();
  }, [refreshLibraries, readyLibraries, settingsLibrary]);

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
                hasMore={paginatedLibraries.hasMore}
                loading={paginatedLibraries.loadingMore}
                onLoadMore={paginatedLibraries.loadMore}
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
