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
import LibraryEditDialog from "@/components/LibraryEditDialog";
import {
  fetchEditableLibrarySharing,
  type LibraryInvite,
  type LibraryMember,
  type UserSearchResult,
} from "@/lib/libraries/sharing";
import { createLibrary } from "@/lib/libraries/client";
import type { LibraryForEdit } from "@/components/LibraryEditDialog";
import {
  definePaneVisitDataKey,
  useClearAllPaneVisitData,
  usePaneReturnReady,
  usePaneVisitData,
} from "@/lib/panes/paneRuntime";
import styles from "./page.module.css";

interface Library {
  id: string;
  name: string;
  owner_user_id: string;
  is_default: boolean;
  role: string;
  created_at: string;
  updated_at: string;
  system_key: string | null;
  can_rename: boolean;
  can_delete: boolean;
  can_edit_entries: boolean;
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
  const [librariesRefreshVersion, setLibrariesRefreshVersion] = useState(0);
  const clearAllVisitData = useClearAllPaneVisitData();
  const [loadingMore, setLoadingMore] = useState(false);
  const [moreError, setMoreError] = useState<FeedbackContent | null>(null);
  const [feedback, setFeedback] = useState<FeedbackContent | null>(null);
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

  /* ---- Edit dialog state ---- */
  const [editLibrary, setEditLibrary] = useState<Library | null>(null);
  const [editMembers, setEditMembers] = useState<LibraryMember[]>([]);
  const [editInvites, setEditInvites] = useState<LibraryInvite[]>([]);

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

  /* ---- Edit dialog handlers ---- */

  const openEditDialog = useCallback(async (library: Library) => {
    setEditLibrary(library);
    try {
      const sharing = await fetchEditableLibrarySharing(library);
      setEditMembers(sharing.members);
      setEditInvites(sharing.invites);
    } catch (err) {
      if (handleUnauthenticatedApiError(err)) return;
      setFeedback(
        toFeedback(err, {
          fallback: "Failed to load library sharing",
        })
      );
    }
  }, []);

  const closeEditDialog = useCallback(() => {
    setEditLibrary(null);
    setEditMembers([]);
    setEditInvites([]);
  }, []);

  const handleRename = useCallback(
    async (name: string) => {
      if (!editLibrary) return;
      await apiFetch(`/api/libraries/${editLibrary.id}`, {
        method: "PATCH",
        body: JSON.stringify({ name }),
      });
      setEditLibrary((prev) => (prev ? { ...prev, name } : null));
      setController((current) =>
        current === null
          ? current
          : {
              ...current,
              libraries: current.libraries.map((library) =>
                library.id === editLibrary.id
                  ? { ...library, name }
                  : library,
              ),
            },
      );
      clearAllVisitData();
    },
    [clearAllVisitData, editLibrary],
  );

  const handleUpdateMemberRole = useCallback(
    async (userId: string, role: string) => {
      if (!editLibrary) return;
      await apiFetch(`/api/libraries/${editLibrary.id}/members/${userId}`, {
        method: "PATCH",
        body: JSON.stringify({ role }),
      });
      setEditMembers((prev) =>
        prev.map((m) => (m.user_id === userId ? { ...m, role } : m))
      );
      clearAllVisitData();
    },
    [clearAllVisitData, editLibrary]
  );

  const handleRemoveMember = useCallback(
    async (userId: string) => {
      if (!editLibrary) return;
      await apiFetch(`/api/libraries/${editLibrary.id}/members/${userId}`, {
        method: "DELETE",
      });
      setEditMembers((prev) => prev.filter((m) => m.user_id !== userId));
      clearAllVisitData();
    },
    [clearAllVisitData, editLibrary]
  );

  const handleCreateInvite = useCallback(
    async (inviteeIdentifier: string, role: string) => {
      if (!editLibrary) return;
      // Determine if identifier looks like an email or a UUID
      const isEmail = inviteeIdentifier.includes("@");
      const resp = await apiFetch<{ data: LibraryInvite }>(
        `/api/libraries/${editLibrary.id}/invites`,
        {
          method: "POST",
          body: JSON.stringify({
            ...(isEmail
              ? { invitee_email: inviteeIdentifier }
              : { invitee_user_id: inviteeIdentifier }),
            role,
          }),
        }
      );
      setEditInvites((prev) => [resp.data, ...prev]);
      clearAllVisitData();
    },
    [clearAllVisitData, editLibrary]
  );

  const handleSearchUsers = useCallback(
    async (query: string): Promise<UserSearchResult[]> => {
      const resp = await apiFetch<{ data: UserSearchResult[] }>(
        `/api/users/search?q=${encodeURIComponent(query)}`
      );
      return resp.data;
    },
    []
  );

  const handleRevokeInvite = useCallback(
    async (inviteId: string) => {
      await apiFetch(`/api/libraries/invites/${inviteId}`, {
        method: "DELETE",
      });
      setEditInvites((prev) =>
        prev.map((inv) =>
          inv.id === inviteId ? { ...inv, status: "revoked" } : inv
        )
      );
      clearAllVisitData();
    },
    [clearAllVisitData]
  );

  const handleDeleteFromDialog = useCallback(async () => {
    if (!editLibrary) return;
    if (!confirm(`Delete "${editLibrary.name}"? This cannot be undone.`))
      return;
    await apiFetch(`/api/libraries/${editLibrary.id}`, {
      method: "DELETE",
    });
    closeEditDialog();
    setController((current) =>
      current === null
        ? current
        : {
            ...current,
            libraries: current.libraries.filter(
              (library) => library.id !== editLibrary.id,
            ),
          },
    );
    clearAllVisitData();
  }, [clearAllVisitData, closeEditDialog, editLibrary]);

  /* ---- Edit dialog library data ---- */

  const editLibraryForDialog: LibraryForEdit | null = editLibrary
    ? {
        id: editLibrary.id,
        name: editLibrary.name,
        is_default: editLibrary.is_default,
        role: editLibrary.role,
        owner_user_id: editLibrary.owner_user_id,
      }
    : null;

  return (
    <>
      <CollectionView
        returnScope="Libraries.Items"
        rows={libraries.map((library) =>
          presentLibrary(library, {
            onEdit: () => void openEditDialog(library),
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

      {editLibraryForDialog && (
        <LibraryEditDialog
          open={!!editLibrary}
          onClose={closeEditDialog}
          library={editLibraryForDialog}
          members={editMembers}
          invites={editInvites}
          onRename={handleRename}
          onUpdateMemberRole={handleUpdateMemberRole}
          onRemoveMember={handleRemoveMember}
          onCreateInvite={handleCreateInvite}
          onRevokeInvite={handleRevokeInvite}
          onDelete={handleDeleteFromDialog}
          onSearchUsers={handleSearchUsers}
        />
      )}
    </>
  );
}
