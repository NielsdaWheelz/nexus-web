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
import CollectionDisplayControls from "@/components/collections/CollectionDisplayControls";
import SectionOpener from "@/components/ui/SectionOpener";
import { usePanePrimaryChrome } from "@/components/workspace/PanePrimaryChrome";
import PaneToolbar from "@/components/ui/PaneToolbar";
import { presentLibrary } from "@/lib/collections/presenters/library";
import { useCollectionDisplayState } from "@/lib/collections/useCollectionDisplayState";
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

export default function LibrariesPaneBody() {
  const { displayState, setDisplayState } = useCollectionDisplayState("/libraries");
  const [localLibraries, setLocalLibraries] = useState<Library[] | null>(null);
  const [librariesRefreshVersion, setLibrariesRefreshVersion] = useState(0);
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

  /* ---- Edit dialog state ---- */
  const [editLibrary, setEditLibrary] = useState<Library | null>(null);
  const [editMembers, setEditMembers] = useState<LibraryMember[]>([]);
  const [editInvites, setEditInvites] = useState<LibraryInvite[]>([]);

  useEffect(() => {
    if (librariesResource.status === "ready") {
      setLocalLibraries(readyLibraries);
    }
  }, [librariesResource.status, readyLibraries]);

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
      setLocalLibraries((current) =>
        (current ?? readyLibraries ?? []).map((library) =>
          library.id === editLibrary.id ? { ...library, name } : library,
        ),
      );
      refreshLibraries();
    },
    [editLibrary, refreshLibraries, readyLibraries],
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
    },
    [editLibrary]
  );

  const handleRemoveMember = useCallback(
    async (userId: string) => {
      if (!editLibrary) return;
      await apiFetch(`/api/libraries/${editLibrary.id}/members/${userId}`, {
        method: "DELETE",
      });
      setEditMembers((prev) => prev.filter((m) => m.user_id !== userId));
    },
    [editLibrary]
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
    },
    [editLibrary]
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
    },
    []
  );

  const handleDeleteFromDialog = useCallback(async () => {
    if (!editLibrary) return;
    if (!confirm(`Delete "${editLibrary.name}"? This cannot be undone.`))
      return;
    await apiFetch(`/api/libraries/${editLibrary.id}`, {
      method: "DELETE",
    });
    closeEditDialog();
    setLocalLibraries((current) =>
      (current ?? readyLibraries ?? []).filter((library) => library.id !== editLibrary.id),
    );
    refreshLibraries();
  }, [editLibrary, closeEditDialog, refreshLibraries, readyLibraries]);

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
        rows={libraries.map((library) =>
          presentLibrary(library, {
            onEdit: () => void openEditDialog(library),
            onDelete: () => void handleDeleteLibrary(library),
          }),
        )}
        view={displayState.view}
        density={displayState.density}
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
            controls={
              <CollectionDisplayControls
                value={displayState}
                onChange={setDisplayState}
              />
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
