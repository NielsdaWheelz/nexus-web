"use client";

import { useCallback, useEffect, useState } from "react";
import { Library as LibraryIcon } from "lucide-react";
import { apiFetch } from "@/lib/api/client";
import { librariesResource as librariesResourceDescriptor } from "@/lib/api/resource";
import { useResource } from "@/lib/api/useResource";
import { libraryResourceOptions } from "@/lib/actions/resourceActions";
import { usePaneRuntime } from "@/lib/panes/paneRuntime";
import {
  FeedbackNotice,
  toFeedback,
  type FeedbackContent,
} from "@/components/feedback/Feedback";
import Pill from "@/components/ui/Pill";
import Button from "@/components/ui/Button";
import Input from "@/components/ui/Input";
import { AppList, AppListItem } from "@/components/ui/AppList";
import SectionCard from "@/components/ui/SectionCard";
import { PaneLoadingState } from "@/components/workspace/PaneLoadingState";
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
}

export default function LibrariesPaneBody() {
  const { openInNewPane } = usePaneRuntime() ?? {};
  const [libraries, setLibraries] = useState<Library[]>([]);
  const [librariesRefreshVersion, setLibrariesRefreshVersion] = useState(0);
  const [error, setError] = useState<FeedbackContent | null>(null);
  const [newLibraryName, setNewLibraryName] = useState("");
  const [creating, setCreating] = useState(false);
  const librariesResource = useResource<
    { data: Library[] },
    { refreshVersion: number }
  >({
    descriptor: librariesResourceDescriptor,
    params: { refreshVersion: librariesRefreshVersion },
  });
  const loading =
    librariesResource.status === "loading" && libraries.length === 0;

  const refreshLibraries = useCallback(() => {
    setLibrariesRefreshVersion((version) => version + 1);
  }, []);

  /* ---- Edit dialog state ---- */
  const [editLibrary, setEditLibrary] = useState<Library | null>(null);
  const [editMembers, setEditMembers] = useState<LibraryMember[]>([]);
  const [editInvites, setEditInvites] = useState<LibraryInvite[]>([]);

  useEffect(() => {
    if (librariesResource.status === "ready") {
      setLibraries(librariesResource.data.data);
      setError(null);
      return;
    }

    if (librariesResource.status === "error") {
      setError(
        toFeedback(librariesResource.error, {
          fallback: "Failed to load libraries",
        }),
      );
    }
  }, [librariesResource]);

  const handleCreateLibrary = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newLibraryName.trim()) return;

    setCreating(true);
    try {
      await createLibrary({ name: newLibraryName.trim() });
      setNewLibraryName("");
      refreshLibraries();
    } catch (err) {
      setError(
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
      setLibraries((current) =>
        current.filter((item) => item.id !== library.id),
      );
      refreshLibraries();
    } catch (err) {
      setError(
        toFeedback(err, {
          fallback: "Failed to delete library",
        })
      );
    }
  };

  const handleOpenLibraryChat = useCallback(
    (library: Library) => {
      openInNewPane?.(
        `/libraries/${library.id}`,
        library.name,
        "library-chat",
      );
    },
    [openInNewPane],
  );

  /* ---- Edit dialog handlers ---- */

  const openEditDialog = useCallback(async (library: Library) => {
    setEditLibrary(library);
    try {
      const sharing = await fetchEditableLibrarySharing(library);
      setEditMembers(sharing.members);
      setEditInvites(sharing.invites);
    } catch (err) {
      setError(
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
      setLibraries((current) =>
        current.map((library) =>
          library.id === editLibrary.id ? { ...library, name } : library,
        ),
      );
      refreshLibraries();
    },
    [editLibrary, refreshLibraries],
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
    setLibraries((current) =>
      current.filter((library) => library.id !== editLibrary.id),
    );
    refreshLibraries();
  }, [editLibrary, closeEditDialog, refreshLibraries]);

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
      <SectionCard>
        <div className={styles.content}>
          <form className={styles.createForm} onSubmit={handleCreateLibrary}>
            <Input
              value={newLibraryName}
              onChange={(e) => setNewLibraryName(e.target.value)}
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

          {error && <FeedbackNotice {...error} />}

          {loading ? (
            <PaneLoadingState />
          ) : libraries.length === 0 ? (
            <FeedbackNotice
              severity="neutral"
              title="No libraries yet."
              message="Create your first library above."
            />
          ) : (
            <AppList>
              {libraries.map((library) => (
                <AppListItem
                  key={library.id}
                  href={`/libraries/${library.id}`}
                  paneTitleHint={library.name}
                  icon={<LibraryIcon size={18} />}
                  title={library.name}
                  meta={
                    library.is_default
                      ? `default media library · role ${library.role}`
                      : `mixed library · role ${library.role}`
                  }
                  trailing={
                    library.is_default ? (
                      <Pill tone="info">default</Pill>
                    ) : null
                  }
                  options={libraryResourceOptions({
                    library,
                    onOpenChat: () => handleOpenLibraryChat(library),
                    onViewIntelligence: () => {
                      openInNewPane?.(
                        `/libraries/${library.id}`,
                        library.name,
                        "library-intelligence",
                      );
                    },
                    onEdit: () => void openEditDialog(library),
                    onDelete: () => void handleDeleteLibrary(library),
                  })}
                />
              ))}
            </AppList>
          )}
        </div>
      </SectionCard>

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
